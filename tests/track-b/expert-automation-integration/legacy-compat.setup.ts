// Compatibility only for the original Track A unit fixtures, which mock all SQL.
// This does not replace the real owner SQL in owner.test.ts / response.test.ts.
import { vi } from 'vitest';
vi.mock('../../../apps/web/src/server/automated-expert-owner',()=>({
 approveSqlManagedExpertDraft:async()=>false,
 expertOwnerDatabase:()=>({transaction:async(fn:(tx:{query:()=>Promise<{rows:unknown[]}>})=>unknown)=>fn({query:async()=>({rows:[]})})}),
}));
