// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda
//
// The watchdog, run every few minutes by .github/workflows/watchdog.yml. It
// asks the monitor for its figures as a visitor would, and, when it has a
// read-only analytics token, asks Cloudflare how much of the free plan's
// daily limits the account has used. Anything wrong is reported on one issue,
// labelled watchdog, which is closed again once all is well. check.ts decides;
// this file only fetches.
//
// Usage: bun scripts/watchdog/run.ts
//   STATUS_URL              the API to check (default https://status.usechirp.app/v1/servers)
//   GITHUB_TOKEN, GITHUB_REPOSITORY   where the issue is kept; without them, the problems are only printed
//   CLOUDFLARE_ANALYTICS_TOKEN, CLOUDFLARE_ACCOUNT_ID   optional; without them, use is not checked

import { USAGE_QUERY, checkApi, checkUsage, decide, parseUsage, reportedKeys, type ApiReply, type OpenIssue, type Problem } from "./check";

const LABEL = "watchdog";
const env = process.env;

async function askApi(url: string): Promise<ApiReply> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "chirp-status-watchdog" } });
    return { status: resp.status, body: await resp.text(), date: resp.headers.get("Date") };
  } catch (e) {
    return { status: 0, body: (e as Error).message, date: null };
  }
}

async function askUsage(token: string, account: string): Promise<Problem[]> {
  const day = new Date().toISOString().slice(0, 10);
  const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: USAGE_QUERY, variables: { account, day } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`GraphQL: ${resp.status}`);
  const usage = parseUsage(await resp.json());
  console.log(`use today: ${JSON.stringify(usage)}`);
  return checkUsage(usage);
}

/** GitHub's REST API, as the workflow's token. */
async function github<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
  const resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "chirp-status-watchdog",
    },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  if (!resp.ok) throw new Error(`GitHub ${init?.method ?? "GET"} ${path}: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as T;
}

async function openIssue(): Promise<OpenIssue | null> {
  const issues = await github<{ number: number; body: string | null; pull_request?: unknown }[]>(`/issues?state=open&labels=${LABEL}&per_page=10`);
  const issue = issues.find((i) => !i.pull_request);
  if (!issue) return null;
  let reported = reportedKeys(issue.body ?? "");
  for (let page = 1; ; page++) {
    const comments = await github<{ body: string }[]>(`/issues/${issue.number}/comments?per_page=100&page=${page}`);
    for (const c of comments) {
      if (c.body.includes("<!-- watchdog:")) reported = reportedKeys(c.body);
    }
    if (comments.length < 100) break;
  }
  return { number: issue.number, reported };
}

const problems = checkApi(await askApi(env.STATUS_URL || "https://status.usechirp.app/v1/servers"), Date.now());

if (env.CLOUDFLARE_ANALYTICS_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
  try {
    problems.push(...(await askUsage(env.CLOUDFLARE_ANALYTICS_TOKEN, env.CLOUDFLARE_ACCOUNT_ID)));
  } catch (e) {
    // The watchdog's own setup, not the monitor: a warning on the run, not
    // an issue.
    console.log(`::warning title=Use not checked::${(e as Error).message}`);
  }
} else {
  console.log("use not checked: no CLOUDFLARE_ANALYTICS_TOKEN or CLOUDFLARE_ACCOUNT_ID");
}

for (const p of problems) console.log(`problem (${p.key}): ${p.text}`);
if (problems.length === 0) console.log("all is well");

if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
  console.log("no GITHUB_TOKEN or GITHUB_REPOSITORY: not reporting on an issue");
  process.exit(0);
}

const action = decide(problems, await openIssue());
switch (action.kind) {
  case "open": {
    const i = await github<{ number: number }>(`/issues`, { method: "POST", body: { title: action.title, body: action.body, labels: [LABEL] } });
    console.log(`opened #${i.number}`);
    break;
  }
  case "comment":
    await github(`/issues/${action.number}/comments`, { method: "POST", body: { body: action.body } });
    console.log(`commented on #${action.number}`);
    break;
  case "close":
    await github(`/issues/${action.number}/comments`, { method: "POST", body: { body: action.body } });
    await github(`/issues/${action.number}`, { method: "PATCH", body: { state: "closed", state_reason: "completed" } });
    console.log(`closed #${action.number}`);
    break;
  case "none":
    break;
}
