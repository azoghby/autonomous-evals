# Combined final release extensions

Parent: `40014f4cf0c08bc8c6986b4a40aa28a53695172c`. Exact source pins remain Track A `530af32067279497161c22ab00006247851d9200` and Track B `687b5086e6bd204fe82809672c0511e2ee3e6f52`.

`node docs/track-b-release-extensions/stage.mjs` calls the immutable final-composition stager, applies comparison, applies resumption except the overlapping rich step, and reproduces that step's clean three-way merge against the complete-workflow base. Reproduction must match the reviewed source byte for byte. Original integration artifacts and application trees are untouched. `INTEGRITY.json` pins extension inputs; staging never refreshes it. `pin.mjs` is an explicit review operation.

This is a combined final artifact: `FINAL-COMPOSITION.json`, `APPLICATION-SHA256.json` and `owner-migrations/manifest.json` are regenerated after both extensions. The inventory excludes its own file and final metadata (which includes the inventory hash). All application source and owner migration bytes are inventoried.

`node docs/track-b-release-extensions/build-artifact.mjs` produces `application.patch` against exact latest A. It checks/applies that patch to a fresh archive, compares every delivered source hash, and compares the complete delivered file set, including deletions. `APPLICATION.json` records patch SHA-256 and the combined inventory hash. It never patches the live application checkout.

Migration identities are full canonical IDs, not ambiguous historical `004` basenames:

| ID | Canonical app filename | Transaction owner | Dependencies |
|---|---|---|---|
| `app.rich-comparison.006` | `006-rich-comparison.sql` | runner, one transaction | `app.workflow-packs.005` and its transitive predecessors |
| `app.workflow-resumption.007` | `007-workflow-resumption.sql` | artifact (`BEGIN`/`COMMIT`), dedicated idle session | comparison 006, workflow-data 003 |

Existing manifest prerequisites and the separate isolated Calendar seed remain in force. No SQL is executed by the stager or artifact builder. Deployment still requires owner schema/catalog/config/grant checks and migration registry/locking.

The merge retains pack authorization before baseline dispatch, approved-suite admission plus private provenance sidecar, Calendar/Text/remediation/report paths, all rich outcomes, observed-intent capture/finish around authoritative data advancement, and review waits within the same original Workflow. Resumption readiness is not permission to bypass acquisition, mapping, costs, approval, or suite authority. The comparison cron replacement uses the configured cron authorization, retains rich comparison results, and produces notification drafts; legacy monitoring email dispatch is removed in the staged route.

See `VERIFICATION.md` for exact offline validation and limitations. No live acceptance is claimed.
