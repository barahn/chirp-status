# Contributing to chirp-status

## Contributions are closed right now

Pull requests from outside Fabrintek will not be merged until the Contributor
License Agreement below is enforced automatically, as in
[Chirp](https://github.com/barahn/chirp/blob/main/CONTRIBUTING.md), and for
the same reason: Fabrintek holds the copyright in all of it. Issues, bug reports
and reproduction cases are welcome. A server joining or leaving the network is
not a change here: it is a pull request to Chirp's `network/servers.json`.

## Contributor License Agreement

These are the terms that will apply. They are identical to the ones used across
Fabrintek's repositories, so that a contributor signs once.

1. **Definitions**
   - *"You"* (or *"Contributor"*) means the copyright owner or legal entity
     authorized by the copyright owner submitting the Contribution.
   - *"Contribution"* means any source code, documentation, art assets, or
     other materials submitted via Git commit, pull request, or issue tracker
     to the project.
2. **Grant of Copyright License**: You hereby grant to the project maintainer
   (**Fabrintek Engenharia Digital Ltda**) a perpetual, worldwide,
   non-exclusive, no-charge, royalty-free, irrevocable copyright license to
   reproduce, prepare derivative works of, publicly display, publicly perform,
   sublicense, and distribute your Contributions and such derivative works.
3. **Grant of Patent License**: You hereby grant a perpetual, worldwide,
   non-exclusive, no-charge, royalty-free, irrevocable patent license to make,
   have made, use, offer to sell, sell, import, and otherwise transfer the
   Work, where such license applies only to those patent claims licensable by
   You that are necessarily infringed by Your Contribution(s).
4. **Originality & Authority**: You represent that each of Your Contributions
   is your original creation, and that you have the full legal right to grant
   the licenses set forth above. If your employer has rights to intellectual
   property that includes your Contributions, you represent that you have
   received permission to make Contributions on behalf of that employer.
5. **Open Source Commitment**: Contributions to chirp-status are published
   under the **GNU Affero General Public License v3.0**. Fabrintek commits to
   keeping chirp-status available under that licence or a compatible
   open-source successor. The sublicensing right in clause 2 is the same as
   Chirp's; it is not a route to closing chirp-status.
6. **Dependency Direction**: Dependencies point inwards only. remotekit depends
   on none of the others; Chirp may depend on remotekit; the Barahn platform
   may depend on both. chirp-status depends on no other repository's code: it
   reads Chirp's list of servers as data. A change that needs an arrow
   reversed is a design problem, not a licensing exception.

### Sign-off is required, and is not the CLA

Every commit must carry a `Signed-off-by` trailer:

```bash
git commit -s -m "fix(probe): count a redirect as down"
```

That trailer is the [Developer Certificate of
Origin](https://developercertificate.org/). It certifies where the code came
from and that you have the right to submit it. It does **not** grant the
copyright and patent licences in clauses 2 and 3 above — those need separate,
explicit acceptance, which is the part this repository does not yet have.

Treating a DCO sign-off as CLA acceptance is a common shortcut and a bad one:
the text a contributor certifies says nothing about relicensing. When CLA
enforcement lands here it will be a distinct, recorded act, not an inference
drawn from a sign-off.

## Branching model

Trunk-based, as Chirp. `main` is the default branch, takes changes only by pull
request with its required checks, and is merged by rebase, so history stays
linear and every commit keeps its sign-off. A merge to `main` is deployed to
`status.usechirp.app` after a maintainer approves it in the `production`
environment.

A pull request can also be held deliberately. The `hold: design` label fails
the required `Design hold` check, so the pull request cannot be merged while it
is there, whatever else is green. It is for changes that wait on a decision
rather than on review -- the relay network's operating architecture is the
standing example: it is designed, demonstrated, tested and approved before any
of it reaches a release. The maintainer puts the label on and takes it off, and
the check re-runs by itself when the label changes; no push is needed to clear
it.

## Versions

The Worker is deployed from `main`, not from releases, so it has no version
yet. When it gets one, it follows the policy of every Barahn repository
(Chirp's and remotekit's `docs/release.md`):

- Semantic Versioning, `vMAJOR.MINOR.PATCH`, with pre-releases as
  `vX.Y.Z-rc.N`;
- annotated tags that never move or go away: a wrong one is answered with a
  new version;
- a release validates a set of changes, not a pull request;
- before a tag: `bun install --frozen-lockfile`, `bun run typecheck`,
  `bun test` and the Worker build all pass at that commit;
- a release is first proposed with its version, why, the changes, their
  impact and the exact commands, and tagged only after the maintainer says
  yes.

## What is enforced

CI checks every commit's `Signed-off-by`, that the code type-checks and its tests
pass under Bun, that the Worker builds, and that the project has no runtime
dependency and only permissively licensed development tools. CodeQL, dependency
review and gitleaks run on every pull request.

`main` and the release tags are protected by rulesets on GitHub, applied by the
maintainer and versioned here as `.github/rulesets/main-protected.json` and
`tags-protected.json`. Those files are the reference: **anything configured on
GitHub and not in them is drift.** They are generated from the live rulesets
rather than written by hand, so that they can be compared field for field —
re-generate instead of editing:

```
gh api repos/barahn/chirp-status/rulesets/25246725   # main
gh api repos/barahn/chirp-status/rulesets/25507486   # tags
```

keeping `name`, `target`, `enforcement`, `conditions`, `bypass_actors` and
`rules`, and dropping the server's own `id`, `source` and timestamps. To apply a
change the other way: `gh api -X PUT repos/barahn/chirp-status/rulesets/<id>
--input <file>`. Never `PUT` a file that was hand-edited from a partial copy: a
field the file omits is sent as its default, which silently turns protection
off.

## Tools

Bun, not Node.js: `bun install`, `bun test`, `bun run typecheck`,
`bunx wrangler`. A tool goes in only if it runs under Bun.
