# Current operator adoption candidate

This ten-file candidate rebases the historical `docs/naive-operator-adoption-integration` onto exact baseline `7c610084dd9827e5cbecca27e09d5b8ca5e2ae8a`. Application source remains unapplied. Historical artifacts are preserved.

The console postimage starts with the complete current console, including the upstream Revenue import, tab and rendered component, and adds only the previously reviewed expert-evidence link. Assembly proves that the historical candidate's sole console change was that exact link. The other nine postimages are unchanged from the historical candidate, with current tracked preimages checked. No upstream source is replaced by an older console snapshot.

`manifest.json` records exact current preimage and proposed postimage SHA-256 hashes, the patch checksum and historical artifact origins. `owner.patch` passes current-root `git apply --check`; actual application to isolated exact preimages reproduced all ten postimages. No application-source changes are authorized by this artifact.

The isolated `/tmp/naive-operator-current-stage` is assembled from 1,162 tracked current app/core/data/test and root package/configuration files. Every baseline file is verified against its Git blob identity before candidate overlays; `evidence/SUPPORT-PINS.json` records the baseline blob and staged SHA-256 identities. Current working-tree bytes are accepted only when they match the pinned baseline Git blob, avoiding stalled cloud-backed loose Git-object reads. No local environment files are copied. The sole test-only synthetic file is `test/stubs/server-only.ts` containing `export {};`, matching the prior test boundary. The root and workspace dependencies use the existing fresh lockfile installation, with `@ae/core` linked to staged candidate source; dependency versions/paths and lockfile hash are in `evidence/dependencies.json`.

Verification passed:

- 35 focused tests in four files; zero failures or skips (28 review tests, seven real-SQL recovery tests).
- Next type generation, full web TypeScript, and full core TypeScript.
- Next 16.4.5 production webpack build: 57 Workflow steps and four workflows; review endpoints/page and proxy-billing recovery are present in the route listing.
- Post-build recheck of all 1,162 tracked pins and ten candidate postimages, with no differences.

Reproduce from the repository root with `python3 docs/naive-operator-current-integration/assemble.py`, `python3 docs/naive-operator-current-integration/link-installed-deps.py`, and `node docs/naive-operator-current-integration/verify.mjs`. Then run `node /tmp/naive-operator-current-stage/node_modules/next/dist/bin/next build --webpack` from the stage's `apps/web` directory and `python3 docs/naive-operator-current-integration/hash-stage.py` from the repository root. Build/command logs, test JSON and post-build hash evidence are retained here.

These checks are local isolated compilation and simulated/PGlite boundary evidence. Historical component/API browser fixtures were not repeated. Independent human reviews, configured grants, live concurrent PostgreSQL behavior, hosted authentication, migrations and deployment remain separate gates. No provider sessions, outreach, payments, live database mutations, deployment or source adoption occurred.
