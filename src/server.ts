import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActiveModel, AvailableModelsResult, ContextUsage, PiVotEvent, PiVotSnapshot } from "./pi-service.ts";
import { PiRuntimeRegistry } from "./runtime-registry.ts";
import { nodeVersionDecision } from "./runtime-policy.ts";
import {
  MAX_IMAGE_REQUEST_BODY_BYTES,
  parsePrompt,
  type ImageAttachment,
} from "./request.ts";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const staticRootCandidates = [resolve(moduleDirectory, "web"), resolve(moduleDirectory, "../web")];
const staticRoot = staticRootCandidates.find((candidate) => existsSync(resolve(candidate, "index.html"))) ??
  staticRootCandidates[0]!;
const staticAssets = new Map<string, { fileName: string; contentType: string }>([
  ["/", { fileName: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/index.html", { fileName: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/main.js", { fileName: "main.js", contentType: "text/javascript; charset=utf-8" }],
  ["/style.css", { fileName: "style.css", contentType: "text/css; charset=utf-8" }],
  ["/markdown-security.js", { fileName: "markdown-security.js", contentType: "text/javascript; charset=utf-8" }],
  ["/vendor/marked.umd.js", { fileName: "vendor/marked.umd.js", contentType: "text/javascript; charset=utf-8" }],
  ["/vendor/highlight.min.js", { fileName: "vendor/highlight.min.js", contentType: "text/javascript; charset=utf-8" }],
]);
export const DEFAULT_PORT = 17_361;
const securityHeaders = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "clipboard-read=(self), clipboard-write=(self), camera=(), microphone=(), geolocation=()",
} as const;

function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PI_VOT_PORT ?? DEFAULT_PORT);
}

export interface PiApplicationService {
  readonly state: string;
  snapshot(): PiVotSnapshot;
  subscribe(listener: (event: PiVotEvent) => void): () => void;
  sendMessage(
    message: string,
    messageId?: string,
    sessionId?: string,
    images?: ImageAttachment[],
  ): Promise<string>;
  abort(sessionId?: string): Promise<void>;
  compact(sessionId?: string): Promise<void>;
  refreshPersistedState?(): Promise<void>;
  switchSession?(sessionId: string): Promise<void>;
  wakeSession?(sessionId: string): Promise<void>;
  newSession?(): Promise<void>;
  renameSession?(sessionId: string, name: string): Promise<void>;
  deleteSession?(sessionId: string): Promise<void>;
  releaseRuntime?(sessionId: string): Promise<void>;
  changeProjectDirectory?(directory: string): Promise<void>;
  getAvailableModels?(sessionId: string): Promise<AvailableModelsResult>;
  changeModel?(sessionId: string, provider: string, modelId: string): Promise<{
    sessionId: string;
    model: ActiveModel | null;
    context: ContextUsage;
  }>;
}

async function readJson(request: IncomingMessage, maxBytes = 200_000): Promise<unknown> {
  let body = "";
  let bytesRead = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    bytesRead += Buffer.byteLength(chunk);
    if (bytesRead > maxBytes) {
      tooLarge = true;
      continue;
    }
    body += chunk.toString();
  }
  if (tooLarge) throw new Error("Request body is too large.");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function localAuthority(authority: string | undefined, port: number): boolean {
  if (!authority) return false;
  try {
    const parsed = new URL(`http://${authority}`);
    return (
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      (parsed.port || "80") === String(port) &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function localOrigin(origin: string, port: number): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      (parsed.port || "80") === String(port) &&
      !parsed.username &&
      !parsed.password &&
      parsed.origin === origin
    );
  } catch {
    return false;
  }
}

function rejectUnsafeMutation(request: IncomingMessage, response: ServerResponse, port: number): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress) || !localAuthority(request.headers.host, port)) {
    sendJson(response, 403, { error: "Requests must use Pi-vot's local address." });
    return true;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !localOrigin(origin, port)) {
    sendJson(response, 403, { error: "Requests must come from Pi-vot's local origin." });
    return true;
  }
  return false;
}

