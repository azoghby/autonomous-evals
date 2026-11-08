import { it } from 'vitest';
import { calendarPhaseOrderingCase } from './cases';

it('CHARACTERIZATION: a passed Calendar run reproduces A5 positional assertion failure under both opaque phase orders', async () => {
  console.log(await calendarPhaseOrderingCase(true));
}, 30000);
it('REGRESSION: select Calendar run outcomes by phase across both orders; no-op reproduction remains a product failure', async () => {
  console.log(await calendarPhaseOrderingCase(false));
}, 30000);
