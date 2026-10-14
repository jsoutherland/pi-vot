import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  PiService,
  appendPiVotDebugEvent,
  createPiSpawnSpec,
  deletePiSessionFiles,
  discoverPiSessions,
  hydratePiSession,
  piVotDebugLogEnabled,
  piVotDebugLogPath,
  piSessionDirectoryName,
  resolvePiExecutable,
  resolvePiSessionDirectory,
  type PiVotEvent,
} from "../src/pi-service.ts";

test("Pi executable resolution cannot be shadowed by files in the selected project", () => {
  const project = "C:\\untrusted\\project";
  const trusted = "C:\\trusted\\npm";
  for (const projectExecutable of ["pi.cmd", "pi.exe"]) {
    const selectedFile = `${project}\\${projectExecutable}`;
    const trustedFile = `${trusted}\\${projectExecutable}`;
    const candidates: string[] = [];
    const executable = resolvePiExecutable(
      { PATH: trusted },
      "win32",
      (candidate) => {
        candidates.push(candidate);
        return candidate.toLowerCase() === trustedFile.toLowerCase() ||
          candidate.toLowerCase() === selectedFile.toLowerCase();
      },
    );
    assert.equal(executable, trustedFile);
    assert.ok(!candidates.includes(selectedFile));
  }
});

test("Pi-vot debug logging accepts 1/true case-insensitively and retains concise event history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-vot-debug-log-"));
  const sessionPath = join(directory, "session.jsonl");
  const logPath = piVotDebugLogPath(sessionPath);
  try {
    assert.equal(piVotDebugLogEnabled({ PI_VOT_DEBUG: "1" }), true);
    assert.equal(piVotDebugLogEnabled({ PI_VOT_DEBUG: "TRUE" }), true);
    assert.equal(piVotDebugLogEnabled({ PI_VOT_DEBUG: " yes " }), false);
    await appendPiVotDebugEvent(sessionPath, "disabled", {}, {});
    await assert.rejects(stat(logPath), { code: "ENOENT" });
    for (let index = 0; index < 2_000; index++) {
      await appendPiVotDebugEvent(sessionPath, "event", { index }, { PI_VOT_DEBUG: "true" });
    }
    const contents = await readFile(logPath, "utf8");
    assert.ok(Buffer.byteLength(contents) > 64 * 1024);
    assert.match(contents, /"index":0\}/);
    assert.match(contents, /"index":1999\}/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi executable resolution is independent of project cwd changes", () => {
  const resolved = resolvePiExecutable(
    { PATH: "C:\\trusted\\bin" },
    "win32",
    (candidate) => candidate.toLowerCase() === "c:\\trusted\\bin\\pi.exe",
  );
  const firstProject = createPiSpawnSpec(resolved, "C:\\project-one", "win32");
  const secondProject = createPiSpawnSpec(resolved, "C:\\project-two", "win32");
  assert.equal(firstProject.command, secondProject.command);
  assert.deepEqual(firstProject.args, secondProject.args);
  assert.equal(firstProject.options.cwd, "C:\\project-one");
  assert.equal(secondProject.options.cwd, "C:\\project-two");
});

test("fresh Pi sessions start RPC directly on the requested persisted session ID", () => {
  const id = "9e859972-24c4-48b6-8db9-f84d2ff7c752";
  const spec = createPiSpawnSpec("/usr/bin/pi", "/project", "linux", undefined, id);
  assert.deepEqual(spec.args, ["--mode", "rpc", "--session-id", id]);
  assert.throws(
    () => createPiSpawnSpec("/usr/bin/pi", "/project", "linux", undefined, "bad id; command"),
    /unsupported characters/,
  );
});

test("Windows PATH resolution selects a native Pi launcher and ignores the extensionless npm shim", () => {
  const directory = "C:\\Users\\south\\AppData\\Roaming\\npm";
  const checked: string[] = [];
  const executable = resolvePiExecutable(
    { PATH: directory },
    "win32",
    (candidate) => {
      checked.push(candidate);
      return candidate.toLowerCase() === `${directory}\\pi.cmd`.toLowerCase();
    },
  );
  assert.equal(executable, `${directory}\\pi.cmd`);
  assert.ok(!checked.includes(`${directory}\\pi`));
});

test("Windows Pi cmd launchers use their absolute path without shell-injectable arguments", () => {
  const launcher = "C:\\Program Files\\Pi & Tools\\pi.cmd";
  const spec = createPiSpawnSpec(launcher, "C:\\project & echo unsafe", "win32", "C:\\Windows");
  assert.equal(spec.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(spec.args, ["/d", "/v:off", "/s", "/c", `""${launcher}" --mode rpc"`]);
  assert.equal(spec.options.cwd, "C:\\project & echo unsafe");
  assert.equal(spec.options.shell, false);
  assert.equal(spec.options.windowsVerbatimArguments, true);
  assert.equal(
    createPiSpawnSpec("C:\\Pi\\pi.exe", "C:\\project", "win32").options.windowsVerbatimArguments,
    undefined,
  );
  assert.throws(
    () => createPiSpawnSpec('C:\\Pi\\pi.cmd" & whoami.cmd', "C:\\project", "win32"),
    /cannot be safely invoked/,
  );
  assert.throws(
    () => createPiSpawnSpec("C:\\100%\\pi.cmd", "C:\\project", "win32"),
    /cannot be safely invoked/,
  );
});

test("Windows cmd and bat Pi launchers execute with exact RPC arguments and cwd", {
  skip: process.platform !== "win32",
  timeout: 15_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vot-windows-launch-"));
  const project = join(root, "Project & echo INJECTED & Workspace");
  const installations = [join(root, "Pi & echo INJECTED & Tools")];
  await mkdir(project, { recursive: true });

  try {
    for (const extension of [".cmd", ".bat"]) {
      const installation = join(installations[0]!, extension.slice(1));
      await mkdir(installation, { recursive: true });
      const launcher = join(installation, `pi${extension}`);
      const record = join(installation, "launcher-record.txt");
      const cwdRecord = join(installation, "cwd-record.txt");
      await writeFile(launcher, [
        "@echo off",
        `> "%~dp0launcher-record.txt" echo executed`,
        `>> "%~dp0launcher-record.txt" echo arg1=[%~1]`,
        `>> "%~dp0launcher-record.txt" echo arg2=[%~2]`,
        `>> "%~dp0launcher-record.txt" echo arg3=[%~3]`,
        `cd > "%~dp0cwd-record.txt"`,
        "echo startup-stdout",
        ">&2 echo startup-stderr",
        "exit /b 23",
        "",
      ].join("\r\n"));
      await writeFile(join(project, `pi${extension}`), "@echo off\r\nexit /b 99\r\n");

      const executable = resolvePiExecutable({ PATH: dirname(launcher) }, "win32");
      assert.equal(executable, launcher);
      const spec = createPiSpawnSpec(executable, project, "win32");
      assert.equal(spec.options.shell, false);
      assert.equal(spec.command.toLowerCase().endsWith("\\system32\\cmd.exe"), true);
      assert.equal(spec.options.windowsVerbatimArguments, true);
      assert.ok(!spec.args.some((argument) => argument.includes("\\\"")));

      const child = spawn(spec.command, spec.args, spec.options);
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const timeout = setTimeout(() => child.kill(), 10_000);
      let result: { code: number | null; signal: NodeJS.Signals | null };
      try {
        result = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
      } finally {
        clearTimeout(timeout);
      }

      assert.equal(result.signal, null, stderr);
      assert.equal(result.code, 23, stderr);
      assert.match(stdout, /startup-stdout/);
      assert.match(stderr, /startup-stderr/);
      assert.equal(stdout.includes("INJECTED"), false, stdout);
      assert.deepEqual((await readFile(record, "utf8")).trim().split(/\r?\n/), [
        "executed",
        "arg1=[--mode]",
        "arg2=[rpc]",
        "arg3=[]",
      ]);
      assert.equal((await readFile(cwdRecord, "utf8")).trim(), project);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi executable configuration requires an absolute existing supported file", () => {
  assert.throws(
    () => resolvePiExecutable({ PI_VOT_PI_EXECUTABLE: "pi.cmd" }, "win32", () => true),
    /must be an absolute path/,
  );
  assert.throws(
    () => resolvePiExecutable(
      { PI_VOT_PI_EXECUTABLE: "C:\\Pi\\pi.cmd" },
      "win32",
      () => false,
    ),
    /existing Pi executable/,
  );
  assert.equal(
    resolvePiExecutable(
      { PI_VOT_PI_EXECUTABLE: "C:\\Pi\\pi.cmd" },
      "win32",
      () => true,
    ),
    "C:\\Pi\\pi.cmd",
  );
});

test("missing Pi produces an actionable installation diagnostic", async () => {
  const service = new PiService(
    "/fake/project",
    undefined,
    undefined,
    { env: { PATH: "" }, home: "/fake/home" },
  );
  await assert.rejects(
    service.sendMessage("hello"),
    /Pi was not found in an absolute PATH directory.*Install Pi.*PI_VOT_PI_EXECUTABLE/,
  );
});

interface Command {
  id?: string;
  type?: string;
  [key: string]: unknown;
}

const testDiscoveryContext = {
  env: { PI_CODING_AGENT_DIR: join(tmpdir(), `pi-vot-test-agent-${process.pid}`) },
  home: join(tmpdir(), `pi-vot-test-home-${process.pid}`),
};

class FakePiProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly commands: Command[] = [];
  exitCode: number | null = null;
  killed = false;
  shutdownGate?: Promise<void>;
  onCommand: (command: Command) => void = (command) => {
    const data = command.type === "prompt"
      ? { disposition: "started" }
      : command.type === "get_state"
      ? { isStreaming: false, isCompacting: false }
      : command.type === "get_session_stats"
      ? { contextUsage: null }
      : undefined;
    this.respond(command, { data });
  };

  constructor() {
    super();
    this.stdin = new Writable({
      highWaterMark: 1,
      write: (chunk, _encoding, callback) => {
        setTimeout(() => {
          const command = JSON.parse(String(chunk).trim()) as Command;
          this.commands.push(command);
          this.onCommand(command);
          callback();
        }, 5);
      },
    });
    this.stdin.on("finish", () => {
      void (this.shutdownGate ?? Promise.resolve()).then(() => this.close(0));
    });
    setImmediate(() => this.emit("spawn"));
  }

  respond(command: Command, extra: Record<string, unknown> = {}): void {
    this.emitRecord({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      ...extra,
    });
  }

  emitRecord(record: unknown, split = false): void {
    const line = `${JSON.stringify(record)}\n`;
    if (split) {
      const middle = Math.floor(line.length / 2);
      this.stdout.write(line.slice(0, middle));
      this.stdout.write(line.slice(middle));
    } else {
      this.stdout.write(line);
    }
  }

  close(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }

  kill(): boolean {
    this.killed = true;
    this.close(1);
    return true;
  }
}

function setup(compactTimeoutMs = 120_000) {
  const child = new FakePiProcess();
  const service = new PiService(
    "/fake/project",
    () => child as unknown as ChildProcessWithoutNullStreams,
    compactTimeoutMs,
    testDiscoveryContext,
  );
  const events: PiVotEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { child, service, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the fake Pi state.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("RPC command IDs correlate concurrent commands regardless of response order", async () => {
  const { child, service, events } = setup();
  let promptFinished = false;
  let releasePrompt!: () => void;
  const delayedPrompt = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  child.onCommand = (command) => {
    if (command.type === "prompt") {
      child.emitRecord({ type: "agent_start" });
      void delayedPrompt.then(() => {
        child.respond(command, { data: { disposition: "started" } });
        promptFinished = true;
      });
    } else if (command.type === "abort") {
      child.emitRecord({ type: "agent_settled" });
      child.respond(command);
    } else {
      child.respond(command, { data: { disposition: "queued" } });
    }
  };

  const prompt = service.sendMessage("first");
  while (service.state !== "running") await new Promise((resolve) => setTimeout(resolve, 1));
  await service.abort();
  assert.equal(promptFinished, false);
  releasePrompt();
  assert.equal(await prompt, "started");
  assert.equal(service.state, "idle");

  child.onCommand = (command) => {
    if (command.type === "prompt") child.emitRecord({ type: "agent_start" });
    if (command.type === "abort") child.emitRecord({ type: "agent_settled" });
    child.respond(command, { data: command.type === "prompt" ? { disposition: "started" } : { disposition: "queued" } });
  };
  assert.equal(await service.sendMessage("next"), "started");
  assert.equal(await service.sendMessage("steering"), "steered");
  assert.deepEqual(child.commands.map(({ type }) => type).filter((type) =>
    ["prompt", "abort", "steer", "compact"].includes(type ?? ""),
  ), ["prompt", "abort", "prompt", "steer"]);
  await service.stop();
});

test("native prompt and steer carry structured images only for models with image input", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: {
        model: { provider: "fake", id: "vision", name: "Vision", input: ["text", "image"] },
        isStreaming: false,
      } });
    }
    else if (command.type === "get_session_stats") child.respond(command, { data: { contextUsage: null } });
    else if (command.type === "prompt" || command.type === "steer") {
      child.respond(command, { data: { disposition: "started" } });
    }
    else child.respond(command);
  };
  const image = {
    mimeType: "image/png",
    data: "iVBORw0KGgo=",
    name: "screenshot.png",
    size: 8,
  };

  assert.equal(await service.sendMessage("describe", "prompt-image", [image]), "started");
  const prompt = child.commands.find((command) => command.type === "prompt");
  assert.deepEqual(prompt, {
    id: prompt?.id,
    type: "prompt",
    message: "describe",
    images: [{ type: "image", mimeType: "image/png", data: image.data }],
  });
  const firstMessage = service.snapshot().transcript[0];
  assert.equal(firstMessage?.type, "user");
  if (firstMessage?.type === "user")
    assert.equal(firstMessage.imageCount, 1);

  child.emitRecord({ type: "agent_start" });
  assert.equal(await service.sendMessage("also inspect", "steer-image", [image]), "steered");
  const steer = child.commands.find((command) => command.type === "steer");
  assert.deepEqual(steer && { type: steer.type, message: steer.message, images: steer.images }, {
    type: "steer",
    message: "also inspect",
    images: [{ type: "image", mimeType: "image/png", data: image.data }],
  });
  await service.stop();
});