function isJsonRequest(request: IncomingMessage): boolean {
  return (request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function selectDirectory(): Promise<string | null> {
  const choices: Array<{ command: string; args: string[] }> = process.platform === "win32"
    ? [{
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-STA",
          "-Command",
          "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }",
        ],
      }]
    : process.platform === "darwin"
      ? [{ command: "osascript", args: ["-e", "POSIX path of (choose folder)"] }]
      : [
          { command: "zenity", args: ["--file-selection", "--directory", "--title=Choose a Pi-vot project"] },
          { command: "kdialog", args: ["--getexistingdirectory", ".", "--title", "Choose a Pi-vot project"] },
        ];

  const run = (index: number): Promise<string | null> => {
    const choice = choices[index];
    if (!choice) return Promise.reject(new Error("No native directory picker is available; enter the full path instead."));
    return new Promise((resolveChoice, rejectChoice) => {
      let output = "";
      let settled = false;
      const child = spawn(choice.command, choice.args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        if (error.code === "ENOENT" && process.platform !== "win32" && process.platform !== "darwin") {
          void run(index + 1).then(resolveChoice, rejectChoice);
        } else {
          rejectChoice(new Error(`Could not open the native directory picker: ${error.message}`));
        }
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        resolveChoice(code === 0 && output.trim() ? output.trim() : null);
      });
    });
  };
  return run(0);
}

async function requireJsonBody(request: IncomingMessage, response: ServerResponse): Promise<unknown | undefined> {
  if (!isJsonRequest(request)) {
    sendJson(response, 415, { error: "Content-Type must be application/json." });
    return undefined;
  }
  try {
    return await readJson(request);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid request body." });
    return undefined;
  }
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const asset = staticAssets.get(pathname);
  if (!asset) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const root = await realpath(staticRoot);
    const file = await realpath(resolve(root, asset.fileName));
    if (!file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, {
      "content-type": asset.contentType,
    });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end("Not found");
  }
}

async function validateRuntimeAssets(): Promise<void> {
  for (const asset of staticAssets.values()) {
    const file = resolve(staticRoot, asset.fileName);
    try {
      await readFile(file);
    } catch {
      throw new Error(`Required Pi-vot runtime asset is missing: ${asset.fileName} (looked under ${staticRoot}).`);
    }
  }
}

