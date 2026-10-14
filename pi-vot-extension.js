import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDefaultBrowser } from "./browser-launch.js";

const DEFAULT_PORT = 17_361;
const STARTUP_TIMEOUT_MS = 20_000;

function appUrl() {
  const port = Number(process.env.PI_VOT_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PI_VOT_PORT must be an integer between 1 and 65535 to launch Pi-vot from Pi.");
  }
  return `http://127.0.0.1:${port}`;
}

async function serverEntry(packageRoot) {
  const candidates = [
    { path: join(packageRoot, "app", "server.js"), source: false },
    { path: join(packageRoot, "src", "server.ts"), source: true },
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate.path);
      return candidate;
    } catch {}
  }
  throw new Error("This Pi-vot package has no runnable server entry point.");
}

async function isServerReady(url) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function launchPiVot() {
  const url = appUrl();
  if (await isServerReady(url)) {
    openDefaultBrowser(url);
    return url;
  }

  const packageRoot = dirname(fileURLToPath(import.meta.url));
  const entry = await serverEntry(packageRoot);
  const args = entry.source
    ? ["--experimental-strip-types", entry.path, "--production"]
    : [entry.path];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, PI_VOT_OPEN_BROWSER: "0" },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  let exitCode;
  let startupError;
  child.once("error", (error) => { startupError = error; });
  child.once("exit", (code) => { exitCode = code; });
  child.unref();

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isServerReady(url)) {
      openDefaultBrowser(url);
      return url;
    }
    if (startupError) throw new Error(`Could not start Pi-vot: ${startupError.message}`);
    if (exitCode !== undefined) throw new Error(`Pi-vot server exited during startup (code ${exitCode}).`);
    await delay(200);
  }
  throw new Error(`Pi-vot did not become ready within ${STARTUP_TIMEOUT_MS / 1000} seconds.`);
}

export default function registerPiVotExtension(pi) {
  pi.registerCommand("pi-vot", {
    description: "Launch the Pi-vot browser app",
    handler: async (_args, ctx) => {
      try {
        const url = await launchPiVot();
        ctx.ui.notify(`Pi-vot opened at ${url}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
