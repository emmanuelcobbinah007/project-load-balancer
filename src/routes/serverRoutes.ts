import express, { Router } from "express";
import type { ServerController } from "../controllers/serverController.js";

export function createServerRouter(controller: ServerController): Router {
  const router = Router();

  // Only the load balancer's own API parses JSON bodies; proxied requests
  // must reach the backends with their body untouched
  router.use(express.json());

  router.get("/stats", controller.getStats);
  router.post("/add-server", controller.addServer);
  router.delete("/remove-server/:id", controller.removeServer);

  // /service/* belongs to the load balancer, so unknown paths here are a 404
  // rather than falling through to the proxy
  router.use((req, res) => {
    res.status(404).json({ error: `Unknown endpoint ${req.method} ${req.originalUrl}` });
  });

  return router;
}
