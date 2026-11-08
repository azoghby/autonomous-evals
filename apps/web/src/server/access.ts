export interface Viewer { id: string; email: string; isOperator: boolean }

/** Ownership rule: owner or operator. Everything else gets "not found" semantics upstream. */
export function canViewJob(viewer: Viewer | null, job: { customerId: string } | null | undefined): boolean {
  if (!viewer || !job) return false;
  return viewer.isOperator || job.customerId === viewer.id;
}
