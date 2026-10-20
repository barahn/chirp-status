# chirp-status

Measures the servers of [Chirp](https://github.com/barahn/chirp)'s public
network from outside, and serves the figures and the page that shows them at
[status.usechirp.app](https://status.usechirp.app): whether each server
is up now, since when it has been off-line, and how much of each day it
answered.

It is a Cloudflare Worker and one Durable Object. The Durable Object probes
every server each 30 seconds, keeps what the figures need in its SQLite storage
as one row per server, totals each day once it ends and keeps those totals for
good, and the Worker serves them at `https://status.usechirp.app`. Single probes
are not kept: a row per probe cost three of the free plan's hundred thousand
daily writes every round, and a day of them had to be deleted once the 90 days
of retention were up. The day in course lives in the server's row, and the days
before it in their totals.

The page itself is Chirp's, written and published with the rest of
`usechirp.app`. The Worker fetches it from `SITE_ORIGIN` at run time and serves
it at `/` with its assets, pointing the site's other links back at the site.
`usechirp.app/status/` keeps working; `status.usechirp.app/status/` redirects
to `/`.

## Every figure is measured, never claimed

- **From outside.** Nothing a server says about itself is counted. Each probe
  asks a server's `/healthz` over HTTPS, and only a `200` within 5 seconds is up.
- **No data is no data.** A minute nobody probed, because the monitor itself was
  down, counts neither as up nor as down. It is a gap.
- **"Most" means more than half.** A minute is up when more than half its probes
  succeeded; a tie is down.
- **Cut, never rounded.** A percentage reads 100 only when every observed minute
  was up.
- **Off-line** is three failed probes in a row. A server nobody has probed for
  three rounds is **unknown**, not shown as it last was.

**What a Worker cannot measure.** A Worker's `fetch` reuses connections and
does not say why one failed. So the latency shown is what a probe took as the
Worker made it, usually over a connection already open, not a fresh TLS
handshake; and a failure is `timeout`, `status` (any answer but `200`, a
redirect included) or `other`, never which of DNS, the connection or TLS gave
out. The probes come from the one place the Durable Object lives, which is
the vantage point.

## Renaming a server

A server's record is keyed by its id, in all five of the Durable Object's
tables. So a server that changes its id in Chirp's registry would otherwise
read as the old one vanishing and a new one appearing with no history: the
registry says what a server is called now, never what it was called before.

A rename is therefore declared here, in [`src/renames.ts`](src/renames.ts), by
a pull request, and the monitor moves the record on its next round. Declare it
before, or together with, the pull request that renames the server in Chirp's
list, so that no round runs with the new id and no record under it.

Moving a record into an id that already has one is refused, not merged: two ids
with a record are two servers, and folding their days together would invent
uptime neither was measured to have. A declared rename stays after it has been
applied — applying it again does nothing — and may be deleted only once no
storage still holds the old id.

The definitions, and why the network is shaped as it is, are in Chirp's
[`docs/status-page-proposal.md`](https://github.com/barahn/chirp/blob/main/docs/status-page-proposal.md).
The list of servers is Chirp's
[`network/servers.json`](https://github.com/barahn/chirp/blob/main/network/servers.json):
a server joins or leaves the network by a pull request there, and the monitor
reads the list from Chirp's `main`.

## The API

`https://status.usechirp.app`, readable by pages on `https://usechirp.app` only
(CORS). The `Date` header is exposed, so a page can tell how old the figures are
by the monitor's clock rather than the visitor's.

| Request | Answer |
| --- | --- |
| `GET /v1/servers` | Every server's status now. |
| `GET /v1/servers/{id}/history?days=N` | One server's days, oldest first, `N` from 1 to 90 (default 90), one entry per day whether it has data or not. |
| `GET /healthz` | `200 ok` while the Worker serves. |
| `GET /` | The status page, from `usechirp.app/status/`. |

`/v1/servers`:

```json
{
  "generated_at": "2026-10-16T13:45:00.000Z",
  "vantage": "Cloudflare",
  "interval_seconds": 30,
  "servers": [
    {
      "id": "bradador-vector", "nickname": "Bradador Vector",
      "kind": "node", "url": "https://relay.usechirp.app",
      "operator": "Fabrintek", "region": "BR", "behind_cdn": false,
      "added": "2026-10-15", "new": true, "listing": "active",
      "state": "up", "last_checked": "2026-10-16T13:44:58.000Z",
      "latency_ms": 42, "last_ok": "2026-10-16T13:44:58.000Z",
      "uptime": {
        "24h": { "up_minutes": 1440, "observed_minutes": 1440, "percent": 100 },
        "30d": { "up_minutes": 2160, "observed_minutes": 2160, "percent": 100 },
        "90d": { "up_minutes": 2160, "observed_minutes": 2160, "percent": 100 }
      }
    }
  ]
}
```

`nickname` is a name from Brazilian folklore and a word from the trade —
"Bradador Vector" — derived from the host in `url` so that a person can speak
of a server without reciting its id. It is derived on every request, never
stored: the id stays what the operator chose in Chirp's registry, and what
`/v1/servers/{id}/history` and the Durable Object's rows are keyed by. A host
always gets the same nickname, in any runtime, for good.

It is not a key, and must not be used as one. There are 1,280 pairs, so two
servers may share a nickname; only the id is unique. And adding a word to
either list in [`src/folklore.ts`](src/folklore.ts) re-shuffles every nickname,
which is why those lists are appended to and never reordered.

`state` is `up`, `failing`, `offline` or `unknown`. `last_error`, when the
latest probe failed, is `timeout`, `status` or `other`; it is absent when that
probe succeeded. `percent` is `null` when no minute was observed.

## Developing

Everything runs on [Bun](https://bun.sh).

```bash
bun install
bun test
bun run typecheck
bun run build
```

The figures are worked out in plain TypeScript modules (`src/`), tested with
`bun test` against Bun's own SQLite, which speaks the same SQL as a Durable
Object's storage. The Durable Object and the Worker (`src/worker.ts`) are thin
layers over them. `bun run build` is `wrangler deploy --dry-run`: the Worker
exactly as it would be deployed, in `dist/`.

wrangler is run with `bunx` at a pinned version rather than installed: its
dependencies include sharp's LGPL libvips, and nothing copyleft is installed
here (`bun run licences`). `wrangler dev` does not run under Bun: its dev
server's control channel to workerd drops, and requests hang. To run the built
Worker in workerd, use Miniflare from a directory of its own, outside this
project.

## Deploying

A merge to `main` runs `.github/workflows/deploy.yml`, which waits for a
maintainer to approve it in the `production` environment, then runs
`wrangler deploy` and checks `https://status.usechirp.app/healthz` answers.

The environment holds two secrets:

- `CLOUDFLARE_ACCOUNT_ID`: the account that owns `usechirp.app`.
- `CLOUDFLARE_API_TOKEN`: a token with **Account · Workers Scripts · Edit** on
  that account, and **Zone · Workers Routes · Edit** and **Zone · DNS · Edit**
  on `usechirp.app`, which the custom domain `status.usechirp.app` needs.

Until both are set, the workflow says so and deploys nothing.

## Watching it

`.github/workflows/watchdog.yml` checks the monitor from outside Cloudflare
every five minutes (`scripts/watchdog/`). It reports on one issue, labelled
`watchdog`, when `/v1/servers` does not answer 200 or its newest probe is more
than 3 minutes old, comments only when what is wrong changes, and closes the
issue once all is well.

It also warns when the day's use of a Durable Objects free-plan limit (rows
read, rows written, requests; reset at 00:00 UTC) passes 60 %, so it can be
dealt with before storage is refused. That needs, in the repository settings:

- the secret `CLOUDFLARE_ANALYTICS_TOKEN`: a token with only **Account ·
  Account Analytics · Read** on the account, not the deploy token;
- the variable `CLOUDFLARE_ACCOUNT_ID`.

Without them, use is not checked and the run says so. If the query fails, the
run shows a warning and the rest of the check goes on.

## Licence

AGPL-3.0-only. Copyright (C) 2026 Fabrintek Engenharia Digital Ltda. See
[LICENSE](LICENSE), [CONTRIBUTING.md](CONTRIBUTING.md) and
[ECOSYSTEM.md](ECOSYSTEM.md).
