# chirp-status

Measures the servers of [Chirp](https://github.com/barahn/chirp)'s public
network from outside, and serves the figures
[usechirp.app/status](https://usechirp.app/status/) shows: whether each server
is up now, since when it has been off-line, and how much of each day it
answered.

It is a Cloudflare Worker and one Durable Object. The Durable Object probes
every server each 30 seconds, keeps the probes in its SQLite storage for 90 days
and each day's totals for good, and the Worker serves them at
`https://status.usechirp.app`.

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
      "state": "up", "last_checked": "2026-10-16T13:44:58.000Z", "last_error": "",
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

`state` is `up`, `failing`, `offline` or `unknown`. `last_error` is `timeout`,
`status` or `other`. `percent` is `null` when no minute was observed.

## Developing

Everything runs on [Bun](https://bun.sh).

```bash
bun install
bun test
bun run typecheck
bunx wrangler dev
```

The figures are worked out in plain TypeScript modules (`src/`), tested with
`bun test` against Bun's own SQLite, which speaks the same SQL as a Durable
Object's storage. The Durable Object and the Worker are thin layers over them.

## Licence

AGPL-3.0-only. Copyright (C) 2026 Fabrintek Engenharia Digital Ltda. See
[LICENSE](LICENSE), [CONTRIBUTING.md](CONTRIBUTING.md) and
[ECOSYSTEM.md](ECOSYSTEM.md).
