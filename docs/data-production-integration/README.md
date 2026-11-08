# Shared evaluation-data production handoff

This workstream owns the new PostgreSQL operation adapter, its tests and migration 002, and this directory only. Existing data orchestration and review logic (including de6a798) remain the admission authority. No existing app, contracts, manifests or platform files are changed. ECC is disabled.

- [Storage contract and local SQL proof](storage/README.md)
- [Track A intake and service composition patch](intake/README.md)
- [Validation and live obligations](validation/RESULTS.md)

The Track A artifact is an application patch, not a deployed service. Apply only after integrating the current core data modules and reviewing its pinned Track A base. Migration SQL is an artifact for the authorized migration owner; these changes do not run cloud migrations.

## Boundary with the Workflow team

`docs/workflow-integration/**` belongs to the main Workflow team and is untouched. The intake handoff documents the exported production advance function and producer seam. Workflow must call that function with its existing stable task/job identity and persist the returned status/provenance. An incomplete, unknown, rejected or ambiguous operation stays blocked; a clock, worker restart, model output or stale ready flag cannot grant approval or authorize another generation dispatch.

Human intake obtains identity from the existing server session and authorizes the stored job. The submitted receipt binds the server-held candidate snapshot. The core review ledger preserves initial review, private snapshot-before-await and source-producer independence checks. A generator is never a reviewer. Source licensing, factual truth, expert qualification and consent require actual independent authorized review.

Measured generation cost is captured in the shared immutable operation ledger before delivery to the existing app cost table. Retries deliver the same external cost identity, never an increment. Approved data goes through `mapApprovedDataToTextDesign`, the existing `designTextSuite` admission path and frozen-suite verification; it does not create a second freeze implementation or bypass design gates.

## Security boundary

The SQL adapter is a trusted server component, not a database user isolation system. Keep the SQL executor, scope factory and reconciliation authorizer inaccessible to candidate/model/request payloads. Tenant/job and owner identity originate in verified server context. SQL roles with direct mutation access can bypass application checks; grant deployment access accordingly. Current known-secret policy must be supplied on each request/operation. Never persist secret lists in candidate data, operation results, receipts or patch evidence.
