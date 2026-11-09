import dns from "node:dns";
dns.setDefaultResultOrder?.("ipv4first");
import "./envcrypt.js";
import { config } from "./config.js";
import { pathToFileURL } from "node:url";
import path from "node:path";

export async function runScreeningCycle(options) {
  if (config.standalone.enabled) return "Standalone mode waits for fresh smart-wallet convergence. Broad screening is disabled.";
  return (await import("./legacy-index.js")).runScreeningCycle(options);
}
export async function runManagementCycle(options) {
  if (config.standalone.enabled) return (await import("./standalone/runtime.js")).manageOnce();
  return (await import("./legacy-index.js")).runManagementCycle(options);
}
export async function startCronJobs() {
  if (config.standalone.enabled) {
    const { startStandalone } = await import("./standalone/runtime.js");
    return startStandalone();
  }
  const { startLegacy } = await import("./legacy-index.js");
  return startLegacy();
}
export async function startLegacy() {
  const { startLegacy: runStartLegacy } = await import("./legacy-index.js");
  return runStartLegacy();
}
const entry = process.env.pm_exec_path || process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  if (config.standalone.enabled) {
    const { startStandalone } = await import("./standalone/runtime.js");
    await startStandalone();
  } else {
    // The legacy module detects its own filename; start explicitly via its exported launcher.
    const { startLegacy } = await import("./legacy-index.js");
    startLegacy();
  }
}
