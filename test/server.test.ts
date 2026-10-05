import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createPaneServer, DEFAULT_PORT, resolvePort } from "../src/server.ts";
import type { PiVotEvent, PiVotSnapshot } from "../src/pi-service.ts";

class FakeService {
  state = "idle";
  messages: string[] = [];
  imageRequests: Array<{ message: string; images: Array<{ mimeType: string; data: string; name?: string }> }> = [];
  aborts = 0;
  messageTargets: Array<string | undefined> = [];
  abortTargets: Array<string | undefined> = [];
  compactions = 0;
  modelListTargets: string[] = [];
  modelChanges: Array<{ sessionId: string; provider: string; modelId: string }> = [];
  sessionActions: string[] = [];
  wakeTargets: string[] = [];
  wakeError?: string;
  projectDirectory = "/fake/project";
  listeners = new Set<(event: PiVotEvent) => void>();

  subscribe(listener: (event: PiVotEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendMessage(
    message: string,
    _messageId?: string,
    sessionId?: string,
    images: Array<{ mimeType: string; data: string; name?: string }> = [],
  ): Promise<string> {
    this.messages.push(message);
    this.imageRequests.push({
      message,
      images: images.map(({ mimeType, data, name }) => ({ mimeType, data, ...(name ? { name } : {}) })),
    });
    this.messageTargets.push(sessionId);
    return this.state === "running" ? "steered" : "started";
  }

  snapshot(): PiVotSnapshot {
    return {
      state: this.state as PiVotSnapshot["state"],
      isCompacting: false,
      context: { tokens: null, contextWindow: null, percent: null },
      model: null,
      queuedMessages: [],
      projectDirectory: this.projectDirectory,
      activeSessionId: null,
      activeSessionName: null,
      sessions: [],
      transcript: [],
    };
  }

  async abort(sessionId?: string): Promise<void> {
    this.aborts++;
    this.abortTargets.push(sessionId);
  }

  async compact(): Promise<void> {
    this.compactions++;
  }

  async getAvailableModels(sessionId: string) {
    this.modelListTargets.push(sessionId);
    return {
      sessionId,
      hasRuntime: true,
      model: { provider: "test", id: "current", name: "Current" },
      models: [{ provider: "test", id: "next", name: "Next" }],
      canChange: true,
    };
  }

  async changeModel(sessionId: string, provider: string, modelId: string) {
    this.modelChanges.push({ sessionId, provider, modelId });
    return {
      sessionId,
      model: { provider, id: modelId, name: modelId },
      context: { tokens: null, contextWindow: 256_000, percent: null },
    };
  }

  async refreshPersistedState(): Promise<void> {
    this.sessionActions.push("refresh");
  }

  async switchSession(sessionId: string): Promise<void> {
    this.sessionActions.push(`switch:${sessionId}`);
  }

  async wakeSession(sessionId: string): Promise<void> {
    this.wakeTargets.push(sessionId);
    this.sessionActions.push(`wake:${sessionId}`);
    if (this.wakeError) throw new Error(this.wakeError);
  }

  async newSession(): Promise<void> {
    this.sessionActions.push("new");
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    this.sessionActions.push(`rename:${sessionId}:${name}`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessionActions.push(`delete:${sessionId}`);
  }

  async releaseRuntime(sessionId: string): Promise<void> {
    this.sessionActions.push(`release:${sessionId}`);
  }

  async changeProjectDirectory(directory: string): Promise<void> {
    this.projectDirectory = directory;
    this.sessionActions.push(`project:${directory}`);
  }

  emit(event: PiVotEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function withServer(callback: (url: string, service: FakeService) => Promise<void>): Promise<void> {
  const service = new FakeService();
  const app = createPaneServer(service);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`, service);
  } finally {
    app.closeEvents();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
}

function postWithHost(url: string, host: string, body: string): Promise<number> {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/api/message",
      method: "POST",
      headers: { host, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("HTTP commands validate input, route sends and stop separately, and report state", async () => {
  await withServer(async (url, service) => {
    const invalid = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });

    assert.equal(invalid.status, 400);

    service.state = "running";
    const sent = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "redirect this run", sessionId: "/project/session-a.jsonl" }),
    });
    assert.equal(sent.status, 202);
    const sendResult = await sent.json();
    assert.equal(sendResult.disposition, "steered");
    assert.match(sendResult.messageId, /^[\da-f-]{36}$/i);
    assert.deepEqual(service.messages, ["redirect this run"]);
    assert.deepEqual(service.messageTargets, ["/project/session-a.jsonl"]);

    const stopped = await fetch(`${url}/api/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "/project/session-a.jsonl" }),
    });
    assert.equal(stopped.status, 202);
    assert.equal(service.aborts, 1);
    assert.deepEqual(service.abortTargets, ["/project/session-a.jsonl"]);
    const compacted = await fetch(`${url}/api/compact`, { method: "POST" });
    assert.equal(compacted.status, 202);
    assert.deepEqual(await compacted.json(), { ok: true });
    assert.equal(service.compactions, 1);
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.state, "running");
    assert.equal(health.isCompacting, false);
  });
});

