import type { Finding, Scenario } from '../src/contracts';
export function mockRedTeamFindings(_scenarios: Scenario[], _failed: Set<string>): Finding[] { throw new Error('MOCK_NOT_ASSESSED'); }
export function mockRedTeamResults(_scenarios: Scenario[]): never[] { throw new Error('MOCK_NOT_ASSESSED'); }
