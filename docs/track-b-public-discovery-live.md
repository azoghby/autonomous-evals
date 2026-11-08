# Live public discovery diagnostic

## Current result: rejection and fallback verified

After the terminal-rejection fix, the live probe passed strict TypeScript and its
integration test. The same query again triggered `pii_detected` after two real GETs.
The durable ledger stored an allowlisted `rejected` outcome, not source content.
Closing/reopening PGlite and using a fresh discovery adapter replayed it with zero GETs.
The SQL-backed acquisition store recorded the rejection and advanced through
`generation:acquiring` to `expert:waiting_for_expert`. Generation and expert ports
were explicit offline fixtures (one call each), so this proves fallback wiring,
not live generation or expert participation. No dataset was approved.

Parent integration also updated the acquisition store's strict decision schema to
accept only validated rejection metadata in a discovery-rejected decision. A fresh
SQL-adapter regression covers the full phase transition. The eval harness passed
strict TypeScript and **391 tests across 25 files**, none skipped, against Track A
`96cb4adcea8c55ae4d8cc353deb059996245aa77`.

`result.json` is the passing probe. `fallback-initial-result.json` preserves an initial
probe assertion error: the test expected `expert:acquiring`, whereas the existing
documented transition correctly reports `expert:waiting_for_expert`. The expectation
was corrected; no production state transition was weakened. Result status is now
marked verified only after all probe assertions pass.

## Historical failure

On 2026-11-07, the production DNS-pinned GET transport and MediaWiki adapter queried
English Wikipedia for `ISO week date`, bounded to one result and two GETs. No
credentials, model-provider calls, expert outreach or cloud mutations were used.

The diagnostic **failed retrieval acceptance**. Search and revision responses arrived
with the expected shapes and no API warnings. The revision contained 32,783 characters,
below the configured limit, but `inspectDataSafety` returned `pii_detected`.
This does not establish whether the match was actual personal information or a
false positive. The screen was not weakened and no source content was committed.

The operation's pending intent survived a file-backed PGlite close/reopen. A fresh
adapter returned `pending` with **zero replay network requests**. That proves the
local restart/replay behavior, not successful acquisition or production Neon failover.

## Integration defect exposed

A definite unusable-source response previously threw `public_discovery_invalid_response`
and left the operation pending. Reinvoking acquisition therefore could not advance to
generation/expert fallback. The fix adds a durable terminal rejection that
preserves safe diagnostic information while allowing the acquisition phase to finish
without admitting the rejected source. Ambiguous storage/transport failures must remain
distinguishable; no blanket retry or approval is justified by this result.

## Reproduction

```sh
node tests/track-b/public-discovery-live/run.mjs --live
```

The explicit flag enables real public GETs. The runner uses existing nested dependencies,
typechecks the probe and its imports, creates disposable source/storage staging and
removes it on exit. It does not install packages. The test exits nonzero when live
retrieval fails; it is deliberately outside the default offline harness.

`initial-result.json` records the first bounded attempt. `rejection-diagnosis-result.json` records a separate
instrumented attempt with response sizes, shape booleans and safety reason codes only.
Each attempt issued two GETs. Neither produced approved cases, source permission,
independent factual verification, or a usable evaluation dataset. The instrumented
attempt was a deliberate diagnostic, not an automatic retry of a pending operation.
