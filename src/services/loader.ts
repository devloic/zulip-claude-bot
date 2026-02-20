import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Service, ServiceContext } from "./types.js";

const SKIP_FILES = new Set(["types.ts", "types.js", "loader.ts", "loader.js"]);

/** Services that are currently active (populated after loadServices). */
export const activeServices: Service[] = [];

/**
 * Discover and load all services from the services directory.
 * Each service file must `export default` a Service object.
 *
 * Services are enabled/disabled via `SERVICE_{NAME}` env vars
 * (e.g. SERVICE_TASKS=false). Falls back to service.defaultEnabled.
 */
export async function loadServices(
  ctx: ServiceContext,
): Promise<Service[]> {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const files = await readdir(dir);

  activeServices.length = 0;

  // First pass: load and register all services (so metadata is available)
  const pending: Array<{ service: Service; file: string }> = [];

  for (const file of files) {
    if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
    if (SKIP_FILES.has(file)) continue;

    try {
      const mod = await import(join(dir, file));
      const service: Service | undefined = mod.default;

      if (!service || !service.name) {
        console.warn(`  [services] ${file}: no default Service export, skipping`);
        continue;
      }

      const envKey = `SERVICE_${service.name.toUpperCase().replace(/-/g, "_")}`;
      const envVal = process.env[envKey];
      const enabled =
        envVal !== undefined
          ? envVal.toLowerCase() !== "false" && envVal !== "0"
          : service.defaultEnabled;

      if (!enabled) {
        console.log(`  [${service.name}] disabled (${envKey}=false)`);
        continue;
      }

      activeServices.push(service);
      pending.push({ service, file });
    } catch (err) {
      console.error(`  [services] failed to load ${file}:`, err);
    }
  }

  // Second pass: initialize (activeServices is already populated)
  for (const { service } of pending) {
    try {
      if (service.init) {
        await service.init(ctx);
      }
      console.log(`  [${service.name}] ${service.description}`);
    } catch (err) {
      console.error(`  [services] failed to init ${service.name}:`, err);
    }
  }

  return [...activeServices];
}

export type { Service, ServiceContext };
