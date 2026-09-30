import { ServerStatus, type BackendServer } from "../db.js";

// Tracks how many requests each backend is currently handling (in memory only:
// this changes on every request, far too often to persist) and routes new
// requests to the healthy server with the fewest.
export class LeastConnectionsBalancer {
  private activeJobs = new Map<string, number>();
  private tieBreaker = 0;

  pick(servers: BackendServer[]): BackendServer | undefined {
    let fewest = Infinity;
    let candidates: BackendServer[] = [];

    for (const server of servers) {
      if (server.status !== ServerStatus.Healthy) continue;

      const jobs = this.getActiveJobs(server.id);
      if (jobs < fewest) {
        fewest = jobs;
        candidates = [server];
      } else if (jobs === fewest) {
        candidates.push(server);
      }
    }

    if (candidates.length === 0) return undefined;
    // Rotate through ties so idle servers share traffic instead of the first
    // one in the list taking every request
    return candidates[this.tieBreaker++ % candidates.length];
  }

  acquire(serverId: string): void {
    this.activeJobs.set(serverId, this.getActiveJobs(serverId) + 1);
  }

  release(serverId: string): void {
    const jobs = this.getActiveJobs(serverId) - 1;
    if (jobs > 0) {
      this.activeJobs.set(serverId, jobs);
    } else {
      this.activeJobs.delete(serverId);
    }
  }

  getActiveJobs(serverId: string): number {
    return this.activeJobs.get(serverId) ?? 0;
  }
}
