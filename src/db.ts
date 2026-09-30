import * as fs from "node:fs";
import * as path from "node:path";

export const ServerStatus = {
  Unknown: "unknown", // just added, not checked yet
  Healthy: "healthy",
  Unhealthy: "unhealthy",
} as const;

export type ServerStatus = (typeof ServerStatus)[keyof typeof ServerStatus];

export interface BackendServer {
  id: string;
  serverName: string;
  ipAddress: string;
  status: ServerStatus;
  lastResponseTime: number;
}

export interface DatabaseSchema {
  servers: BackendServer[];
}

const DEFAULT_DATA: DatabaseSchema = {
  servers: [],
};

export class LocalStore {
  private filePath: string;

  constructor(fileName: string = "data.json") {
    const dataDir = path.join(process.cwd(), "data");

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.filePath = path.join(dataDir, fileName);
    this.initializeStore();
  }

  private initializeStore(): void {
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(DEFAULT_DATA, null, 2),
        "utf-8",
      );
      return;
    }
    this.migrateLegacyRecords();
  }

  // Older records stored health as `isActiveStatus: boolean`. Convert them to
  // `status: "unknown"`; the next health check round fills in the real value.
  private migrateLegacyRecords(): void {
    const data = this.read();
    let changed = false;

    for (const server of data.servers as Array<
      BackendServer & { isActiveStatus?: boolean }
    >) {
      if ("isActiveStatus" in server) {
        delete server.isActiveStatus;
        changed = true;
      }
      if (!server.status) {
        server.status = ServerStatus.Unknown;
        changed = true;
      }
    }

    if (changed) this.write(data);
  }

  public read(): DatabaseSchema {
    try {
      const rawData = fs.readFileSync(this.filePath, "utf-8");
      return JSON.parse(rawData) as DatabaseSchema;
    } catch (error) {
      console.error("Error reading local data store:", error);
      return { servers: [] };
    }
  }

  public write(data: DatabaseSchema): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (error) {
      console.error("Error writing to local data store:", error);
    }
  }
}