test("explicit Send, Queue, and Steer use prompt, local FIFO, and steer behavior", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: {
        model: { provider: "fake", id: "vision", name: "Vision", input: ["text", "image"] },
        isStreaming: false,
        isCompacting: false,
      } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else {
      child.respond(command, { data: command.type === "prompt" ? { disposition: "started" } : undefined });
    }
  };
  const image = { mimeType: "image/png", data: "iVBORw0KGgo=", size: 8 };
  await assert.rejects(service.sendMessage("wrong mode", "mode-idle-queue", [], "queue"), /not running/);
  assert.equal(await service.sendMessage("start normally", "mode-send", [], "send"), "started");
  await assert.rejects(service.sendMessage("late normal send", "mode-busy-send", [], "send"), /already responding/);
  assert.equal(await service.sendMessage("queue next", "mode-queue", [image], "queue"), "queued");
  assert.equal(await service.sendMessage("steer now", "mode-steer", [], "steer"), "steered");

  const submitted = child.commands.filter((command) =>
    ["prompt", "follow_up", "steer"].includes(command.type ?? ""),
  );
  assert.deepEqual(submitted.map(({ type, message }) => [type, message]), [
    ["prompt", "start normally"],
    ["steer", "steer now"],
  ]);
  assert.equal(submitted.some((command) => command.message === "late normal send"), false);
  assert.deepEqual(service.snapshot().queuedMessages.map(({ id, reason }) => [id, reason]), [["mode-queue", "turn"]]);
  assert.ok(events.some((event) => event.type === "queued_message" && event.id === "mode-queue" && event.imageCount === 1));

  child.emitRecord({ type: "compaction_start", reason: "manual" });
  await assert.rejects(service.sendMessage("during compaction", "mode-compacting", [], "steer"), /compacting/);
  assert.equal(child.commands.some((command) => command.message === "during compaction"), false);
  await service.stop();
});

test("non-image models reject image input and compaction queues retain image payloads in FIFO order", async () => {
  const unsupported = setup();
  unsupported.child.onCommand = (command) => {
    if (command.type === "get_state") {
      unsupported.child.respond(command, { data: {
        model: { provider: "fake", id: "text", name: "Text", input: ["text"] },
        isStreaming: false,
      } });
    }
    else unsupported.child.respond(command, { data: { contextUsage: null } });
  };
  const image = { mimeType: "image/png", data: "iVBORw0KGgo=", size: 8 };
  await assert.rejects(unsupported.service.sendMessage("blocked", "blocked-image", [image]), /does not support image input/);
  assert.equal(unsupported.child.commands.some((command) => command.type === "prompt"), false);
  await unsupported.service.stop();

  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: {
        model: { provider: "fake", id: "vision", name: "Vision", input: ["text", "image"] },
        isStreaming: false,
      } });
    }
    else if (command.type === "prompt") child.respond(command, { data: { disposition: "started" } });
    else child.respond(command, { data: { contextUsage: null } });
  };
  const internal = service as unknown as {
    compacting: boolean;
    drainQueuedMessages(): Promise<void>;
  };
  internal.compacting = true;
  assert.equal(await service.sendMessage("first", "queue-image-1", [image]), "queued");
  assert.equal(await service.sendMessage("second", "queue-image-2", [image, image]), "queued");
  assert.deepEqual(service.snapshot().queuedMessages, [
    { id: "queue-image-1", message: "first", imageCount: 1, reason: "compaction" },
    { id: "queue-image-2", message: "second", imageCount: 2, reason: "compaction" },
  ]);
  internal.compacting = false;
  await internal.drainQueuedMessages();
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => child.commands.filter((command) => command.type === "prompt").length === 2);
  assert.deepEqual(child.commands.filter((command) =>
    command.type === "prompt" || command.type === "steer",
  ).map((command) => ({
    type: command.type,
    message: command.message,
    count: Array.isArray(command.images) ? command.images.length : 0,
  })), [
    { type: "prompt", message: "first", count: 1 },
    { type: "prompt", message: "second", count: 2 },
  ]);
  await service.stop();
});

test("assistant and thinking deltas stream, then canonical message_end content wins", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => {
    child.emitRecord({ type: "agent_start" });
    child.respond(command, { data: { disposition: "started" } });
  };
  await service.sendMessage("stream");
  child.emitRecord({ type: "message_start", message: { role: "assistant", content: [] } }, true);
  const assistantStart = events.find((event) => event.type === "assistant_start");
  assert.ok(assistantStart?.type === "assistant_start");
  assert.ok(typeof assistantStart.createdAt === "string");
  child.emitRecord({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "approx " } }, true);
  child.emitRecord({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "reason " } });
  child.emitRecord({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "canonical reasoning" },
        { type: "text", text: "canonical answer" },
      ],
    },
  });
  child.emitRecord({ type: "agent_end", messages: [], willRetry: true });
  assert.equal(service.state, "running");
  assert.ok(service.snapshot().transcript.some((item) =>
    item.type === "assistant" && item.text === "canonical answer" && item.thinking === "canonical reasoning",
  ));
  const assistantMessage = service.snapshot().transcript.find((item) => item.type === "assistant");
  assert.equal(assistantMessage?.type, "assistant");
  if (assistantMessage?.type === "assistant") {
    assert.equal(typeof assistantMessage.createdAt, "string");
    assert.equal(assistantMessage.createdAt, assistantStart.createdAt);
  }
  child.emitRecord({ type: "agent_settled" });
  assert.equal(service.state, "idle");
  assert.ok(events.some((event) => event.type === "assistant_delta" && event.text === "approx "));
  assert.ok(events.some((event) => event.type === "thinking_delta" && event.text === "reason "));
  assert.ok(events.some((event) =>
    event.type === "assistant_end" &&
    event.text === "canonical answer" &&
    event.thinking === "canonical reasoning",
  ));
  await service.stop();
});

test("interrupted thinking-only assistant records are discarded during compaction and ignored on reload", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming: false, isCompacting: false } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "get_messages") {
      child.respond(command, { data: { messages: [
        { id: "partial", role: "assistant", content: [{ type: "thinking", thinking: "The" }] },
        { id: "truncated", role: "assistant", stopReason: "length", content: [{ type: "thinking", thinking: "The" }] },
        { id: "complete", role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "complete thought" }] },
      ] } });
    } else {
      child.respond(command);
    }
  };
  await service.initialize();
  assert.deepEqual(service.snapshot().transcript.filter((item) => item.type === "assistant").map((item) => item.id), ["complete"]);

  child.emitRecord({ type: "message_start", message: { role: "assistant" } }, true);
  child.emitRecord({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "The" } }, true);
  const firstPartial = [...events].reverse().find((event) => event.type === "assistant_start");
  assert.ok(firstPartial?.type === "assistant_start");
  child.emitRecord({ type: "message_start", message: { role: "assistant" } }, true);
  assert.ok(events.some((event) => event.type === "assistant_discard" && event.messageId === firstPartial.messageId));
  child.emitRecord({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "I" } }, true);
  const secondPartial = [...events].reverse().find((event) => event.type === "assistant_start");
  assert.ok(secondPartial?.type === "assistant_start");
  child.emitRecord({ type: "compaction_start", reason: "threshold" }, true);
  assert.ok(events.some((event) => event.type === "assistant_discard" && event.messageId === secondPartial.messageId));
  assert.equal(service.snapshot().transcript.some((item) => item.type === "assistant" &&
    (item.id === "partial" || item.id === firstPartial.messageId || item.id === secondPartial.messageId)), false);
  await service.stop();
});

test("tool lifecycle remains correlated by tool call ID and preserves error results", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => {
    child.emitRecord({ type: "agent_start" });
    child.respond(command, { data: { disposition: "started" } });
  };
  await service.sendMessage("tools");
  child.emitRecord({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.ts" } });
  child.emitRecord({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "pwd" } });
  child.emitRecord({ type: "tool_execution_update", toolCallId: "b", partialResult: { content: [{ type: "text", text: "working" }] } });
  child.emitRecord({
    type: "tool_execution_end",
    toolCallId: "a",
    toolName: "read",
    result: { content: [{ type: "text", text: "File read successfully." }] },
    isError: false,
  });
  child.emitRecord({
    type: "tool_execution_end",
    toolCallId: "b",
    toolName: "bash",
    result: { content: [{ type: "text", text: "failed" }] },
    isError: true,
  });
  assert.ok(service.snapshot().transcript.some((item) =>
    item.type === "tool" && item.toolCallId === "a" && item.output === "File read successfully.",
  ));
  assert.ok(events.some((event) => event.type === "tool_start" && event.toolCallId === "a"));
  assert.ok(events.some((event) => event.type === "tool_start" && event.toolCallId === "b"));
  assert.ok(events.some((event) => event.type === "tool_update" && event.toolCallId === "b" && event.output === "working"));
  assert.ok(events.some((event) => event.type === "tool_end" && event.toolCallId === "a" && !event.isError));
  assert.ok(events.some((event) => event.type === "tool_end" && event.toolCallId === "b" && event.isError));
  await service.stop();
});

test("a handled prompt is not treated as a new assistant response", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => child.respond(command, { data: { disposition: "handled" } });
  assert.equal(await service.sendMessage("/extension-command"), "handled");
  assert.ok(events.some((event) => event.type === "input_disposition" && event.disposition === "handled"));
  assert.equal(events.some((event) => event.type === "assistant_end"), false);
  assert.deepEqual(child.commands.map(({ type }) => type).filter((type) => type === "prompt"), ["prompt"]);
  await service.stop();
});

test("a newly started runtime initializes state and context RPC without failing", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming: false, isCompacting: false } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();

  assert.ok(child.commands.some(({ type }) => type === "get_state"));
  assert.ok(child.commands.some(({ type }) => type === "get_session_stats"));
  assert.equal(service.state, "idle");
  await service.stop();
});

test("initial RPC state failure after child exit rejects initialization with the process error", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "get_state") child.close(23);
    else child.respond(command);
  };

  await assert.rejects(service.initialize(), /Pi exited with code 23/);
  assert.equal(service.state, "failed");
  await assert.rejects(service.newSession(), /Pi exited with code 23/);
  await service.stop();
});

test("an established runtime tolerates advisory metadata refresh failures", async () => {
  const { child, service } = setup();
  await service.initialize();
  child.onCommand = (command) => {
    child.respond(command, { success: false, error: "Temporary metadata failure." });
  };

  await service.refreshPersistedState();

  assert.equal(service.state, "idle");
  await service.stop();
});

test("agent_end does not settle; agent_settled does", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    child.emitRecord({ type: "agent_start" });
    child.respond(command, { data: { disposition: "started" } });
  };
  await service.sendMessage("lifecycle");
  child.emitRecord({ type: "agent_end", messages: [], willRetry: false });
  assert.equal(service.state, "running");
  child.emitRecord({ type: "agent_settled" });
  assert.equal(service.state, "idle");
  await service.stop();
});

