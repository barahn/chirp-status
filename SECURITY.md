# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Email
[security@fabrintek.com.br](mailto:security@fabrintek.com.br).

chirp-status reads only public figures and serves only public figures: it
probes servers' `/healthz` and holds no credential of anyone's. What matters
here is that its figures can be trusted. A way to make the monitor report a
server up that is down, or down that is up, to write into its storage, to make
it probe something it should not, or to read anything but the API, is a
security problem. So is a flaw in Chirp's own servers that the monitor reveals.

Include what you have: the commit, what an attacker gains, and a reproduction
case if you have one. A report without a proof of concept is still worth
sending.

### What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement of your report | 3 working days |
| Initial assessment and severity | 10 working days |
| Fix or documented mitigation for a confirmed high/critical issue | 90 days |

These are targets, not contractual terms.

### Disclosure

Coordinated disclosure. Please give the 90-day window above before publishing.
If a fix is not shipping in that time, you are free to disclose. Reporters are
credited in the advisory unless they ask not to be.

## Supported versions

Only the tip of `main`, which is what runs at `status.usechirp.app`.

Flaws in Chirp itself go to Chirp's policy:
<https://github.com/barahn/chirp/security/policy>.