test("model routes require protected JSON and target the requested runtime", async () => {
  await withServer(async (url, service) => {
    const models = await fetch(`${url}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "/project/session-a.jsonl" }),
    });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).models[0].id, "next");
    assert.deepEqual(service.modelListTargets, ["/project/session-a.jsonl"]);

    const changed = await fetch(`${url}/api/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "/project/session-a.jsonl", provider: "test", modelId: "next" }),
    });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).context.contextWindow, 256_000);
    assert.deepEqual(service.modelChanges, [{
      sessionId: "/project/session-a.jsonl",
      provider: "test",
      modelId: "next",
    }]);

    const unsupported = await fetch(`${url}/api/models`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(unsupported.status, 415);
  });
});

test("message route validates image data and forwards supported image payloads", async () => {
  await withServer(async (url, service) => {
    const post = (value: unknown) => fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    const unsupported = await post({
      message: "reject",
      images: [{ mimeType: "application/pdf", data: "JVBERi0=" }],
    });
    assert.equal(unsupported.status, 400);
    assert.match((await unsupported.json()).error, /Unsupported image type/);
    assert.deepEqual(service.messages, []);

    const malformed = await post({
      message: "reject",
      images: [{ mimeType: "image/png", data: "not base64!" }],
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /malformed/);

    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    const accepted = await post({
      message: "describe",
      images: [{ mimeType: "image/png", data: image, name: "screen.png" }],
      sessionId: "/project/session-a.jsonl",
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(service.imageRequests, [{
      message: "describe",
      images: [{ mimeType: "image/png", data: image, name: "screen.png" }],
    }]);

    const imageOnly = await post({ images: [{ mimeType: "image/png", data: image }] });
    assert.equal(imageOnly.status, 202);
    assert.equal(service.messages.at(-1), "");
  });
});

test("static browser assets are served from the explicit asset list only", async () => {
  await withServer(async (url) => {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(page.headers.get("content-security-policy"),
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("permissions-policy"),
      "clipboard-read=(self), clipboard-write=(self), camera=(), microphone=(), geolocation=()");
    const html = await page.text();
    assert.match(html, /href="\/style\.css"/);
    assert.match(html, /accept="image\/\*" multiple/);
    const main = await fetch(`${url}/main.js`);
    assert.match(main.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(await main.text(), /new EventSource\("\/api\/events"\)/);
    const css = await fetch(`${url}/style.css`);
    assert.match(css.headers.get("x-content-type-options") ?? "", /nosniff/);
    assert.match(await css.text(), /#app-shell/);
    const marked = await fetch(`${url}/vendor/marked.umd.js`);
    assert.match(marked.headers.get("referrer-policy") ?? "", /no-referrer/);
    assert.match(await marked.text(), /marked/);
    assert.match((await (await fetch(`${url}/vendor/highlight.min.js`)).text()).slice(0, 100), /highlight\.js/i);
    assert.match((await (await fetch(`${url}/markdown-security.js`)).text()), /safeMarkdownHref/);
    const health = await fetch(`${url}/api/health`);
    assert.match(health.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);

    for (const path of ["/package.json", "/src/server.ts", "/..%2fsrc%2fserver.ts", "/vendor/../package.json"]) {
      assert.equal((await fetch(`${url}${path}`)).status, 404);
    }
  });
});

test("mutation endpoints require a local Host and reject foreign Origins", async () => {
  await withServer(async (url, service) => {
    const port = new URL(url).port;
    const body = JSON.stringify({ message: "safe local request" });
    const accepted = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        origin: `http://localhost:${port}`,
      },
      body,
    });

    assert.equal(accepted.status, 202);

    const noOrigin = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(noOrigin.status, 202);

    const foreignOrigin = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://malicious.example",
      },
      body,
    });
    assert.equal(foreignOrigin.status, 403);
    assert.match((await foreignOrigin.json()).error, /local origin/);

    assert.equal(await postWithHost(url, `malicious.example:${port}`, body), 403);
    assert.equal(service.messages.length, 2);

    const deniedStop = await fetch(`${url}/api/stop`, {
      method: "POST",
      headers: { origin: `http://localhost:${Number(port) + 1}` },
    });
    assert.equal(deniedStop.status, 403);
    assert.equal(service.aborts, 0);
  });
});

