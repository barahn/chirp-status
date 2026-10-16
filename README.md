# chirp-status

Measures the servers of [Chirp](https://github.com/barahn/chirp)'s public
network from outside, and serves the figures and the page that shows them at
[status.usechirp.app](https://status.usechirp.app): whether each server
is up now, since when it has been off-line, and how much of each day it
answered.

It is a Cloudflare Worker and one Durable Object. The Durable Object probes
every server each 30 seconds, keeps the probes in its SQLite storage for 90 days
and each day's totals for good, and the Worker serves them at
`https://status.usechirp.app`.

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
      "id": "pve-dc-01", "kind": "node", "url": "https://relay.usechirp.app",
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

## Licence

AGPL-3.0-only. Copyright (C) 2026 Fabrintek Engenharia Digital Ltda. See
[LICENSE](LICENSE), [CONTRIBUTING.md](CONTRIBUTING.md) and
[ECOSYSTEM.md](ECOSYSTEM.md).
