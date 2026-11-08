// This module deliberately imports no application or credential code.
export const APPROVED = Object.freeze({ target:32, gateway:16, naive:0, cloudMutation:0, maxElapsedMs:180000 });
export const PLAN = Object.freeze({ target:77, gateway:50, naive:10, cloudMutation:0, maxElapsedMs:180000 });
export function preflight(limits) {
  for (const key of ['target','gateway','naive','cloudMutation','maxElapsedMs']) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < PLAN[key]) throw Error(`operation_plan_exceeds_approved_caps:${key}:${PLAN[key]}`);
  }
}
export async function createAcceptanceDriver(options) {
  preflight(options.limits); // Must precede even reading the private runtime getter.
  // Higher numbers are not authorization. No release composition or live runner here.
  throw Error('owner_composition_and_hosted_authorization_required');
}