export function createPaneServer(service: PiApplicationService) {
  const clients = new Set<ServerResponse>();
  const history: Array<{ id: number; event: PiVotEvent }> = [];
  let sequence = 0;
  let disposed = false;

  function writeEvent(response: ServerResponse, event: unknown, id?: number): void {
    if (response.writableEnded) return;
    if (id !== undefined) response.write(`id: ${id}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = service.subscribe((event) => {
    const entry = { id: ++sequence, event };
    history.push(entry);
    if (history.length > 2_000) history.shift();
    for (const response of clients) writeEvent(response, event, entry.id);
  });

  function openEventStream(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    clients.add(response);
    const previousId = Number(request.headers["last-event-id"]);
    const oldestId = history[0]?.id ?? sequence + 1;
    if (Number.isSafeInteger(previousId) && previousId >= oldestId - 1 && previousId < sequence) {
      for (const entry of history) {
        if (entry.id > previousId) writeEvent(response, entry.event, entry.id);
      }
    }
    writeEvent(response, { type: "snapshot", ...service.snapshot() });
    response.write(": connected\n\n");
    const heartbeat = setInterval(() => response.write(": ping\n\n"), 20_000);
    heartbeat.unref();
    response.once("close", () => {
      clearInterval(heartbeat);
      clients.delete(response);
    });
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySecurityHeaders(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/events") {
      openEventStream(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/message") {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      if (rejectUnsafeMutation(request, response, port)) return;
      if (!isJsonRequest(request)) {
        sendJson(response, 415, { error: "Content-Type must be application/json." });
        return;
      }
      try {
        const contentLength = Number(request.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_REQUEST_BODY_BYTES) {
          request.resume();
          sendJson(response, 413, { error: "Request body is too large." });
          return;
        }
        const body = await readJson(request, MAX_IMAGE_REQUEST_BODY_BYTES);
        const { message, images } = parsePrompt(body);
        const requestedId = typeof body === "object" && body !== null && "messageId" in body &&
          typeof body.messageId === "string" && /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(body.messageId)
          ? body.messageId
          : undefined;
        const sessionId = typeof body === "object" && body !== null && "sessionId" in body &&
          typeof body.sessionId === "string" && body.sessionId
          ? body.sessionId
          : undefined;
        const messageId = requestedId ?? randomUUID();
        const disposition = await service.sendMessage(message, messageId, sessionId, images);
        sendJson(response, 202, { disposition, messageId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pi could not process the message.";
        const status = message === "Request body is too large."
          ? 413
          : message.startsWith("Enter a message") ||
          message.startsWith("Request body") ||
          message.startsWith("Messages must") ||
          message.startsWith("Image") ||
          message.startsWith("Unsupported image") ||
          message.startsWith("Total attachment") ||
          message.startsWith("Attach no more")
          ? 400
          : message.includes("already responding") || message.includes("stopping") ||
              message.includes("selected model does not support image input") ||
              message.includes("Four Pi sessions") || message.includes("active Pi runtime") ||
              message.includes("before starting another")
            ? 409
            : 500;
        sendJson(response, status, { error: message });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/stop") {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      if (rejectUnsafeMutation(request, response, port)) return;
      try {
        const body = isJsonRequest(request) ? await readJson(request) : undefined;
        const sessionId = typeof body === "object" && body !== null && "sessionId" in body &&
          typeof body.sessionId === "string" ? body.sessionId : undefined;
        await service.abort(sessionId);
        sendJson(response, 202, { ok: true });
      } catch (error) {
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : "Pi could not be stopped.",
        });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/compact") {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      if (rejectUnsafeMutation(request, response, port)) return;
      try {
        const body = isJsonRequest(request) ? await readJson(request) : undefined;
        const sessionId = typeof body === "object" && body !== null && "sessionId" in body &&
          typeof body.sessionId === "string" ? body.sessionId : undefined;
        await service.compact(sessionId);
        sendJson(response, 202, { ok: true });
      } catch (error) {
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : "Pi could not compact the session.",
        });
      }
      return;
    }
    if (request.method === "POST" && (url.pathname === "/api/models" || url.pathname === "/api/model")) {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      if (rejectUnsafeMutation(request, response, port)) return;
      const body = await requireJsonBody(request, response);
      if (body === undefined) return;
      const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      if (typeof payload.sessionId !== "string" || !payload.sessionId) {
        sendJson(response, 400, { error: "A Pi session ID is required." });
        return;
      }
      try {
        if (url.pathname === "/api/models") {
          if (!service.getAvailableModels) {
            sendJson(response, 501, { error: "This Pi service does not support model selection." });
            return;
          }
          sendJson(response, 200, await service.getAvailableModels(payload.sessionId));
          return;
        }
        if (typeof payload.provider !== "string" || !payload.provider || payload.provider.length > 256 ||
          typeof payload.modelId !== "string" || !payload.modelId || payload.modelId.length > 512) {
          sendJson(response, 400, { error: "A valid provider and model ID are required." });
          return;
        }
        if (!service.changeModel) {
          sendJson(response, 501, { error: "This Pi service does not support model selection." });
          return;
        }
        sendJson(response, 200, await service.changeModel(payload.sessionId, payload.provider, payload.modelId));
      } catch (error) {
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : "Pi-vot could not complete the model operation.",
        });
      }
      return;
    }
    const sessionActions: Record<string, keyof Pick<PiApplicationService,
      "refreshPersistedState" | "switchSession" | "wakeSession" | "newSession" | "renameSession" | "deleteSession" | "releaseRuntime" | "changeProjectDirectory">> = {
      "/api/sessions/refresh": "refreshPersistedState",
      "/api/sessions/new": "newSession",
      "/api/sessions/switch": "switchSession",
      "/api/sessions/wake": "wakeSession",
      "/api/sessions/rename": "renameSession",
      "/api/sessions/delete": "deleteSession",
      "/api/sessions/release": "releaseRuntime",
      "/api/project/select": "changeProjectDirectory",
    };
    if (request.method === "POST" && (Object.hasOwn(sessionActions, url.pathname) || url.pathname === "/api/project/pick")) {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      if (rejectUnsafeMutation(request, response, port)) return;
      if (url.pathname === "/api/project/pick") {
        try {
          const directory = await selectDirectory();
          sendJson(response, 200, { directory });
        } catch (error) {
          sendJson(response, 501, { error: error instanceof Error ? error.message : "No directory picker is available." });
        }
        return;
      }
      const body = await requireJsonBody(request, response);
      if (body === undefined) return;
      const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const action = sessionActions[url.pathname]!;
      const operation = service[action];
      if (!operation) {
        sendJson(response, 501, { error: "This Pi service does not support session management." });
        return;
      }
      try {
        if (action === "switchSession" || action === "wakeSession" ||
          action === "deleteSession" || action === "releaseRuntime") {
          if (typeof payload.sessionId !== "string" || !payload.sessionId.trim() ||
            payload.sessionId.length > 4_096) {
            sendJson(response, 400, { error: "A Pi session ID is required." });
            return;
          }
          if (action === "switchSession") await service.switchSession!(payload.sessionId);
          else if (action === "wakeSession") await service.wakeSession!(payload.sessionId);
          else if (action === "deleteSession") await service.deleteSession!(payload.sessionId);
          else await service.releaseRuntime!(payload.sessionId);
        } else if (action === "renameSession") {
          if (typeof payload.sessionId !== "string" || typeof payload.name !== "string") {
            sendJson(response, 400, { error: "A Pi session ID and name are required." });
            return;
          }
          await service.renameSession!(payload.sessionId, payload.name);
        } else if (action === "changeProjectDirectory") {
          if (typeof payload.directory !== "string" || !payload.directory.trim()) {
            sendJson(response, 400, { error: "A project directory is required." });
            return;
          }
          await service.changeProjectDirectory!(payload.directory);
        } else {
          if (action === "refreshPersistedState") await service.refreshPersistedState!();
          else await service.newSession!();
        }
        sendJson(response, 200, service.snapshot());
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pi-vot could not complete the session operation.";
        sendJson(response, message.startsWith("Select") || message.startsWith("Session names") ||
          message.startsWith("A Pi session") || message.startsWith("A project directory")
          ? 400
          : 409, { error: message });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, ...service.snapshot() });
      return;
    }

    if (request.method === "GET") {
      await serveStatic(url.pathname, response);
      return;
    }
    response.writeHead(404).end("Not found");
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      console.error("Request failed:", error);
      if (!response.headersSent) sendJson(response, 500, { error: "The server could not complete the request." });
      else response.end();
    });
  });

  return {
    server,
    closeEvents(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const response of clients) response.end();
      clients.clear();
    },
  };
}

async function main(): Promise<void> {
  const nodeDecision = nodeVersionDecision(
    process.versions.node,
    process.env.PI_VOT_ALLOW_UNSUPPORTED_NODE,
  );
  if (nodeDecision.status === "blocked") throw new Error(nodeDecision.error);
  if (nodeDecision.status === "allowed") console.error(nodeDecision.warning);
  await validateRuntimeAssets();
  const port = resolvePort();
  const pi = new PiRuntimeRegistry(process.cwd());
  await pi.initialize().catch((error: unknown) => {
    console.error(`Pi startup initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const app = createPaneServer(pi);
  app.server.listen(port, "127.0.0.1", () => {
    const address = app.server.address();
    const listeningPort = address && typeof address !== "string" ? address.port : port;
    console.log(`Pi-vot is running at http://127.0.0.1:${listeningPort}`);
  });

  let shutdown: Promise<void> | undefined;
  const close = () => {
    if (shutdown) return shutdown;
    shutdown = (async () => {
      const serverClosed = new Promise<void>((resolveClose) => {
        app.server.close(() => resolveClose());
      });
      app.closeEvents();
      await pi.stop();
      await serverClosed;
    })();
    return shutdown;
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  if (process.platform !== "win32") process.once("SIGHUP", () => void close());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
