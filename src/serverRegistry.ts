import { randomUUID } from "node:crypto";
import { LocalStore, ServerStatus, type BackendServer } from "./db.js";

export class DuplicateServerError extends Error {}

export class ServerRegistry {
  constructor(private store: LocalStore) {}

  getAllServers(): BackendServer[] {
    return this.store.read().servers;
  }

  addServer(serverName: string, ipAddress: string): BackendServer {
    const data = this.store.read();
    if (data.servers.some((s) => s.ipAddress === ipAddress)) {
      throw new DuplicateServerError(`Server ${ipAddress} already registered`);
    }
    // New servers get no traffic until they pass a health check
    const server: BackendServer = {
      id: randomUUID(),
      serverName,
      ipAddress,
      status: ServerStatus.Unknown,
      lastResponseTime: 0,
    };
    data.servers.push(server);
    this.store.write(data);
    return server;
  }

  removeServer(id: string): boolean {
    const data = this.store.read();
    const before = data.servers.length;
    data.servers = data.servers.filter((s) => s.id !== id);
    if (data.servers.length === before) return false;
    this.store.write(data);
    return true;
  }

  // Read-modify-write in one synchronous step so it can't clobber an
  // add/remove that happened while a health check was waiting on the network
  updateHealth(
    id: string,
    status: ServerStatus,
    responseTime: number,
  ): boolean {
    const data = this.store.read();
    const server = data.servers.find((s) => s.id === id);
    if (!server) return false;
    server.status = status;
    server.lastResponseTime = responseTime;
    this.store.write(data);
    return true;
  }
}
