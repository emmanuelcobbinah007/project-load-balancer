import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerStatus } from "./db.js";

export interface HealthLogEntry {
  ts: string;
  serverId: string;
  serverName: string;
  ipAddress: string;
  status: ServerStatus;
  responseTime: number;
  error?: string;
  // "active" = the health checker's /health probe,
  // "passive" = real traffic failing through the proxy
  source: "active" | "passive";
}

// Append-only JSON Lines log, one file per day (UTC):
// data/health-logs/health-2026-09-29.jsonl
export class HealthLog {
  private dir: string;

  constructor(dirName: string = "health-logs") {
    this.dir = path.join(process.cwd(), "data", dirName);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  append(entries: HealthLogEntry[]): void {
    if (entries.length === 0) return;

    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.dir, `health-${day}.jsonl`);
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

    try {
      fs.appendFileSync(file, lines, "utf-8");
    } catch (error) {
      console.error("Error writing health log:", error);
    }
  }
}
