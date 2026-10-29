import { readFileSync } from "node:fs";

/**
 * The version reported by GET /health.
 *
 * package.json is read at runtime so the compiled output in `dist/` and the
 * TypeScript source both resolve the same file (see `../../package.json`).
 */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "version" in parsed) {
      const version: unknown = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) {
        return version;
      }
    }
    return "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const APP_VERSION: string = readVersion();
