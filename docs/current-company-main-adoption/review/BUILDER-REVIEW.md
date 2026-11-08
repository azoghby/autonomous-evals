# Builder and stager review

Review target is immutable owner pin `b66a3e2973382403e571e4003054cca9a46492d9`, tree `d75da3fde972559ed359fe7d7ce99da1489806e2`. Reviewed script hashes are in `BUILDER-REVIEW-PIN.json`; subsequent parent fixes require comparison to this snapshot. This review changes only its owned review directory and executes no Git commands.

## Findings to resolve before handoff

1. `build.py` checks the candidate file hashes but trusts `source/CURRENT-COMPOSITION.json` without checking its bytes against a named input hash. That metadata decides target selection and expected preimages. Freeze and validate this metadata hash together with any supplemental test files outside the 2,041-file candidate inventory.
2. `build.py` reads and copies every base filesystem file without verifying that the directory exactly matches `BASE-INVENTORY.json` at the named pin/tree. The currently executing snapshot establishes provenance operationally, but a reproducible build should reject added, missing, or altered base files and assert the inventory tree equals `PIN.json.tree` before generating the differential.
3. `stage.mjs` validates all listed baseline and postimage bytes, but does not assert the relationship between the manifests. Require `base.tree === PIN.tree`, `app.parent === PIN.currentMain`, exact base domain equals preserved plus changes, every addition absent from base, and changed preimage hashes equal baseline hashes. Validate relative safe paths before copying/applying. These checks make the preservation inventory complete rather than trusting metadata shape alone.
4. Supplemental tests require their own explicit pin: the retained reproduced candidate does not contain `tests/track-b/current-autonomy-payment-startup/composition.test.ts`, whereas builder logic transforms it if selected. If the build uses a supplemented source directory, freeze each supplemental input and verify its hash before applying transforms. Do not imply the original 2,041-file verification covers these extra bytes.

## Positive observations

`snapshot.py` reconstructs canonical Git tree hashing from stage-zero index entries and requires the exact immutable tree before reading source. Each actual byte source, including retained-byte fallback, must independently match its Git blob ID. A moving working tree therefore causes refusal rather than silently changing the snapshot. The script performs no Git writes. Its output directory must be empty.

The stager's `git apply --no-index` calls operate on disposable source files and never write an index or refs. Exact preimage checks and final postimage checks are appropriate. Keep them when adding manifest relationship checks.

The webhook transform composes onto the new owner webhook, preserving all subscription/plan/audit branches and canonical billing behavior; it does not install the historical webhook. Five pricing fixture transforms derive expected values from current canonical `PRICE_CENTS`, retain exact mismatch checks, and preserve monetary settlement assertions. They require explicit compatibility documentation and their own input/output hashes.

The builder records every original baseline file as changed or preserved and checks exact known historical preimages for non-webhook replacements. Additions and retained source copies are scoped to a disposable output; historical whole-tree overlay is avoided. Existing script and output modes/symlinks should either be inventoried/reproduced or the manifest should explicitly state that this artifact guarantees byte preservation only; the snapshot itself records modes correctly.

No hosted authorization, provider billing, independent PostgreSQL contention, migration, deployment, or live activation is implied by these scripts. Genuine owner adapters remain unconfigured.
