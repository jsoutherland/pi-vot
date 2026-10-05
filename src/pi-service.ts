import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { ImageAttachment } from "./request.ts";

type RunState = "idle" | "running" | "stopping" | "failed";
type PromptDisposition = "started" | "queued" | "handled" | "steered";

export interface PiDiscoveryContext {
  env: NodeJS.ProcessEnv;
  home: string;
}

export function capturePiDiscoveryContext(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): PiDiscoveryContext {
  return { env: { ...env }, home };
}

type PiVotEventPayload =
  | { type: "session_snapshot"; snapshot: PiVotSnapshot }
  | { type: "state"; state: RunState; error?: string }
  | { type: "context_update"; context: ContextUsage }
  | { type: "model_update"; model: ActiveModel | null }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; success: boolean; aborted: boolean; error?: string; informational?: boolean }
  | { type: "queued_message"; id: string; message: string; imageCount?: number }
  | { type: "queued_message_sent"; id: string; disposition: PromptDisposition }
  | { type: "queued_message_failed"; id: string; error: string }
  | { type: "assistant_start"; messageId: string }
  | { type: "assistant_delta"; messageId: string; text: string }
  | { type: "thinking_delta"; messageId: string; text: string }
  | { type: "assistant_end"; messageId: string; text: string; thinking: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; input: string }
  | { type: "tool_update"; toolCallId: string; output: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; output: string; isError: boolean }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "input_disposition"; disposition: PromptDisposition };

export type PiVotEvent = PiVotEventPayload & { sessionId?: string };

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

function messageImageCount(value: unknown): number {
  return Array.isArray(value)
    ? value.filter((item) => asRecord(item)?.type === "image").length
    : 0;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const block = asRecord(item);
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function sessionPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "Untitled session";
  return compact.length > 84 ? `${compact.slice(0, 81)}…` : compact;
}

export function piSessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-")}--`;
}

async function readSessionDirSetting(file: string): Promise<string | undefined> {
  try {
    const contents = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
    const settings = asRecord(JSON.parse(contents));
    return typeof settings?.sessionDir === "string" ? settings.sessionDir : undefined;
  } catch {
    return undefined;
  }
}

