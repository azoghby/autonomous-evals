# Unified factual Workflow, sourcing and cancellation candidate

**Unapplied source, not deployed.** This increment contains 64 source/test postimages (133 unique paths with the inherited chain) and composes the 39-file factual Workflow and 26-file expert sourcing candidates (60 unique input paths) over the 75-path cancellation chain. Shared runtime, services and Workflow postimages retain durable stage ownership, settlement and cancellation while adding factual-gap preparation, expert sourcing and resumed evaluation. Cancellation and sourcing share the job advisory lock before acquiring the canonical row lock.

The manifest records upstream preservation overrides from cancellation's reviewed `c4fcf0f` baseline through `7f28e20`, which includes merged main `ef368fc`. These retain current Track A session hint, command palette, homepage and statistics changes. The owner patch contains only the incremental candidate postimages; upstream preservation overrides are applied separately and checked against exact Git blobs.

Assembly verifies the inherited chain, baseline preimages, candidate postimages and SQL hashes. Factual Workflow and sourcing manifests are pinned as provenance. SQL copies retain exact original bytes and origin paths for expert automation (0024), expert Workflow (0025), expert text runtime (0026), and sourcing authority. Assembly places these SQL bytes in both the unified SQL directory and their pinned original artifact namespaces so portable installer tests resolve the same dependencies. They are review dependencies, not an instruction to apply duplicate migrations; inherited chain SQL remains in its original artifact namespace.

```sh
python3 docs/naive-unified-integration/freeze.py
python3 docs/naive-unified-integration/assemble.py /tmp/new-unified-stage
python3 docs/naive-unified-integration/verify.py
cd /tmp/new-unified-stage/apps/web
npx --no-install next typegen
cd ../..
npx --no-install tsc -p apps/web --noEmit
npm test -- --maxWorkers=2
cd apps/web
NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/new-unified-stage/font-mock.cjs NEXT_TELEMETRY_DISABLED=1 npx --no-install next build --webpack
```

`freeze.py` is a maintainer operation that regenerates the manifest and patch from reviewed postimages. Reproduction uses `assemble.py` with an unused destination. `verify.py` independently applies `owner.patch` over a fresh preserved cancellation baseline and compares every postimage. Dependencies use the locally installed graph; assembly copies no secrets and installs nothing.

Validation receipts belong in `validation/`. Local SQL and fake transports do not establish native PostgreSQL contention, hosted Workflow/Stripe behavior, production migration acceptance, expert availability or full Naïve readiness. No actual application/core adoption, provider calls, customer contact, spending, migration or deployment occurs in this artifact.

Mixed callback recovery remains disabled. Generic pending admission/operation errors retain their stage holds; ordinary real qualification/audit/report keep the strict one-child recovery profile. The obsolete blanket release of engineer reservations has been removed, so uncertain design-release acknowledgements require reconciliation. Native job/policy UUID lock identities are canonicalized centrally; casing cannot bypass cancellation/dispatch ordering.

The next runtime work is complete mixed child protocols and budget envelopes, current-authority remediation and judge recovery composition, copilot conversation/idle integration, and full roster/Phase 0 hosted acceptance. This artifact closes the factual/sourcing rebase task; it does not close those remaining gates.

Final verification: **4,449 candidate tests passed, zero failed, two documented skips**; web/core types and offline-font production build passed (62 steps/four workflows). Actual source: web types and 3,956 tests passed, zero failures/two skips. Independent patch application and fresh reproduction match all 2,350 source/baseline files plus 16 SQL namespace paths. See [results.json](validation/results.json), [verification.json](validation/verification.json) and [patch-verification.json](validation/patch-verification.json).
