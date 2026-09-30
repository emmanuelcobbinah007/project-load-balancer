import express from "express";
import { LocalStore } from "./db.js";
import { ServerRegistry } from "./serverRegistry.js";
import { ServerController } from "./controllers/serverController.js";
import { createServerRouter } from "./routes/serverRoutes.js";
import { startHealthChecks } from "./healthChecker.js";
import { HealthLog } from "./healthLog.js";
import { LeastConnectionsBalancer } from "./balancer/leastConnections.js";
import { PassiveHealthTracker } from "./balancer/passiveHealth.js";
import { createProxyHandler } from "./proxy.js";

const app = express();

const PORT = 3000;

let store: LocalStore;

// Initialize the local data store
try {
  store = new LocalStore();
  console.log("Local data store initialized successfully.");
} catch (error) {
  console.log("Error initializing local data store:", error);
  process.exit(1);
}

const registry = new ServerRegistry(store);
const healthLog = new HealthLog();
const balancer = new LeastConnectionsBalancer();
const passiveHealth = new PassiveHealthTracker(registry, healthLog);
const serverController = new ServerController(registry, balancer);

// Load balancer management API
app.use("/service", createServerRouter(serverController));

// Everything else is forwarded to a backend
app.use(createProxyHandler(registry, balancer, passiveHealth));

app.listen(PORT, () => {
  console.log(`[server]: Server is running at http://localhost:${PORT}`);
  startHealthChecks(registry, healthLog);
});