test("regular queued messages run as separate turns in FIFO order", async () => {
  const { child, service, events } = setup();
  let isStreaming = false;
  const promptMessages: string[] = [];
  child.onCommand = (command) => {
    if (command.type === "prompt") {
      promptMessages.push(String(command.message));
      isStreaming = true;
      child.emitRecord({ type: "agent_start" });
      child.respond(command, { data: { disposition: "started" } });
    } else if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming, isCompacting: false } });
    } else {
      child.respond(command);
    }
  };
  await service.sendMessage("current turn", "current-id");
  await service.sendMessage("first queued", "queue-one", [], "queue");
  await service.sendMessage("second queued", "queue-two", [], "queue");
  assert.deepEqual(service.snapshot().queuedMessages.map(({ id, reason }) => [id, reason]), [
    ["queue-one", "turn"],
    ["queue-two", "turn"],
  ]);

  isStreaming = false;
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => promptMessages.length === 2);
  assert.deepEqual(promptMessages, ["current turn", "first queued"]);
  assert.deepEqual(events.filter((event) => event.type === "queued_message_sent").map((event) => event.id), ["queue-one"]);

  isStreaming = false;
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => promptMessages.length === 3);
  await waitFor(() => events.filter((event) => event.type === "queued_message_sent").length === 2);
  assert.deepEqual(promptMessages, ["current turn", "first queued", "second queued"]);
  assert.deepEqual(events.filter((event) => event.type === "queued_message_sent").map((event) => event.id), ["queue-one", "queue-two"]);
  isStreaming = false;
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => service.snapshot().queuedMessages.length === 0);
  await service.stop();
});

test("compaction hides Pi's internal assistant messages and anchors history to the prior turn", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => {
    if (command.type === "prompt") {
      child.emitRecord({ type: "agent_start" });
      child.respond(command, { data: {
        disposition: "started",
        message: { id: "pi-user-anchor", timestamp: new Date().toISOString() },
      } });
    } else if (command.type === "compact") {
      child.emitRecord({ type: "compaction_start", reason: "manual" });
      child.emitRecord({ type: "message_start", message: { role: "assistant", content: [] } });
      child.emitRecord({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "internal summary" } });
      child.emitRecord({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "internal summary" }] } });
      child.emitRecord({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "internal", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      child.respond(command, { data: { summary: "internal" } });
    } else {
      child.respond(command, { data: command.type === "get_state"
        ? { isStreaming: false, isCompacting: false }
        : command.type === "get_session_stats" ? { contextUsage: null } : undefined });
    }
  };
  await service.sendMessage("preserve this turn", "anchor-user");
  await service.compact();
  await waitFor(() => events.some((event) => event.type === "compaction_end" && event.success));
  assert.equal(events.some((event) => event.type === "assistant_start" || event.type === "assistant_delta" || event.type === "assistant_end"), false);
  assert.equal(service.snapshot().transcript.some((item) => item.type === "assistant" && item.text === "internal summary"), false);
  const completion = events.find((event) => event.type === "compaction_end" && event.success);
  assert.ok(completion?.type === "compaction_end" && completion.entry?.anchorId === "anchor-user");
  assert.equal(completion?.type === "compaction_end" ? completion.entry?.reason : undefined, "manual");
  assert.equal(completion?.type === "compaction_end" ? completion.entry?.tokensBefore : undefined, 10_000);
  assert.equal(completion?.type === "compaction_end" ? completion.entry?.estimatedTokensAfter : undefined, 2_000);
  await service.stop();
});

test("a fast agent_settled event before the prompt response is not lost", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "prompt") {
      child.emitRecord({ type: "agent_start" });
      child.emitRecord({ type: "agent_settled" });
    }
    child.respond(command, { data: { disposition: "started" } });
  };
  await service.sendMessage("quick");
  assert.equal(service.state, "idle");
  await service.stop();
});

test("extension UI prompts are surfaced and safely cancelled with the RPC response", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => child.respond(command, { data: { disposition: "handled" } });
  await service.sendMessage("invoke extension");
  child.emitRecord({ type: "extension_ui_request", id: "extension-1", method: "confirm", title: "Continue?", message: "Proceed?" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(events.some((event) => event.type === "notice" && event.message.includes("does not support yet")));
  assert.ok(child.commands.some((command) =>
    command.type === "extension_ui_response" && command.id === "extension-1" && command.cancelled === true,
  ));
  await service.stop();
});

test("RPC errors are useful, malformed records are ignored, and stdin backpressure drains", async () => {
  const { child, service } = setup();
  let drains = 0;
  child.stdin.on("drain", () => drains++);
  child.onCommand = (command) => {
    child.emitRecord({ type: "response", id: "unexpected", success: true });
    child.emitRecord("{ invalid json");
    child.respond(command, { success: false, error: "The selected model is unavailable." });
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(service.sendMessage("fail"), /selected model is unavailable/);
  } finally {
    console.error = originalError;
  }
  assert.ok(drains > 0);
  await service.stop();
});

test("child exit rejects pending commands and marks the service disconnected", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    child.emitRecord({ type: "agent_start" });
  };
  const sending = service.sendMessage("wait");
  while (service.state !== "running") await new Promise((resolve) => setTimeout(resolve, 1));
  child.close(9);
  await assert.rejects(sending, /Pi exited with code 9/);
  assert.equal(service.state, "failed");
  await service.stop();
});

test("abort settles the session and the same Pi process accepts another prompt", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "prompt") child.emitRecord({ type: "agent_start" });
    if (command.type === "abort") child.emitRecord({ type: "agent_settled" });
    const data = command.type === "prompt"
      ? { disposition: "started" }
      : command.type === "get_state"
      ? { isStreaming: false, isCompacting: false }
      : command.type === "get_session_stats"
      ? { contextUsage: null }
      : undefined;
    child.respond(command, { data });
  };
  await service.sendMessage("first");
  await service.abort();
  assert.equal(service.state, "idle");
  assert.equal(await service.sendMessage("after abort"), "started");
  assert.deepEqual(child.commands.map(({ type }) => type).filter((type) =>
    ["prompt", "abort", "steer", "compact"].includes(type ?? ""),
  ), ["prompt", "abort", "prompt"]);
  await service.stop();
});

test("shutdown aborts active work, closes RPC input, and waits for the child", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "prompt") child.emitRecord({ type: "agent_start" });
    if (command.type === "abort") child.emitRecord({ type: "agent_settled" });
    const data = command.type === "prompt"
      ? { disposition: "started" }
      : command.type === "get_state"
      ? { isStreaming: false, isCompacting: false }
      : command.type === "get_session_stats"
      ? { contextUsage: null }
      : undefined;
    child.respond(command, { data });
  };
  await service.sendMessage("active");
  await service.stop();
  assert.deepEqual(child.commands.map(({ type }) => type).filter((type) =>
    ["prompt", "abort", "steer", "compact"].includes(type ?? ""),
  ), ["prompt", "abort"]);
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(child.exitCode, 0);
});

test("initial context and model come from Pi and unavailable usage never falls back to cumulative tokens", async () => {
  const { child, service, events } = setup();
  let model = { provider: "test-provider", id: "model-one", name: "Model One", contextWindow: 200_000 };
  let usage: unknown = { tokens: 134_982, contextWindow: 200_000, percent: 67.49 };
  let statsCalls = 0;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { model, isStreaming: false, isCompacting: false } });
    } else if (command.type === "get_session_stats") {
      statsCalls++;
      child.respond(command, {
        data: {
          tokens: { input: 999_000, output: 800_000, total: 1_799_000 },
          contextUsage: usage,
        },
      });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  assert.deepEqual(service.snapshot().model, {
    provider: "test-provider",
    id: "model-one",
    name: "Model One",
    contextWindow: 200_000,
  });
  assert.deepEqual(service.snapshot().context, {
    tokens: 134_982,
    contextWindow: 200_000,
    percent: 67.49,
  });

  model = { provider: "test-provider", id: "model-two", name: "Model Two", contextWindow: 256_000 };
  usage = { tokens: null, contextWindow: 190_000, percent: null };
  child.emitRecord({ type: "model_change", model });
  await waitFor(() => statsCalls >= 2 && service.snapshot().model?.id === "model-two");
  assert.deepEqual(service.snapshot().context, {
    tokens: null,
    contextWindow: 190_000,
    percent: null,
  });
  assert.equal(service.snapshot().model?.contextWindow, 256_000);
  assert.ok(events.some((event) => event.type === "context_update" && event.context.tokens === null));
  await service.stop();
});

test("model listing and switching use native Pi RPC and refresh model/context state", async () => {
  const { child, service } = setup();
  let model = { provider: "test", id: "first", name: "First", contextWindow: 100_000 };
  let usage: unknown = { tokens: 12_000, contextWindow: 100_000, percent: 12 };
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { model, isStreaming: false, isCompacting: false } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: usage } });
    } else if (command.type === "get_available_models") {
      child.respond(command, { data: { models: [model, { provider: "other", id: "second", name: "Second" }] } });
    } else if (command.type === "set_model") {
      assert.deepEqual(
        { provider: command.provider, modelId: command.modelId },
        { provider: "other", modelId: "second" },
      );
      model = { provider: "other", id: "second", name: "Second", contextWindow: 256_000 };
      usage = { tokens: 12_000, contextWindow: 256_000, percent: 4.6875 };
      child.respond(command, { data: model });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  assert.deepEqual(await service.getAvailableModels(), [
    { provider: "test", id: "first", name: "First", contextWindow: 100_000 },
    { provider: "other", id: "second", name: "Second" },
  ]);
  await service.changeModel("other", "second");
  assert.deepEqual(service.snapshot().model, model);
  assert.deepEqual(service.snapshot().context, usage);
  assert.ok(child.commands.some((command) => command.type === "get_available_models"));
  assert.ok(child.commands.some((command) =>
    command.type === "set_model" && command.provider === "other" && command.modelId === "second",
  ));
  await service.stop();
});

test("prompt template discovery returns only Pi prompt commands and submission preserves all arguments", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { model: { provider: "test", id: "model" }, isStreaming: false, isCompacting: false } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "get_commands") {
      child.respond(command, { data: { commands: [
        { name: "review", description: "Review changes", source: "prompt" },
        { name: "skill:security", description: "Security review", source: "skill" },
        { name: "extension-command", description: "Extension command", source: "extension" },
        { name: "invalid name", source: "prompt" },
      ] } });
    } else {
      child.respond(command, { data: command.type === "prompt" ? { disposition: "started" } : undefined });
    }
  };

  await service.initialize();
  assert.deepEqual(await service.getPromptTemplates(), [
    { name: "review", description: "Review changes" },
  ]);
  const templatePrompt = '/review src/file.ts "API compatibility" extra context';
  await service.sendMessage(templatePrompt, "template-prompt");
  const prompt = child.commands.find((command) => command.type === "prompt");
  assert.equal(prompt?.message, templatePrompt);
  await service.stop();
});

test("failed or busy model changes do not overwrite Pi's current model", async () => {
  const { child, service } = setup();
  const original = { provider: "test", id: "unchanged", name: "Unchanged" };
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { model: original, isStreaming: false, isCompacting: false } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "set_model") {
      child.respond(command, { success: false, error: "Model unavailable." });
    } else {
      child.respond(command, { data: command.type === "prompt" ? { disposition: "started" } : undefined });
    }
  };
  await service.initialize();
  await assert.rejects(service.changeModel("other", "missing"), /Model unavailable/);
  assert.deepEqual(service.snapshot().model, original);
  assert.equal(await service.sendMessage("run"), "started");
  await assert.rejects(service.changeModel("other", "second"), /when the session is idle/);
  assert.equal(child.commands.some((command) => command.type === "set_model"), true);
  assert.equal(child.commands.filter((command) => command.type === "set_model").length, 1);
  await service.abort();
  await service.stop();
});

test("queued messages can be cancelled individually or cleared as a group", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => {
    if (command.type === "prompt") {
      child.emitRecord({ type: "agent_start" });
      child.respond(command, { data: { disposition: "started" } });
    } else {
      child.respond(command, { data: { isStreaming: true, isCompacting: false } });
    }
  };
  await service.sendMessage("active turn", "cancel-active");
  await service.sendMessage("keep this queued", "cancel-one", [], "queue");
  await service.sendMessage("cancel this queued message", "cancel-two", [], "queue");
  await service.sendMessage("clear this queued message", "cancel-three", [], "queue");

  assert.equal(service.cancelQueuedMessage("cancel-two"), true);
  assert.deepEqual(service.snapshot().queuedMessages.map(({ id }) => id), ["cancel-one", "cancel-three"]);
  assert.deepEqual(service.clearQueuedMessages(), ["cancel-three", "cancel-one"]);
  assert.deepEqual(service.snapshot().queuedMessages, []);
  assert.deepEqual(events.filter((event) => event.type === "queued_message_cancelled").map((event) => event.id), [
    "cancel-two", "cancel-three", "cancel-one",
  ]);
  await service.stop();
});

