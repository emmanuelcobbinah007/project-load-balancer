import * as http from "node:http";
import type { Request, Response } from "express";
import type { LeastConnectionsBalancer } from "./balancer/leastConnections.js";
import type { ServerRegistry } from "./serverRegistry.js";

// Headers that describe a single connection, not the request itself, so they
// must not be passed along to the next hop
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function stripHopByHop<T extends Record<string, unknown>>(headers: T): T {
  const copy = { ...headers };
  for (const name of HOP_BY_HOP_HEADERS) delete copy[name];
  return copy;
}

interface ProxyOptions {
  timeoutMs?: number;
}

export function createProxyHandler(
  registry: ServerRegistry,
  balancer: LeastConnectionsBalancer,
  { timeoutMs = 30_000 }: ProxyOptions = {},
) {
  return (req: Request, res: Response) => {
    const server = balancer.pick(registry.getAllServers());
    if (!server) {
      return res.status(503).json({ error: "No healthy servers available." });
    }

    balancer.acquire(server.id);

    // Tell the backend who the original client was; to the backend, every
    // request otherwise looks like it came from the load balancer
    const clientIp = req.socket.remoteAddress ?? "unknown";
    const priorHops = req.headers["x-forwarded-for"];
    const headers = stripHopByHop(req.headers);
    headers["x-forwarded-for"] = priorHops
      ? `${[priorHops].flat().join(", ")}, ${clientIp}`
      : clientIp;

    const target = new URL(`http://${server.ipAddress}`);
    const proxyReq = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.originalUrl,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, stripHopByHop(proxyRes.headers));
        proxyRes.pipe(res);
      },
    );

    // `close` fires exactly once per response: when it finished, failed, or
    // the client hung up. That makes it the one place to release the job.
    res.on("close", () => {
      balancer.release(server.id);
      if (!res.writableFinished) proxyReq.destroy(); // client left early
    });

    proxyReq.setTimeout(timeoutMs, () => {
      proxyReq.destroy(new Error("Upstream timeout"));
    });

    proxyReq.on("error", (error) => {
      console.error(
        `[proxy]: ${req.method} ${req.originalUrl} -> ${server.serverName} failed:`,
        error.message,
      );
      if (res.headersSent) {
        res.destroy(); // already streaming the backend's response; just cut it off
      } else if (error.message === "Upstream timeout") {
        res.status(504).json({ error: "Upstream server timed out." });
      } else {
        res.status(502).json({ error: "Upstream server unavailable." });
      }
    });

    req.pipe(proxyReq);
  };
}
