import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, createReadStream, statSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, posix as posixPath, resolve, sep, win32 as win32Path } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { bigPiLegacySidecarPath } from "./big-pi.ts";
import type { ImageAttachment } from "./request.ts";

type RunState = "idle" | "running" | "stopping" | "failed";
type PromptDisposition = "started" | "queued" | "handled" | "steered";
export type MessageMode = "send" | "queue" | "steer";

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
  | {
      type: "compaction_end";
      success: boolean;
      aborted: boolean;
      error?: string;
      informational?: boolean;
      entry?: Extract<TranscriptItem, { type: "compaction" }>;
    }
  | { type: "queued_message"; id: string; message: string; reason?: "compaction" | "turn"; imageCount?: number }
  | { type: "queued_message_sent"; id: string; disposition: PromptDisposition }
  | { type: "queued_message_failed"; id: string; error: string }
  | { type: "queued_message_cancelled"; id: string }
  | { type: "assistant_start"; messageId: string; createdAt?: string }
  | { type: "user_message"; messageId: string; createdAt: string; disposition?: PromptDisposition }
  | { type: "assistant_delta"; messageId: string; text: string }
  | { type: "thinking_delta"; messageId: string; text: string }
  | { type: "assistant_end"; messageId: string; text: string; thinking: string; createdAt?: string }
  | { type: "assistant_discard"; messageId: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; input: string }
  | { type: "tool_update"; toolCallId: string; output: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; output: string; isError: boolean }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "input_disposition"; messageId?: string; disposition: PromptDisposition }
  | { type: "agent_settled" };

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

const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

async function readCompactionKeepRecentTokens(
  cwd: string,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<number> {
  const agentDir = resolvePiPath(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), cwd, home);
  let keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS;
  for (const file of [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")]) {
    try {
      const contents = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
      const settings = asRecord(JSON.parse(contents));
      const value = asRecord(settings?.compaction)?.keepRecentTokens;
      if (Number.isSafeInteger(value) && (value as number) >= 0) keepRecentTokens = value as number;
    } catch {
      // Match Pi's built-in default when a settings file is absent or unreadable.
    }
  }
  return keepRecentTokens;
}

function isPiFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolvePiExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  isFile: (path: string, platform: NodeJS.Platform) => boolean = isPiFile,
): string {
  const pathApi = platform === "win32" ? win32Path : posixPath;
  const configured = env.PI_VOT_PI_EXECUTABLE;
  if (configured !== undefined) {
    if (!pathApi.isAbsolute(configured)) {
      throw new Error("PI_VOT_PI_EXECUTABLE must be an absolute path to the installed Pi executable or launcher.");
    }
    const executable = pathApi.resolve(configured);
    const extension = pathApi.extname(executable).toLowerCase();
    if ((platform === "win32" && ![".exe", ".cmd", ".bat", ".com"].includes(extension)) ||
      !isFile(executable, platform)) {
      throw new Error("PI_VOT_PI_EXECUTABLE must name an existing Pi executable or supported launcher file.");
    }
    return executable;
  }

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const directories = pathValue.split(platform === "win32" ? ";" : ":");
  const names = platform === "win32" ? ["pi.exe", "pi.cmd", "pi.bat", "pi.com"] : ["pi"];
  for (const directory of directories) {
    if (!directory || !pathApi.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = pathApi.resolve(directory, name);
      if (isFile(candidate, platform)) return candidate;
    }
  }
  throw new Error(
    "Pi was not found in an absolute PATH directory. Install Pi and add it to PATH, or set PI_VOT_PI_EXECUTABLE to its absolute path.",
  );
}

export interface PiSpawnSpec {
  command: string;
  args: string[];
  options: {
    cwd: string;
    shell: false;
    stdio: ["pipe", "pipe", "pipe"];
    windowsHide: true;
    windowsVerbatimArguments?: true;
  };
}

