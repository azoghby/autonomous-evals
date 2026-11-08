import { it } from 'vitest';
import { calendarIdentityReplayCase, calendarUnresolvedCase, calendarCleanControlCase, calendarIdentityRejectionCase } from './cases';
it('ACCEPTANCE: durable calendar identity survives investigation, report, progress and fresh-service replay', calendarIdentityReplayCase, 30_000);
it('ACCEPTANCE: original infrastructure errors stay unresolved through report and progress', () => calendarUnresolvedCase('infra'), 30_000);
it('ACCEPTANCE: reproduction infrastructure errors cannot become confirmations or delivery', () => calendarUnresolvedCase('reproduction-infra'), 30_000);
it('ACCEPTANCE: actual reference executions provide a clean delivery control', calendarCleanControlCase, 30_000);
it('ACCEPTANCE: report and progress reject drifted durable operation identity', calendarIdentityRejectionCase, 30_000);
