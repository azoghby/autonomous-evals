# Parent integration

The parent copied the completed privacy and mount artifacts byte-for-byte into
Track B on 2026-11-07. All five privacy patch hashes and the mounted candidate's
recorded applied/changed source hashes were independently verified.

The supplemental baseline collection failure has a verified correction in
`../current-autonomy-baseline-correction/owner.patch`: mock the actual current
agent-factory import and remove the inherited runner exclusion. Both original
assertion sets pass against this mounted candidate in an isolated harness.
Apply that test correction before the final unfiltered combined run. The prior
failure logs remain retained as historical evidence.

These are owner-applyable artifacts. Actual Track A application files remain
unchanged; hosted authorization and deployment acceptance are not established.
