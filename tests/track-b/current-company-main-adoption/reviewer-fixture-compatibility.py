"""Fixture-only canonical-price and optional additive migration compatibility.

Only the four parent-supplied queue-count expectations change reviewer test bodies.
All Calendar/forged-identity/SQL/refusal bodies stay exact. The migration appends after
001 only when parentfix002 is staged; it never replaces historical001 bytes.
"""
TARGET='tests/track-b/current-company-review/authorization-payment/fixture.ts'
REPLAY='tests/track-b/current-company-review/replay-verification/payment-fixture.ts'
def transform(path,text,payment_fixes=False):
 if path==TARGET:
  changes=[("'text_eval',500,$2", "'text_eval',${PRICE_CENTS.text_eval},$2"), ("$5,500,'usd'", "$5,${PRICE_CENTS.text_eval},'usd'"), ('amount_total:o.amount??500,','amount_total:o.amount??PRICE_CENTS.text_eval,')]
  for before,after in changes:
   if text.count(before)!=1:raise ValueError('Reviewer fixture drift: '+before)
   text=text.replace(before,after)
  text="import {PRICE_CENTS} from '@ae/core/contracts';\n"+text
  if payment_fixes:
   anchor="'packages/core/src/agents/persistence-migrations/001-agent-persistence.sql'])await engine.exec(read(p));"
   if text.count(anchor)!=1:raise ValueError('Reviewer migration anchor drift')
   text=text.replace(anchor,anchor+"\n await engine.exec(read('docs/current-company-payment-fixes/sql/002-payment-recovery.sql'));")
 elif path==REPLAY and payment_fixes:
  anchor="await db.exec(read('docs/current-autonomy-payment-startup/sql/001-current-payment.sql'));"
  if text.count(anchor)!=1:raise ValueError('Reviewer replay migration anchor drift')
  text=text.replace(anchor,anchor+"\n await db.exec(read('docs/current-company-payment-fixes/sql/002-payment-recovery.sql'));")
 return text

# Parent-supplied corrected queue expectations, exactly run.mjs lines66-73.
_fixture_transform=transform
BRIDGE='tests/track-b/current-autonomy-payment-startup/bridge.test.ts'
FINDINGS='tests/track-b/current-company-review/authorization-payment/findings.test.ts'
CONTROL='tests/track-b/current-company-review/replay-verification/receipt-drain.characterization.test.ts'
def transform(path,text,payment_fixes=False):
 text=_fixture_transform(path,text,payment_fixes)
 if not payment_fixes:return text
 replacements=[]
 if path==FINDINGS:
  replacements=[('expect(stuck).toBe(25); // root cause: revocation rows are never acknowledged','expect(stuck).toBe(0); // permanently revoked rows are acknowledged')]
 elif path==CONTROL:
  replacements=[('expect(outcomes).toHaveLength(25)','expect(outcomes).toHaveLength(1)'),('.outcomes).toEqual([{jobId:j.id,checked:1}])','.outcomes).toEqual([])'),('expect(await f.undelivered()).toBe(1)','expect(await f.undelivered()).toBe(0)')]
 elif path==BRIDGE:
  # This fixture scripts its SQL port; it executes no migration and needs no002 append.
  replacements=[("from '../../../docs/current-autonomy-payment-startup/bridge/source/apps/web/src/server/current-payment'", "from '@/server/current-payment'")]
 for before,after in replacements:
  if text.count(before)!=1:raise ValueError('Corrected expectation/import preimage drift: '+path+' '+before)
  text=text.replace(before,after)
 return text

# Execute copies at the same relative depth while preserving original base paths.
_namespaced_transform=transform
PAYMENT_REGRESSION='tests/track-b/current-company-payment-fixes/refund-reconciliation.test.ts'
def transform(path,text,payment_fixes=False):
 original=path.replace('tests/track-b/current-company-adoption-review/','tests/track-b/current-company-review/').replace('tests/track-b/current-company-adoption-payment-fixes/','tests/track-b/current-company-payment-fixes/')
 if original==PAYMENT_REGRESSION and payment_fixes:
  before="from '../current-company-review/authorization-payment/fixture'"
  after="from '../current-company-adoption-review/authorization-payment/fixture'"
  if text.count(before)!=1:raise ValueError('Regression import preimage drift')
  return text.replace(before,after)
 return _namespaced_transform(original,text,payment_fixes)
