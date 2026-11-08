"""Explicit assertion-preserving migration of five historical test fixtures.

Parent imports transform(path, text) while constructing the owner differential.
CLI writes a reviewable unified patch only; it never mutates source inputs.
"""
from pathlib import Path
import difflib, sys

PREFIX = 'tests/track-b/'
TARGETS = {
 PREFIX+'autonomous-company/communications.test.ts',
 PREFIX+'autonomous-company/company.test.ts',
 PREFIX+'current-autonomy-payment-startup/bridge.test.ts',
 PREFIX+'autonomy-release-adoption/server.test.ts',
 PREFIX+'autonomy-paid-app-integration/acceptance-authority.test.ts',
}

def once(text, before, after, count=1):
    actual=text.count(before)
    if actual!=count:raise ValueError(f'Compatibility preimage drift: expected {count}, found {actual}: {before}')
    return text.replace(before,after)

def transform(path, text):
    if path not in TARGETS:return text
    header="import { PRICE_CENTS } from '../../../packages/core/src/contracts';\n"
    if path.endswith('/communications.test.ts'):
        text=once(text,"expect(row.body).toContain('$5');", "expect(row.body).toContain('$'+(PRICE_CENTS.trace_audit/100));")
    elif path.endswith('/company.test.ts'):
        text=once(text,"record.body).toContain('$5');", "record.body).toContain('$'+(PRICE_CENTS.text_eval/100));")
    elif path.endswith('/bridge.test.ts'):
        text=once(text,'price_cents:500,','price_cents:PRICE_CENTS.text_eval,')
        text=once(text,'amount_cents:500,','amount_cents:PRICE_CENTS.text_eval,')
        text=once(text,'amount_total:500,','amount_total:PRICE_CENTS.text_eval,')
        text=once(text,'f.event.data.object.amount_total=501;','f.event.data.object.amount_total=PRICE_CENTS.text_eval+1;')
        text=once(text,'f.event.data.object.amount_total=500;','f.event.data.object.amount_total=PRICE_CENTS.text_eval;')
    else:
        text=once(text,"priceMicroUsd:5000000,priceCents:500,priceLabel:'$5'", "priceMicroUsd:PRICE_CENTS.text_eval*10000,priceCents:PRICE_CENTS.text_eval,priceLabel:'$'+(PRICE_CENTS.text_eval/100)")
        # Preserve exact-amount settlement by using the same quote's micro-USD amount.
        start='"INSERT INTO company_autonomy_release.payment_receipts(tenant_id,job_id,receipt_id,settled,amount_micro_usd,record)'
        text=once(text,start,'`INSERT INTO company_autonomy_release.payment_receipts(tenant_id,job_id,receipt_id,settled,amount_micro_usd,record)')
        text=once(text,"'receipt',true,5000000,$1::jsonb)\"", "'receipt',true,${quote.priceMicroUsd},$1::jsonb)`")
    return header+text

if __name__=='__main__':
    root=Path(sys.argv[1]);out=Path(sys.argv[2]);patch=[]
    for path in sorted(TARGETS):
        before=(root/path).read_text();after=transform(path,before)
        patch.extend(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='a/'+path,tofile='b/'+path))
    out.write_text(''.join(patch))
