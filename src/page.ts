// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// The status page, at the monitor's own address. The page is Chirp's: it is
// written and published with the rest of usechirp.app, and the Worker fetches
// it from there at run time, as it does the list of servers, so there is one
// page and this repository imports none of it. The page's CSP allows scripts,
// styles and images from 'self' only, so its assets are passed through from
// here too; the rest of the site's links are pointed back at usechirp.app.

/** Where the page lives on the site, for a path the Worker serves it at; null
 * for a path that is not the page or one of its assets. */
export function upstreamPath(pathname: string): string | null {
  if (pathname === "/" || pathname === "/index.html") return "/status/";
  if (pathname === "/favicon.svg") return pathname;
  if (/^\/assets\/[A-Za-z0-9._/-]+$/.test(pathname) && !pathname.includes("..")) return pathname;
  return null;
}

/** A link in the page, as it must read when the page is served from here:
 * the page itself and its assets stay on this host, any other path on the
 * site goes to the site. */
export function rewriteHref(href: string, siteOrigin: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const m = /^\/status(?:\/|(?=[?#]|$))(.*)$/.exec(href);
  if (m) return "/" + m[1];
  if (href === "/favicon.svg" || href.startsWith("/favicon.svg?") || href.startsWith("/assets/")) return href;
  return siteOrigin.replace(/\/+$/, "") + href;
}

/** The site's response headers the page is served with. Its security headers
 * come from Cloudflare rules scoped to the site's own host, so they are
 * carried over for the page to keep them here. */
const KEPT_HEADERS = [
  "Content-Type", "Cache-Control", "ETag", "Last-Modified",
  "Content-Security-Policy", "Cross-Origin-Opener-Policy", "Cross-Origin-Resource-Policy",
  "Referrer-Policy", "Permissions-Policy", "X-Frame-Options", "Strict-Transport-Security",
];

/** The page, or one of its assets, as the site publishes it at path. */
export async function servePage(
  request: Request,
  siteOrigin: string,
  path: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
): Promise<Response> {
  const site = siteOrigin.replace(/\/+$/, "");
  const upstream = await fetcher(site + path + new URL(request.url).search, {
    method: request.method,
    headers: { Accept: request.headers.get("Accept") ?? "*/*" },
    signal: AbortSignal.timeout(10_000),
  });
  const headers = new Headers();
  for (const name of KEPT_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("X-Content-Type-Options", "nosniff");
  const response = new Response(upstream.body, { status: upstream.status, headers });
  if (!(headers.get("Content-Type") ?? "").startsWith("text/html")) return response;
  return new HTMLRewriter()
    .on("a[href]", {
      element(el) {
        el.setAttribute("href", rewriteHref(el.getAttribute("href")!, site));
      },
    })
    .transform(response);
}