test("compact RPC timeout keeps messages queued until Pi confirms compaction has ended", async () => {
  const { child, service, events } = setup(20);
  let isCompacting = false;
  let compactCalls = 0;
  let stateCalls = 0;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      stateCalls++;
      child.respond(command, { data: { isStreaming: false, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "compact") {
      compactCalls++;
      isCompacting = true;
      child.emitRecord({ type: "compaction_start", reason: "manual" });
    } else if (command.type === "prompt") {
      child.respond(command, { data: { disposition: "started" } });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  await service.compact();
  await waitFor(() => compactCalls === 1);
  await service.sendMessage("wait until Pi says ready", "timeout-queue");
  await waitFor(() => stateCalls >= 2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(service.snapshot().isCompacting, true);
  assert.deepEqual(service.snapshot().queuedMessages.map(({ id }) => id), ["timeout-queue"]);
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 0);
  assert.equal(events.some((event) => event.type === "queued_message_sent"), false);

  isCompacting = false;
  child.emitRecord({
    type: "compaction_end",
    reason: "manual",
    result: { summary: "done", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
    aborted: false,
    willRetry: false,
  });
  await waitFor(() => events.some((event) =>
    event.type === "queued_message_sent" && event.id === "timeout-queue",
  ));
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 1);
  assert.equal(events.filter((event) => event.type === "queued_message_sent" && event.id === "timeout-queue").length, 1);
  await service.stop();
});

test("a retrying compaction keeps the automatic-compaction queue until final completion", async () => {
  const { child, service, events } = setup();
  let isCompacting = false;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming: false, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "prompt") {
      child.respond(command, { data: { disposition: "started" } });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "threshold" });
  await service.sendMessage("preserve through compaction retry", "retry-queue");
  isCompacting = false;
  child.emitRecord({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    errorMessage: "temporary summarization failure",
    willRetry: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(service.snapshot().isCompacting, true);
  assert.deepEqual(service.snapshot().queuedMessages.map(({ id }) => id), ["retry-queue"]);
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 0);
  assert.equal(events.some((event) => event.type === "queued_message_sent"), false);

  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "threshold" });
  isCompacting = false;
  child.emitRecord({
    type: "compaction_end",
    reason: "threshold",
    result: { summary: "success", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
    aborted: false,
    willRetry: false,
  });
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => events.some((event) =>
    event.type === "queued_message_sent" && event.id === "retry-queue",
  ));
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 1);
  assert.equal(events.filter((event) => event.type === "queued_message_sent" && event.id === "retry-queue").length, 1);
  await service.stop();
});

test("agent settlement and authoritative idle state recover a missing compaction completion without recording success", async () => {
  const { child, service, events } = setup();
  let isStreaming = false;
  let isCompacting = false;
  let promptCalls = 0;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "prompt") {
      promptCalls++;
      child.respond(command, { data: { disposition: "started" } });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  isStreaming = true;
  isCompacting = true;
  child.emitRecord({ type: "agent_start" });
  child.emitRecord({ type: "compaction_start", reason: "threshold" });
  await service.sendMessage("send after stale compaction", "stale-queue");

  isStreaming = false;
  isCompacting = false;
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => events.some((event) =>
    event.type === "queued_message_sent" && event.id === "stale-queue",
  ));

  assert.equal(service.snapshot().isCompacting, false);
  assert.equal(service.snapshot().queuedMessages.length, 0);
  assert.equal(service.snapshot().transcript.filter((item) => item.type === "compaction").length, 0);
  assert.equal(events.filter((event) => event.type === "queued_message_sent" && event.id === "stale-queue").length, 1);
  assert.equal(promptCalls, 1);
  await service.stop();
});

test("willRetry holds queued messages through the agent retry delay and resumed request", async () => {
  const { child, service, events } = setup();
  let isStreaming = false;
  let isCompacting = false;
  let promptCalls = 0;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "prompt") {
      promptCalls++;
      child.respond(command, { data: { disposition: "started" } });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  isStreaming = true;
  isCompacting = true;
  child.emitRecord({ type: "agent_start" });
  child.emitRecord({ type: "compaction_start", reason: "overflow" });
  await service.sendMessage("send after retry settles", "retry-settle-queue");

  isStreaming = false;
  isCompacting = false;
  child.emitRecord({
    type: "compaction_end",
    reason: "overflow",
    result: { summary: "compacted", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
    aborted: false,
    willRetry: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(service.snapshot().isCompacting, true);
  assert.deepEqual(service.snapshot().queuedMessages.map(({ id }) => id), ["retry-settle-queue"]);
  assert.equal(promptCalls, 0);

  isStreaming = true;
  child.emitRecord({ type: "agent_start" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(service.snapshot().isCompacting, true);
  assert.equal(promptCalls, 0);

  isStreaming = false;
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => events.some((event) =>
    event.type === "queued_message_sent" && event.id === "retry-settle-queue",
  ));
  assert.equal(service.snapshot().isCompacting, false);
  assert.equal(service.snapshot().transcript.filter((item) => item.type === "compaction").length, 1);
  assert.equal(events.filter((event) => event.type === "queued_message_sent" && event.id === "retry-settle-queue").length, 1);
  assert.equal(promptCalls, 1);
  await service.stop();
});

test("a stale reconciliation response cannot clear a newer compaction", async () => {
  const { child, service, events } = setup();
  let isStreaming = false;
  let isCompacting = false;
  let holdState = false;
  const delayedStates: Command[] = [];
  let promptCalls = 0;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      if (holdState) delayedStates.push(command);
      else child.respond(command, { data: { isStreaming, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "prompt") {
      promptCalls++;
      child.respond(command, { data: { disposition: "started" } });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "threshold" });
  await service.sendMessage("remain queued for newer compaction", "newer-compaction-queue");
  isCompacting = false;
  holdState = true;
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => delayedStates.length === 1);

  isStreaming = true;
  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "overflow" });
  child.respond(delayedStates.shift()!, { data: { isStreaming: false, isCompacting: false } });
  await waitFor(() => delayedStates.length === 1);
  child.respond(delayedStates.shift()!, { data: { isStreaming, isCompacting } });
  await waitFor(() => service.snapshot().isCompacting);
  assert.equal(promptCalls, 0);
  assert.deepEqual(service.snapshot().queuedMessages.map(({ id }) => id), ["newer-compaction-queue"]);

  holdState = false;
  isStreaming = false;
  isCompacting = false;
  child.emitRecord({
    type: "compaction_end",
    reason: "overflow",
    result: { summary: "newer compaction", tokensBefore: 12_000, estimatedTokensAfter: 3_000 },
    aborted: false,
    willRetry: false,
  });
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => events.some((event) =>
    event.type === "queued_message_sent" && event.id === "newer-compaction-queue",
  ));
  assert.equal(service.snapshot().isCompacting, false);
  assert.equal(events.filter((event) => event.type === "queued_message_sent" && event.id === "newer-compaction-queue").length, 1);
  assert.equal(promptCalls, 1);
  await service.stop();
});

test("manual compaction uses Pi RPC and drains queued messages once, in FIFO order", async () => {
  const { child, service, events } = setup();
  let isStreaming = false;
  let isCompacting = false;
  let tokenCount = 150_000;
  let compactCommand: Command | undefined;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, {
        data: {
          model: { provider: "test-provider", id: "model-one", name: "Model One" },
          isStreaming,
          isCompacting,
        },
      });
    } else if (command.type === "get_session_stats") {
      child.respond(command, {
        data: { contextUsage: { tokens: tokenCount, contextWindow: 200_000, percent: tokenCount / 2_000 } },
      });
    } else if (command.type === "compact") {
      compactCommand = command;
      isCompacting = true;
      child.emitRecord({ type: "compaction_start", reason: "manual" });
    } else if (command.type === "prompt") {
      isStreaming = true;
      child.emitRecord({ type: "agent_start" });
      child.respond(command, { data: { disposition: "started" } });
    } else if (command.type === "steer") {
      child.respond(command, { data: { disposition: "queued" } });
    } else if (command.type === "abort") {
      child.respond(command);
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  await service.compact();
  await waitFor(() => compactCommand !== undefined);
  assert.ok(child.commands.some((command) => command.type === "compact"));
  assert.equal(service.snapshot().isCompacting, true);
  await Promise.all([
    service.sendMessage("first queued message", "queue-1"),
    service.sendMessage("second queued message", "queue-2"),
  ]);
  assert.equal(service.snapshot().queuedMessages.map(({ id }) => id).join(","), "queue-1,queue-2");
  assert.equal(child.commands.some((command) => command.type === "prompt" || command.type === "steer"), false);
  await assert.rejects(service.abort(), /does not cancel compaction/);
  assert.equal(child.commands.some((command) => command.type === "abort"), false);

  isCompacting = false;
  tokenCount = 32_000;
  child.emitRecord({
    type: "compaction_end",
    reason: "manual",
    result: { tokensBefore: 150_000, estimatedTokensAfter: 30_000, summary: "not shown" },
    aborted: false,
    willRetry: false,
  });
  child.respond(compactCommand!, { data: { summary: "not shown" } });
  await waitFor(() => events.filter((event) => event.type === "queued_message_sent").length === 1);
  assert.deepEqual(child.commands
    .filter((command) => command.type === "prompt" || command.type === "steer")
    .map((command) => [command.type, command.message]), [
      ["prompt", "first queued message"],
    ]);
  assert.deepEqual(service.snapshot().queuedMessages.map(({ id }) => id), ["queue-2"]);
  isStreaming = false;
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => events.filter((event) => event.type === "queued_message_sent").length === 2);
  assert.deepEqual(child.commands
    .filter((command) => command.type === "prompt" || command.type === "steer")
    .map((command) => [command.type, command.message]), [
      ["prompt", "first queued message"],
      ["prompt", "second queued message"],
    ]);
  assert.deepEqual(events.filter((event) => event.type === "queued_message_sent").map((event) => event.id), [
    "queue-1",
    "queue-2",
  ]);
  assert.equal(service.snapshot().context.tokens, 32_000);
  assert.equal(service.snapshot().isCompacting, false);
  isStreaming = false;
  child.emitRecord({ type: "agent_settled" });
  await service.stop();
});

test("manual compaction below the keep-recent threshold does not interrupt an active turn", async () => {
  const { child, service, events } = setup();
  let isStreaming = false;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming, isCompacting: false } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: { tokens: 19_999, contextWindow: 128_000, percent: 15.6 } } });
    } else if (command.type === "prompt") {
      isStreaming = true;
      child.emitRecord({ type: "agent_start" });
      child.respond(command, { data: { disposition: "started" } });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  await service.sendMessage("keep working", "active-user");
  await assert.rejects(service.compact(), /Nothing to compact yet/);
  assert.equal(isStreaming, true);
  assert.equal(child.commands.some((command) => command.type === "compact" || command.type === "abort"), false);
  assert.equal(events.some((event) => event.type === "compaction_start"), false);
  assert.equal(service.snapshot().isCompacting, false);
  await service.stop();
});

test("automatic compaction and failed or aborted endings clear state and retain usable queued messages", async () => {
  const { child, service, events } = setup();
  let isStreaming = false;
  let isCompacting = false;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } } });
    } else if (command.type === "prompt") {
      isStreaming = true;
      child.emitRecord({ type: "agent_start" });
      child.respond(command, { data: { disposition: "started" } });
    } else if (command.type === "steer") {
      child.respond(command, { data: { disposition: "queued" } });
    } else if (command.type === "abort") {
      child.respond(command);
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "threshold" });
  assert.equal(service.snapshot().isCompacting, true);
  await service.sendMessage("survives automatic compaction", "auto-queue");
  isCompacting = false;
  child.emitRecord({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    errorMessage: "summary provider temporarily unavailable",
    willRetry: false,
  });
  isStreaming = false;
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => events.some((event) =>
    event.type === "queued_message_sent" && event.id === "auto-queue",
  ));
  assert.ok(events.some((event) =>
    event.type === "compaction_end" && !event.success && !event.aborted &&
    event.error?.includes("summary provider"),
  ));
  assert.ok(events.some((event) => event.type === "compaction_end" && event.error?.includes("summary provider") &&
    event.informational !== true));

  isStreaming = false;
  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "overflow" });
  await service.sendMessage("survives aborted compaction", "abort-queue");
  isCompacting = false;
  child.emitRecord({ type: "compaction_end", reason: "overflow", aborted: true, willRetry: false });
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => events.some((event) =>
    event.type === "queued_message_sent" && event.id === "abort-queue",
  ));
  assert.ok(events.some((event) => event.type === "compaction_end" && event.aborted));
  assert.equal(service.snapshot().isCompacting, false);
  await service.stop();
});

