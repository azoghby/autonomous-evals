# CI route-type generation fix

Owner-applied patch against `4d9842b`. Alex explicitly approved this CI-only ownership override; the patch is now applied to the actual workflow.

GitHub run [42459613849](https://github.com/azoghby/standard-evals/actions/runs/42459613849) fails web typechecking because `apps/web/src/app/layout.tsx:44` references `LayoutProps<"/">` before Next route types are generated. The previous commit has the same failure in [42458922464](https://github.com/azoghby/standard-evals/actions/runs/42458922464). Unit tests and build were not reached. The scoped Track B pass did not validate this full-app boundary.

The three-line patch inserts `npx next typegen` with `working-directory: apps/web` before web typechecking. Installed Next 16.4 documentation (`next/dist/docs/01-app/03-api-reference/06-cli/next.md`) recommends typegen before standalone TypeScript checking. This preserves generated route types and existing checks; it does not suppress the error with an ambient type.

Apply with `git apply --check docs/ci-typegen/owner.patch` followed by `git apply docs/ci-typegen/owner.patch`. Run the full CI sequence from a clean checkout. A successful patch applicability check alone does not prove CI green.

The applied-source staging check found the Workflow plugin requires app-local execution: root `next typegen apps/web` failed directory discovery, while running `next typegen` from `apps/web` succeeded. The patch uses the verified app-local form.
