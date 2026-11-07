import type { BranchOwnership, NeonBranchService } from './neon.js';
/** Track A wires durable ownership lookup and branch-scoped connection URI retrieval. */
export function createBranchServices(input: {
  service: NeonBranchService;
  findOwnedBranch(branchId: string): Promise<BranchOwnership | undefined>;
  connectionString(owned: BranchOwnership): Promise<string>;
}) {
  return {
    async createJobBranch(jobId: string): Promise<{ branchId: string; connectionString: string }> {
      const owned = await input.service.createJobBranch(jobId);
      if (!owned.branchId) throw new Error('branch_not_ready');
      const connectionString = await input.connectionString(owned);
      // Credentials are returned only to the platform; never persisted in evidence or logs.
      let url: URL; try { url = new URL(connectionString); } catch { throw new Error('invalid_branch_connection'); }
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('invalid_branch_connection');
      return { branchId: owned.branchId, connectionString };
    },
    async deleteJobBranch(branchId: string): Promise<void> {
      const owned = await input.findOwnedBranch(branchId);
      if (!owned || owned.branchId !== branchId) throw new Error('branch_not_owned');
      await input.service.deleteJobBranch(owned.jobId);
    },
  };
}