test("Pi's session-too-small compaction result is informational and leaves the session usable", async () => {
  const { child, service, events } = setup();
  let isCompacting = false;
  let compactCalls = 0;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming: false, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: { tokens: 12_000, contextWindow: 200_000, percent: 6 } } });
    } else if (command.type === "compact") {
      compactCalls++;
      isCompacting = true;
      child.emitRecord({ type: "compaction_start", reason: "manual" });
      isCompacting = false;
      child.emitRecord({
        type: "compaction_end",
        reason: "manual",
        errorMessage: "Nothing to compact (session too small)",
        aborted: false,
        willRetry: false,
      });
      child.respond(command);
    } else if (command.type === "prompt") {
      child.respond(command, { data: { disposition: "started" } });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  (service as unknown as { manualCompactionKeepRecentTokens: number }).manualCompactionKeepRecentTokens = 0;
  await service.compact();
  await waitFor(() => events.some((event) => event.type === "compaction_end"));

  const end = events.find((event) => event.type === "compaction_end");
  assert.ok(end?.type === "compaction_end");
  assert.equal(end.success, false);
  assert.equal(end.informational, true);
  assert.equal(end.error, "Nothing to compact (session too small)");
  assert.equal(service.snapshot().isCompacting, false);
  assert.equal(service.state, "idle");
  assert.deepEqual(service.snapshot().context, { tokens: 12_000, contextWindow: 200_000, percent: 6 });
  assert.equal(service.snapshot().transcript.filter((item) => item.type === "compaction").length, 0);
  assert.equal(compactCalls, 1);

  assert.equal(await service.sendMessage("session remains usable"), "started");
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 1);
  assert.equal(compactCalls, 1);
  await service.stop();
});

test("context usage refreshes after messages, assistant completion, tool activity, and compaction", async () => {
  const { child, service, events } = setup();
  let tokens = 100;
  let isCompacting = false;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming: false, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: { tokens, contextWindow: 10_000, percent: tokens / 100 } } });
    } else if (command.type === "prompt") {
      child.respond(command, { data: { disposition: "started" } });
    } else if (command.type === "compact") {
      isCompacting = true;
      child.respond(command);
      setTimeout(() => {
        isCompacting = false;
        tokens = 600;
        child.emitRecord({ type: "compaction_end", result: { summary: "compacted" }, aborted: false });
        child.emitRecord({ type: "agent_settled" });
      }, 20);
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  (service as unknown as { manualCompactionKeepRecentTokens: number }).manualCompactionKeepRecentTokens = 0;
  tokens = 200;
  await service.sendMessage("accepted message", "context-message");
  await waitFor(() => service.snapshot().context.tokens === 200);
  assert.ok(events.some((event) => event.type === "user_message" && event.messageId === "context-message"));

  child.emitRecord({ type: "message_start", message: { role: "assistant", content: [] } });
  tokens = 300;
  child.emitRecord({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Answer" }] },
  });
  await waitFor(() => service.snapshot().context.tokens === 300);

  tokens = 350;
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => service.snapshot().context.tokens === 350);

  tokens = 400;
  child.emitRecord({ type: "tool_execution_end", toolCallId: "context-tool", toolName: "read", result: {} });
  await waitFor(() => service.snapshot().context.tokens === 400);

  tokens = 500;
  await service.compact();
  await waitFor(() => service.snapshot().context.tokens === 500);
  await waitFor(() => events.some((event) => event.type === "compaction_end"));
  assert.equal(service.snapshot().context.tokens, 600);
  await service.stop();
});