test("PI_VOT_PORT is the only port override and preserves numeric conversion behavior", () => {
  assert.equal(DEFAULT_PORT, 17_361);
  assert.equal(resolvePort({}), DEFAULT_PORT);
  assert.equal(resolvePort({ PI_VOT_PORT: "18000" }), 18_000);
  assert.equal(resolvePort({ PORT: "18000" }), DEFAULT_PORT);
  assert.equal(resolvePort({ PI_PANE_PORT: "18000" }), DEFAULT_PORT);
  assert.equal(resolvePort({ PORT: "17000", PI_VOT_PORT: "18000" }), 18_000);
  assert.equal(resolvePort({ PORT: "17000", PI_PANE_PORT: "18000" }), DEFAULT_PORT);
  assert.ok(Number.isNaN(resolvePort({ PI_VOT_PORT: "invalid" })));
  assert.equal(resolvePort({ PI_VOT_PORT: "" }), 0);
});

test("message mutation requires JSON content type before parsing", async () => {
  await withServer(async (url, service) => {
    const unsupported = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"message":"not accepted"}',
    });
    assert.equal(unsupported.status, 415);
    assert.equal(service.messages.length, 0);

    const accepted = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ message: "valid JSON" }),
    });
    assert.equal(accepted.status, 202);
  });
});

test("session and project routes validate their payloads and invoke the service boundary", async () => {
  await withServer(async (url, service) => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    assert.equal((await post("/api/sessions/switch", { sessionId: "/project/session.jsonl" })).status, 200);
    const wake = await post("/api/sessions/wake", { sessionId: "/project/explicit-target.jsonl" });
    assert.equal(wake.status, 200);
    assert.equal((await wake.json()).state, "idle");
    assert.deepEqual(service.wakeTargets, ["/project/explicit-target.jsonl"]);
    assert.equal((await post("/api/sessions/new", {})).status, 200);
    assert.equal((await post("/api/sessions/rename", { sessionId: "/project/session.jsonl", name: "renamed" })).status, 200);
    assert.equal((await post("/api/sessions/delete", { sessionId: "/project/session.jsonl" })).status, 200);
    assert.equal((await post("/api/sessions/release", { sessionId: "/project/session.jsonl" })).status, 200);
    assert.equal((await post("/api/sessions/refresh", {})).status, 200);
    assert.equal((await post("/api/project/select", { directory: "/fake/new-project" })).status, 200);
    assert.deepEqual(service.sessionActions, [
      "switch:/project/session.jsonl",
      "wake:/project/explicit-target.jsonl",
      "new",
      "rename:/project/session.jsonl:renamed",
      "delete:/project/session.jsonl",
      "release:/project/session.jsonl",
      "refresh",
      "project:/fake/new-project",
    ]);

    const missingId = await post("/api/sessions/switch", {});
    assert.equal(missingId.status, 400);
    assert.equal((await post("/api/sessions/wake", { sessionId: "   " })).status, 400);
    service.wakeError = "Four Pi sessions are already active. Stop or release one before starting another.";
    const atCapacity = await post("/api/sessions/wake", { sessionId: "/project/capacity.jsonl" });
    assert.equal(atCapacity.status, 409);
    assert.match((await atCapacity.json()).error, /Four Pi sessions are already active/);
    service.wakeError = undefined;
    const unsupportedWakeType = await fetch(`${url}/api/sessions/wake`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(unsupportedWakeType.status, 415);
    const foreign = await post("/api/sessions/delete", { sessionId: "/project/session.jsonl" }, {
      origin: "https://malicious.example",
    });
    assert.equal(foreign.status, 403);
    const foreignWake = await post("/api/sessions/wake", { sessionId: "/project/foreign.jsonl" }, {
      origin: "https://malicious.example",
    });
    assert.equal(foreignWake.status, 403);
    assert.deepEqual(service.wakeTargets, [
      "/project/explicit-target.jsonl",
      "/project/capacity.jsonl",
    ]);
    assert.equal(service.sessionActions.length, 9);
  });
});

test("SSE streams normalized application events and sends a state snapshot", async () => {
  await withServer(async (url, service) => {
    const response = await fetch(`${url}/api/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const snapshot = decoder.decode((await reader.read()).value);
    assert.match(snapshot, /"type":"snapshot","state":"idle"/);

    service.emit({ type: "assistant_delta", messageId: "assistant-1", text: "live" });
    const update = decoder.decode((await reader.read()).value);
    assert.match(update, /"type":"assistant_delta"/);
    assert.match(update, /"text":"live"/);
    await reader.cancel();
  });
});
