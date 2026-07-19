import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export function loadHarnessDotenv(cwd = process.cwd()): void {
  dotenv.config({ path: path.join(cwd, ".env") });
  const localPath = path.join(cwd, ".env.local");
  if (existsSync(localPath)) {
    dotenv.config({ path: localPath, override: true });
  }
}