test("successful compaction history persists once and reconstructs across session hydration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vot-compaction-history-"));
  const sessionFile = join(root, "session.jsonl");
  const createdAt = "2026-10-06T21:00:00.000Z";
  const user = { role: "user", content: "Earlier message", timestamp: Date.parse(createdAt) };
  const assistant = { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] };
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", id: "session-1", cwd: "/fake/project" }),
    JSON.stringify({ type: "message", id: "user-1", timestamp: createdAt, message: user }),
    JSON.stringify({ type: "message", id: "assistant-1", timestamp: "2026-10-06T21:01:00.000Z", message: assistant }),
    "",
  ].join("\n"));
  const { child, service, events } = setup();
  let isCompacting = false;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { sessionFile, isStreaming: false, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: { tokens: 50, contextWindow: 10_000, percent: 0.5 } } });
    } else if (command.type === "get_messages") {
      child.respond(command, { data: { messages: [user, assistant] } });
    } else if (command.type === "compact") {
      isCompacting = true;
      child.respond(command);
      setTimeout(() => {
        isCompacting = false;
        child.emitRecord({
          type: "compaction_end",
          reason: "manual",
          result: { summary: "done", tokensBefore: 8_000, estimatedTokensAfter: 2_000 },
          aborted: false,
        });
      }, 20);
    } else {
      child.respond(command);
    }
  };

  try {
    await service.initialize();
    (service as unknown as { manualCompactionKeepRecentTokens: number }).manualCompactionKeepRecentTokens = 0;
    await service.compact();
    await waitFor(() => events.some((event) => event.type === "compaction_end"));
    const entry = service.snapshot().transcript.filter((item) => item.type === "compaction");
    assert.equal(entry.length, 1);
    assert.equal(entry[0]?.type, "compaction");
    assert.equal(entry[0]?.type === "compaction" ? entry[0].reason : undefined, "manual");
    assert.equal(entry[0]?.type === "compaction" ? entry[0].tokensBefore : undefined, 8_000);
    assert.equal(entry[0]?.type === "compaction" ? entry[0].estimatedTokensAfter : undefined, 2_000);
    assert.equal(events.filter((event) => event.type === "compaction_end" && event.entry).length, 1);

    isCompacting = true;
    child.emitRecord({ type: "compaction_start", reason: "threshold" });
    isCompacting = false;
    child.emitRecord({ type: "compaction_end", reason: "threshold", result: { summary: "automatic" }, aborted: false });
    child.emitRecord({ type: "agent_settled" });
    await waitFor(() => events.filter((event) => event.type === "compaction_end" && event.entry).length === 2);

    child.emitRecord({ type: "compaction_end", result: { summary: "duplicate callback" }, aborted: false });
    await service.refreshPersistedState();
    assert.equal(service.snapshot().transcript.filter((item) => item.type === "compaction").length, 2);

    const hydrated = await hydratePiSession({
      id: sessionFile,
      cwd: "/fake/project",
      name: null,
      preview: "Earlier message",
      updatedAt: createdAt,
    });
    assert.equal(hydrated.transcript.filter((item) => item.type === "compaction").length, 2);
    const reloadedUser = hydrated.transcript.find((item) => item.type === "user");
    const reloadedAssistant = hydrated.transcript.find((item) => item.type === "assistant");
    assert.equal(reloadedUser?.type === "user" ? reloadedUser.createdAt : undefined, createdAt);
    assert.equal(
      reloadedAssistant?.type === "assistant" ? reloadedAssistant.createdAt : undefined,
      "2026-10-06T21:01:00.000Z",
    );
    const persistedEntry = hydrated.transcript.find((item) => item.type === "compaction");
    assert.equal(persistedEntry?.type === "compaction" ? persistedEntry.reason : undefined, "manual");
    assert.equal(persistedEntry?.type === "compaction" ? persistedEntry.tokensBefore : undefined, 8_000);
    assert.equal(persistedEntry?.type === "compaction" ? persistedEntry.estimatedTokensAfter : undefined, 2_000);
    assert.equal(persistedEntry?.type === "compaction" ? persistedEntry.createdAt : undefined,
      entry[0]?.type === "compaction" ? entry[0].createdAt : undefined);
    assert.ok(persistedEntry?.type === "compaction" &&
      hydrated.transcript.some((item) => item.id === persistedEntry.anchorId),
    JSON.stringify({ persistedEntry, transcript: hydrated.transcript }));
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy persisted messages without timestamps still hydrate without fabricated times", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vot-legacy-timestamp-"));
  const sessionFile = join(root, "legacy.jsonl");
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", id: "legacy", cwd: "/fake/project" }),
    JSON.stringify({ type: "message", id: "legacy-message", message: { role: "user", content: "Untimed legacy message" } }),
    "",
  ].join("\n"));
  try {
    const hydrated = await hydratePiSession({
      id: sessionFile,
      cwd: "/fake/project",
      name: null,
      preview: "Untimed legacy message",
      updatedAt: new Date().toISOString(),
    });
    assert.equal(hydrated.transcript[0]?.type, "user");
    assert.equal(hydrated.transcript[0]?.type === "user" ? hydrated.transcript[0].createdAt : undefined, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inactive transcript hydration follows only the persisted session-tree branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vot-history-branch-"));
  const sessionFile = join(root, "branch.jsonl");
  const entries = [
    { type: "session", id: "branch-session", cwd: "/fake/project" },
    { type: "message", id: "root-user", parentId: null, timestamp: "2026-10-06T10:00:00.000Z", message: { role: "user", content: "Root prompt" } },
    { type: "message", id: "root-assistant", parentId: "root-user", timestamp: "2026-10-06T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Root answer" }] } },
    { type: "message", id: "branch-a-user", parentId: "root-assistant", message: { role: "user", content: "Branch A prompt" } },
    { type: "message", id: "branch-a-assistant", parentId: "branch-a-user", message: { role: "assistant", content: [{ type: "text", text: "Branch A answer" }] } },
    { type: "message", id: "branch-b-user", parentId: "root-assistant", timestamp: "2026-10-06T11:00:00.000Z", message: { role: "user", content: "Branch B prompt" } },
    {
      type: "message",
      id: "branch-b-assistant",
      parentId: "branch-b-user",
      timestamp: "2026-10-06T11:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Branch B answer" }, { type: "toolCall", id: "branch-tool", name: "read", arguments: { path: "file" } }],
      },
    },
    {
      type: "message",
      id: "branch-tool-result",
      parentId: "branch-b-assistant",
      timestamp: "2026-10-06T11:00:02.000Z",
      message: { role: "toolResult", toolCallId: "branch-tool", toolName: "read", content: "Branch B tool result" },
    },
  ];
  await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await writeFile(`${sessionFile}.pi-vot.jsonl`, [
    {
      type: "compaction",
      id: "compaction-branch-a",
      createdAt: "2026-10-06T10:01:00.000Z",
      afterId: "branch-a-assistant",
      afterIndex: 3,
    },
    {
      type: "compaction",
      id: "compaction-branch",
      createdAt: "2026-10-06T11:01:00.000Z",
      afterId: "branch-b-assistant",
      afterIndex: 3,
    },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  try {
    const hydrated = await hydratePiSession({
      id: sessionFile,
      cwd: "/fake/project",
      name: null,
      preview: "Root prompt",
      updatedAt: new Date().toISOString(),
    });
    assert.deepEqual(hydrated.transcript.map((item) => item.id), [
      "root-user",
      "root-assistant",
      "branch-b-user",
      "branch-b-assistant",
      "compaction-branch",
      "tool-branch-tool",
    ]);
    assert.equal(hydrated.transcript.some((item) =>
      (item.type === "user" || item.type === "assistant") && item.text.includes("Branch A")), false);
    assert.equal(hydrated.transcript[0]?.type === "user" ? hydrated.transcript[0].createdAt : undefined,
      "2026-10-06T10:00:00.000Z");
    const tool = hydrated.transcript.at(-1);
    assert.equal(tool?.type === "tool" ? tool.output : undefined, "Branch B tool result");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locally synthesized message timestamps persist and authoritative Pi times win on reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vot-timestamp-fallback-"));
  const sessionFile = join(root, "fallback.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "fallback", cwd: "/fake/project" })}\n`);
  const user = { id: "pi-user-1", role: "user", content: "Fallback user" };
  const assistant = { id: "pi-assistant-1", role: "assistant", content: [{ type: "text", text: "Fallback assistant" }] };
  const { child, service } = setup();
  let messages: unknown[] = [];
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { sessionFile, isStreaming: false, isCompacting: false } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "get_messages") {
      child.respond(command, { data: { messages } });
    } else if (command.type === "prompt") {
      messages = [user];
      child.respond(command, { data: { disposition: "started", messageId: "pi-user-1" } });
    } else {
      child.respond(command);
    }
  };

  try {
    await service.initialize();
    await service.sendMessage("Fallback user", "local-user-id");
    const userTimestamp = service.snapshot().transcript.find((item) =>
      item.type === "user" && item.id === "local-user-id",
    );
    assert.equal(userTimestamp?.type === "user" ? typeof userTimestamp.createdAt : false, "string");
    assert.ok(userTimestamp?.type === "user" && userTimestamp.createdAt);

    child.emitRecord({ type: "message_start", message: assistant });
    child.emitRecord({ type: "message_end", message: assistant });
    const assistantTimestamp = service.snapshot().transcript.find((item) => item.type === "assistant");
    assert.equal(assistantTimestamp?.type === "assistant" ? typeof assistantTimestamp.createdAt : false, "string");

    messages = [user, assistant];
    await service.refreshPersistedState();
    await writeFile(sessionFile, [
      JSON.stringify({ type: "session", id: "fallback", cwd: "/fake/project" }),
      JSON.stringify({ type: "message", id: "pi-user-1", message: user }),
      JSON.stringify({ type: "message", id: "pi-assistant-1", message: assistant }),
      "",
    ].join("\n"));
    const hydrated = await hydratePiSession({
      id: sessionFile,
      cwd: "/fake/project",
      name: null,
      preview: "Fallback user",
      updatedAt: new Date().toISOString(),
    });
    const reloadedUser = hydrated.transcript.find((item) => item.type === "user");
    const reloadedAssistant = hydrated.transcript.find((item) => item.type === "assistant");
    assert.equal(reloadedUser?.type === "user" ? reloadedUser.createdAt : undefined,
      userTimestamp?.type === "user" ? userTimestamp.createdAt : undefined);
    assert.equal(reloadedAssistant?.type === "assistant" ? reloadedAssistant.createdAt : undefined,
      assistantTimestamp?.type === "assistant" ? assistantTimestamp.createdAt : undefined);

    const metadataPath = `${sessionFile}.pi-vot.jsonl`;
    const fallbackRecords = (await readFile(metadataPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(fallbackRecords.filter((item) => item.type === "timestamp_fallback").length, 2);
    assert.ok(fallbackRecords.some((item) => item.piMessageId === "pi-user-1"));

    const authoritativeTime = "2026-10-06T22:00:00.000Z";
    await writeFile(sessionFile, [
      JSON.stringify({ type: "session", id: "fallback", cwd: "/fake/project" }),
      JSON.stringify({ type: "message", id: "pi-user-1", message: { ...user, timestamp: authoritativeTime } }),
      JSON.stringify({ type: "message", id: "pi-assistant-1", message: assistant }),
      "",
    ].join("\n"));
    await appendFile(metadataPath, [
      "malformed record",
      JSON.stringify({
        type: "compaction",
        id: "compaction-old-format",
        createdAt: "2026-10-06T21:59:00.000Z",
        afterId: "pi-user-1",
        afterIndex: 0,
      }),
      JSON.stringify({
        type: "timestamp_fallback",
        localId: "conflicting-authoritative-user",
        role: "user",
        piMessageId: "pi-user-1",
        contentHash: createHash("sha256").update("user\0Fallback user").digest("hex"),
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
      "\n",
    ].join("\n"));
    const authoritativeReload = await hydratePiSession({
      id: sessionFile,
      cwd: "/fake/project",
      name: null,
      preview: "Fallback user",
      updatedAt: new Date().toISOString(),
    });
    const authoritativeUser = authoritativeReload.transcript.find((item) => item.type === "user");
    assert.equal(authoritativeUser?.type === "user" ? authoritativeUser.createdAt : undefined, authoritativeTime);
    assert.equal(authoritativeReload.transcript.filter((item) => item.type === "compaction").length, 1);
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated identical messages keep fallback timestamps attached to persisted Pi IDs after transcript changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vot-repeated-timestamps-"));
  const sessionFile = join(root, "repeated.jsonl");
  const repeated = { role: "user", content: "Repeat this" };
  const hash = createHash("sha256").update("user\0Repeat this").digest("hex");
  const timestampById = new Map([
    ["pi-user-1", "2026-10-06T22:00:00.000Z"],
    ["pi-user-2", "2026-10-06T22:01:00.000Z"],
  ]);
  const transcriptLine = (id: string) => JSON.stringify({
    type: "message",
    id,
    message: repeated,
  });
  const sidecarLines = [...timestampById].map(([piMessageId, createdAt]) => JSON.stringify({
    type: "timestamp_fallback",
    role: "user",
    piMessageId,
    contentHash: hash,
    createdAt,
  }));
  const hydrate = async (messageIds: string[]) => {
    await writeFile(sessionFile, [
      JSON.stringify({ type: "session", id: "repeated", cwd: "/fake/project" }),
      ...messageIds.map(transcriptLine),
      "",
    ].join("\n"));
    await writeFile(`${sessionFile}.pi-vot.jsonl`, `${sidecarLines.join("\n")}\n`);
    return hydratePiSession({
      id: sessionFile,
      cwd: "/fake/project",
      name: null,
      preview: "Repeat this",
      updatedAt: new Date().toISOString(),
    });
  };

  try {
    const original = await hydrate(["pi-user-1", "pi-user-2", "pi-user-3"]);
    assert.deepEqual(original.transcript.map((item) => item.type === "user" ? item.createdAt : undefined), [
      "2026-10-06T22:00:00.000Z",
      "2026-10-06T22:01:00.000Z",
      undefined,
    ]);

    const earlierDeleted = await hydrate(["pi-user-2", "pi-user-3"]);
    assert.deepEqual(earlierDeleted.transcript.map((item) =>
      item.type === "user" ? item.createdAt : undefined,
    ), ["2026-10-06T22:01:00.000Z", undefined]);

    const inserted = await hydrate(["pi-user-new", "pi-user-1", "pi-user-2"]);
    assert.deepEqual(inserted.transcript.map((item) =>
      item.type === "user" ? item.createdAt : undefined,
    ), [undefined, "2026-10-06T22:00:00.000Z", "2026-10-06T22:01:00.000Z"]);

    const restructured = await hydrate(["pi-user-2", "pi-user-1", "pi-user-3"]);
    assert.deepEqual(restructured.transcript.map((item) =>
      item.type === "user" ? item.createdAt : undefined,
    ), ["2026-10-06T22:01:00.000Z", "2026-10-06T22:00:00.000Z", undefined]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timestamp fallbacks without persisted Pi IDs fail closed after transcript changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vot-no-pi-message-id-"));
  const sessionFile = join(root, "no-ids.jsonl");
  const repeated = { role: "user", content: "Repeat this" };
  const hash = createHash("sha256").update("user\0Repeat this").digest("hex");
  await writeFile(`${sessionFile}.pi-vot.jsonl`, `${JSON.stringify({
    type: "timestamp_fallback",
    localId: "local-message-id",
    role: "user",
    contentHash: hash,
    occurrence: 0,
    createdAt: "2026-10-06T22:00:00.000Z",
  })}\n`);

  try {
    for (const transcript of [
      [repeated],
      [{ role: "user", content: "Inserted before" }, repeated],
      [{ role: "user", content: "Reordered context" }, repeated],
    ]) {
      await writeFile(sessionFile, [
        JSON.stringify({ type: "session", id: "no-ids", cwd: "/fake/project" }),
        ...transcript.map((message) => JSON.stringify({ type: "message", message })),
        "",
      ].join("\n"));
      const hydrated = await hydratePiSession({
        id: sessionFile,
        cwd: "/fake/project",
        name: null,
        preview: "Repeat this",
        updatedAt: new Date().toISOString(),
      });
      const matchingMessages = hydrated.transcript.filter((item) =>
        item.type === "user" && item.text === "Repeat this",
      );
      assert.ok(matchingMessages.length > 0);
      assert.ok(matchingMessages.every((item) => item.type === "user" && item.createdAt === undefined));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queued metadata writes remain bound to their original session after switching", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vot-metadata-session-"));
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  const sessionA = join(sessions, "a.jsonl");
  const sessionB = join(sessions, "b.jsonl");
  const discoveryContext = {
    env: {
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_CODING_AGENT_SESSION_DIR: sessions,
    },
    home: join(root, "home"),
  };
  await mkdir(sessions, { recursive: true });
  for (const [file, id] of [[sessionA, "a"], [sessionB, "b"]] as const) {
    await writeFile(file, `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-10-01T00:00:00.000Z",
      cwd: project,
    })}\n`);
  }
  const child = new FakePiProcess();
  let activeFile = sessionA;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: {
        isStreaming: false,
        isCompacting: false,
        sessionFile: activeFile,
        sessionId: activeFile,
      } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "get_messages") {
      child.respond(command, { data: { messages: [] } });
    } else if (command.type === "switch_session") {
      activeFile = String(command.sessionPath);
      child.respond(command, { data: { cancelled: false } });
    } else {
      child.respond(command);
    }
  };
  const service = new PiService(
    project,
    () => child as unknown as ChildProcessWithoutNullStreams,
    undefined,
    discoveryContext,
  );

  try {
    await service.initialize();
    let releaseWrite!: () => void;
    const internals = service as unknown as {
      metadataWrite: Promise<void>;
      persistMetadata: (event: {
        type: "compaction";
        id: string;
        createdAt: string;
        afterIndex: number;
      }) => Promise<void>;
      sessionFile: string | null;
    };
    internals.metadataWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const pendingWrite = internals.persistMetadata({
      type: "compaction",
      id: "compaction-session-a",
      createdAt: "2026-10-06T22:02:00.000Z",
      afterIndex: -1,
    });

    const switching = service.switchSession(sessionB);
    await waitFor(() => internals.sessionFile === sessionB);
    releaseWrite();
    await Promise.all([pendingWrite, switching]);

    const metadataA = await readFile(`${sessionA}.pi-vot.jsonl`, "utf8");
    assert.match(metadataA, /compaction-session-a/);
    await assert.rejects(readFile(`${sessionB}.pi-vot.jsonl`, "utf8"), { code: "ENOENT" });
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed submission of a queued message is reported and removed without being retried", async () => {
  const { child, service, events } = setup();
  let isCompacting = false;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming: false, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "prompt") {
      child.respond(command, { success: false, error: "Pi rejected the queued prompt." });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "threshold" });
  await service.sendMessage("keep me", "failed-queue");
  isCompacting = false;
  child.emitRecord({ type: "compaction_end", reason: "threshold", result: { summary: "done" }, aborted: false });
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => events.some((event) => event.type === "queued_message_failed"));
  assert.ok(events.some((event) =>
    event.type === "queued_message_failed" &&
    event.id === "failed-queue" &&
    event.error.includes("rejected the queued prompt"),
  ));
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 1);
  assert.equal(service.snapshot().queuedMessages.length, 0);
  await service.stop();
});

test("Pi session discovery, transcript hydration, native new/rename/delete, and branch-safe switching", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-vot-sessions-"));
  const project = join(temporary, "project");
  const sessionDirectory = join(temporary, "pi-sessions");
  await mkdir(sessionDirectory, { recursive: true });
  const namedSession = join(sessionDirectory, "named.jsonl");
  const unnamedSession = join(sessionDirectory, "unnamed.jsonl");
  const unrelatedSession = join(sessionDirectory, "other-project.jsonl");
  const toolCallId = "tool-call-1";
  const userMessage = { role: "user", content: "Continue with the persisted session.", timestamp: 1 };
  const assistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Inspecting the stored transcript." },
      { type: "text", text: "The old assistant response." },
      { type: "toolCall", id: toolCallId, name: "read", arguments: { path: "notes.md" } },
    ],
    provider: "test-provider",
    model: "old-model",
    timestamp: 2,
  };
  const toolResult = {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: "Stored tool output." }],
    isError: false,
    timestamp: 3,
  };
  const writeSession = async (
    file: string,
    cwd: string,
    id: string,
    entries: unknown[] = [],
  ) => {
    const header = { type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd };
    await writeFile(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  };
  await writeSession(namedSession, project, "named-id", [
    { type: "message", id: "user-1", parentId: null, timestamp: "2026-10-01T00:00:01.000Z", message: userMessage },
    { type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-10-01T00:00:02.000Z", message: assistantMessage },
    { type: "message", id: "tool-1", parentId: "assistant-1", timestamp: "2026-10-01T00:00:03.000Z", message: toolResult },
    { type: "session_info", id: "name-1", parentId: "tool-1", timestamp: "2026-10-01T00:00:04.000Z", name: "Stored Pi name" },
  ]);
  await writeSession(unnamedSession, project, "unnamed-id", [
    { type: "message", id: "user-2", parentId: null, timestamp: "2026-10-01T00:00:05.000Z", message: { role: "user", content: "Fallback title from the first message.", timestamp: 5 } },
  ]);
  await writeSession(unrelatedSession, join(temporary, "elsewhere"), "unrelated-id", [
    { type: "message", id: "other-user", parentId: null, timestamp: "2026-10-01T00:00:06.000Z", message: { role: "user", content: "Must not leak.", timestamp: 6 } },
  ]);

  const child = new FakePiProcess();
  let currentFile = namedSession;
  let currentName: string | null = "Stored Pi name";
  let messages: unknown[] = [userMessage, assistantMessage, toolResult];
  let createdSessionCount = 0;
  child.onCommand = (command) => {
    void (async () => {
      if (command.type === "get_state") {
        child.respond(command, { data: {
          model: { provider: "test-provider", id: "current-model", name: "Current model", contextWindow: 128_000 },
          isStreaming: false,
          isCompacting: false,
          sessionFile: currentFile,
          sessionId: currentFile,
          sessionName: currentName,
        } });
      } else if (command.type === "get_session_stats") {
        child.respond(command, { data: { contextUsage: { tokens: 100, contextWindow: 128_000, percent: 1 } } });
      } else if (command.type === "get_messages") {
        child.respond(command, { data: { messages } });
      } else if (command.type === "switch_session") {
        currentFile = String(command.sessionPath);
        messages = currentFile === namedSession ? [userMessage, assistantMessage, toolResult] :
          currentFile === unnamedSession ? [{ role: "user", content: "Fallback title from the first message.", timestamp: 5 }] : [];
        currentName = currentFile === namedSession ? "Stored Pi name" : null;
        child.respond(command, { data: { cancelled: false } });
      } else if (command.type === "new_session") {
        currentFile = join(sessionDirectory, `created-${++createdSessionCount}.jsonl`);
        currentName = null;
        messages = [];
        await writeSession(currentFile, project, `created-${createdSessionCount}`);
        child.respond(command, { data: { cancelled: false } });
      } else if (command.type === "set_session_name") {
        currentName = String(command.name);
        await appendFile(currentFile, `${JSON.stringify({
          type: "session_info",
          id: `name-${createdSessionCount + 2}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          name: currentName,
        })}\n`);
        child.respond(command);
      } else {
        child.respond(command);
      }
    })();
  };
  const service = new PiService(
    project,
    () => child as unknown as ChildProcessWithoutNullStreams,
    undefined,
    { env: { PI_CODING_AGENT_DIR: join(temporary, "agent") }, home: join(temporary, "home") },
  );
  try {
    await service.initialize();
    let snapshot = service.snapshot();
    assert.equal(snapshot.activeSessionId, namedSession);
    assert.equal(snapshot.activeSessionName, "Stored Pi name");
    assert.ok(snapshot.sessions.some((session) => session.id === namedSession && session.name === "Stored Pi name"));
    assert.equal(snapshot.sessions.find((session) => session.id === namedSession)?.cwd, project);
    assert.ok(snapshot.sessions.some((session) =>
      session.id === unnamedSession && session.name === null && session.preview === "Fallback title from the first message.",
    ));
    assert.equal(snapshot.sessions.some((session) => session.id === unrelatedSession), true);
    assert.deepEqual(snapshot.transcript.map((item) => item.type), ["user", "assistant", "tool"]);
    assert.deepEqual(snapshot.transcript[1], {
      id: "history-1",
      type: "assistant",
      text: "The old assistant response.",
      createdAt: new Date(2).toISOString(),
      thinking: "Inspecting the stored transcript.",
    });
    assert.equal(snapshot.transcript[2]?.type, "tool");
    if (snapshot.transcript[2]?.type === "tool") {
      assert.equal(snapshot.transcript[2].toolName, "read");
      assert.equal(snapshot.transcript[2].output, "Stored tool output.");
    }
    const originalHistoryRevision = snapshot.historyRevision;
    messages = [
      { ...userMessage, id: "history-0" },
      {
        ...assistantMessage,
        id: "history-1",
        content: [
          { type: "thinking", thinking: "Updated thinking." },
          { type: "text", text: "Updated assistant content." },
          { type: "toolCall", id: toolCallId, name: "read", arguments: { path: "notes.md" } },
        ],
      },
      { ...toolResult, content: [{ type: "text", text: "Updated tool output." }] },
    ];
    await service.refreshPersistedState();
    snapshot = service.snapshot();
    assert.notEqual(snapshot.historyRevision, originalHistoryRevision);
    assert.equal(snapshot.transcript[1]?.type, "assistant");
    if (snapshot.transcript[1]?.type === "assistant") {
      assert.equal(snapshot.transcript[1].text, "Updated assistant content.");
      assert.equal(snapshot.transcript[1].thinking, "Updated thinking.");
    }
    assert.equal(snapshot.transcript[2]?.type, "tool");
    if (snapshot.transcript[2]?.type === "tool")
      assert.equal(snapshot.transcript[2].output, "Updated tool output.");

    const updatedHistoryRevision = snapshot.historyRevision;
    messages = [{ role: "user", id: "replacement-branch-user", content: "A different selected branch." }];
    await service.refreshPersistedState();
    snapshot = service.snapshot();
    assert.notEqual(snapshot.historyRevision, updatedHistoryRevision);
    assert.equal(snapshot.transcript[0]?.id, "replacement-branch-user");
    assert.equal(snapshot.activeSessionId, namedSession);

    await service.switchSession(unnamedSession);
    snapshot = service.snapshot();
    assert.equal(snapshot.activeSessionId, unnamedSession);
    assert.equal(snapshot.transcript[0]?.type, "user");

    await service.newSession();
    snapshot = service.snapshot();
    const createdSession = snapshot.activeSessionId!;
    assert.equal(snapshot.transcript.length, 0);
    assert.equal(snapshot.model?.id, "current-model");
    assert.equal(snapshot.context.tokens, 100);
    assert.ok(snapshot.sessions.some((session) => session.id === createdSession));

    await service.renameSession(namedSession, "Renamed in Pi");
    assert.equal(service.snapshot().activeSessionId, createdSession);
    assert.equal(service.snapshot().sessions.find((session) => session.id === namedSession)?.name, "Renamed in Pi");
    assert.match(await readFile(namedSession, "utf8"), /"name":"Renamed in Pi"/);

    const metadataSidecar = `${createdSession}.pi-vot.jsonl`;
    const piVotDebugLog = `${createdSession}.pi-vot-debug.jsonl`;
    const bigPiDebugLog = `${createdSession}.big-pi-debug.jsonl`;
    const bigPiSidecar = `${createdSession}.big-pi.json`;
    const bigPiDirectory = `${createdSession}.big-pi`;
    await writeFile(metadataSidecar, '{"type":"compaction"}\n');
    await writeFile(piVotDebugLog, '{"event":"test"}\n');
    await writeFile(bigPiDebugLog, '{"event":"test"}\n');
    await writeFile(bigPiSidecar, '{"blocks":[{"tier":1}]}');
    await mkdir(join(bigPiDirectory, "blocks"), { recursive: true });
    await writeFile(join(bigPiDirectory, "blocks", "B000001.json"), "{}");
    await service.deleteSession(unnamedSession);
    assert.equal(service.snapshot().sessions.some((session) => session.id === unnamedSession), false);
    await service.sendMessage("stop work before deleting");
    assert.equal(service.state, "running");
    let finishShutdown!: () => void;
    child.shutdownGate = new Promise<void>((resolve) => { finishShutdown = resolve; });
    const shutdown = service.stop();
    const deletion = service.deleteSession(createdSession);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await stat(createdSession);
    finishShutdown();
    await Promise.all([shutdown, deletion]);
    assert.notEqual(service.snapshot().activeSessionId, createdSession);
    assert.equal(service.snapshot().sessions.some((session) => session.id === createdSession), false);
    assert.equal(service.snapshot().sessions.some((session) => session.id === namedSession), true);
    assert.equal(child.exitCode, 0);
    assert.ok(child.commands.some((command) => command.type === "new_session"));
    assert.ok(child.commands.some((command) => command.type === "switch_session" && command.sessionPath === unnamedSession));
    assert.ok(child.commands.some((command) => command.type === "set_session_name" && command.name === "Renamed in Pi"));
    assert.equal(child.commands.filter((command) => command.type === "new_session").length, 1);
    await stat(unnamedSession).then(
      () => assert.fail("The selected session file should have been removed."),
      () => undefined,
    );
    for (const sidecar of [metadataSidecar, piVotDebugLog, bigPiDebugLog, bigPiSidecar, bigPiDirectory]) {
      await stat(sidecar).then(
        () => assert.fail(`Session sidecar ${sidecar} should have been removed.`),
        () => undefined,
      );
    }
    await stat(namedSession);
    await service.stop();
  } finally {
    await service.stop();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("session file deletion ignores missing sidecars and reports sidecar filesystem failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-vot-delete-session-"));
  const sessionPath = join(directory, "session.jsonl");
  const metadataSidecar = `${sessionPath}.pi-vot.jsonl`;
  try {
    await writeFile(sessionPath, "transcript");
    await mkdir(metadataSidecar);
    await assert.rejects(deletePiSessionFiles(sessionPath), (error: NodeJS.ErrnoException) =>
      ["EISDIR", "EPERM"].includes(error.code ?? ""));
    await stat(sessionPath);
    await stat(metadataSidecar);

    await rm(metadataSidecar, { recursive: true });
    await deletePiSessionFiles(sessionPath);
    await assert.rejects(stat(sessionPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session file deletion removes sidecars when the validated transcript is already missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-vot-delete-missing-session-"));
  const sessionPath = join(directory, "session.jsonl");
  const metadataSidecar = `${sessionPath}.pi-vot.jsonl`;
  const piVotDebugLog = `${sessionPath}.pi-vot-debug.jsonl`;
  const bigPiDebugLog = `${sessionPath}.big-pi-debug.jsonl`;
  const bigPiSidecar = `${sessionPath}.big-pi.json`;
  try {
    await writeFile(metadataSidecar, "Pi-vot metadata");
    await writeFile(piVotDebugLog, "Pi-vot debug");
    await writeFile(bigPiDebugLog, "Big Pi debug");
    await writeFile(bigPiSidecar, "Big Pi metadata");

    await deletePiSessionFiles(sessionPath);

    for (const file of [sessionPath, metadataSidecar, piVotDebugLog, bigPiDebugLog, bigPiSidecar]) {
      await assert.rejects(stat(file), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session deletion removes the Big Pi folder without following links or touching neighboring files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-vot-delete-big-pi-"));
  const sessionPath = join(directory, "session.jsonl");
  const bigPiDirectory = `${sessionPath}.big-pi`;
  const bigPiAgentsDirectory = `${sessionPath}.big-pi-agents`;
  const legacySidecar = `${sessionPath}.big-pi.json`;
  const neighboringSession = join(directory, "neighbor.jsonl");
  const unrelatedDirectory = join(directory, "unrelated");
  const linkedDirectory = join(bigPiDirectory, "linked");
  try {
    await writeFile(sessionPath, "transcript");
    await writeFile(neighboringSession, "keep neighboring session");
    await mkdir(join(bigPiDirectory, "blocks"), { recursive: true });
    await writeFile(join(bigPiDirectory, "manifest.json"), "{}");
    await writeFile(join(bigPiDirectory, "blocks", "B000001.json"), "{}");
    await writeFile(join(bigPiDirectory, "temporary.tmp"), "temporary");
    await mkdir(join(bigPiAgentsDirectory, "agent-a", "blocks"), { recursive: true });
    await writeFile(join(bigPiAgentsDirectory, "agent-a", "manifest.json"), "agent a manifest");
    await writeFile(join(bigPiAgentsDirectory, "agent-a", "debug.jsonl"), "agent a debug");
    await mkdir(join(bigPiAgentsDirectory, "agent-b", "blocks"), { recursive: true });
    await writeFile(join(bigPiAgentsDirectory, "agent-b", "manifest.json"), "agent b manifest");
    await mkdir(unrelatedDirectory);
    await writeFile(join(unrelatedDirectory, "keep.txt"), "keep link target");
    await symlink(unrelatedDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    await writeFile(legacySidecar, "legacy");

    await deletePiSessionFiles(sessionPath);

    for (const target of [sessionPath, bigPiDirectory, bigPiAgentsDirectory, legacySidecar]) {
      await assert.rejects(lstat(target), { code: "ENOENT" });
    }
    assert.equal(await readFile(neighboringSession, "utf8"), "keep neighboring session");
    assert.equal(await readFile(join(unrelatedDirectory, "keep.txt"), "utf8"), "keep link target");
    await stat(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session deletion propagates partial cleanup failures and can be retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-vot-delete-partial-"));
  const sessionPath = join(directory, "session.jsonl");
  const metadataSidecar = `${sessionPath}.pi-vot.jsonl`;
  const legacySidecar = `${sessionPath}.big-pi.json`;
  const bigPiDirectory = `${sessionPath}.big-pi`;
  try {
    await writeFile(sessionPath, "transcript");
    await writeFile(metadataSidecar, "Pi-vot metadata");
    await mkdir(legacySidecar);
    await mkdir(bigPiDirectory);
    await writeFile(join(bigPiDirectory, "manifest.json"), "{}");

    await assert.rejects(deletePiSessionFiles(sessionPath), (error: NodeJS.ErrnoException) =>
      ["EISDIR", "EPERM"].includes(error.code ?? ""));

    await assert.rejects(lstat(metadataSidecar), { code: "ENOENT" });
    await stat(sessionPath);
    await stat(bigPiDirectory);
    await stat(legacySidecar);

    await rm(legacySidecar, { recursive: true });
    await deletePiSessionFiles(sessionPath);
    for (const target of [sessionPath, bigPiDirectory, legacySidecar]) {
      await assert.rejects(lstat(target), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi session and project switching is blocked during active, compacting, and queued work", async () => {
  const { child, service } = setup();
  await service.initialize();
  const internalQueue = service as unknown as { queuedMessages: Array<{ id: string; message: string }> };
  internalQueue.queuedMessages.push({ id: "pending-after-compaction", message: "preserve me" });
  await assert.rejects(service.switchSession("/unused"), /queued post-compaction messages/);
  internalQueue.queuedMessages.length = 0;
  child.emitRecord({ type: "agent_start" });
  await assert.rejects(service.switchSession("/unused"), /Finish or stop/);
  await assert.rejects(service.changeProjectDirectory("/unused"), /Finish or stop/);
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => service.state === "idle");

  child.emitRecord({ type: "compaction_start", reason: "manual" });
  await assert.rejects(service.switchSession("/unused"), /Finish or stop/);
  await assert.rejects(service.changeProjectDirectory("/unused"), /Finish or stop/);
  await service.stop();
});

test("failed Pi processes report their disconnect instead of an active-operation guard", async () => {
  const { child, service } = setup();
  await service.initialize();
  child.close(17);

  assert.equal(service.state, "failed");
  await assert.rejects(service.newSession(), /Pi exited with code 17/);
  await assert.rejects(service.switchSession("/unused"), /Pi exited with code 17/);
  await service.stop();
});

test("project changes restart one idle Pi runtime and discover only the new project's sessions", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-vot-projects-"));
  const firstProject = join(temporary, "first");
  const secondProject = join(temporary, "second");
  const firstSession = join(firstProject, "sessions", "first.jsonl");
  const secondSession = join(secondProject, "sessions", "second.jsonl");
  const discoveryContext = {
    env: { PI_CODING_AGENT_DIR: join(temporary, "agent") },
    home: join(temporary, "home"),
  };
  await mkdir(join(firstProject, "sessions"), { recursive: true });
  await mkdir(join(secondProject, "sessions"), { recursive: true });
  const makeFile = async (file: string, cwd: string, id: string) => {
    await writeFile(file, `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-10-01T00:00:00.000Z",
      cwd,
    })}\n`);
  };
  await makeFile(firstSession, firstProject, "first-session");
  await makeFile(secondSession, secondProject, "second-session");
  const children: Array<{ cwd: string; child: FakePiProcess }> = [];
  const service = new PiService(firstProject, (cwd) => {
    const child = new FakePiProcess();
    children.push({ cwd, child });
    const activeFile = cwd === firstProject ? firstSession : secondSession;
    child.onCommand = (command) => {
      if (command.type === "get_state") {
        child.respond(command, { data: {
          isStreaming: false,
          isCompacting: false,
          sessionFile: activeFile,
          sessionId: activeFile,
        } });
      } else if (command.type === "get_session_stats") {
        child.respond(command, { data: { contextUsage: null } });
      } else if (command.type === "get_messages") {
        child.respond(command, { data: { messages: [] } });
      } else {
        child.respond(command);
      }
    };
    return child as unknown as ChildProcessWithoutNullStreams;
  }, undefined, discoveryContext);

  try {
    await service.initialize();
    assert.equal(children.length, 1);
    assert.equal(children[0]?.cwd, firstProject);
    assert.deepEqual(service.snapshot().sessions.map(({ id }) => id), [firstSession]);
    await service.changeProjectDirectory(secondProject);
    assert.equal(children.length, 2);
    assert.equal(children[0]?.child.exitCode, 0);
    assert.equal(children[1]?.cwd, secondProject);
    assert.equal(service.snapshot().projectDirectory, secondProject);
    assert.equal(service.snapshot().activeSessionId, secondSession);
    assert.deepEqual(service.snapshot().sessions.map(({ id }) => id), [secondSession]);
    assert.equal((await readFile(firstSession, "utf8")).includes("first-session"), true);
    await service.stop();
  } finally {
    await service.stop();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Pi session directory names preserve Windows drive and Unix path conventions", () => {
  assert.equal(piSessionDirectoryName("C:\\Users\\Alice\\repo"), "--C--Users-Alice-repo--");
  assert.equal(piSessionDirectoryName("C:\\Users\\Alice\\My Project"), "--C--Users-Alice-My Project--");
  assert.equal(piSessionDirectoryName("/home/alice/repo"), "--home-alice-repo--");
  assert.equal(piSessionDirectoryName("/home/alice/my project"), "--home-alice-my project--");
  assert.equal(piSessionDirectoryName("D:/src/repo"), "--D--src-repo--");
  assert.equal(piSessionDirectoryName("D:/src/My Project"), "--D--src-My Project--");
});

test("Pi session directory fallback follows environment and settings precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-dir-"));
  const cwd = join(root, "My Project");
  const home = join(root, "home");
  const agentDir = join(root, "custom-agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });

  try {
    assert.equal(
      await resolvePiSessionDirectory(cwd, {}, home),
      join(home, ".pi", "agent", "sessions", piSessionDirectoryName(cwd)),
    );
    assert.equal(
      await resolvePiSessionDirectory(cwd, { PI_CODING_AGENT_DIR: agentDir }, home),
      join(agentDir, "sessions", piSessionDirectoryName(cwd)),
    );

    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ sessionDir: join(root, "global-sessions") }),
    );
    assert.equal(
      await resolvePiSessionDirectory(cwd, { PI_CODING_AGENT_DIR: agentDir }, home),
      join(root, "global-sessions"),
    );
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ sessionDir: "relative sessions" }),
    );
    assert.equal(
      await resolvePiSessionDirectory(cwd, { PI_CODING_AGENT_DIR: agentDir }, home),
      join(cwd, "relative sessions"),
    );
    assert.equal(
      await resolvePiSessionDirectory(
        cwd,
        {
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: "~/environment sessions",
        },
        home,
      ),
      join(home, "environment sessions"),
    );
    assert.equal(
      await resolvePiSessionDirectory(
        cwd,
        { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(root, "env-sessions") },
        home,
      ),
      join(root, "env-sessions"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi discovers sessions from configured storage before the active session has a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-discovery-"));
  const cwd = join(root, "project");
  const configuredDirectory = join(root, "configured-sessions");
  const authoritativeDirectory = join(root, "actual-sessions");
  const discoveredSession = join(configuredDirectory, "existing.jsonl");
  const authoritativeSession = join(authoritativeDirectory, "actual.jsonl");
  await mkdir(configuredDirectory, { recursive: true });
  await mkdir(authoritativeDirectory, { recursive: true });
  await writeFile(
    discoveredSession,
    `${JSON.stringify({ type: "session", id: "existing", cwd })}\n${JSON.stringify({
      type: "message",
      message: { role: "user", content: "Stored in custom session directory" },
    })}\n`,
  );
  await writeFile(
    authoritativeSession,
    `${JSON.stringify({ type: "session", id: "actual", cwd })}\n${JSON.stringify({
      type: "message",
      message: { role: "user", content: "Actual RPC session file directory" },
    })}\n`,
  );
  const discoveryContext = {
    env: {
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_CODING_AGENT_SESSION_DIR: configuredDirectory,
    },
    home: join(root, "home"),
  };
  const child = new FakePiProcess();
  let exposeSessionFile = false;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, {
        data: {
          isStreaming: false,
          sessionId: "new-empty-session",
          ...(exposeSessionFile ? { sessionFile: authoritativeSession } : {}),
        },
      });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "get_messages") {
      child.respond(command, { data: { messages: [] } });
    } else {
      child.respond(command);
    }
  };
  const service = new PiService(
    cwd,
    () => child as unknown as ChildProcessWithoutNullStreams,
    undefined,
    discoveryContext,
  );

  try {
    discoveryContext.env.PI_CODING_AGENT_SESSION_DIR = join(root, "changed-after-construction");
    await service.initialize();
    assert.deepEqual(service.snapshot().sessions.map(({ id }) => id), [discoveredSession]);
    exposeSessionFile = true;
    await service.refreshPersistedState();
    assert.deepEqual(
      new Set(service.snapshot().sessions.map(({ id }) => id)),
      new Set([discoveredSession, authoritativeSession]),
    );
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("all-project discovery honors native roots, header cwd, bounded metadata, and corrupt entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-all-projects-"));
  const agentDirectory = join(root, "agent");
  const defaultSessions = join(agentDirectory, "sessions");
  const sharedSessions = join(root, "shared");
  const globalSessions = join(root, "global");
  const projectSessions = join(root, "project-specific");
  const knownCustomSessions = join(root, "known-custom-session-store");
  const currentCwd = join(root, "current");
  const otherCwd = join(root, "other");
  const knownCustomCwd = join(root, "known-custom-project");
  const thirdCwd = join(root, "third");
  await Promise.all([
    mkdir(defaultSessions, { recursive: true }),
    mkdir(sharedSessions, { recursive: true }),
    mkdir(globalSessions, { recursive: true }),
    mkdir(knownCustomSessions, { recursive: true }),
    mkdir(currentCwd, { recursive: true }),
    mkdir(otherCwd, { recursive: true }),
    mkdir(knownCustomCwd, { recursive: true }),
    mkdir(thirdCwd, { recursive: true }),
  ]);
  const writeSession = async (directory: string, filename: string, cwd: string, name?: string) => {
    await mkdir(directory, { recursive: true });
    const file = join(directory, filename);
    await writeFile(file, [
      JSON.stringify({ type: "session", id: filename, cwd }),
      ...(name ? [JSON.stringify({ type: "session_info", name })] : []),
      JSON.stringify({
        type: "message",
        id: `${filename}-user`,
        message: { role: "user", content: "Persisted project history" },
      }),
      JSON.stringify({
        type: "message",
        id: `${filename}-assistant`,
        message: {
          role: "assistant",
          provider: "stored-provider",
          model: "stored-model",
          content: [
            { type: "thinking", thinking: "Stored reasoning" },
            { type: "text", text: "Stored Markdown **answer**" },
          ],
        },
      }),
    ].join("\n") + "\n");
    return file;
  };
  const misleadingPath = join(defaultSessions, piSessionDirectoryName(otherCwd));
  const defaultSession = await writeSession(misleadingPath, "default.jsonl", currentCwd, "Default session");
  const sharedCurrent = await writeSession(sharedSessions, "shared-current.jsonl", currentCwd);
  const sharedOther = await writeSession(sharedSessions, "shared-other.jsonl", otherCwd);
  const knownCustomSession = await writeSession(knownCustomSessions, "custom-only.jsonl", knownCustomCwd);
  const globalSession = await writeSession(globalSessions, "global.jsonl", thirdCwd);
  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({ sessionDir: globalSessions }));
  await mkdir(join(currentCwd, ".pi"), { recursive: true });
  await writeFile(join(currentCwd, ".pi", "settings.json"), JSON.stringify({ sessionDir: projectSessions }));
  await mkdir(join(knownCustomCwd, ".pi"), { recursive: true });
  await writeFile(join(knownCustomCwd, ".pi", "settings.json"), JSON.stringify({ sessionDir: knownCustomSessions }));
  const projectSession = await writeSession(projectSessions, "project-specific.jsonl", currentCwd);
  await writeFile(join(sharedSessions, "corrupt.jsonl"), "{not-json}\n");
  try {
    const sessions = await discoverPiSessions(currentCwd, {
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_CODING_AGENT_SESSION_DIR: sharedSessions,
    }, root, [], [knownCustomCwd]);
    assert.deepEqual(new Set(sessions.map(({ id }) => id)), new Set([
      defaultSession,
      sharedCurrent,
      sharedOther,
      knownCustomSession,
      globalSession,
      projectSession,
    ]));
    assert.equal(sessions.find(({ id }) => id === defaultSession)?.cwd, currentCwd);
    assert.equal(sessions.find(({ id }) => id === sharedOther)?.cwd, otherCwd);
    const history = await hydratePiSession(sessions.find(({ id }) => id === sharedOther)!);
    assert.equal(history.session.cwd, otherCwd);
    assert.equal(history.model?.id, "stored-model");
    assert.deepEqual(history.transcript.map(({ type }) => type), ["user", "assistant"]);
    assert.equal(history.transcript[1]?.type, "assistant");
    if (history.transcript[1]?.type === "assistant") {
      assert.equal(history.transcript[1].thinking, "Stored reasoning");
      assert.equal(history.transcript[1].text, "Stored Markdown **answer**");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
