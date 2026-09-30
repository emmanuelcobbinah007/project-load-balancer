import type { Request, Response } from "express";
import type { LeastConnectionsBalancer } from "../balancer/leastConnections.js";
import {
  DuplicateServerError,
  type ServerRegistry,
} from "../serverRegistry.js";

export class ServerController {
  constructor(
    private registry: ServerRegistry,
    private balancer: LeastConnectionsBalancer,
  ) {}

  getStats = (req: Request, res: Response) => {
    const servers = this.registry.getAllServers().map((s) => ({
      ...s,
      activeJobs: this.balancer.getActiveJobs(s.id),
    }));
    res.status(200).json({ servers });
  };

  // Arrow functions keep `this` bound when Express calls them as route handlers
  addServer = (req: Request, res: Response) => {
    const { serverName, ipAddress } = req.body ?? {};

    if (
      typeof serverName !== "string" ||
      serverName.trim() === "" ||
      typeof ipAddress !== "string" ||
      ipAddress.trim() === ""
    ) {
      return res.status(400).json({
        error: "Invalid request body. Please provide serverName and ipAddress.",
      });
    }

    try {
      const newServer = this.registry.addServer(
        serverName.trim(),
        ipAddress.trim(),
      );
      res
        .status(201)
        .json({ message: "Server added successfully.", server: newServer });
    } catch (error) {
      if (error instanceof DuplicateServerError) {
        return res.status(409).json({ error: error.message });
      }
      console.error("Error adding server:", error);
      res.status(500).json({ error: "Failed to add server." });
    }
  };

  removeServer = (req: Request<{ id: string }>, res: Response) => {
    const { id } = req.params;

    try {
      if (!this.registry.removeServer(id)) {
        return res.status(404).json({ error: `Server ${id} not found.` });
      }
      res.status(200).json({ message: "Server removed successfully." });
    } catch (error) {
      console.error("Error removing server:", error);
      res.status(500).json({ error: "Failed to remove server." });
    }
  };
}
