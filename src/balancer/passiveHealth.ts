import { ServerStatus, type BackendServer } from "../db.js";
import type { HealthLog } from "../healthLog.js";
import type { ServerRegistry } from "../serverRegistry.js";

// Passive health checking: watches real proxied traffic and takes a server out
// of rotation after N connection failures in a row, instead of waiting for the
// next active health check. The active checker brings it back once it recovers.
//
// This matters for least connections in particular: a dead server fails in
// ~1ms, so it always looks like the least busy server and attracts traffic.
export class PassiveHealthTracker {
  private consecutiveFailures = new Map<string, number>();

  constructor(
    private registry: ServerRegistry,
    private healthLog: HealthLog,
    private failureThreshold: number = 3,
  ) {}

  recordSuccess(serverId: string): void {
    this.consecutiveFailures.delete(serverId);
  }

  recordFailure(server: BackendServer, error: string, responseTime: number): void {
    const failures = (this.consecutiveFailures.get(server.id) ?? 0) + 1;

    if (failures < this.failureThreshold) {
      this.consecutiveFailures.set(server.id, failures);
      return;
    }

    // Start from zero again so a recovered server gets a fresh allowance
    this.consecutiveFailures.delete(server.id);

    // No-op if the server was removed in the meantime
    if (!this.registry.updateHealth(server.id, ServerStatus.Unhealthy, responseTime)) {
      return;
    }

    console.log(
      `[passive]: ${server.serverName} (${server.ipAddress}) marked unhealthy after ${failures} consecutive failures (${error})`,
    );
    this.healthLog.append([
      {
        ts: new Date().toISOString(),
        serverId: server.id,
        serverName: server.serverName,
        ipAddress: server.ipAddress,
        status: ServerStatus.Unhealthy,
        responseTime,
        error,
        source: "passive",
      },
    ]);
  }
}
