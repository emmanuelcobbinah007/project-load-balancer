import * as http from "node:http";
import type { Request, Response } from "express";
import type { LeastConnectionsBalancer } from "./balancer/leastConnections.js";
import type { PassiveHealthTracker } from "./balancer/passiveHealth.js";
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

// Methods that don't change anything on the server, so sending one twice is harmless
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Bodies are streamed straight through without keeping a copy, so a request
// with a body can only ever be sent once
function hasBody(req: Request): boolean {
  const length = req.headers["content-length"];
  return (
    (length !== undefined && length !== "0") ||
    req.headers["transfer-encoding"] !== undefined
  );
}

const UPSTREAM_TIMEOUT = "Upstream timeout";

function describeError(error: Error): string {
  return (error as NodeJS.ErrnoException).code ?? error.message;
}

interface ProxyOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

export function createProxyHandler(
  registry: ServerRegistry,
  balancer: LeastConnectionsBalancer,
  passiveHealth: PassiveHealthTracker,
  { timeoutMs = 30_000, maxRetries = 1 }: ProxyOptions = {},
) {
  return (req: Request, res: Response) => {
    const canRetry = RETRYABLE_METHODS.has(req.method) && !hasBody(req);
    const triedServerIds = new Set<string>();
    let lastFailure = "";
    let clientGone = false;

    // The attempt currently in flight, so the client's `close` handler below
    // can release its job and cancel it
    let current: { proxyReq: http.ClientRequest; release: () => void } | undefined;

    // Tell the backend who the original client was; to the backend, every
    // request otherwise looks like it came from the load balancer
    const clientIp = req.socket.remoteAddress ?? "unknown";
    const priorHops = req.headers["x-forwarded-for"];
    const headers = stripHopByHop(req.headers);
    headers["x-forwarded-for"] = priorHops
      ? `${[priorHops].flat().join(", ")}, ${clientIp}`
      : clientIp;

    // `close` fires exactly once per client response: when it finished, when
    // we cut it off, or when the client hung up
    res.on("close", () => {
      clientGone = !res.writableFinished;
      current?.release();
      if (clientGone) current?.proxyReq.destroy();
    });

    const sendUpstreamError = () => {
      if (lastFailure === UPSTREAM_TIMEOUT) {
        res.status(504).json({ error: "Upstream server timed out." });
      } else {
        res.status(502).json({ error: "Upstream server unavailable." });
      }
    };

    const attempt = () => {
      const server = balancer.pick(
        registry.getAllServers().filter((s) => !triedServerIds.has(s.id)),
      );

      if (!server) {
        if (triedServerIds.size === 0) {
          return res.status(503).json({ error: "No healthy servers available." });
        }
        // Retries allowed, but no healthy server left that we haven't tried
        return sendUpstreamError();
      }

      triedServerIds.add(server.id);
      balancer.acquire(server.id);

      // Each attempt releases its job exactly once, whichever way it ends
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        balancer.release(server.id);
      };

      const start = performance.now();

      // Handles every way this attempt can fail. Returns false if the failure
      // was already handled, or if we caused it ourselves because the client left.
      let failed = false;
      const fail = (reason: string): boolean => {
        release();
        if (failed || clientGone) return false;
        failed = true;
        lastFailure = reason;

        console.error(
          `[proxy]: ${req.method} ${req.originalUrl} -> ${server.serverName} failed: ${reason}`,
        );
        passiveHealth.recordFailure(
          server,
          reason,
          Math.round(performance.now() - start),
        );
        return true;
      };

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
          // Any response, even a 500, proves the server is reachable
          passiveHealth.recordSuccess(server.id);

          res.writeHead(proxyRes.statusCode ?? 502, stripHopByHop(proxyRes.headers));
          proxyRes.pipe(res);

          // If the backend dies halfway through the body, `pipe` doesn't notice
          // and the client would wait forever. `complete` is only true once
          // the whole response has arrived.
          proxyRes.on("error", () => {}); // handled by `close` below
          proxyRes.on("close", () => {
            if (proxyRes.complete) return;
            if (fail("response cut off")) res.destroy();
          });
        },
      );
      current = { proxyReq, release };

      proxyReq.setTimeout(timeoutMs, () => {
        proxyReq.destroy(new Error(UPSTREAM_TIMEOUT));
      });

      proxyReq.on("error", (error) => {
        if (!fail(describeError(error))) return;

        if (res.headersSent) {
          // Already streaming this backend's response; nothing to do but cut it off
          res.destroy();
        } else if (canRetry && triedServerIds.size <= maxRetries) {
          console.log(`[proxy]: retrying ${req.method} ${req.originalUrl} on another server`);
          attempt();
        } else {
          sendUpstreamError();
        }
      });

      if (hasBody(req)) {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    };

    attempt();
  };
}
