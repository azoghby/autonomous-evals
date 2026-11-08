-- Optional owner-applied migration; never runtime DDL. Requires remediation accounting migration.
CREATE SCHEMA accounting_reconciliation;
CREATE TABLE accounting_reconciliation.bindings (
 operation_id text PRIMARY KEY REFERENCES remediation_accounting.operations(operation_id),
 binding jsonb NOT NULL
);
CREATE TABLE accounting_reconciliation.receipts (
 operation_id text PRIMARY KEY REFERENCES accounting_reconciliation.bindings(operation_id),
 provider text NOT NULL,
 account_id text NOT NULL,
 external_receipt_id text NOT NULL,
 receipt jsonb NOT NULL,
 UNIQUE(provider,account_id,external_receipt_id)
);
-- Binding/evidence rows are append-only capabilities. Runtime role receives SELECT/INSERT only.
REVOKE ALL ON SCHEMA accounting_reconciliation FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA accounting_reconciliation FROM PUBLIC;
