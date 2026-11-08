/** Explicit owner API. Importing performs no I/O or database work. No credential loader. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseUniqueJson} from '../release-registry-reconciliation/strict-json.mjs';
import {planAdoption,applyAdoption} from './executor.mjs';
function options(config){
  const pin=parseUniqueJson(readFileSync(new URL('./PIN.json',import.meta.url)));
  return {...config,manifestPath:fileURLToPath(new URL('./MIGRATIONS.json',import.meta.url)),expectedManifestSha256:pin.manifestSha256};
}
export const ownerPlan=config=>planAdoption(options(config));
export const ownerApply=(config,review)=>applyAdoption({...options(config),authorize:review.authorize,expectedRegistrySha256:review.expectedRegistrySha256,expectedContextSha256:review.expectedContextSha256,approvedActions:review.approvedActions});
