// A tiny stand-in backend for testing the load balancer.
// Usage: npm run backend -- 5001
import express from "express";
import type { Request, Response } from "express";

const PORT = Number(process.argv[2] ?? 5001);
const NAME = `backend-${PORT}`;

const app = express();

app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.get("/", (req: Request, res: Response) => {
  res.json({
    message: `Hello from ${NAME}`,
    forwardedFor: req.headers["x-forwarded-for"] ?? null,
  });
});

// Simulates a slow job, e.g. GET /slow?ms=3000
app.get("/slow", (req: Request, res: Response) => {
  const ms = Number(req.query.ms ?? 3000);
  setTimeout(() => {
    res.json({ message: `${NAME} finished a ${ms}ms job` });
  }, ms);
});

// Simulates a crash halfway through a response: sends the headers and part of
// the body, then drops the connection
app.get("/broken", (req: Request, res: Response) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.write(`${NAME} started a response... `);
  setTimeout(() => res.socket?.destroy(), 100);
});

app.listen(PORT, () => {
  console.log(`[${NAME}]: listening on http://localhost:${PORT}`);
});