function resolvePiPath(value: string, cwd: string, home: string): string {
  const expanded = value === "~"
    ? home
    : value.startsWith("~/") || value.startsWith("~\\")
    ? join(home, value.slice(2))
    : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export async function resolvePiSessionDirectory(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<string> {
  const agentDir = resolvePiPath(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), cwd, home);
  const configuredSessionDir = env.PI_CODING_AGENT_SESSION_DIR;
  if (configuredSessionDir) return resolvePiPath(configuredSessionDir, cwd, home);

  const [globalSessionDir, projectSessionDir] = await Promise.all([
    readSessionDirSetting(join(agentDir, "settings.json")),
    readSessionDirSetting(join(cwd, ".pi", "settings.json")),
  ]);
  const sessionDir = projectSessionDir ?? globalSessionDir;
  if (sessionDir) return resolvePiPath(sessionDir, cwd, home);
  return join(agentDir, "sessions", piSessionDirectoryName(cwd));
}

async function configuredSessionDirectories(
  cwd: string,
  env: NodeJS.ProcessEnv,
  home: string,
  knownCwds: string[],
): Promise<string[]> {
  const agentDir = resolvePiPath(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), cwd, home);
  const [globalSessionDir, projectSessionDirs] = await Promise.all([
    readSessionDirSetting(join(agentDir, "settings.json")),
    Promise.all([...new Set([cwd, ...knownCwds])].map(async (projectCwd) => {
      const sessionDir = await readSessionDirSetting(join(projectCwd, ".pi", "settings.json"));
      return sessionDir ? resolvePiPath(sessionDir, projectCwd, home) : undefined;
    })),
  ]);
  const values = [
    join(agentDir, "sessions"),
    env.PI_CODING_AGENT_SESSION_DIR,
    globalSessionDir,
    ...projectSessionDirs,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(values.map((value) => resolvePiPath(value, cwd, home)))];
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isWithin(directory: string, file: string): boolean {
  const relative = file.slice(directory.length).replace(/^[/\\]/, "");
  return file.startsWith(`${directory}${sep}`) && relative.length > 0 && !relative.startsWith(`..${sep}`);
}

const SESSION_METADATA_SCAN_LIMIT = 256 * 1024;
const SESSION_METADATA_TAIL_LIMIT = 64 * 1024;

async function readSessionMetadata(file: string): Promise<{
  header?: SessionHeader;
  name: string | null;
  firstUserMessage: string;
}> {
  let header: SessionHeader | undefined;
  let name: string | null = null;
  let firstUserMessage = "";
  let bytesRead = 0;
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      bytesRead += Buffer.byteLength(line) + 1;
      if (!line) continue;
      let record: SessionRecord;
      try {
        record = JSON.parse(line) as SessionRecord;
      } catch {
        continue;
      }
      if (!header && record.type === "session") {
        header = record as SessionHeader;
      } else if (record.type === "session_info" && typeof record.name === "string" && record.name.trim()) {
        name = record.name.trim();
      } else if (!firstUserMessage && record.type === "message" && record.message?.role === "user") {
        firstUserMessage = messageText(record.message.content);
      }
      if (bytesRead >= SESSION_METADATA_SCAN_LIMIT) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  const fileInfo = await stat(file);
  if (fileInfo.size > SESSION_METADATA_SCAN_LIMIT) {
    const tail = createReadStream(file, {
      encoding: "utf8",
      start: Math.max(0, fileInfo.size - SESSION_METADATA_TAIL_LIMIT),
    });
    const tailLines = createInterface({ input: tail, crlfDelay: Infinity });
    try {
      for await (const line of tailLines) {
        try {
          const record = JSON.parse(line) as SessionRecord;
          if (record.type === "session_info" && typeof record.name === "string" && record.name.trim()) {
            name = record.name.trim();
          } else if (!firstUserMessage && record.type === "message" && record.message?.role === "user") {
            firstUserMessage = messageText(record.message.content);
          }
        } catch {
          continue;
        }
      }
    } finally {
      tailLines.close();
      tail.destroy();
    }
  }
  return { header, name, firstUserMessage };
}

async function scanSessionDirectory(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    else if (entry.isDirectory()) {
      const children = await readdir(path, { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        if (child.isFile() && child.name.endsWith(".jsonl")) files.push(resolve(path, child.name));
      }
    }
  }
  return files;
}

export async function discoverPiSessions(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  extraDirectories: string[] = [],
  knownCwds: string[] = [cwd],
): Promise<PiSession[]> {
  const directories = [...new Set([
    ...await configuredSessionDirectories(cwd, env, home, knownCwds),
    ...extraDirectories.map((directory) => resolve(directory)),
  ])];
  const pendingDirectories = [...directories];
  const scannedDirectories = new Set<string>();
  const scannedFiles = new Set<string>();
  const sessions = new Map<string, PiSession>();
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.shift()!;
    const normalizedDirectory = process.platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory);
    if (scannedDirectories.has(normalizedDirectory)) continue;
    scannedDirectories.add(normalizedDirectory);
    for (const file of await scanSessionDirectory(directory)) {
      const normalizedFile = process.platform === "win32" ? file.toLowerCase() : file;
      if (scannedFiles.has(normalizedFile)) continue;
      scannedFiles.add(normalizedFile);
      try {
        const metadata = await readSessionMetadata(file);
        const actualCwd = metadata.header?.cwd;
        if (typeof actualCwd !== "string" || !actualCwd) continue;
        const fileInfo = await stat(file);
        sessions.set(file, {
          id: file,
          cwd: actualCwd,
          name: metadata.name,
          preview: sessionPreview(metadata.firstUserMessage || file.slice(file.lastIndexOf(sep) + 1).replace(/\.jsonl$/, "")),
          updatedAt: fileInfo.mtime.toISOString(),
        });
        const projectSpecific = await readSessionDirSetting(join(actualCwd, ".pi", "settings.json"));
        if (projectSpecific) pendingDirectories.push(resolvePiPath(projectSpecific, actualCwd, home));
      } catch {
        continue;
      }
    }
  }
  return [...sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function hydratePiSession(session: PiSession): Promise<{
  session: PiSession;
  transcript: TranscriptItem[];
  model: ActiveModel | null;
}> {
  const lines = createInterface({
    input: createReadStream(session.id, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const messages: unknown[] = [];
  let header: SessionHeader | undefined;
  let name = session.name;
  let model: ActiveModel | null = null;
  try {
    for await (const line of lines) {
      if (!line) continue;
      let record: SessionRecord;
      try {
        record = JSON.parse(line) as SessionRecord;
      } catch {
        continue;
      }
      if (!header && record.type === "session") {
        header = record as SessionHeader;
      } else if (record.type === "session_info" && typeof record.name === "string" && record.name.trim()) {
        name = record.name.trim();
      } else if (record.type === "message" && record.message) {
        messages.push(record.message);
        if (record.message.role === "assistant") {
          const provider = typeof record.message.provider === "string" ? record.message.provider : "";
          const id = typeof record.message.model === "string" ? record.message.model : "";
          if (provider && id) {
            model = {
              provider,
              id,
              name: id,
              ...(isFiniteNumber(record.message.contextWindow) && record.message.contextWindow > 0
                ? { contextWindow: record.message.contextWindow }
                : {}),
            };
          }
        }
      }
    }
  } finally {
    lines.close();
  }
  const fileInfo = await stat(session.id);
  return {
    session: {
      ...session,
      cwd: typeof header?.cwd === "string" ? header.cwd : session.cwd,
      name,
      updatedAt: fileInfo.mtime.toISOString(),
    },
    transcript: normalizeTranscript(messages),
    model,
  };
}

export interface ActiveModel {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  input?: string[];
}

export interface AvailableModelsResult {
  sessionId: string;
  hasRuntime: boolean;
  model: ActiveModel | null;
  models: ActiveModel[];
  canChange: boolean;
  message?: string;
}

export interface PiVotSnapshot {
  state: RunState;
  isCompacting: boolean;
  context: ContextUsage;
  model: ActiveModel | null;
  queuedMessages: Array<{ id: string; message: string; imageCount?: number }>;
  projectDirectory: string;
  activeSessionId: string | null;
  selectedSessionId?: string | null;
  activeSessionName: string | null;
  sessions: PiSession[];
  transcript: TranscriptItem[];
  status?: { kind: "notice" | "error" | "compaction"; message: string } | null;
}

export interface PiSession {
  id: string;
  cwd: string;
  name: string | null;
  preview: string;
  updatedAt: string;
  model?: ActiveModel | null;
  active?: boolean;
  hasRuntime?: boolean;
}

export type TranscriptItem =
  | { id: string; type: "user"; text: string; imageCount?: number }
  | { id: string; type: "assistant" | "custom"; text: string; thinking?: string }
  | {
      id: string;
      type: "tool";
      toolCallId: string;
      toolName: string;
      input: string;
      output: string;
      isError: boolean;
    };

interface SessionHeader {
  id?: string;
  cwd?: string;
}

interface SessionRecord {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: RpcRecord;
  name?: string;
}

interface RpcRecord {
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (record: RpcRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface AssistantMessageState {
  messageId: string;
  text: string;
  thinking: string;
}

interface QueuedMessage {
  id: string;
  message: string;
  images: ImageAttachment[];
}

type SpawnPi = (cwd: string) => ChildProcessWithoutNullStreams;

const MAX_COMPACTION_QUEUE = 100;
const MAX_QUEUED_IMAGE_BYTES = 40 * 1024 * 1024;
const COMPACTION_STATE_RECHECK_MS = 250;
const COMPACT_RPC_TIMEOUT_MS = 120_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function modelFrom(value: unknown): ActiveModel | null {
  const record = asRecord(value);
  if (!record) return null;
  const provider = typeof record.provider === "string" ? record.provider : "";
  const id = typeof record.id === "string" ? record.id : "";
  if (!provider || !id) return null;
  return {
    provider,
    id,
    name: typeof record.name === "string" && record.name ? record.name : id,
    ...(isFiniteNumber(record.contextWindow) && record.contextWindow > 0
      ? { contextWindow: record.contextWindow }
      : {}),
    ...(Array.isArray(record.input) && record.input.every((item) => typeof item === "string")
      ? { input: [...record.input] as string[] }
      : {}),
  };
}

function contextFrom(value: unknown): ContextUsage {
  const context = asRecord(value);
  if (!context) return { tokens: null, contextWindow: null, percent: null };
  return {
    tokens: isFiniteNumber(context.tokens) && context.tokens >= 0 ? context.tokens : null,
    contextWindow: isFiniteNumber(context.contextWindow) && context.contextWindow > 0
      ? context.contextWindow
      : null,
    percent: isFiniteNumber(context.percent) && context.percent >= 0 ? context.percent : null,
  };
}

function asRecord(value: unknown): RpcRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RpcRecord)
    : undefined;
}

function isNothingToCompactError(error: string): boolean {
  return /\bnothing\s+to\s+compact\s*\(\s*session\s+too\s+small\s*\)(?![a-z])/i.test(error);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const block = asRecord(item);
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        if (block?.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function messageContent(message: unknown, contentType: "text" | "thinking"): string {
  const record = asRecord(message);
  if (!record || !Array.isArray(record.content)) return "";
  return record.content
    .filter((item) => asRecord(item)?.type === contentType)
    .map((item) => {
      const block = asRecord(item);
      return typeof block?.[contentType] === "string" ? (block[contentType] as string) : "";
    })
    .join("");
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function normalizeTranscript(messages: unknown[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { type: "tool" }>>();
  messages.forEach((value, index) => {
    const message = asRecord(value);
    if (!message) return;
    const role = message.role;
    const id = typeof message.id === "string" ? message.id : `history-${index}`;
    if (role === "user") {
      const text = messageText(message.content);
      const imageCount = messageImageCount(message.content);
      if (text || imageCount > 0) {
        items.push({ id, type: "user", text, ...(imageCount > 0 ? { imageCount } : {}) });
      }
    } else if (role === "assistant") {
      const text = messageContent(message, "text");
      const thinking = messageContent(message, "thinking");
      if (text || thinking) items.push({ id, type: "assistant", text, ...(thinking ? { thinking } : {}) });
      if (Array.isArray(message.content)) {
        for (const blockValue of message.content) {
          const block = asRecord(blockValue);
          if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
          const tool: Extract<TranscriptItem, { type: "tool" }> = {
            id: `tool-${block.id}`,
            type: "tool",
            toolCallId: block.id,
            toolName: typeof block.name === "string" ? block.name : "tool",
            input: json(block.arguments ?? {}),
            output: "",
            isError: false,
          };
          tools.set(block.id, tool);
          items.push(tool);
        }
      }
    } else if (role === "toolResult" && typeof message.toolCallId === "string") {
      const tool = tools.get(message.toolCallId);
      if (tool) {
        tool.output = messageText(message.content);
        tool.isError = message.isError === true;
      } else {
        items.push({
          id,
          type: "tool",
          toolCallId: message.toolCallId,
          toolName: typeof message.toolName === "string" ? message.toolName : "tool",
          input: "",
          output: messageText(message.content),
          isError: message.isError === true,
        });
      }
    } else if (role === "custom") {
      const text = messageText(message.content);
      if (text) items.push({ id, type: "custom", text });
    }
  });
  return items;
}

export class PiService {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private output = "";
  private discardingOversizedLine = false;
  private requestId = 0;
  private messageId = 0;
  private lifecycleVersion = 0;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<(event: PiVotEvent) => void>();
  private exitedChildren = new WeakSet<object>();
  private sendChain: Promise<void> = Promise.resolve();
  private runState: RunState = "idle";
  private compacting = false;
  private compactionGeneration = 0;
  private compactionFinishing = false;
  private compactionRetryPending = false;
  private compactionAttemptActive = false;
  private compactTimeoutRequiresObservedStart = false;
  private observedCompactionActive = false;
  private compactionMonitor?: Promise<void>;
  private pendingCompactionOutcome?: { success: boolean; aborted: boolean; error?: string };
  private compactionCompletionEvent = false;
  private initialization?: Promise<void>;
  private context: ContextUsage = { tokens: null, contextWindow: null, percent: null };
  private model: ActiveModel | null = null;
  private piStateRefreshVersion = 0;
  private contextRefreshVersion = 0;
  private queuedMessages: QueuedMessage[] = [];
  private drainingQueue = false;
  private currentAssistant?: AssistantMessageState;
  private pendingPrompt = false;
  private sessionOperation = false;
  private modelChangeInProgress = false;
  private processError?: string;
  private closing = false;
  private closed = false;
  private cwd: string;
  private readonly spawnPi: SpawnPi;
  private readonly compactTimeoutMs: number;
  private readonly discoveryContext: PiDiscoveryContext;
  private activeSessionId: string | null = null;
  private activeSessionName: string | null = null;
  private sessionFile: string | null = null;
  private sessionDirectory: string | null = null;
  private sessions: PiSession[] = [];
  private transcript: TranscriptItem[] = [];
  private status: PiVotSnapshot["status"] = null;

  constructor(
    cwd = process.cwd(),
    spawnPi: SpawnPi = (directory) =>
      spawn("pi", ["--mode", "rpc"], {
        cwd: directory,
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    compactTimeoutMs = COMPACT_RPC_TIMEOUT_MS,
    discoveryContext?: PiDiscoveryContext,
  ) {
    this.cwd = cwd;
    this.spawnPi = spawnPi;
    this.compactTimeoutMs = compactTimeoutMs;
    this.discoveryContext = capturePiDiscoveryContext(
      discoveryContext?.env,
      discoveryContext?.home,
    );
  }

  get state(): RunState {
    return this.runState;
  }

  get canChangeModel(): boolean {
    return this.runState === "idle" && !this.compacting && !this.pendingPrompt &&
      !this.sessionOperation && !this.modelChangeInProgress && this.queuedMessages.length === 0;
  }

  snapshot(): PiVotSnapshot {
    return {
      state: this.runState,
      isCompacting: this.compacting,
      context: { ...this.context },
      model: this.model ? { ...this.model } : null,
      queuedMessages: this.queuedMessages.map(({ id, message, images }) => ({
        id,
        message,
        ...(images.length ? { imageCount: images.length } : {}),
      })),
      projectDirectory: this.cwd,
      activeSessionId: this.activeSessionId,
      activeSessionName: this.activeSessionName,
      sessions: this.sessions.map((session) => ({ ...session })),
      transcript: this.transcript.map((item) => ({ ...item })),
      status: this.status ? { ...this.status } : null,
    };
  }

  subscribe(listener: (event: PiVotEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await this.start();
    await this.initializeRpcState();
    await this.refreshPersistedState();
  }

  async refreshPersistedState(): Promise<void> {
    if (this.closing || this.closed) return;
    await this.refreshSession();
    await this.refreshTranscript();
    await this.refreshSessions();
    this.emitSessionSnapshot();
  }

  async switchSession(sessionId: string): Promise<void> {
    await this.withSessionOperation(async () => {
      await this.refreshSessions();
      const selected = this.sessions.find((session) => session.id === sessionId);
      if (!selected) throw new Error("That Pi session is no longer available; refresh the session list.");
      if (sessionId !== this.activeSessionId) {
        const response = await this.command("switch_session", { sessionPath: sessionId });
        if (asRecord(response.data)?.cancelled === true) throw new Error("Pi cancelled the session switch.");
        this.status = null;
      }
      await this.refreshPersistedState();
    });
  }

  async newSession(): Promise<void> {
    await this.withSessionOperation(async () => {
      const response = await this.command("new_session");
      if (asRecord(response.data)?.cancelled === true) throw new Error("Pi cancelled creating a new session.");
      this.status = null;
      await this.refreshPersistedState();
    });
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this.withSessionOperation(async () => {
      const cleanName = name.trim();
      if (!cleanName || cleanName.length > 120) throw new Error("Session names must be between 1 and 120 characters.");
      await this.refreshSessions();
      if (!this.sessions.some((session) => session.id === sessionId)) {
        throw new Error("That Pi session is no longer available; refresh the session list.");
      }
      const previousId = this.activeSessionId;
      if (sessionId !== previousId) {
        const switched = await this.command("switch_session", { sessionPath: sessionId });
        if (asRecord(switched.data)?.cancelled === true) throw new Error("Pi cancelled the session switch.");
      }
      try {
        await this.command("set_session_name", { name: cleanName });
      } finally {
        if (previousId && previousId !== sessionId) {
          const restored = await this.command("switch_session", { sessionPath: previousId });
          if (asRecord(restored.data)?.cancelled === true) {
            throw new Error("Pi cancelled restoring the previously active session.");
          }
        }
      }
      await this.refreshPersistedState();
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.withSessionOperation(async () => {
      await this.refreshSessions();
      if (!this.sessions.some((session) => session.id === sessionId)) {
        throw new Error("That Pi session is no longer available; refresh the session list.");
      }
      const directory = this.sessionDirectory;
      if (!directory || !isWithin(directory, sessionId) || !sessionId.endsWith(".jsonl")) {
        throw new Error("Pi-vot refused to delete a session outside the selected project's Pi session directory.");
      }
      if (sessionId === this.activeSessionId) {
        const response = await this.command("new_session");
        if (asRecord(response.data)?.cancelled === true) throw new Error("Pi cancelled creating a replacement session.");
        await this.refreshPiState();
        await this.refreshContext();
      }
      await unlink(sessionId);
      await this.refreshPersistedState();
    });
  }

  async changeProjectDirectory(directory: string): Promise<void> {
    await this.withSessionOperation(async () => {
      const nextDirectory = resolve(directory);
      const info = await stat(nextDirectory).catch(() => undefined);
      if (!info?.isDirectory()) throw new Error("Select an existing project directory.");
      if (nextDirectory === this.cwd) {
        await this.refreshPersistedState();
        return;
      }

      this.closing = true;
      const child = this.child;
      if (child && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      if (child && !(await this.waitForClose(child, 2_000))) {
        child.kill();
        if (!(await this.waitForClose(child, 1_000))) child.kill("SIGKILL");
      }
      this.cwd = nextDirectory;
      this.closing = false;
      this.closed = false;
      this.initialization = undefined;
      this.sessionDirectory = null;
      this.sessionFile = null;
      this.activeSessionId = null;
      this.activeSessionName = null;
      this.sessions = [];
      this.transcript = [];
      this.model = null;
      this.context = { tokens: null, contextWindow: null, percent: null };
      this.output = "";
      this.discardingOversizedLine = false;
      this.currentAssistant = undefined;
      this.pendingPrompt = false;
      this.processError = undefined;
      this.status = null;
      this.compacting = false;
      this.compactionRetryPending = false;
      this.compactionAttemptActive = false;
      this.compactionFinishing = false;
      this.pendingCompactionOutcome = undefined;
      this.compactionCompletionEvent = false;
      this.compactionGeneration++;
      this.lifecycleVersion++;
      this.setState("idle");
      try {
        await this.initialize();
      } catch (error) {
        this.emitSessionSnapshot();
        throw error;
      }
    });
  }

  async sendMessage(
    message: string,
    messageId: string = randomUUID(),
    images: ImageAttachment[] = [],
  ): Promise<PromptDisposition> {
    const operation = this.sendChain.then(() => this.sendMessageNow(message, messageId, images));
    this.sendChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async sendMessageNow(message: string, messageId: string, images: ImageAttachment[]): Promise<PromptDisposition> {
    if (this.closing) throw new Error("Pi-vot is shutting down.");
    if (this.modelChangeInProgress) throw new Error("Pi-vot is changing the model; wait for it to finish.");
    if (this.sessionOperation) throw new Error("Pi-vot is switching sessions or projects; wait for the change to finish.");
    if (this.runState === "failed") throw new Error("The Pi process is disconnected.");
    if (this.runState === "stopping") throw new Error("Pi is stopping; wait for it to settle before sending.");

    await this.start();
    await this.initializeRpcState();
    if (this.closing) throw new Error("Pi-vot is shutting down.");
    if (this.modelChangeInProgress) throw new Error("Pi-vot is changing the model; wait for it to finish.");
    if (this.sessionOperation) throw new Error("Pi-vot is switching sessions or projects; wait for the change to finish.");
    if (this.hasFailed()) throw new Error(this.processError ?? "The Pi process is disconnected.");
    if (images.length > 0 && !this.model?.input?.includes("image")) {
      throw new Error("The selected model does not support image input.");
    }
    if (this.compacting) {
      if (this.queuedMessages.some((queued) => queued.id === messageId)) return "queued";
      if (this.queuedMessages.length >= MAX_COMPACTION_QUEUE) {
        throw new Error("The post-compaction message queue is full; wait for compaction to finish.");
      }
      const queuedImageBytes = this.queuedMessages.reduce((total, queued) =>
        total + queued.images.reduce((size, image) => size + image.size, 0), 0);
      const newImageBytes = images.reduce((size, image) => size + image.size, 0);
      if (queuedImageBytes + newImageBytes > MAX_QUEUED_IMAGE_BYTES) {
        throw new Error("Queued image attachments exceed the limit; wait for compaction to finish.");
      }
      const queued = { id: messageId, message, images };
      this.queuedMessages.push(queued);
      this.emit({
        type: "queued_message",
        id: messageId,
        message,
        ...(images.length ? { imageCount: images.length } : {}),
      });
      return "queued";
    }
    const steering = this.runState === "running";
    const lifecycleVersion = this.lifecycleVersion;
    if (!steering) this.pendingPrompt = true;
    if (!this.transcript.some((item) => item.id === messageId)) {
      this.transcript.push({
        id: messageId,
        type: "user",
        text: message,
        ...(images.length ? { imageCount: images.length } : {}),
      });
    }
    let response: RpcRecord;
    try {
      response = await this.command(steering ? "steer" : "prompt", {
        message,
        ...(images.length
          ? { images: images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })) }
          : {}),
      });
    } catch (error) {
      this.transcript = this.transcript.filter((item) => item.id !== messageId);
      throw error;
    } finally {
      if (!steering) this.pendingPrompt = false;
    }
    const disposition = asRecord(response.data)?.disposition;
    const result: PromptDisposition = steering
      ? disposition === "handled"
        ? "handled"
        : "steered"
      : disposition === "handled" || disposition === "queued" || disposition === "started"
        ? disposition
        : "started";
    if (result === "handled" && images.length === 0) {
      this.transcript = this.transcript.filter((item) => item.id !== messageId);
    } else if (!this.transcript.some((item) => item.type === "user" && item.text === message)) {
      this.transcript.push({ id: messageId, type: "user", text: message });
    }

    if (!steering && result !== "handled" && this.runState === "idle" && lifecycleVersion === this.lifecycleVersion) {
      this.setState("running");
    }
    this.emit({ type: "input_disposition", disposition: result });
    return result;
  }

  async compact(): Promise<void> {
    if (this.closing) throw new Error("Pi-vot is shutting down.");
    if (this.modelChangeInProgress) throw new Error("Pi-vot is changing the model; wait for it to finish.");
    if (this.sessionOperation) throw new Error("Pi-vot is switching sessions or projects; wait for the change to finish.");
    if (this.runState === "failed") throw new Error("The Pi process is disconnected.");
    await this.start();
    await this.initializeRpcState();
    if (this.modelChangeInProgress) throw new Error("Pi-vot is changing the model; wait for it to finish.");
    if (this.sessionOperation) throw new Error("Pi-vot is switching sessions or projects; wait for the change to finish.");
    if (this.compacting) throw new Error("Pi is already compacting.");

    this.compacting = true;
    this.compactionFinishing = false;
    this.compactionRetryPending = false;
    this.compactionAttemptActive = false;
    this.compactTimeoutRequiresObservedStart = false;
    this.observedCompactionActive = false;
    this.pendingCompactionOutcome = undefined;
    this.compactionCompletionEvent = false;
    const generation = ++this.compactionGeneration;
    this.emit({ type: "compaction_start", reason: "manual" });
    void this.command("compact", {}, this.compactTimeoutMs).then(
      () => {
        void this.monitorCompaction(generation, { success: true, aborted: false });
      },
      (error: unknown) => {
        this.compactTimeoutRequiresObservedStart =
          error instanceof Error && error.message.includes("did not respond to the compact command in time");
        void this.monitorCompaction(generation, {
          success: false,
          aborted: false,
          error: error instanceof Error ? error.message : "Pi could not compact the session.",
        });
      },
    );
  }

  async abort(): Promise<void> {
    if (this.sessionOperation) throw new Error("Pi-vot is switching sessions or projects; wait for the change to finish.");
    if (this.compacting) {
      throw new Error("Pi is compacting; Stop does not cancel compaction.");
    }
    if (this.runState !== "running" && this.runState !== "stopping") {
      throw new Error("There is no active Pi operation to stop.");
    }
    this.setState("stopping");
    try {
      await this.command("abort");
    } catch (error) {
      if (this.runState === "stopping") this.setState("running");
      throw error;
    }
  }

  async getAvailableModels(): Promise<ActiveModel[]> {
    const response = await this.command("get_available_models");
    const models = asRecord(response.data)?.models;
    if (!Array.isArray(models)) throw new Error("Pi did not return an available model list.");
    return models.map(modelFrom).filter((model): model is ActiveModel => model !== null);
  }

  async changeModel(provider: string, modelId: string): Promise<void> {
    if (this.runState === "failed") throw new Error("The Pi process is disconnected.");
    if (!this.canChangeModel) {
      throw new Error("Model can be changed when the session is idle.");
    }
    this.modelChangeInProgress = true;
    try {
      const response = await this.command("set_model", { provider, modelId });
      const confirmedModel = modelFrom(response.data);
      if (!confirmedModel) throw new Error("Pi did not confirm the selected model.");
      this.model = confirmedModel;
      this.context = { tokens: null, contextWindow: null, percent: null };
      this.emit({ type: "model_update", model: this.model });
      this.emit({ type: "context_update", context: { ...this.context } });
      await this.refreshSession();
    } finally {
      this.modelChangeInProgress = false;
    }
  }

  async stop(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      if (this.startPromise) await this.startPromise.catch(() => {});
      const child = this.child;
      if (!child) return;

      if (!this.compacting && (this.runState === "running" || this.runState === "stopping" || this.pendingPrompt)) {
        this.setState("stopping");
        await this.command("abort", {}, 1_500).catch(() => {});
      }

      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      if (!(await this.waitForClose(child, 2_000))) {
        child.kill();
        if (!(await this.waitForClose(child, 1_000))) child.kill("SIGKILL");
      }
    } finally {
      this.closed = true;
    }
  }

  private async start(): Promise<void> {
    if (this.child && !this.closed) return;
    if (this.startPromise) return this.startPromise;
    if (this.closing) throw new Error("Pi-vot is shutting down.");

    this.closed = false;
    this.startPromise = new Promise<void>((resolve, reject) => {
      let spawned = false;
      let settled = false;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnPi(this.cwd);
      } catch (error) {
        reject(this.startError(error));
        return;
      }
      this.child = child;
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      child.stdout.on("data", (chunk: Buffer) => this.readOutput(stdoutDecoder.write(chunk)));
      child.stderr.on("data", (chunk: Buffer) => this.logPiError(stderrDecoder.write(chunk)));
      child.once("spawn", () => {
        spawned = true;
        settled = true;
        this.setState("idle");
        resolve();
      });
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(this.startError(error));
        }
        this.handleExit(child, error);
      });
      child.once("close", (code, signal) => {
        const error = new Error(
          `Pi exited${code === null ? ` (${signal ?? "unknown reason"})` : ` with code ${code}`}.`,
        );
        if (!spawned && !settled) {
          settled = true;
          reject(this.startError(error));
        }
        this.handleExit(child, error);
      });
    }).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private initializeRpcState(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.refreshSession().then(() => undefined);
    }
    return this.initialization;
  }

  private async refreshSession(): Promise<void> {
    await Promise.all([this.refreshPiState(), this.refreshContext()]);
  }

  private async refreshPiState(): Promise<RpcRecord | undefined> {
    const refreshVersion = ++this.piStateRefreshVersion;
    try {
      const response = await this.command("get_state");
      const state = asRecord(response.data);
      if (!state) return undefined;
      if (refreshVersion !== this.piStateRefreshVersion) return state;
      this.model = modelFrom(state.model);
      if (typeof state.sessionFile === "string" && state.sessionFile) {
        this.sessionFile = resolve(this.cwd, state.sessionFile);
        this.sessionDirectory = dirname(this.sessionFile);
        this.activeSessionId = this.sessionFile;
      } else {
        this.sessionFile = null;
        this.sessionDirectory = await resolvePiSessionDirectory(this.cwd);
        if (typeof state.sessionId === "string" && state.sessionId) {
          this.activeSessionId = state.sessionId;
        }
      }
      this.activeSessionName = typeof state.sessionName === "string" && state.sessionName.trim()
        ? state.sessionName.trim()
        : null;
      this.emit({ type: "model_update", model: this.model });
      if (typeof state.isStreaming === "boolean" && this.runState !== "failed" && this.runState !== "stopping") {
        this.setState(state.isStreaming ? "running" : "idle");
      }
      if (typeof state.isCompacting === "boolean" &&
        (state.isCompacting || this.compactionFinishing || !this.compacting)) {
        this.compacting = state.isCompacting;
      }
      if (state.isCompacting === true) this.observedCompactionActive = true;
      return state;
    } catch (error) {
      if (refreshVersion !== this.piStateRefreshVersion) return undefined;
      console.error(`Pi does not expose usable session state: ${error instanceof Error ? error.message : String(error)}`);
      this.model = null;
      this.emit({ type: "model_update", model: null });
      return undefined;
    }
  }

  private async refreshContext(): Promise<void> {
    const refreshVersion = ++this.contextRefreshVersion;
    let context: ContextUsage;
    try {
      const response = await this.command("get_session_stats");
      const stats = asRecord(response.data);
      context = contextFrom(stats?.contextUsage);
    } catch (error) {
      if (refreshVersion !== this.contextRefreshVersion) return;
      console.error(`Pi does not expose session context usage: ${error instanceof Error ? error.message : String(error)}`);
      context = { tokens: null, contextWindow: null, percent: null };
    }
    if (refreshVersion !== this.contextRefreshVersion) return;
    this.context = context;
    this.emit({ type: "context_update", context: { ...this.context } });
  }

  private async refreshTranscript(): Promise<void> {
    try {
      const response = await this.command("get_messages");
      const messages = asRecord(response.data)?.messages;
      const hydrated = Array.isArray(messages) ? this.normalizeTranscript(messages) : [];
      if (this.currentAssistant &&
        !hydrated.some((item) => item.type === "assistant" && item.id === this.currentAssistant?.messageId)) {
        hydrated.push({
          id: this.currentAssistant.messageId,
          type: "assistant",
          text: this.currentAssistant.text,
          ...(this.currentAssistant.thinking ? { thinking: this.currentAssistant.thinking } : {}),
        });
      }
      this.transcript = hydrated;
    } catch (error) {
      console.error(`Pi does not expose persisted session messages: ${error instanceof Error ? error.message : String(error)}`);
      this.transcript = [];
      this.emit({ type: "notice", message: "Pi-vot could not load this session's stored conversation from the installed Pi runtime." });
    }
  }

  private normalizeTranscript(messages: unknown[]): TranscriptItem[] {
    return normalizeTranscript(messages);
  }

  private async refreshSessions(): Promise<void> {
    this.sessions = await discoverPiSessions(
      this.cwd,
      this.discoveryContext.env,
      this.discoveryContext.home,
      this.sessionDirectory ? [this.sessionDirectory] : [],
    );
    if (this.sessionFile && !this.sessions.some((session) => session.id === this.sessionFile)) {
      this.sessions.unshift({
        id: this.sessionFile,
        cwd: this.cwd,
        name: this.activeSessionName,
        preview: "New session",
        updatedAt: new Date().toISOString(),
      });
    }
    const active = this.sessions.find((session) => session.id === this.activeSessionId);
    if (active) this.activeSessionName = active.name;
  }

  private assertSessionOperationSafe(): void {
    if (this.modelChangeInProgress) {
      throw new Error("Pi-vot is changing the model; wait for it to finish.");
    }
    if (this.sessionOperation) {
      throw new Error("Another Pi session or project change is still in progress.");
    }
    if (this.runState !== "idle" || this.compacting) {
      throw new Error("Finish or stop the active Pi operation before switching sessions or projects.");
    }
    if (this.queuedMessages.length > 0) {
      throw new Error("Deliver or clear queued post-compaction messages before switching sessions or projects.");
    }
    if (this.pendingPrompt) {
      throw new Error("Wait for Pi to settle before switching sessions or projects.");
    }
  }

  private async withSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertSessionOperationSafe();
    this.sessionOperation = true;
    try {
      return await operation();
    } finally {
      this.sessionOperation = false;
    }
  }

  private emitSessionSnapshot(): void {
    this.emit({ type: "session_snapshot", snapshot: this.snapshot() });
  }

  private onCompactionStart(reason: unknown): void {
    const supportedReasons = ["manual", "threshold", "overflow"];
    const normalizedReason = typeof reason === "string" ? reason : "unknown";
    if (!supportedReasons.includes(normalizedReason)) {
      console.error(`Pi emitted an unknown compaction reason: ${normalizedReason}`);
    }
    this.compactionAttemptActive = true;
    this.observedCompactionActive = true;
    if (this.compacting) {
      this.compactionRetryPending = false;
      this.pendingCompactionOutcome = undefined;
      this.compactionCompletionEvent = false;
      return;
    }
    this.compacting = true;
    this.compactionFinishing = false;
    this.compactionRetryPending = false;
    this.compactionGeneration++;
    this.emit({ type: "compaction_start", reason: normalizedReason });
  }

  private onCompactionEnd(record: RpcRecord): void {
    const generation = this.compactionGeneration;
    if (record.willRetry === true) {
      this.compacting = true;
      this.compactionRetryPending = true;
      this.compactionAttemptActive = false;
      this.compactionFinishing = false;
      return;
    }
    this.compactionRetryPending = false;
    this.compactionAttemptActive = false;
    const aborted = record.aborted === true;
    const result = asRecord(record.result);
    const error = typeof record.errorMessage === "string" ? record.errorMessage : undefined;
    void this.monitorCompaction(generation, {
      success: !aborted && !!result && !error,
      aborted,
      ...(error ? { error } : {}),
    }, true);
  }

  private monitorCompaction(
    generation: number,
    outcome: { success: boolean; aborted: boolean; error?: string },
    completionEvent = false,
  ): Promise<void> {
    if (generation !== this.compactionGeneration) return Promise.resolve();
    if (!this.compactionCompletionEvent || completionEvent) this.pendingCompactionOutcome = outcome;
    this.compactionCompletionEvent ||= completionEvent;
    if (this.compactionMonitor) return this.compactionMonitor;
    this.compactionMonitor = (async () => {
      while (generation === this.compactionGeneration && this.compacting) {
        const state = await this.refreshPiState();
        if (generation !== this.compactionGeneration) return;
        if (this.compactionRetryPending || this.compactionAttemptActive || asRecord(state)?.isCompacting === true) {
          await new Promise((resolve) => setTimeout(resolve, COMPACTION_STATE_RECHECK_MS));
          continue;
        }
        const stateConfirmsFinished = asRecord(state)?.isCompacting === false &&
          (!this.compactTimeoutRequiresObservedStart || this.observedCompactionActive);
        if (stateConfirmsFinished || this.compactionCompletionEvent) {
          const confirmedOutcome = this.pendingCompactionOutcome;
          if (confirmedOutcome) await this.finishCompaction(generation, confirmedOutcome);
          if (!this.compacting) return;
        }
        await new Promise((resolve) => setTimeout(resolve, COMPACTION_STATE_RECHECK_MS));
      }
    })().finally(() => {
      this.compactionMonitor = undefined;
    });
    return this.compactionMonitor;
  }

  private async finishCompaction(
    generation: number,
    outcome: { success: boolean; aborted: boolean; error?: string },
  ): Promise<void> {
    if (generation !== this.compactionGeneration || this.compactionFinishing || this.compactionRetryPending) return;
    this.compactionFinishing = true;
    if (outcome.success) await this.refreshContext();
    if (generation !== this.compactionGeneration) return;
    if (this.compactionRetryPending || this.compactionAttemptActive) {
      this.compactionFinishing = false;
      return;
    }
    this.compacting = false;
    this.compactionFinishing = false;
    this.compactionRetryPending = false;
    this.compactionAttemptActive = false;
    this.compactTimeoutRequiresObservedStart = false;
    this.observedCompactionActive = false;
    this.pendingCompactionOutcome = undefined;
    this.compactionCompletionEvent = false;
    this.emit({
      type: "compaction_end",
      success: outcome.success,
      aborted: outcome.aborted,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.error && isNothingToCompactError(outcome.error) ? { informational: true } : {}),
    });
    void this.drainQueuedMessages();
  }

  private async drainQueuedMessages(): Promise<void> {
    if (this.drainingQueue || this.compacting || this.queuedMessages.length === 0) return;
    this.drainingQueue = true;
    try {
      while (!this.compacting && this.queuedMessages.length > 0) {
        const queued = this.queuedMessages[0]!;
        try {
          const disposition = await this.sendMessage(queued.message, queued.id, queued.images);
          if (disposition === "queued") break;
          if (this.queuedMessages[0]?.id !== queued.id) continue;
          this.queuedMessages.shift();
          this.emit({ type: "queued_message_sent", id: queued.id, disposition });
        } catch (error) {
          if (this.queuedMessages[0]?.id !== queued.id) continue;
          this.queuedMessages.shift();
          this.emit({
            type: "queued_message_failed",
            id: queued.id,
            error: error instanceof Error ? error.message : "Pi could not accept the queued message.",
          });
        }
      }
    } finally {
      this.drainingQueue = false;
      if (!this.compacting && this.queuedMessages.length > 0) void this.drainQueuedMessages();
    }
  }

  private startError(error: unknown): Error {
    const spawnError = error as NodeJS.ErrnoException;
    return spawnError.code === "ENOENT"
      ? new Error("Pi was not found. Install Pi and make sure the `pi` command is on PATH.")
      : new Error(`Could not start Pi: ${error instanceof Error ? error.message : String(error)}`);
  }

  private hasFailed(): boolean {
    return this.runState === "failed";
  }

  private async command(
    type: string,
    fields: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<RpcRecord> {
    const child = this.child;
    if (!child || child.killed || this.closed) throw new Error("The Pi process is not running.");

    const id = String(++this.requestId);
    const response = new Promise<RpcRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not respond to the ${type} command in time.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    void response.catch(() => {});

    try {
      await this.writeRecord({ id, type, ...fields });
      const record = await response;
      if (record.success === false) {
        throw new Error(typeof record.error === "string" ? record.error : `Pi rejected the ${type} command.`);
      }
      return record;
    } catch (error) {
      const request = this.pending.get(id);
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(id);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async writeRecord(record: RpcRecord): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("The Pi process input is closed.");
    }
    const serialized = `${JSON.stringify(record)}\n`;
    await new Promise<void>((resolve, reject) => {
      let callbackComplete = false;
      let drained = true;
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        if (error) {
          settled = true;
          child.stdin.off("drain", onDrain);
          child.stdin.off("error", onError);
          reject(error);
          return;
        }
        callbackComplete = true;
        if (callbackComplete && drained) {
          settled = true;
          child.stdin.off("drain", onDrain);
          child.stdin.off("error", onError);
          resolve();
        }
      };
      const onError = (error: Error) => finish(error);
      const onDrain = () => {
        drained = true;
        finish();
      };

      child.stdin.once("error", onError);
      try {
        drained = child.stdin.write(serialized, (error) => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
      if (!drained) child.stdin.once("drain", onDrain);
      else if (callbackComplete) finish();
    });
  }

  private async writeUncorrelated(record: RpcRecord): Promise<void> {
    try {
      await this.writeRecord(record);
    } catch (error) {
      this.emit({ type: "error", message: error instanceof Error ? error.message : "Could not respond to Pi." });
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.exitedChildren.has(child)) return;
    this.exitedChildren.add(child);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (this.child === child) this.child = undefined;
    this.closed = true;
    if (!this.closing) {
      this.processError = error.message;
      this.setState("failed", error.message);
      this.emit({ type: "error", message: error.message });
    }
  }

  private waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (this.closed || child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.off("close", onClose);
        resolve(false);
      }, timeoutMs);
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("close", onClose);
    });
  }

  private readOutput(chunk: string): void {
    if (this.discardingOversizedLine) {
      const newline = chunk.indexOf("\n");
      if (newline === -1) return;
      this.discardingOversizedLine = false;
      chunk = chunk.slice(newline + 1);
    }
    this.output += chunk;
    let newline = this.output.indexOf("\n");
    while (newline !== -1) {
      const line = this.output.slice(0, newline).replace(/\r$/, "");
      this.output = this.output.slice(newline + 1);
      if (line) this.handleRecord(line);
      newline = this.output.indexOf("\n");
    }
    if (this.output.length > 5_000_000) {
      this.output = "";
      this.discardingOversizedLine = true;
      console.error("Pi emitted an oversized RPC record; discarding it.");
    }
  }

  private handleRecord(line: string): void {
    let record: RpcRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      const object = asRecord(parsed);
      if (!object || typeof object.type !== "string") throw new Error("RPC record must be an object with a type.");
      record = object;
    } catch (error) {
      console.error(`Pi returned an invalid RPC record: ${error instanceof Error ? error.message : "invalid JSON"}`);
      return;
    }

    if (record.type === "response" && typeof record.id === "string") {
      const request = this.pending.get(record.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(record.id);
      if (record.success === false) {
        request.reject(new Error(typeof record.error === "string" ? record.error : "Pi rejected the command."));
      } else {
        request.resolve(record);
      }
      return;
    }

    switch (record.type) {
      case "agent_start":
        this.lifecycleVersion++;
        this.setState("running");
        break;
      case "agent_end":
        break;
      case "agent_settled":
        this.lifecycleVersion++;
        this.currentAssistant = undefined;
        if (this.runState !== "failed") this.setState("idle");
        if (!this.closing) {
          void this.refreshPersistedState();
        }
        break;
      case "message_start":
        this.onMessageStart(record);
        break;
      case "message_update":
        this.onMessageUpdate(record);
        break;
      case "message_end":
        this.onMessageEnd(record);
        break;
      case "tool_execution_start":
        this.onToolStart(record);
        break;
      case "tool_execution_update":
        this.onToolUpdate(record);
        break;
      case "tool_execution_end":
        this.onToolEnd(record);
        break;
      case "extension_ui_request":
        this.onExtensionUiRequest(record);
        break;
      case "compaction_start":
        this.onCompactionStart(record.reason);
        break;
      case "compaction_end":
        this.onCompactionEnd(record);
        break;
      case "model_change":
      case "model_changed":
        void this.refreshSession();
        break;
      default:
        break;
    }
  }

  private onMessageStart(record: RpcRecord): void {
    const message = asRecord(record.message);
    if (message?.role !== "assistant") return;
    const messageId = `assistant-${++this.messageId}`;
    this.currentAssistant = { messageId, text: "", thinking: "" };
    this.updateLiveAssistant();
    this.emit({ type: "assistant_start", messageId });
  }

  private onMessageUpdate(record: RpcRecord): void {
    const event = asRecord(record.assistantMessageEvent);
    const delta = event?.delta;
    if (!this.currentAssistant || typeof delta !== "string") return;
    if (event?.type === "text_delta") {
      this.currentAssistant.text += delta;
      this.updateLiveAssistant();
      this.emit({ type: "assistant_delta", messageId: this.currentAssistant.messageId, text: delta });
    } else if (event?.type === "thinking_delta") {
      this.currentAssistant.thinking += delta;
      this.updateLiveAssistant();
      this.emit({ type: "thinking_delta", messageId: this.currentAssistant.messageId, text: delta });
    }
  }

  private onMessageEnd(record: RpcRecord): void {
    const message = asRecord(record.message);
    if (message?.role !== "assistant" || !this.currentAssistant) return;
    const current = this.currentAssistant;
    current.text = messageContent(message, "text");
    current.thinking = messageContent(message, "thinking");
    this.updateLiveAssistant();
    this.emit({
      type: "assistant_end",
      messageId: current.messageId,
      text: current.text,
      thinking: current.thinking,
    });
  }

  private onToolStart(record: RpcRecord): void {
    if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") return;
    this.upsertLiveTool({
      id: `tool-${record.toolCallId}`,
      type: "tool",
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      input: json(record.args ?? {}),
      output: "",
      isError: false,
    });
    this.emit({
      type: "tool_start",
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      input: json(record.args ?? {}),
    });
  }

  private onToolUpdate(record: RpcRecord): void {
    if (typeof record.toolCallId !== "string") return;
    const partialResult = asRecord(record.partialResult);
    const output = contentText(partialResult?.content ?? record.partialResult);
    const tool = this.transcript.find((item) => item.type === "tool" && item.toolCallId === record.toolCallId);
    if (tool?.type === "tool") tool.output = output || json(record.partialResult);
    this.emit({ type: "tool_update", toolCallId: record.toolCallId, output: output || json(record.partialResult) });
  }

  private onToolEnd(record: RpcRecord): void {
    if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") return;
    const result = asRecord(record.result);
    const output = contentText(result?.content ?? record.result);
    this.upsertLiveTool({
      id: `tool-${record.toolCallId}`,
      type: "tool",
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      input: "",
      output: output || json(record.result),
      isError: record.isError === true,
    });
    this.emit({
      type: "tool_end",
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      output: output || json(record.result),
      isError: record.isError === true,
    });
  }

  private onExtensionUiRequest(record: RpcRecord): void {
    if (typeof record.id !== "string" || typeof record.method !== "string") return;
    const blocking = ["select", "confirm", "input", "editor"].includes(record.method);
    if (blocking) {
      this.emit({
        type: "notice",
        message: `A Pi extension requested ${record.method} interaction, which Pi-vot does not support yet. The request was cancelled.`,
      });
      void this.writeUncorrelated({ type: "extension_ui_response", id: record.id, cancelled: true });
      return;
    }

    if (record.method === "notify" && typeof record.message === "string") {
      this.emit({ type: "notice", message: record.message });
    }
  }

  private updateLiveAssistant(): void {
    const current = this.currentAssistant;
    if (!current) return;
    const item: TranscriptItem & { type: "assistant" } = {
      id: current.messageId,
      type: "assistant",
      text: current.text,
      ...(current.thinking ? { thinking: current.thinking } : {}),
    };
    const index = this.transcript.findIndex((entry) => entry.id === current.messageId);
    if (index === -1) this.transcript.push(item);
    else this.transcript[index] = item;
  }

  private upsertLiveTool(tool: Extract<TranscriptItem, { type: "tool" }>): void {
    const index = this.transcript.findIndex((item) => item.type === "tool" && item.toolCallId === tool.toolCallId);
    if (index === -1) this.transcript.push(tool);
    else {
      const existing = this.transcript[index];
      if (existing?.type === "tool") {
        this.transcript[index] = {
          ...existing,
          ...tool,
          input: tool.input || existing.input,
        };
      }
    }
  }

  private setState(state: RunState, error?: string): void {
    const clearedError = (state === "idle" || state === "running") && this.status?.kind === "error";
    if (clearedError) this.status = null;
    if (this.runState === state && error === undefined && !clearedError) return;
    this.runState = state;
    this.emit({ type: "state", state, ...(error ? { error } : {}) });
  }

  private emit(event: PiVotEvent): void {
    if (event.type === "notice") this.status = { kind: "notice", message: event.message };
    else if (event.type === "error") this.status = { kind: "error", message: event.message };
    else if (event.type === "compaction_start") {
      this.status = { kind: "compaction", message: "Pi is compacting the session…" };
    } else if (event.type === "compaction_end") {
      this.status = {
        kind: "compaction",
        message: event.success
          ? "Compaction complete."
          : event.informational
            ? "Nothing to compact yet."
            : event.aborted
              ? "Compaction was aborted."
              : event.error ?? "Compaction failed; the session is still available.",
      };
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Pi-vot event listener failed:", error);
      }
    }
  }

  private logPiError(chunk: string): void {
    const safe = chunk
      .replace(/\bBearer\s+\S+/gi, "******")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, "[REDACTED]");
    if (safe.trim()) console.error(`[Pi] ${safe.trimEnd()}`);
  }
}