export function createPiSpawnSpec(
  executable: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
  initialSessionId?: string,
): PiSpawnSpec {
  if (initialSessionId && !/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(initialSessionId)) {
    throw new Error("The initial Pi session ID contains unsupported characters.");
  }
  const rpcArgs = ["--mode", "rpc", ...(initialSessionId ? ["--session-id", initialSessionId] : [])];
  const isWindowsScript = platform === "win32" && /\.(cmd|bat)$/i.test(executable);
  const command = isWindowsScript
    ? win32Path.resolve(systemRoot, "System32", "cmd.exe")
    : executable;
  const args = isWindowsScript
    ? (() => {
        if (/[%"\r\n]/.test(executable)) {
          throw new Error("The resolved Pi launcher path cannot be safely invoked by cmd.exe.");
        }
        return ["/d", "/v:off", "/s", "/c", `""${executable}" ${rpcArgs.join(" ")}"`];
      })()
    : rpcArgs;
  return {
    command,
    args,
    options: {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(isWindowsScript ? { windowsVerbatimArguments: true as const } : {}),
    },
  };
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
  const messages: Array<{ persistedId?: string; message: unknown }> = [];
  const branchParents = new Map<string, string | null>();
  let activeLeafId: string | undefined;
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
      if (record.type !== "session" && typeof record.id === "string" &&
        (record.parentId === null || typeof record.parentId === "string")) {
        branchParents.set(record.id, record.parentId);
        activeLeafId = record.id;
      }
      if (!header && record.type === "session") {
        header = record as SessionHeader;
      } else if (record.type === "session_info" && typeof record.name === "string" && record.name.trim()) {
        name = record.name.trim();
      } else if (record.type === "message" && record.message) {
        const recordTimestamp = timestampFrom(record.timestamp);
        const messageTimestamp = timestampFrom(record.message.timestamp);
        messages.push({
          ...(typeof record.id === "string" ? { persistedId: record.id } : {}),
          message: {
            ...record.message,
            ...(typeof record.id === "string" ? { _piVotPersistedId: record.id } : {}),
            ...(!messageTimestamp && recordTimestamp ? { timestamp: recordTimestamp } : {}),
          },
        });
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
  let selectedBranchIds: Set<string> | undefined;
  if (activeLeafId !== undefined && branchParents.size > 0) {
    selectedBranchIds = new Set();
    let current: string | null | undefined = activeLeafId;
    while (typeof current === "string" && branchParents.has(current) && !selectedBranchIds.has(current)) {
      selectedBranchIds.add(current);
      current = branchParents.get(current);
    }
    if (current === null && selectedBranchIds.size === 0) selectedBranchIds = undefined;
  }
  const fileInfo = await stat(session.id);
  const metadata = await readPersistedMetadata(session.id);
  const compactions = metadata.filter((item): item is PersistedCompaction => item.type === "compaction");
  const branchMessages = messages
    .filter((entry) => !selectedBranchIds || !entry.persistedId || selectedBranchIds.has(entry.persistedId))
    .map((entry) => entry.message);
  const normalized = normalizeTranscript(branchMessages);
  const selectedTranscriptIds = new Set(normalized.map((item) => item.id));
  const selectedCompactions = selectedBranchIds
    ? compactions.filter((entry) => !entry.afterId || selectedTranscriptIds.has(entry.afterId))
    : compactions;
  const transcript = mergePersistedTimestampFallbacks(
    mergePersistedCompactions(normalized, selectedCompactions),
    metadata,
  );
  return {
    session: {
      ...session,
      cwd: typeof header?.cwd === "string" ? header.cwd : session.cwd,
      name,
      updatedAt: fileInfo.mtime.toISOString(),
    },
    transcript,
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

export interface PromptTemplateCommand {
  name: string;
  description?: string;
}

export interface PromptTemplateCommandsResult {
  sessionId: string;
  hasRuntime: boolean;
  commands: PromptTemplateCommand[];
  message?: string;
}

export interface PiVotSnapshot {
  state: RunState;
  isCompacting: boolean;
  context: ContextUsage;
  manualCompactionKeepRecentTokens?: number;
  model: ActiveModel | null;
  queuedMessages: Array<{ id: string; message: string; reason?: "compaction" | "turn"; imageCount?: number }>;
  projectDirectory: string;
  activeSessionId: string | null;
  selectedSessionId?: string | null;
  activeSessionName: string | null;
  sessions: PiSession[];
  transcript: TranscriptItem[];
  historyRevision?: string;
  transcriptHasOlder?: boolean;
  transcriptBeforeId?: string;
  bigPi?: import("./big-pi.ts").BigPiSummary | null;
  billionContextPi?: import("./billion-context-pi.ts").BillionContextPiSummary | null;
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
  | { id: string; type: "user"; text: string; createdAt?: string; imageCount?: number; persistedId?: string }
  | { id: string; type: "assistant" | "custom"; text: string; createdAt?: string; thinking?: string; persistedId?: string }
  | {
      id: string;
      type: "compaction";
      createdAt: string;
      afterId?: string;
      afterIndex?: number;
      anchorId?: string;
      reason?: string;
      tokensBefore?: number;
      estimatedTokensAfter?: number;
    }
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
  parentId?: string | null;
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
  piMessageId?: string;
  text: string;
  thinking: string;
  createdAt: string;
  timestampIsFallback: boolean;
  compactionInternal: boolean;
}

interface CompactionAnchor {
  afterId?: string;
  afterIndex: number;
  anchorId?: string;
}

interface QueuedMessage {
  id: string;
  message: string;
  images: ImageAttachment[];
  reason: "compaction" | "turn";
}

type SpawnPi = (cwd: string) => ChildProcessWithoutNullStreams;

const MAX_QUEUED_MESSAGES = 100;
const MAX_QUEUED_IMAGE_BYTES = 40 * 1024 * 1024;
const COMPACTION_STATE_RECHECK_MS = 250;
const PROMPT_RPC_TIMEOUT_MS = 120_000;
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

function timestampFrom(value: unknown): string | undefined {
  const date = typeof value === "number" && Number.isFinite(value)
    ? new Date(value)
    : typeof value === "string" ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

interface PersistedCompaction {
  type: "compaction";
  id: string;
  createdAt: string;
  afterId?: string;
  afterIndex: number;
  reason?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface PersistedTimestampFallback {
  type: "timestamp_fallback";
  localId?: string;
  role: "user" | "assistant";
  createdAt: string;
  contentHash: string;
  piMessageId?: string;
}

interface CompactionOutcome {
  success: boolean;
  aborted: boolean;
  error?: string;
  reason?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

type PersistedMetadata = PersistedCompaction | PersistedTimestampFallback;

function contentHash(role: "user" | "assistant", text: string): string {
  return createHash("sha256").update(`${role}\0${text}`).digest("hex");
}

function piVotMetadataPath(sessionPath: string): string {
  return `${sessionPath}.pi-vot.jsonl`;
}

export function piVotDebugLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true)$/i.test(env.PI_VOT_DEBUG?.trim() ?? "");
}

export function piVotDebugLogPath(sessionPath: string): string {
  return `${sessionPath}.pi-vot-debug.jsonl`;
}

export async function appendPiVotDebugEvent(
  sessionPath: string,
  event: string,
  details: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!piVotDebugLogEnabled(env)) return;
  const logPath = piVotDebugLogPath(sessionPath);
  const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`;
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, line, { mode: 0o600 });
}

export async function deletePiSessionFiles(sessionPath: string): Promise<void> {
  if (!isAbsolute(sessionPath) || !sessionPath.endsWith(".jsonl")) {
    throw new Error("Pi-vot refused to delete an invalid Pi session path.");
  }
  for (const sidecar of [
    piVotMetadataPath(sessionPath),
    piVotDebugLogPath(sessionPath),
    `${sessionPath}.big-pi-debug.jsonl`,
    bigPiLegacySidecarPath(sessionPath),
  ]) {
    try {
      await unlink(sidecar);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    await rm(`${sessionPath}.big-pi`, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rm(`${sessionPath}.big-pi-agents`, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await unlink(sessionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readPersistedMetadata(sessionPath: string): Promise<PersistedMetadata[]> {
  let contents: string;
  try {
    contents = await readFile(piVotMetadataPath(sessionPath), "utf8");
  } catch {
    return [];
  }
  const events: PersistedMetadata[] = [];
  const seenCompactions = new Set<string>();
  const seenTimestampFallbacks = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const record = asRecord(JSON.parse(line));
      const createdAt = timestampFrom(record?.createdAt);
      if (!record || !createdAt) continue;
      if (record.type === "compaction" && typeof record.id === "string" &&
        record.id && !seenCompactions.has(record.id)) {
        seenCompactions.add(record.id);
        events.push({
          type: "compaction",
          id: record.id,
          createdAt,
          ...(typeof record.afterId === "string" ? { afterId: record.afterId } : {}),
          afterIndex: Number.isSafeInteger(record.afterIndex) && (record.afterIndex as number) >= -1
            ? record.afterIndex as number
            : -1,
          ...(typeof record.reason === "string" && ["manual", "threshold", "overflow"].includes(record.reason)
            ? { reason: record.reason }
            : {}),
          ...(isFiniteNumber(record.tokensBefore) && record.tokensBefore >= 0 ? { tokensBefore: record.tokensBefore } : {}),
          ...(isFiniteNumber(record.estimatedTokensAfter) && record.estimatedTokensAfter >= 0
            ? { estimatedTokensAfter: record.estimatedTokensAfter }
            : {}),
        });
      } else if (record.type === "timestamp_fallback" &&
        (record.role === "user" || record.role === "assistant") &&
        typeof record.contentHash === "string" && /^[a-f0-9]{64}$/.test(record.contentHash)) {
        const piMessageId = typeof record.piMessageId === "string" && record.piMessageId
          ? record.piMessageId
          : undefined;
        const fallbackKey = piMessageId
          ? `pi:${piMessageId}`
          : `local:${typeof record.localId === "string" ? record.localId : ""}:${record.role}:${record.contentHash}:${createdAt}`;
        if (seenTimestampFallbacks.has(fallbackKey)) continue;
        seenTimestampFallbacks.add(fallbackKey);
        events.push({
          type: "timestamp_fallback",
          role: record.role,
          ...(typeof record.localId === "string" ? { localId: record.localId } : {}),
          createdAt,
          contentHash: record.contentHash,
          ...(piMessageId ? { piMessageId } : {}),
        });
      }
    } catch {
      continue;
    }
  }
  return events;
}

async function appendPersistedMetadata(
  sessionPath: string,
  event: PersistedMetadata,
): Promise<void> {
  const line = event.type === "compaction"
    ? {
        type: event.type,
        id: event.id,
        createdAt: event.createdAt,
        afterId: event.afterId,
        afterIndex: event.afterIndex,
        reason: event.reason,
        tokensBefore: event.tokensBefore,
        estimatedTokensAfter: event.estimatedTokensAfter,
      }
    : {
        type: event.type,
        localId: event.localId,
        role: event.role,
        createdAt: event.createdAt,
        contentHash: event.contentHash,
        piMessageId: event.piMessageId,
      };
  await appendFile(
    piVotMetadataPath(sessionPath),
    `${JSON.stringify(line)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function mergePersistedCompactions(
  transcript: TranscriptItem[],
  events: PersistedCompaction[],
): TranscriptItem[] {
  const result = [...transcript];
  const afterIdOffsets = new Map<string, number>();
  const afterIndexOffsets = new Map<number, number>();
  for (const event of events) {
    if (result.some((item) => item.id === event.id)) continue;
    let anchorIndex = event.afterId
      ? result.findIndex((item) => item.id === event.afterId ||
        ((item.type === "user" || item.type === "assistant") && item.persistedId === event.afterId))
      : -1;
    if (anchorIndex < 0 && event.afterIndex >= 0) {
      const persistentMessages = result.filter((item) => item.type !== "compaction" && item.type !== "tool");
      const indexedAnchor = persistentMessages[event.afterIndex];
      if (indexedAnchor) anchorIndex = result.findIndex((item) => item.id === indexedAnchor.id);
    }
    if (anchorIndex >= 0) {
      const anchor = result[anchorIndex]!;
      const nextIndex = event.afterId
        ? afterIdOffsets.get(event.afterId) ?? anchorIndex + 1
        : afterIndexOffsets.get(event.afterIndex) ?? anchorIndex + 1;
      result.splice(nextIndex, 0, {
        id: event.id,
        type: "compaction",
        createdAt: event.createdAt,
        ...(event.afterId ? { afterId: event.afterId } : {}),
        afterIndex: event.afterIndex,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.tokensBefore !== undefined ? { tokensBefore: event.tokensBefore } : {}),
        ...(event.estimatedTokensAfter !== undefined ? { estimatedTokensAfter: event.estimatedTokensAfter } : {}),
        ...(anchor.type !== "compaction" && anchor.type !== "tool" ? { anchorId: anchor.id } : {}),
      });
      if (event.afterId) afterIdOffsets.set(event.afterId, nextIndex + 1);
      else afterIndexOffsets.set(event.afterIndex, nextIndex + 1);
      continue;
    }
    const targetIndex = Math.min(Math.max(event.afterIndex + 1, 0), result.length);
    const nextIndex = afterIndexOffsets.get(event.afterIndex) ?? targetIndex;
    result.splice(nextIndex, 0, {
      id: event.id,
      type: "compaction",
      createdAt: event.createdAt,
      ...(event.afterId ? { afterId: event.afterId } : {}),
      afterIndex: event.afterIndex,
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.tokensBefore !== undefined ? { tokensBefore: event.tokensBefore } : {}),
      ...(event.estimatedTokensAfter !== undefined ? { estimatedTokensAfter: event.estimatedTokensAfter } : {}),
    });
    afterIndexOffsets.set(event.afterIndex, nextIndex + 1);
  }
  return result;
}

function mergePersistedTimestampFallbacks(
  transcript: TranscriptItem[],
  metadata: PersistedMetadata[],
): TranscriptItem[] {
  const byPiId = new Map<string, PersistedTimestampFallback>();
  for (const item of metadata) {
    if (item.type !== "timestamp_fallback") continue;
    if (item.piMessageId) byPiId.set(item.piMessageId, item);
  }
  return transcript.map((item) => {
    if (item.type !== "user" && item.type !== "assistant") return item;
    let createdAt = item.createdAt;
    if (!createdAt && "persistedId" in item && item.persistedId) {
      const match = byPiId.get(item.persistedId);
      if (match && match.role === item.type && match.contentHash === contentHash(item.type, item.text)) {
        createdAt = match.createdAt;
      }
    }
    if (item.type === "user") {
      const { persistedId: _persistedId, ...publicItem } = item;
      return { ...publicItem, ...(createdAt ? { createdAt } : {}) };
    }
    const { persistedId: _persistedId, ...publicItem } = item;
    return { ...publicItem, ...(createdAt ? { createdAt } : {}) };
  });
}

function isIncrementalTranscript(
  previous: TranscriptItem[],
  next: TranscriptItem[],
  mutableIds: ReadonlySet<string>,
): boolean {
  const nextIndexes = new Map(next.map((item, index) => [item.id, index]));
  let previousIndex = -1;
  for (const oldItem of previous) {
    const index = nextIndexes.get(oldItem.id);
    if (index === undefined || index <= previousIndex) return false;
    previousIndex = index;
    const updated = next[index]!;
    if (JSON.stringify(oldItem) !== JSON.stringify(updated) && !mutableIds.has(oldItem.id)) {
      return false;
    }
  }
  const oldIds = new Set(previous.map((item) => item.id));
  for (let index = 0; index < next.length; index++) {
    if (oldIds.has(next[index]!.id)) continue;
    if (next[index]!.type !== "compaction" &&
      previousIndex >= 0 && index < previousIndex) return false;
  }
  return true;
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
    const persistedId = typeof message._piVotPersistedId === "string"
      ? message._piVotPersistedId
      : typeof message.id === "string" ? message.id : undefined;
    const id = typeof message.id === "string" ? message.id : persistedId ?? `history-${index}`;
    const createdAt = timestampFrom(message.timestamp);
    if (role === "user") {
      const text = messageText(message.content);
      const imageCount = messageImageCount(message.content);
      if (text || imageCount > 0) {
        items.push({
          id,
          type: "user",
          text,
          ...(createdAt ? { createdAt } : {}),
          ...(imageCount > 0 ? { imageCount } : {}),
          ...(persistedId ? { persistedId } : {}),
        });
      }
    } else if (role === "assistant") {
      const text = messageContent(message, "text");
      const thinking = messageContent(message, "thinking");
      if (text || (thinking && typeof message.stopReason === "string" && message.stopReason !== "length")) {
        items.push({
          id,
          type: "assistant",
          text,
          ...(createdAt ? { createdAt } : {}),
          ...(thinking ? { thinking } : {}),
          ...(persistedId ? { persistedId } : {}),
        });
      }
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

function latestTranscriptPageStart(items: TranscriptItem[], limit: number): number {
  let start = items.length;
  let count = 0;
  let bytes = 0;
  while (start > 0 && count < limit) {
    const itemBytes = Buffer.byteLength(JSON.stringify(items[start - 1]));
    if (count > 0 && bytes + itemBytes > 1_048_576) break;
    bytes += itemBytes;
    count++;
    start--;
  }
  return start;
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
  private compactionEvidenceVersion = 0;
  private compactionFinishing = false;
  private compactionRetryPending = false;
  private compactionAttemptActive = false;
  private compactionRequiresSettlement = false;
  private compactionAgentSettled = false;
  private compactTimeoutRequiresObservedStart = false;
  private observedCompactionActive = false;
  private compactionMonitor?: Promise<void>;
  private pendingCompactionOutcome?: CompactionOutcome;
  private compactionReason?: string;
  private compactionCompletionEvent = false;
  private compactionAnchor?: CompactionAnchor;
  private initialization?: Promise<void>;
  private context: ContextUsage = { tokens: null, contextWindow: null, percent: null };
  private manualCompactionKeepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS;
  private model: ActiveModel | null = null;
  private piStateRefreshVersion = 0;
  private contextRefreshVersion = 0;
  private metadataWrite = Promise.resolve();
  private debugLogWrite = Promise.resolve();
  private metadataWritesDisabled = false;
  private persistedTimestampLocalIds = new Set<string>();
  private queuedMessages: QueuedMessage[] = [];
  private queuedTurnInFlightId?: string;
  private queueDispatchPending = false;
  private queuedTurnSettledBeforeResponse = false;
  private drainingQueue = false;
  private currentAssistant?: AssistantMessageState;
  private pendingPrompt = false;
  private sessionOperation = false;
  private modelChangeInProgress = false;
  private processError?: string;
  private closing = false;
  private closed = false;
  private stopPromise?: Promise<void>;
  private cwd: string;
  private readonly spawnPi: SpawnPi;
  private readonly initialSessionId?: string;
  private readonly compactTimeoutMs: number;
  private readonly discoveryContext: PiDiscoveryContext;
  private activeSessionId: string | null = null;
  private transcriptSessionId: string | null = null;
  private activeSessionName: string | null = null;
  private sessionFile: string | null = null;
  private sessionDirectory: string | null = null;
  private sessions: PiSession[] = [];
  private transcript: TranscriptItem[] = [];
  private historyRevision = randomUUID();
  private status: PiVotSnapshot["status"] = null;

  constructor(
    cwd = process.cwd(),
    spawnPi?: SpawnPi,
    compactTimeoutMs = COMPACT_RPC_TIMEOUT_MS,
    discoveryContext?: PiDiscoveryContext,
    initialSessionId?: string,
  ) {
    this.cwd = cwd;
    this.compactTimeoutMs = compactTimeoutMs;
    this.initialSessionId = initialSessionId;
    this.discoveryContext = capturePiDiscoveryContext(
      discoveryContext?.env,
      discoveryContext?.home,
    );
    if (spawnPi) {
      this.spawnPi = spawnPi;
    } else {
      let executable: string | undefined;
      let resolutionError: Error | undefined;
      try {
        executable = resolvePiExecutable(this.discoveryContext.env);
      } catch (error) {
        resolutionError = error instanceof Error ? error : new Error(String(error));
      }
        this.spawnPi = (directory) => {
        if (!executable) throw resolutionError ?? new Error("Pi executable resolution failed.");
          const spec = createPiSpawnSpec(executable, directory, process.platform, undefined, this.initialSessionId);
        return spawn(spec.command, spec.args, spec.options);
      };
    }
  }

  get state(): RunState {
    return this.runState;
  }

  get canChangeModel(): boolean {
    return this.runState === "idle" && !this.compacting && !this.pendingPrompt &&
      !this.sessionOperation && !this.modelChangeInProgress && this.queuedMessages.length === 0;
  }

  snapshot(transcriptLimit?: number): PiVotSnapshot {
    const transcriptStart = transcriptLimit === undefined
      ? 0
      : latestTranscriptPageStart(this.transcript, Math.max(1, transcriptLimit));
    const transcript = this.transcript.slice(transcriptStart);
    return {
      state: this.runState,
      isCompacting: this.compacting,
      context: { ...this.context },
      manualCompactionKeepRecentTokens: this.manualCompactionKeepRecentTokens,
      model: this.model ? { ...this.model } : null,
      queuedMessages: this.queuedMessages.map(({ id, message, images, reason }) => ({
        id,
        message,
        reason,
        ...(images.length ? { imageCount: images.length } : {}),
      })),
      projectDirectory: this.cwd,
      activeSessionId: this.activeSessionId,
      activeSessionName: this.activeSessionName,
      sessions: this.sessions.map((session) => ({ ...session })),
      transcript: transcript.map((item) => ({ ...item })),
      historyRevision: this.historyRevision,
      ...(transcriptStart > 0 ? {
        transcriptHasOlder: true,
        transcriptBeforeId: transcript[0]?.id,
      } : { transcriptHasOlder: false }),
      status: this.status ? { ...this.status } : null,
    };
  }

  transcriptItemsForHistory(): readonly TranscriptItem[] {
    return this.transcript;
  }

  subscribe(listener: (event: PiVotEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await this.start();
    this.manualCompactionKeepRecentTokens = await readCompactionKeepRecentTokens(
      this.cwd,
      this.discoveryContext.env,
      this.discoveryContext.home,
    );
    await this.initializeRpcState();
    if (this.hasFailed()) throw new Error(this.processError ?? "The Pi process is disconnected.");
    await this.refreshPersistedState();
    if (this.hasFailed()) throw new Error(this.processError ?? "The Pi process is disconnected.");
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
    if (this.modelChangeInProgress) {
      throw new Error("Pi-vot is changing the model; wait for it to finish.");
    }
    if (this.sessionOperation) {
      throw new Error("Another Pi session or project change is still in progress.");
    }
    if (sessionId !== this.activeSessionId) this.assertSessionOperationSafe();
    this.sessionOperation = true;
    try {
      await this.refreshSessions();
      if (!this.sessions.some((session) => session.id === sessionId)) {
        throw new Error("That Pi session is no longer available; refresh the session list.");
      }
      const directory = this.sessionDirectory;
      if (!directory || !isWithin(directory, sessionId) || !sessionId.endsWith(".jsonl")) {
        throw new Error("Pi-vot refused to delete a session outside the selected project's Pi session directory.");
      }
      const deletingActiveSession = sessionId === this.activeSessionId;
      if (deletingActiveSession) {
        this.metadataWritesDisabled = true;
        await this.stop();
      }
      await this.metadataWrite;
      await this.debugLogWrite;
      await deletePiSessionFiles(sessionId);
      this.sessions = this.sessions.filter((session) => session.id !== sessionId);
      if (deletingActiveSession) {
        this.activeSessionId = null;
        this.activeSessionName = null;
        this.sessionFile = null;
        this.transcript = [];
        this.historyRevision = randomUUID();
        this.emitSessionSnapshot();
      } else {
        await this.refreshPersistedState();
      }
    } finally {
      this.sessionOperation = false;
    }
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
      this.stopPromise = undefined;
      this.initialization = undefined;
      this.sessionDirectory = null;
      this.sessionFile = null;
      this.activeSessionId = null;
      this.activeSessionName = null;
      this.sessions = [];
      this.transcript = [];
      this.historyRevision = randomUUID();
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
      this.compactionRequiresSettlement = false;
      this.compactionAgentSettled = false;
      this.compactionFinishing = false;
      this.pendingCompactionOutcome = undefined;
      this.compactionCompletionEvent = false;
      this.compactionGeneration++;
      this.compactionEvidenceVersion++;
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
    mode?: MessageMode,
  ): Promise<PromptDisposition> {
    const operation = this.sendChain.then(() => this.sendMessageNow(message, messageId, images, mode));
    this.sendChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async sendMessageNow(
    message: string,
    messageId: string,
    images: ImageAttachment[],
    mode?: MessageMode,
  ): Promise<PromptDisposition> {
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
    if (mode === "queue" || (this.compacting && mode === undefined)) {
      if (mode === "queue" && !this.compacting && this.runState !== "running") {
        throw new Error("Pi is not running; choose Send after it becomes idle.");
      }
      return this.enqueueMessage(message, messageId, images, this.compacting ? "compaction" : "turn");
    }
    if (mode && this.compacting) throw new Error("Pi is compacting; wait for compaction to finish before sending.");
    if (mode) {
      const expectedState = mode === "send" ? "idle" : "running";
      if (this.runState !== expectedState) {
        throw new Error(mode === "send"
          ? "Pi is already responding; choose Queue or Steer."
          : "Pi is not running; choose Send after it becomes idle.");
      }
    }
    if (this.compacting) {
      return this.enqueueMessage(message, messageId, images, "compaction");
    }
    const steering = mode === "steer" || (!mode && this.runState === "running");
    const lifecycleVersion = this.lifecycleVersion;
    let createdAt = new Date().toISOString();
    if (!steering) this.pendingPrompt = true;
    if (!this.transcript.some((item) => item.id === messageId)) {
      this.transcript.push({
        id: messageId,
        type: "user",
        text: message,
        createdAt,
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
      }, PROMPT_RPC_TIMEOUT_MS);
    } catch (error) {
      this.transcript = this.transcript.filter((item) => item.id !== messageId);
      throw error;
    } finally {
      if (!steering) this.pendingPrompt = false;
    }
    const responseData = asRecord(response.data);
    const responseMessage = asRecord(responseData?.message);
    const authoritativeTimestamp = timestampFrom(responseMessage?.timestamp ?? responseData?.timestamp);
    if (authoritativeTimestamp) createdAt = authoritativeTimestamp;
    const piMessageId = typeof responseMessage?.id === "string"
      ? responseMessage.id
      : typeof responseData?.messageId === "string" ? responseData.messageId : undefined;
    const disposition = responseData?.disposition;
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
      this.transcript.push({ id: messageId, type: "user", text: message, createdAt });
    }

    if (result !== "handled" || images.length > 0) {
      const userEntry = this.transcript.find((item) => item.id === messageId);
      if (userEntry?.type === "user") {
        userEntry.createdAt = createdAt;
        if (piMessageId) userEntry.persistedId = piMessageId;
      }
      if (!authoritativeTimestamp && this.sessionFile) {
        await this.persistMetadata({
          type: "timestamp_fallback",
          localId: messageId,
          role: "user",
          createdAt,
          contentHash: contentHash("user", message),
          ...(piMessageId ? { piMessageId } : {}),
        });
      }
      this.emit({ type: "user_message", messageId, createdAt, disposition: result });
      void this.refreshContext();
    }
    if (!steering && result !== "handled" && this.runState === "idle" && lifecycleVersion === this.lifecycleVersion) {
      this.setState("running");
    }
    this.emit({ type: "input_disposition", messageId, disposition: result });
    return result;
  }

  private enqueueMessage(
    message: string,
    messageId: string,
    images: ImageAttachment[],
    reason: QueuedMessage["reason"],
  ): PromptDisposition {
    if (this.queuedMessages.some((queued) => queued.id === messageId)) return "queued";
    if (this.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
      throw new Error("The message queue is full; wait for Pi to process queued messages.");
    }
      const queuedImageBytes = this.queuedMessages.reduce((total, queued) =>
        total + queued.images.reduce((size, image) => size + image.size, 0), 0);
      const newImageBytes = images.reduce((size, image) => size + image.size, 0);
      if (queuedImageBytes + newImageBytes > MAX_QUEUED_IMAGE_BYTES) {
        throw new Error("Queued image attachments exceed the limit; wait for Pi to process queued messages.");
      }
      const queued = { id: messageId, message, images, reason };
      this.queuedMessages.push(queued);
      this.emit({
        type: "queued_message",
        id: messageId,
        message,
        reason,
        ...(images.length ? { imageCount: images.length } : {}),
      });
      return "queued";
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

    // Refresh before setting compacting or sending the RPC: Pi aborts an active turn before
    // discovering that a small session has nothing eligible to summarize.
    await this.refreshContext();
    if (this.context.tokens !== null && this.context.tokens <= this.manualCompactionKeepRecentTokens) {
      throw new Error(
        `Nothing to compact yet: Pi keeps the most recent ${this.manualCompactionKeepRecentTokens.toLocaleString()} tokens. ` +
        "Manual compaction is available after the context grows beyond that threshold.",
      );
    }
    let lastCompactionIndex = -1;
    for (let index = this.transcript.length - 1; index >= 0; index--) {
      if (this.transcript[index]?.type === "compaction") {
        lastCompactionIndex = index;
        break;
      }
    }
    if (lastCompactionIndex >= 0 && !this.transcript.slice(lastCompactionIndex + 1).some((item) =>
      item.type === "user" || item.type === "assistant" || item.type === "tool")) {
      throw new Error("Nothing to compact yet: there are no new messages after the latest compaction.");
    }

    this.compacting = true;
    this.compactionFinishing = false;
    this.compactionRetryPending = false;
    this.compactionAttemptActive = false;
    this.compactionRequiresSettlement = false;
    this.compactionAgentSettled = false;
    this.compactTimeoutRequiresObservedStart = false;
    this.observedCompactionActive = false;
    this.pendingCompactionOutcome = undefined;
    this.compactionCompletionEvent = false;
    this.compactionAnchor = this.captureCompactionAnchor();
    this.compactionReason = "manual";
    const generation = ++this.compactionGeneration;
    this.compactionEvidenceVersion++;
    this.emit({ type: "compaction_start", reason: "manual" });
    void this.refreshContext();
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

  cancelQueuedMessage(messageId: string): boolean {
    const index = this.queuedMessages.findIndex((queued) => queued.id === messageId);
    if (index < 0 || this.queuedTurnInFlightId === messageId) return false;
    this.queuedMessages.splice(index, 1);
    this.emit({ type: "queued_message_cancelled", id: messageId });
    return true;
  }

  clearQueuedMessages(): string[] {
    const cancelled: string[] = [];
    for (let index = this.queuedMessages.length - 1; index >= 0; index--) {
      const queued = this.queuedMessages[index]!;
      if (queued.id === this.queuedTurnInFlightId) continue;
      this.queuedMessages.splice(index, 1);
      cancelled.push(queued.id);
      this.emit({ type: "queued_message_cancelled", id: queued.id });
    }
    return cancelled;
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

  async getPromptTemplates(): Promise<PromptTemplateCommand[]> {
    const response = await this.command("get_commands");
    const commands = asRecord(response.data)?.commands;
    if (!Array.isArray(commands)) throw new Error("Pi did not return its prompt template list.");
    const result: PromptTemplateCommand[] = [];
    for (const value of commands) {
      const command = asRecord(value);
      if (command?.source !== "prompt" || typeof command.name !== "string" ||
        !command.name.trim() || command.name.length > 256 || /[\s/]/.test(command.name)) continue;
      const name = command.name.trim();
      if (result.some((item) => item.name === name)) continue;
      result.push({
        name,
        ...(typeof command.description === "string" && command.description.trim()
          ? { description: command.description.trim().slice(0, 500) }
          : {}),
      });
    }
    return result;
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
    if (this.stopPromise) return this.stopPromise;
    if (this.closed) return;
    this.closing = true;
    this.stopPromise = (async () => {
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
        await this.metadataWrite;
      } finally {
        this.closed = true;
      }
    })();
    return this.stopPromise;
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
      this.initialization = (async () => {
        await this.refreshPiState(true);
        await this.refreshContext();
        if (this.hasFailed()) throw new Error(this.processError ?? "The Pi process is disconnected.");
      })();
    }
    return this.initialization;
  }

  private async refreshSession(): Promise<void> {
    await Promise.all([this.refreshPiState(), this.refreshContext()]);
  }

  private async refreshPiState(initializationCritical = false): Promise<RpcRecord | undefined> {
    const refreshVersion = ++this.piStateRefreshVersion;
    try {
      const response = await this.command("get_state");
      const state = asRecord(response.data);
      if (!state) {
        if (initializationCritical) throw new Error("Pi did not provide authoritative session state.");
        return undefined;
      }
      if (refreshVersion !== this.piStateRefreshVersion) return undefined;
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
        (state.isCompacting || !this.compacting)) {
        this.compacting = state.isCompacting;
      }
      if (state.isCompacting === true) this.observedCompactionActive = true;
      return state;
    } catch (error) {
      if (initializationCritical) {
        throw new Error(this.processError ?? (error instanceof Error ? error.message : String(error)));
      }
      if (refreshVersion !== this.piStateRefreshVersion) return undefined;
      if (!this.hasFailed()) {
        console.error(`Pi does not expose usable session state: ${error instanceof Error ? error.message : String(error)}`);
      }
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
      if (!this.hasFailed()) {
        console.error(`Pi does not expose session context usage: ${error instanceof Error ? error.message : String(error)}`);
      }
      context = { tokens: null, contextWindow: null, percent: null };
    }
    if (refreshVersion !== this.contextRefreshVersion) return;
    this.context = context;
    this.emit({ type: "context_update", context: { ...this.context } });
  }

  private async refreshTranscript(): Promise<void> {
    const previous = this.transcript;
    const sessionChanged = this.transcriptSessionId !== this.activeSessionId;
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
          createdAt: this.currentAssistant.createdAt,
          ...(this.currentAssistant.thinking ? { thinking: this.currentAssistant.thinking } : {}),
        });
      }
      if (this.sessionFile) {
        await this.metadataWrite;
        const metadata = await readPersistedMetadata(this.sessionFile);
        this.transcript = mergePersistedCompactions(
          hydrated,
          metadata.filter((item): item is PersistedCompaction => item.type === "compaction"),
        );
        this.transcript = mergePersistedTimestampFallbacks(this.transcript, metadata);
      } else this.transcript = hydrated.map((item) => {
        if (item.type !== "user" && item.type !== "assistant") return item;
        const { persistedId: _persistedId, ...publicItem } = item;
        return publicItem;
      });
      const mutableIds = new Set<string>();
      if (this.currentAssistant) mutableIds.add(this.currentAssistant.messageId);
      if (this.runState === "running") {
        let lastUser = -1;
        for (let index = previous.length - 1; index >= 0; index--) {
          if (previous[index]!.type === "user") {
            lastUser = index;
            break;
          }
        }
        for (const item of previous.slice(lastUser + 1)) {
          if (item.type === "assistant" || item.type === "tool") mutableIds.add(item.id);
        }
      }
      if (!isIncrementalTranscript(previous, this.transcript, mutableIds)) {
        this.historyRevision = randomUUID();
      }
      if (sessionChanged) this.historyRevision = randomUUID();
      this.transcriptSessionId = this.activeSessionId;
    } catch (error) {
      console.error(`Pi does not expose persisted session messages: ${error instanceof Error ? error.message : String(error)}`);
      this.transcript = [];
      if (previous.length) this.historyRevision = randomUUID();
      if (sessionChanged) this.historyRevision = randomUUID();
      this.transcriptSessionId = this.activeSessionId;
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
    if (this.runState === "failed") {
      throw new Error(this.processError ?? "The Pi process is disconnected.");
    }
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

  private persistMetadata(event: PersistedMetadata): Promise<void> {
    if (this.metadataWritesDisabled) return this.metadataWrite;
    const sessionPath = this.sessionFile;
    if (!sessionPath) return this.metadataWrite;
    const fallbackKey = event.type === "timestamp_fallback" && event.localId
      ? `${sessionPath}\0${event.localId}`
      : undefined;
    if (fallbackKey && this.persistedTimestampLocalIds.has(fallbackKey)) {
      return this.metadataWrite;
    }
    const write = this.metadataWrite.then(async () => {
      await appendPersistedMetadata(sessionPath, event);
    });
    this.metadataWrite = write.catch((error: unknown) => {
      console.error(`Pi-vot could not persist session metadata: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (fallbackKey) this.persistedTimestampLocalIds.add(fallbackKey);
    return this.metadataWrite;
  }

  private onCompactionStart(reason: unknown): void {
    this.discardIncompleteThinking();
    const supportedReasons = ["manual", "threshold", "overflow"];
    const normalizedReason = typeof reason === "string" ? reason : "unknown";
    this.compactionReason = supportedReasons.includes(normalizedReason) ? normalizedReason : undefined;
    this.recordDebugEvent("compaction_start", {
      reason: supportedReasons.includes(normalizedReason) ? normalizedReason : "unknown",
    });
    if (!supportedReasons.includes(normalizedReason)) {
      console.error(`Pi emitted an unknown compaction reason: ${normalizedReason}`);
    }
    this.compactionEvidenceVersion++;
    this.compactionAttemptActive = true;
    this.compactionRequiresSettlement = normalizedReason !== "manual";
    this.compactionAgentSettled = false;
    this.observedCompactionActive = true;
    if (this.compacting) {
      this.compactionRetryPending = false;
      this.compactionFinishing = false;
      this.pendingCompactionOutcome = undefined;
      this.compactionCompletionEvent = false;
      return;
    }
    this.compactionAnchor = this.captureCompactionAnchor();
    this.compacting = true;
    this.compactionFinishing = false;
    this.compactionRetryPending = false;
    this.compactionGeneration++;
    this.emit({ type: "compaction_start", reason: normalizedReason });
    void this.refreshContext();
  }

  private onCompactionEnd(record: RpcRecord): void {
    this.recordDebugEvent("compaction_end", {
      success: !!asRecord(record.result) && record.aborted !== true && typeof record.errorMessage !== "string",
      aborted: record.aborted === true,
      willRetry: record.willRetry === true,
      ...(typeof record.reason === "string" && ["manual", "threshold", "overflow"].includes(record.reason)
        ? { reason: record.reason }
        : {}),
      ...(typeof record.errorMessage === "string" ? { errorType: "CompactionError" } : {}),
    });
    const generation = this.compactionGeneration;
    this.compactionEvidenceVersion++;
    this.compactionFinishing = false;
    this.compactionAttemptActive = false;
    if (record.willRetry === true) {
      this.compacting = true;
      this.compactionRetryPending = true;
      this.compactionFinishing = false;
    } else {
      this.compactionRetryPending = false;
    }
    const aborted = record.aborted === true;
    const result = asRecord(record.result);
    const error = typeof record.errorMessage === "string" ? record.errorMessage : undefined;
    const reason = typeof record.reason === "string" && ["manual", "threshold", "overflow"].includes(record.reason)
      ? record.reason
      : this.compactionReason;
    void this.monitorCompaction(generation, {
      success: !aborted && !!result && !error,
      aborted,
      ...(reason ? { reason } : {}),
      ...(isFiniteNumber(result?.tokensBefore) && result.tokensBefore >= 0 ? { tokensBefore: result.tokensBefore } : {}),
      ...(isFiniteNumber(result?.estimatedTokensAfter) && result.estimatedTokensAfter >= 0
        ? { estimatedTokensAfter: result.estimatedTokensAfter }
        : {}),
      ...(error ? { error } : {}),
    }, true);
  }

  private captureCompactionAnchor(): CompactionAnchor {
    const persistentMessages = this.transcript.filter((item) =>
      item.type !== "compaction" && item.type !== "tool",
    );
    const last = persistentMessages[persistentMessages.length - 1];
    return {
      ...(last?.persistedId ? { afterId: last.persistedId } : {}),
      afterIndex: persistentMessages.length - 1,
      ...(last ? { anchorId: last.id } : {}),
    };
  }

  private monitorCompaction(
    generation: number,
    outcome: CompactionOutcome,
    completionEvent = false,
    evidenceVersion = this.compactionEvidenceVersion,
  ): Promise<void> {
    if (generation !== this.compactionGeneration) return Promise.resolve();
    if (!this.compactionCompletionEvent || completionEvent) this.pendingCompactionOutcome = outcome;
    this.compactionCompletionEvent ||= completionEvent;
    if (this.compactionMonitor) return this.compactionMonitor;
    this.compactionMonitor = (async () => {
      while (generation === this.compactionGeneration && evidenceVersion === this.compactionEvidenceVersion && this.compacting) {
        const state = await this.refreshPiState();
        if (generation !== this.compactionGeneration || evidenceVersion !== this.compactionEvidenceVersion) return;
        if (this.compactionRetryPending || this.compactionAttemptActive || asRecord(state)?.isCompacting === true) {
          await new Promise((resolve) => setTimeout(resolve, COMPACTION_STATE_RECHECK_MS));
          continue;
        }
        const stateConfirmsFinished = asRecord(state)?.isCompacting === false &&
          asRecord(state)?.isStreaming === false &&
          (!this.compactTimeoutRequiresObservedStart || this.observedCompactionActive);
        const lifecycleConfirmsFinished = this.compactionRequiresSettlement
          ? this.compactionAgentSettled
          : this.compactionCompletionEvent || this.pendingCompactionOutcome !== undefined;
        if (stateConfirmsFinished && lifecycleConfirmsFinished) {
          const confirmedOutcome = this.pendingCompactionOutcome ?? { success: false, aborted: false };
          await this.finishCompaction(generation, evidenceVersion, confirmedOutcome);
          if (!this.compacting) return;
        }
        await new Promise((resolve) => setTimeout(resolve, COMPACTION_STATE_RECHECK_MS));
      }
    })().finally(() => {
      this.compactionMonitor = undefined;
      if (generation === this.compactionGeneration &&
        evidenceVersion !== this.compactionEvidenceVersion &&
        this.compacting) {
        void this.monitorCompaction(
          generation,
          this.pendingCompactionOutcome ?? { success: false, aborted: false },
          this.compactionCompletionEvent,
          this.compactionEvidenceVersion,
        );
      }
    });
    return this.compactionMonitor;
  }

  private async finishCompaction(
    generation: number,
    evidenceVersion: number,
    outcome: CompactionOutcome,
  ): Promise<void> {
    if (generation !== this.compactionGeneration || this.compactionFinishing || this.compactionRetryPending) return;
    this.compactionFinishing = true;
    const createdAt = new Date().toISOString();
    await this.refreshContext();
    if (generation !== this.compactionGeneration || evidenceVersion !== this.compactionEvidenceVersion) return;
    if (this.compactionRetryPending || this.compactionAttemptActive) {
      this.compactionFinishing = false;
      return;
    }
    let historyEntry: Extract<TranscriptItem, { type: "compaction" }> | undefined;
    if (outcome.success) {
      const anchor = this.compactionAnchor ?? this.captureCompactionAnchor();
      const reason = outcome.reason ?? this.compactionReason;
      const entry: PersistedCompaction = {
        type: "compaction",
        id: `compaction-${randomUUID()}`,
        createdAt,
        ...(anchor.afterId ? { afterId: anchor.afterId } : {}),
        afterIndex: anchor.afterIndex,
        ...(reason ? { reason } : {}),
        ...(outcome.tokensBefore !== undefined ? { tokensBefore: outcome.tokensBefore } : {}),
        ...(outcome.estimatedTokensAfter !== undefined
          ? { estimatedTokensAfter: outcome.estimatedTokensAfter }
          : {}),
      };
      if (this.sessionFile) {
        try {
          await this.persistMetadata(entry);
        } catch (error) {
          console.error(`Pi-vot could not persist a compaction history event: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.transcript = mergePersistedCompactions(this.transcript, [entry]);
      historyEntry = {
        id: entry.id,
        type: "compaction",
        createdAt,
        ...(anchor.afterId ? { afterId: anchor.afterId } : {}),
        afterIndex: anchor.afterIndex,
        ...(reason ? { reason } : {}),
        ...(outcome.tokensBefore !== undefined ? { tokensBefore: outcome.tokensBefore } : {}),
        ...(outcome.estimatedTokensAfter !== undefined
          ? { estimatedTokensAfter: outcome.estimatedTokensAfter }
          : {}),
        ...(anchor.anchorId ? { anchorId: anchor.anchorId } : {}),
      };
    }
    if (generation !== this.compactionGeneration || evidenceVersion !== this.compactionEvidenceVersion) return;
    this.compacting = false;
    this.compactionFinishing = false;
    this.compactionRetryPending = false;
    this.compactionAttemptActive = false;
    this.compactionRequiresSettlement = false;
    this.compactionAgentSettled = false;
    this.compactTimeoutRequiresObservedStart = false;
    this.observedCompactionActive = false;
    this.pendingCompactionOutcome = undefined;
    this.compactionCompletionEvent = false;
    this.compactionAnchor = undefined;
    this.compactionReason = undefined;
    this.emit({
      type: "compaction_end",
      success: outcome.success,
      aborted: outcome.aborted,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.error && isNothingToCompactError(outcome.error) ? { informational: true } : {}),
      ...(historyEntry ? { entry: historyEntry } : {}),
    });
    void this.drainQueuedMessages();
  }

  private async drainQueuedMessages(): Promise<void> {
    if (this.drainingQueue || this.compacting || this.runState !== "idle" ||
      this.queuedTurnInFlightId || this.queuedMessages.length === 0) return;
    this.drainingQueue = true;
    const queued = this.queuedMessages[0]!;
    this.queuedTurnInFlightId = queued.id;
    this.queueDispatchPending = true;
    this.queuedTurnSettledBeforeResponse = false;
    try {
      const disposition = await this.sendMessage(queued.message, queued.id, queued.images);
      if (disposition !== "queued" && this.queuedMessages[0]?.id === queued.id) {
        this.queuedMessages.shift();
        this.emit({ type: "queued_message_sent", id: queued.id, disposition });
      }
      if (disposition === "handled" || this.queuedTurnSettledBeforeResponse) {
        this.queuedTurnInFlightId = undefined;
      } else if (disposition === "queued") {
        this.queuedTurnInFlightId = undefined;
      }
    } catch (error) {
      if (this.queuedMessages[0]?.id === queued.id) {
        this.queuedMessages.shift();
        this.emit({
          type: "queued_message_failed",
          id: queued.id,
          error: error instanceof Error ? error.message : "Pi could not accept the queued message.",
        });
      }
      this.queuedTurnInFlightId = undefined;
    } finally {
      const settledBeforeResponse = this.queuedTurnSettledBeforeResponse;
      this.queueDispatchPending = false;
      this.queuedTurnSettledBeforeResponse = false;
      this.drainingQueue = false;
      if (!this.compacting && this.runState === "idle" && !this.queuedTurnInFlightId &&
        (settledBeforeResponse || this.queuedMessages[0]?.id !== queued.id)) {
        void this.drainQueuedMessages();
      }
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
        this.recordDebugEvent("rpc_timeout", {
          commandType: /^[a-z_]{1,50}$/.test(type) ? type : "other",
        });
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
        this.recordDebugEvent("rpc_error", { errorType: "PiCommandError" });
        request.reject(new Error(typeof record.error === "string" ? record.error : "Pi rejected the command."));
      } else {
        request.resolve(record);
      }
      return;
    }

    switch (record.type) {
      case "agent_start":
        this.recordDebugEvent("agent_start");
        this.lifecycleVersion++;
        this.compactionEvidenceVersion++;
        this.compactionAgentSettled = false;
        if (this.compacting) {
          this.compactionRetryPending = false;
          this.compactionFinishing = false;
        }
        this.setState("running");
        break;
      case "agent_end":
        this.recordDebugEvent("agent_end", { willRetry: record.willRetry === true });
        break;
      case "agent_settled":
        this.recordDebugEvent("agent_settled");
        this.discardIncompleteThinking();
        this.lifecycleVersion++;
        this.currentAssistant = undefined;
        if (this.runState !== "failed") this.setState("idle");
        if (this.queuedTurnInFlightId) {
          if (this.queueDispatchPending) this.queuedTurnSettledBeforeResponse = true;
          else this.queuedTurnInFlightId = undefined;
        }
        this.emit({ type: "agent_settled" });
        this.compactionEvidenceVersion++;
        this.compactionAgentSettled = true;
        if (this.compacting) {
          this.compactionFinishing = false;
          this.compactionRetryPending = false;
          this.compactionAttemptActive = false;
          void this.monitorCompaction(
            this.compactionGeneration,
            this.pendingCompactionOutcome ?? { success: false, aborted: false },
            this.compactionCompletionEvent,
          );
        }
        if (!this.closing) {
          void this.refreshPersistedState();
          if (!this.compacting) void this.drainQueuedMessages();
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
    this.discardIncompleteThinking();
    const messageId = `assistant-${++this.messageId}`;
    const authoritativeTimestamp = timestampFrom(message.timestamp);
    const createdAt = authoritativeTimestamp ?? new Date().toISOString();
    this.currentAssistant = {
      messageId,
      ...(typeof message.id === "string" ? { piMessageId: message.id } : {}),
      text: "",
      thinking: "",
      createdAt,
      timestampIsFallback: !authoritativeTimestamp,
      compactionInternal: this.compactionAttemptActive,
    };
    if (this.currentAssistant.compactionInternal) return;
    this.updateLiveAssistant();
    this.emit({ type: "assistant_start", messageId, createdAt });
  }

  private onMessageUpdate(record: RpcRecord): void {
    const event = asRecord(record.assistantMessageEvent);
    if (event?.contextUsage !== undefined || event?.usage !== undefined ||
      event?.type === "usage_update" || event?.type === "token_count") {
      void this.refreshContext();
    }
    const delta = event?.delta;
    if (!this.currentAssistant || typeof delta !== "string") return;
    if (event?.type === "text_delta") {
      this.currentAssistant.text += delta;
      if (this.currentAssistant.compactionInternal) return;
      this.updateLiveAssistant();
      this.emit({ type: "assistant_delta", messageId: this.currentAssistant.messageId, text: delta });
    } else if (event?.type === "thinking_delta") {
      this.currentAssistant.thinking += delta;
      if (this.currentAssistant.compactionInternal) return;
      this.updateLiveAssistant();
      this.emit({ type: "thinking_delta", messageId: this.currentAssistant.messageId, text: delta });
    }
  }

  private onMessageEnd(record: RpcRecord): void {
    const message = asRecord(record.message);
    if (message?.role !== "assistant" || !this.currentAssistant) return;
    const current = this.currentAssistant;
    if (current.compactionInternal) {
      this.currentAssistant = undefined;
      return;
    }
    current.text = messageContent(message, "text");
    current.thinking = messageContent(message, "thinking");
    const hasToolCall = Array.isArray(message.content) &&
      message.content.some((item) => asRecord(item)?.type === "toolCall");
    if (!current.text.trim() && !hasToolCall) {
      this.discardIncompleteThinking();
      void this.refreshContext();
      return;
    }
    const authoritativeTimestamp = timestampFrom(message.timestamp);
    if (authoritativeTimestamp) {
      current.createdAt = authoritativeTimestamp;
      current.timestampIsFallback = false;
    }
    if (typeof message.id === "string") current.piMessageId = message.id;
    this.updateLiveAssistant();
    this.emit({
      type: "assistant_end",
      messageId: current.messageId,
      text: current.text,
      thinking: current.thinking,
      createdAt: current.createdAt,
    });
    this.currentAssistant = undefined;
    if (current.timestampIsFallback && this.sessionFile) {
      void this.persistMetadata({
        type: "timestamp_fallback",
        localId: current.messageId,
        role: "assistant",
        createdAt: current.createdAt,
        contentHash: contentHash("assistant", current.text),
        ...(current.piMessageId ? { piMessageId: current.piMessageId } : {}),
      });
    }
    void this.refreshContext();
  }

  private discardIncompleteThinking(): void {
    const current = this.currentAssistant;
    if (!current) return;
    this.currentAssistant = undefined;
    if (current.compactionInternal || current.text.trim()) return;
    this.transcript = this.transcript.filter((item) => item.id !== current.messageId);
    this.emit({ type: "assistant_discard", messageId: current.messageId });
  }

  private onToolStart(record: RpcRecord): void {
    if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") return;
    this.recordDebugEvent("tool_start", {
      toolName: /^[a-zA-Z0-9_.-]{1,80}$/.test(record.toolName) ? record.toolName : "other",
    });
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
    this.recordDebugEvent("tool_end", {
      toolName: /^[a-zA-Z0-9_.-]{1,80}$/.test(record.toolName) ? record.toolName : "other",
      isError: record.isError === true,
    });
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
    void this.refreshContext();
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
      createdAt: current.createdAt,
      ...(current.thinking ? { thinking: current.thinking } : {}),
      ...(current.piMessageId ? { persistedId: current.piMessageId } : {}),
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
    this.recordDebugEvent("state", { state, ...(error ? { errorType: "PiError" } : {}) });
    this.emit({ type: "state", state, ...(error ? { error } : {}) });
  }

  private recordDebugEvent(event: string, details: Record<string, unknown> = {}): void {
    if (!piVotDebugLogEnabled(this.discoveryContext.env) || !this.sessionFile) return;
    const sessionPath = this.sessionFile;
    this.debugLogWrite = this.debugLogWrite.then(async () => {
      await appendPiVotDebugEvent(sessionPath, event, details, this.discoveryContext.env);
    }).catch(() => {
      // Optional diagnostics must never disrupt Pi-vot session processing.
    });
  }

  private emit(event: PiVotEvent): void {
    if (event.type === "notice") this.status = { kind: "notice", message: event.message };
    else if (event.type === "error") this.status = { kind: "error", message: event.message };
    else if (event.type === "compaction_start") {
      this.status = { kind: "compaction", message: "Pi is compacting the session…" };
    }     else if (event.type === "compaction_end") this.status = null;
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
