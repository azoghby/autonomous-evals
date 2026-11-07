# Live public discovery diagnostic

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

A definite unusable-source response currently throws `public_discovery_invalid_response`
and leaves the operation pending. Reinvoking acquisition therefore cannot advance to
generation/expert fallback. A terminal rejection needs a durable representation that
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

`initial-result.json` records the first bounded attempt. `result.json` records a separate
instrumented attempt with response sizes, shape booleans and safety reason codes only.
Each attempt issued two GETs. Neither produced approved cases, source permission,
independent factual verification, or a usable evaluation dataset. The instrumented
attempt was a deliberate diagnostic, not an automatic retry of a pending operation.
