import { ServerStatus, type BackendServer } from "./db.js";
import type { HealthLog } from "./healthLog.js";
import type { ServerRegistry } from "./serverRegistry.js";

interface HealthCheckOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

interface HealthResult {
  server: BackendServer;
  status: ServerStatus;
  responseTime: number;
  error?: string;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "timeout";
    // fetch wraps network errors; the useful code (ECONNREFUSED etc.) is on `cause`
    const code = (error.cause as { code?: string } | undefined)?.code;
    return code ?? error.message;
  }
  return String(error);
}

async function checkServer(
  server: BackendServer,
  timeoutMs: number,
): Promise<HealthResult> {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);

  try {
    const res = await fetch(`http://${server.ipAddress}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      return { server, status: ServerStatus.Healthy, responseTime: elapsed() };
    }
    return {
      server,
      status: ServerStatus.Unhealthy,
      responseTime: elapsed(),
      error: `HTTP ${res.status}`,
    };
  } catch (error) {
    return {
      server,
      status: ServerStatus.Unhealthy,
      responseTime: elapsed(),
      error: describeError(error),
    };
  }
}

export function startHealthChecks(
  registry: ServerRegistry,
  healthLog: HealthLog,
  { intervalMs = 5000, timeoutMs = 500 }: HealthCheckOptions = {},
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const runRound = async () => {
    const servers = registry.getAllServers();
    // Check every server in parallel so one slow server doesn't delay the rest
    const results = await Promise.all(
      servers.map((s) => checkServer(s, timeoutMs)),
    );

    const ts = new Date().toISOString();
    const logEntries = [];

    for (const { server, status, responseTime, error } of results) {
      // Skips servers that were removed while the checks were in flight
      if (!registry.updateHealth(server.id, status, responseTime)) continue;

      logEntries.push({
        ts,
        serverId: server.id,
        serverName: server.serverName,
        ipAddress: server.ipAddress,
        status,
        responseTime,
        ...(error && { error }),
      });

      if (server.status !== status) {
        console.log(
          `[health]: ${server.serverName} (${server.ipAddress}) ${server.status} -> ${status} (${responseTime}ms${
            error ? `, ${error}` : ""
          })`,
        );
      }
    }

    healthLog.append(logEntries);
  };

  // Schedule the next round only after this one finishes, so rounds never overlap
  const loop = async () => {
    try {
      await runRound();
    } catch (error) {
      console.error("[health]: Health check round failed:", error);
    }
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };

  void loop();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
