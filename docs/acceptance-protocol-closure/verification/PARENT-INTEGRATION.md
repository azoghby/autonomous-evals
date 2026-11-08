# Parent integration verification

On 2026-11-07, the parent copied the completed acceptance artifact and tests into
the Track B checkout without overwriting existing files. All 28 files matched
their captured source SHA-256 digests. The associated ten runtime-storage files
were also copied and byte-verified. Original worker files remain intact.

Parent verification in the destination checkout:

```sh
node --test tests/track-b/acceptance-protocol-closure/identity.test.mjs tests/track-b/acceptance-protocol-closure/meter.test.mjs
```

Result: 14 passed, zero failed/skipped/todo. This covers receipt identity,
cross-instance reservation fencing, Calendar identity validation, honest call
caps, durable metering, and late measured-cost reconciliation without redispatch.
It does not replace applied-source, hosted, or live-provider acceptance.

Git repository reads remain stalled on metadata. These changes are integrated
into working files but are not committed or pushed. Historical application
patches and Track A application/platform files were not changed.
