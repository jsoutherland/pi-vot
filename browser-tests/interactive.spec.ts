import { expect, test } from "@playwright/test";

const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/BkAAAAASUVORK5CYII=",
  "base64",
);

function imageFile(name: string) {
  return { name, mimeType: "image/png", buffer: TEST_PNG };
}

async function waitForResponseHandling(page: import("@playwright/test").Page, response: import("@playwright/test").Response) {
  await response.finished();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test("migrates legacy browser preferences to canonical Pi-vot storage keys", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pi-pane-collapsed-session-groups", JSON.stringify(["/fake/project"]));
    localStorage.setItem("pi-pane-composer-height", "180");
  });
  await page.goto("/");

  await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-vot-collapsed-session-groups")))
    .toBe(JSON.stringify(["/fake/project"]));
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-vot-composer-height"))).toBe("180");
  expect(await page.evaluate(() => localStorage.getItem("pi-pane-collapsed-session-groups"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("pi-pane-composer-height"))).toBeNull();
});

test("user messages and composer preview render inline and fenced Markdown", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  const lineHeights = await page.evaluate(() => ({
    textarea: getComputedStyle(document.querySelector("#message")!).lineHeight,
    overlay: getComputedStyle(document.querySelector("#message-markdown-overlay")!).lineHeight,
  }));
  expect(lineHeights.overlay).toBe(lineHeights.textarea);
  const source = [
    "A `hello` inline snippet.",
    "",
    "```js",
    "const answer = 42;",
    "```",
    "",
    "```",
    "plain fenced code",
    "```",
  ].join("\n");
  await input.fill(source);
  const liveOverlay = page.locator("#message-markdown-overlay");
  await expect(liveOverlay.locator(".composer-markdown-inline")).toHaveText("`hello`");
  await expect(liveOverlay.locator(".composer-markdown-fence")).toHaveCount(2);
  await page.locator("#message-preview-toggle").click();
  await expect(input).toBeHidden();
  const preview = page.locator("#message-preview");
  await expect(preview.locator("p code")).toHaveText("hello");
  await expect(preview.locator(".code-block")).toHaveCount(2);
  await expect(preview.locator(".code-block").nth(0).locator(".code-language")).toHaveText("js");
  await expect(preview.locator(".code-block").nth(1).locator(".code-language")).toHaveText("Code");
  await page.locator("#message-preview-toggle").click();
  await expect(input).toHaveValue(source);
  await input.press("Enter");
  const userMessage = page.locator(".message.user .user-message-content").last();
  await expect(userMessage.locator("p code")).toHaveText("hello");
  await expect(userMessage.locator(".code-block")).toHaveCount(2);
  await expect(userMessage.locator(".code-block").nth(0).locator(".code-language")).toHaveText("js");
  await expect(userMessage.locator(".code-block").nth(1).locator(".code-language")).toHaveText("Code");
});

test.beforeEach(async ({ request }) => {
  await request.post("/__test__/reset");
});

test.afterEach(async ({ page }) => {
  if (page.url()) await page.request.post("/api/stop");
});

test("the sidebar permits four active runtimes and reports the fifth activation limit", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-vot-recent-projects", JSON.stringify(["/fake/other-project"])));
  await page.goto("/");
  const refresh = page.getByRole("button", { name: "Refresh sessions" });
  await refresh.click();
  await refresh.click();
  await expect(page.locator(".session-row")).toHaveCount(5);

  const input = page.getByLabel("Message Pi");
  for (const title of ["HDF5 debugging", "Created in terminal Pi 1", "Created in terminal Pi 2"]) {
    const row = page.locator(".session-row").filter({ hasText: title });
    await row.locator(".session-switch").click();
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(row.locator(".session-active-dot")).toBeHidden();
    await input.fill(`activate ${title}`);
    await input.press("Enter");
    await expect(row.locator(".session-active-dot")).toBeVisible();
  }
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(4);

  const fifth = page.locator(".session-row").filter({ hasText: "Find a parser regression" });
  await fifth.locator(".session-switch").click();
  await expect(fifth).toHaveAttribute("aria-current", "true");
  await expect(fifth.locator(".session-active-dot")).toBeHidden();
  await page.locator("#image-picker").setInputFiles(imageFile("capacity.png"));
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  await input.fill("preserve at capacity");
  await input.press("Enter");
  await expect(page.locator("#status")).toContainText("Four Pi sessions are already active");
  await expect(input).toHaveValue("preserve at capacity");
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(4);

  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();
  await expect(page.locator("#conversation .message")).toHaveCount(0);
  await page.locator("#image-picker").setInputFiles(imageFile("pending-capacity.png"));
  await input.fill("pending capacity draft");
  await input.press("Enter");
  await expect(page.locator("#status")).toContainText("Four Pi sessions are already active");
  await expect(input).toHaveValue("pending capacity draft");
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(4);
});

test("inactive history can be browsed without activating it", async ({ page }) => {
  await page.goto("/");
  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historical.locator(".session-switch").click();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await expect(page.locator(".message.user").first().locator(".image-message-placeholder")).toHaveText("[Image attachment]");
  await expect(page.locator(".message.user").first().locator(".image-message-attachments img")).toHaveCount(0);
  await expect(page.locator(".assistant-text h2")).toHaveText("Persisted heading");
  await expect(historical.locator(".session-active-dot")).toBeHidden();
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(1);
  await expect(page.locator("#context-value")).toContainText("Context unavailable");
  await page.locator(".session-row").filter({ hasText: "Find a parser regression" }).locator(".session-switch").click();
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(1);
  await expect(page.locator(".message.user").first()).toContainText("Find a parser regression");
});

test("empty Big Pi and Billion Context Pi stores do not render a chunk indicator", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#big-pi-indicator")).toBeHidden();
  await expect(page.locator("#warning-indicator")).toBeHidden();
});

test("selected-session Big Pi storage appears beside Context without activating history", async ({ page }) => {
  await page.goto("/");
  const indicator = page.locator("#big-pi-indicator");
  const tooltip = page.locator("#big-pi-details");
  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  const bigPiOnly = page.locator(".session-row").filter({ hasText: "Find a parser regression" });
  const meter = page.locator("#context-meter");
  const initialMeter = await meter.boundingBox();

  await historical.locator(".session-switch").click();
  await expect(historical).toHaveAttribute("aria-current", "true");
  await expect(indicator).toBeVisible();
  await expect(historical.locator(".session-active-dot")).toBeHidden();
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(1);
  expect(await page.locator("#context-label > span:first-child").evaluate((element) => element.nextElementSibling?.id))
    .toBe("big-pi-anchor");
  await expect(indicator.locator("svg")).toHaveCount(1);
  const iconBounds = await indicator.boundingBox();
  expect(iconBounds!.width).toBeLessThanOrEqual(24);
  expect(iconBounds!.height).toBeLessThanOrEqual(24);
  await expect(meter).toBeVisible();
  const selectedMeter = await meter.boundingBox();
  expect(selectedMeter!.x).toBeCloseTo(initialMeter!.x, 0);
  expect(selectedMeter!.width).toBeCloseTo(initialMeter!.width, 0);
  expect(selectedMeter!.y).toBeCloseTo(initialMeter!.y, 0);
  await expect(indicator).toHaveAttribute(
    "aria-label",
    "Billion Context Pi blocks. T1 3, T2 2, T3 1, total blocks 6.",
  );
  await expect(indicator.locator("#big-pi-top-label")).toHaveText("B");

  await indicator.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("Billion Context Pi Blocks");
  await expect(tooltip.locator("#big-pi-disk")).toBeHidden();
  await expect(tooltip).toContainText("T1: 3");
  await expect(tooltip).toContainText("T2: 2");
  await expect(tooltip).toContainText("T3: 1");
  await expect(tooltip).toContainText("Total blocks: 6");

  await indicator.focus();
  await expect(tooltip).toBeVisible();
  await expect(indicator).toHaveAttribute("aria-describedby", "big-pi-details");

  await bigPiOnly.locator(".session-switch").click();
  await expect(bigPiOnly).toHaveAttribute("aria-current", "true");
  await expect(indicator).toBeVisible();
  await expect(indicator.locator("#big-pi-top-label")).toHaveText("");
  await expect(tooltip).toContainText("Big Pi Storage");
  await indicator.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator("#big-pi-disk")).toBeVisible();
  await expect(tooltip).toContainText("Disk usage: 512 B");
  await expect(tooltip).toContainText("T1: 2");
  await expect(tooltip).toContainText("T2: 1");
  await expect(tooltip).toContainText("T3: 1");
  await expect(tooltip).toContainText("Total chunks: 4");
  await expect(meter).toBeVisible();
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(1);

  await historical.locator(".session-switch").click();
  await expect(historical).toHaveAttribute("aria-current", "true");
  await expect(indicator).toBeVisible();
  await expect(tooltip).toContainText("Billion Context Pi Blocks");
  await expect(tooltip).toContainText("Total blocks: 6");
  await expect(bigPiOnly.locator(".session-active-dot")).toBeHidden();
});

test("Billion Context Pi conflict warning is appended after existing warnings", async ({ page }) => {
  await page.goto("/");
  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historical.locator(".session-switch").click();
  await expect(page.locator("#big-pi-indicator")).toBeVisible();
  const input = page.getByLabel("Message Pi");
  await input.fill("show one MCP warning");
  await input.press("Enter");

  const warning = page.locator("#warning-indicator");
  await expect(warning).toBeVisible();
  await warning.hover();
  const messages = page.locator("#warning-messages p");
  await expect(messages).toHaveCount(2);
  await expect(messages.nth(0)).toContainText("MCP: Failed to connect");
  await expect(messages.nth(1)).toHaveText(
    "Both Big Pi and Billion Context Pi session data were detected. Pi-vot is showing Billion Context Pi block summaries.",
  );
});

test("Wake activates selected history without sending, adding transcript, or clearing attachments", async ({ page }) => {
  await page.goto("/");
  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historical.locator(".session-switch").click();
  await expect(page.getByRole("button", { name: "Wake", exact: true })).toBeVisible();
  await expect(page.locator("#compact")).toBeDisabled();
  await expect(page.locator("#context-value")).toContainText("Context unavailable");

  await page.locator("#image-picker").setInputFiles(imageFile("wake-keeps-image.png"));
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  const messagesBefore = await page.locator("#conversation .message").count();
  await page.getByRole("button", { name: "Wake", exact: true }).click();

  await expect(page.getByRole("button", { name: "Wake", exact: true })).toBeHidden();
  await expect(page.locator("#compact")).toBeEnabled();
  await expect(historical.locator(".session-active-dot")).toBeVisible();
  await expect(page.locator("#context-value")).toHaveText("80,000 / 200,000");
  await expect(page.locator("#context-percent")).toHaveText("40%");
  await expect(page.getByRole("button", { name: /Current model: fake-provider \/ fake-model/ })).toBeEnabled();
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  await expect(page.locator("#conversation .message")).toHaveCount(messagesBefore);
});

test("session menu Wake uses runtime activation and disappears once live", async ({ page }) => {
  await page.goto("/");
  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historical.locator(".session-switch").click();
  await expect(page.getByRole("button", { name: "Wake", exact: true })).toBeVisible();
  await historical.locator(".session-actions summary").click();
  await historical.getByRole("button", { name: "Wake session HDF5 debugging" }).click();

  await expect(historical.locator(".session-active-dot")).toBeVisible();
  await expect(page.getByRole("button", { name: "Wake", exact: true })).toBeHidden();
  await historical.locator(".session-actions summary").click();
  await expect(historical.getByRole("button", { name: "Wake session HDF5 debugging" })).toHaveCount(0);
  await expect(page.locator("#conversation .message.user")).toHaveCount(2);
});

test("composer stays viewport-safe with stable splitter sizing and bottom-aligned actions", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto("/");
  const splitter = page.getByRole("separator", { name: "Resize message composer" });
  const form = page.locator("#message-form");
  const textarea = page.getByLabel("Message Pi");
  const send = page.locator("#send");
  await expect(splitter).toHaveAttribute("aria-orientation", "horizontal");
  const initialLayout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return {
      viewport: window.innerHeight,
      document: document.documentElement.scrollHeight,
      model: bounds("#model-trigger"),
      context: bounds("#context-panel"),
      splitter: bounds("#composer-splitter"),
      composer: bounds("#message-form"),
      conversation: bounds("#conversation"),
      send: bounds("#send"),
    };
  });
  expect(initialLayout.document).toBeLessThanOrEqual(initialLayout.viewport + 1);
  for (const element of [initialLayout.model, initialLayout.context, initialLayout.splitter, initialLayout.composer, initialLayout.send]) {
    expect(element.bottom).toBeLessThanOrEqual(initialLayout.viewport + 1);
  }
  expect(initialLayout.send.top).toBeGreaterThanOrEqual(initialLayout.splitter.bottom);
  expect(Math.abs(initialLayout.send.bottom - initialLayout.composer.bottom)).toBeLessThan(2);
  const initial = await form.boundingBox();
  const initialInput = await textarea.boundingBox();
  const initialConversation = await page.locator("#conversation").boundingBox();
  const handle = await splitter.boundingBox();
  expect(initial).not.toBeNull();
  expect(initialConversation).not.toBeNull();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y - 80);
  await page.mouse.up();
  await expect.poll(async () => (await form.boundingBox())!.height).toBeGreaterThan(initial!.height + 50);
  const resized = await form.boundingBox();
  const inputBounds = await textarea.boundingBox();
  const resizedConversation = await page.locator("#conversation").boundingBox();
  expect(resized!.height).toBeGreaterThan(initial!.height + 50);
  expect(inputBounds!.height).toBeGreaterThan(initialInput!.height + 50);
  expect(resizedConversation!.height).toBeLessThan(initialConversation!.height - 50);
  const settledHeight = resized!.height;
  await page.waitForTimeout(100);
  expect((await form.boundingBox())!.height).toBeCloseTo(settledHeight, 0);
  await expect(textarea).toHaveCSS("resize", "none");
  await expect(textarea).toHaveCSS("overflow-y", "auto");
  const resizedActionBounds = await send.boundingBox();
  expect(resizedActionBounds!.height).toBeLessThan(50);
  expect(Math.abs(resizedActionBounds!.y + resizedActionBounds!.height - resized!.y - resized!.height)).toBeLessThan(2);

  const resizedHandle = await splitter.boundingBox();
  await page.mouse.move(resizedHandle!.x + resizedHandle!.width / 2, resizedHandle!.y + resizedHandle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizedHandle!.x + resizedHandle!.width / 2, resizedHandle!.y + 60);
  await page.mouse.up();
  await expect.poll(async () => (await form.boundingBox())!.height).toBeLessThan(settledHeight - 30);

  await textarea.fill("overflow line\n".repeat(120));
  expect(await textarea.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await textarea.fill("long run");
  await textarea.press("Enter");
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  const stopBounds = await stop.boundingBox();
  const sendBounds = await send.boundingBox();
  const formBounds = await form.boundingBox();
  const splitterBounds = await splitter.boundingBox();
  expect(stopBounds!.y).toBeGreaterThanOrEqual(splitterBounds!.y + splitterBounds!.height);
  expect(sendBounds!.y).toBeGreaterThanOrEqual(splitterBounds!.y + splitterBounds!.height);
  expect(stopBounds!.height).toBeLessThan(50);
  expect(sendBounds!.height).toBeLessThan(50);
  expect(Math.abs(stopBounds!.y + stopBounds!.height - formBounds!.y - formBounds!.height)).toBeLessThan(2);
  expect(Math.abs(sendBounds!.y + sendBounds!.height - stopBounds!.y + 6)).toBeLessThan(2);
  expect(stopBounds!.y + stopBounds!.height).toBeLessThanOrEqual(850);

  await splitter.focus();
  await page.keyboard.press("Home");
  await expect.poll(async () => (await form.boundingBox())!.height).toBeGreaterThanOrEqual(96);
  const minimumLayout = await page.evaluate(() => ({
    composer: document.querySelector("#message-form")!.getBoundingClientRect(),
    conversation: document.querySelector("#conversation")!.getBoundingClientRect(),
    maximum: Number(document.querySelector("#composer-splitter")!.getAttribute("aria-valuemax")),
  }));
  expect(minimumLayout.composer.height).toBeGreaterThanOrEqual(96);
  expect(minimumLayout.conversation.height).toBeGreaterThanOrEqual(96);
  expect(minimumLayout.composer.height).toBeLessThanOrEqual(minimumLayout.maximum + 1);
  await page.keyboard.press("End");
  const maximumLayout = await page.evaluate(() => ({
    viewport: window.innerHeight,
    document: document.documentElement.scrollHeight,
    conversation: document.querySelector("#conversation")!.getBoundingClientRect(),
    splitter: document.querySelector("#composer-splitter")!.getBoundingClientRect(),
    form: document.querySelector("#message-form")!.getBoundingClientRect(),
    send: document.querySelector("#send")!.getBoundingClientRect(),
    stop: document.querySelector("#stop")!.getBoundingClientRect(),
  }));
  expect(maximumLayout.document).toBeLessThanOrEqual(maximumLayout.viewport + 1);
  expect(maximumLayout.conversation.height).toBeGreaterThanOrEqual(96);
  expect(maximumLayout.send.height).toBeLessThan(50);
  expect(maximumLayout.stop.height).toBeLessThan(50);
  expect(maximumLayout.send.top).toBeGreaterThanOrEqual(maximumLayout.splitter.bottom);
  expect(maximumLayout.stop.top).toBeGreaterThanOrEqual(maximumLayout.splitter.bottom);
  expect(maximumLayout.send.bottom).toBeLessThanOrEqual(maximumLayout.viewport);
  expect(maximumLayout.stop.bottom).toBeLessThanOrEqual(maximumLayout.viewport);
  expect(Math.abs(maximumLayout.stop.bottom - maximumLayout.form.bottom)).toBeLessThan(2);
  const savedHeight = await page.evaluate(() => localStorage.getItem("pi-vot-composer-height"));
  await page.reload();
  await expect.poll(async () => page.locator("#message-form").evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(Number(savedHeight));
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(async () => page.locator("#message-form").evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(Number(savedHeight));
  await page.evaluate(() => localStorage.setItem("pi-vot-composer-height", "10000"));
  await page.setViewportSize({ width: 640, height: 480 });
  await page.reload();
  await expect.poll(async () => page.locator("#composer-splitter").evaluate((element) =>
    element.getAttribute("aria-valuenow") === element.getAttribute("aria-valuemax"),
  )).toBe(true);
  const compactViewport = await page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    app: document.querySelector("#app-shell")!.getBoundingClientRect(),
    form: document.querySelector("#message-form")!.getBoundingClientRect(),
    send: document.querySelector("#send")!.getBoundingClientRect(),
    pane: document.querySelector("#conversation")!.getBoundingClientRect(),
    maximum: Number(document.querySelector("#composer-splitter")!.getAttribute("aria-valuemax")),
  }));
  expect(compactViewport.documentHeight).toBeLessThanOrEqual(compactViewport.viewportHeight + 1);
  expect(compactViewport.app.bottom).toBeLessThanOrEqual(compactViewport.viewportHeight + 1);
  expect(compactViewport.form.bottom).toBeLessThanOrEqual(compactViewport.viewportHeight + 1);
  expect(compactViewport.send.bottom).toBeLessThanOrEqual(compactViewport.viewportHeight + 1);
  expect(compactViewport.form.height).toBeLessThanOrEqual(compactViewport.maximum + 1);
  expect(compactViewport.pane.height).toBeGreaterThanOrEqual(0);
});
test("tab title follows only the selected session's ready, running, and error status", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("pi - Ready");
  await page.getByLabel("Message Pi").fill("long run");
  await page.getByLabel("Message Pi").press("Enter");
  await expect(page).toHaveTitle("pi - Running");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page).toHaveTitle("pi - Ready");

  const sessionA = page.locator(".session-row").filter({ hasText: "Current session" });
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await sessionB.locator(".session-switch").click();
  await expect(page).toHaveTitle("pi - Ready");
  await page.request.post("/api/message", {
    data: { message: "background stream", sessionId: "/fake/project/current.jsonl" },
  });
  await expect(sessionA).toHaveAttribute("data-runtime-state", "running");
  await expect(sessionA).toHaveAttribute("data-runtime-state", "idle", { timeout: 5_000 });
  await expect(page).toHaveTitle("pi - Ready");
  await page.request.post("/api/message", {
    data: { message: "background crash", sessionId: "/fake/project/current.jsonl" },
  });
  await expect(sessionA).toHaveAttribute("data-runtime-state", "failed", { timeout: 5_000 });
  await expect(page).toHaveTitle("pi - Ready");
  await sessionA.locator(".session-switch").click();
  await expect(page).toHaveTitle("Pi - Error");
  await sessionB.locator(".session-switch").click();
  await expect(page).toHaveTitle("pi - Ready");
  expect(await page.title()).not.toMatch(/[✓●✕]/);
  expect(await page.title()).not.toContain("Pi-vot");
});

test("Control+ArrowUp and Control+ArrowDown browse the last 25 submitted prompts", async ({ page }) => {
  const submitted: string[] = [];
  await page.route("**/api/message", async (route) => {
    const payload = route.request().postDataJSON() as { message: string; messageId: string; sessionId: string };
    submitted.push(payload.message);
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({
      disposition: "started", messageId: payload.messageId, sessionId: payload.sessionId,
    }) });
  });
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  const prompts = Array.from({ length: 27 }, (_, index) => `prompt ${index + 1}`);
  for (const [index, prompt] of prompts.entries()) {
    await input.fill(prompt);
    await input.press("Enter");
    await expect.poll(() => submitted.length).toBe(index + 1);
    await expect.poll(() => input.inputValue()).toBe("");
  }
  await input.fill("unsent draft");
  const pressHistoryKey = (key: "ArrowUp" | "ArrowDown") => input.evaluate((element, eventKey) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: eventKey, ctrlKey: true, bubbles: true, cancelable: true }));
  }, key);
  await pressHistoryKey("ArrowUp");
  await expect(input).toHaveValue("prompt 27");
  for (let index = 0; index < 24; index++)
    await pressHistoryKey("ArrowUp");
  await expect(input).toHaveValue("prompt 3");
  await pressHistoryKey("ArrowUp");
  await expect(input).toHaveValue("prompt 3");
  for (let index = 0; index < 24; index++)
    await pressHistoryKey("ArrowDown");
  await expect(input).toHaveValue("prompt 27");
  await pressHistoryKey("ArrowDown");
  await expect(input).toHaveValue("unsent draft");
});

test("slash autocomplete discovers Pi prompt templates and preserves variable arguments", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("/");
  const suggestions = page.getByRole("listbox", { name: "Pi prompt templates" });
  await expect(suggestions.getByRole("option")).toHaveCount(2);
  await expect(suggestions).toContainText("Review the requested changes.");
  await input.press("ArrowDown");
  await input.press("Tab");
  await expect(input).toHaveValue("/review ");
  await input.pressSequentially('src/file.ts "API compatibility" extra context');
  const request = page.waitForRequest((item) => item.url().endsWith("/api/message") && item.method() === "POST");
  await input.press("Enter");
  const sent = await request;
  expect(sent.postDataJSON().message).toBe('/review src/file.ts "API compatibility" extra context');
});

test("context recovery details are available from the recovery marker on hover", async ({ page }) => {
  const recoveryText = [
    "✅ **Context Recovery Complete**",
    "",
    "The emergency overflow has been resolved by compressing 14 messages (62,351 characters) into Tier-1 block B000001.",
    "",
    "**Current Status:**",
    "- Context usage: ~47% (down from 142%)",
    "- Available for new work: ~53%",
  ].join("\n");
  const streamEvents = [
    { type: "snapshot", state: "idle", isCompacting: false,
      context: { tokens: null, contextWindow: null, percent: null }, model: null,
      queuedMessages: [], projectDirectory: "/fake/project", activeSessionId: null,
      selectedSessionId: null, activeSessionName: null, sessions: [], transcript: [], historyRevision: "empty" },
    { type: "assistant_start", messageId: "recovery-message", createdAt: "2026-10-09T02:47:49.907Z" },
    { type: "assistant_end", messageId: "recovery-message", text: recoveryText, thinking: "" },
  ];
  await page.addInitScript((events) => {
    class MockEventSource {
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onerror?: () => void;
      constructor() {
        setTimeout(() => {
          this.onopen?.();
          for (const event of events)
            this.onmessage?.({ data: JSON.stringify(event) });
        }, 0);
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: MockEventSource, configurable: true });
  }, streamEvents);
  await page.goto("/");
  const marker = page.locator(".context-recovery-marker");
  await expect(marker).toHaveText("✅ Context Recovery Complete");
  await expect(marker).toHaveAttribute("title", "Context usage: ~47% (down from 142%)\nAvailable for new work: ~53%");
  const assistantText = page.locator(".assistant-text");
  await expect(assistantText).not.toContainText("Context usage:");
  await expect(assistantText).not.toContainText("Available for new work:");
  await expect(assistantText).toContainText("compressing 14 messages");
});

test("tab title prioritizes selected-session compaction and recovers after successful, failed, and no-op runs", async ({ page }) => {
  await page.goto("/");
  await page.locator("#compact").click();
  await expect(page).toHaveTitle("pi - Compacting");
  await expect(page.locator("#status-favicon")).toHaveAttribute("data-state", "running");
  await expect(page).toHaveTitle("pi - Ready", { timeout: 3_000 });

  const input = page.getByLabel("Message Pi");
  await input.fill("trigger failed compaction");
  await input.press("Enter");
  await expect(page).toHaveTitle("pi - Compacting");
  await expect(page).toHaveTitle("pi - Ready", { timeout: 3_000 });

  await input.fill("arm no-op compaction");
  await input.press("Enter");
  const previousUserMessages = await page.locator(".message.user").count();
  await page.locator("#compact").click();
  await expect(page).toHaveTitle("pi - Compacting");
  await expect(page).toHaveTitle("pi - Ready", { timeout: 3_000 });
});

test("manual compaction stays disabled below Pi's keep-recent threshold", async ({ page }) => {
  await page.goto("/");
  const compact = page.locator("#compact");
  await expect(compact).toBeEnabled();
  const input = page.getByLabel("Message Pi");
  await input.fill("show small context");
  await input.press("Enter");
  await expect(page.locator("#context-value")).toContainText("19,999 / 200,000");
  await expect(compact).toBeDisabled();
  await expect(compact).toHaveAttribute("title", /keeps the most recent 20,000 tokens/);
  await input.fill("tool-only activity");
  await input.press("Enter");
  await expect(page.locator("#context-value")).toContainText("42,000 / 200,000");
  await expect(compact).toBeEnabled();
});

test("model picker is session-specific, scrollable, viewport-safe, accessible, and failure-safe", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 520 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /Current model:/ });
  await expect(trigger).toBeVisible();
  await expect(page.locator("#attach-images + #model-info")).toHaveCount(1);
  await trigger.click();
  const picker = page.locator("#model-picker");
  const options = picker.getByRole("option");
  await expect(picker).toBeVisible();
  await expect(options).toHaveCount(17);
  await expect(picker.locator('[data-model-id="fake-model"]')).toHaveAttribute("aria-selected", "true");
  await expect(picker.locator('[data-model-id="fake-model"]')).toContainText("✓");
  await expect.poll(() => page.locator("#model-options").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(picker.locator('[data-model-id="fake-model"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(picker.locator('[data-model-id="model-next"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await trigger.click();
  const bounds = await page.evaluate(() => {
    const panel = document.querySelector("#model-picker")!.getBoundingClientRect();
    return {
      left: panel.left,
      right: panel.right,
      top: panel.top,
      bottom: panel.bottom,
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      sidebarWidth: document.querySelector("#session-sidebar")!.scrollWidth,
      sidebarClientWidth: document.querySelector("#session-sidebar")!.clientWidth,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(700);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(520);
  expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
  expect(bounds.sidebarWidth).toBeLessThanOrEqual(bounds.sidebarClientWidth);

  await picker.locator('[data-model-id="model-next"]').click();
  await expect(page.locator("#model-name")).toHaveText("fake-provider / model-next");
  await expect(page.locator("#context-value")).toHaveText("134,982 / 256,000");
  await expect(picker).toBeHidden();

  const sessionA = page.locator(".session-row").filter({ hasText: "Current session" });
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await sessionB.locator(".session-switch").click();
  await expect(page.locator("#model-name")).toHaveText("fake-provider / fake-model");
  await trigger.click();
  await expect(page.locator("#model-picker [role=option]")).toHaveCount(1);
  await expect(page.locator("#model-picker [role=option]")).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByLabel("Message Pi").fill("activate model history");
  await page.getByLabel("Message Pi").press("Enter");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await trigger.click();
  await picker.locator('[data-model-id="available-0"]').click();
  await expect(page.locator("#model-name")).toHaveText("another-provider / available-model-0");
  await sessionA.locator(".session-switch").click();
  await expect(page.locator("#model-name")).toHaveText("fake-provider / model-next");
  await sessionB.locator(".session-switch").click();
  await expect(page.locator("#model-name")).toHaveText("another-provider / available-model-0");

  await trigger.click();
  await picker.locator('[data-model-id="fail-model"]').click();
  await expect(picker).toBeVisible();
  await expect(page.locator("#model-picker-message")).toHaveText("Fake model switch failed.");
  await expect(page.locator("#model-name")).toHaveText("another-provider / available-model-0");
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  await trigger.click();
  await expect(picker).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(picker).toBeHidden();
});

test("non-fatal MCP warnings are compact, accessible, and do not block sending", async ({ page }) => {
  await page.goto("/");
  const warning = page.locator("#warning-indicator");
  const input = page.getByLabel("Message Pi");
  const detail = "MCP: Failed to connect to eclipse_coder: fetch failed — Nothing is listening at http://localhost:8124/mcp/eclipse-coder. Start the app or local process that serves this MCP server.";

  await expect(warning).toBeHidden();
  await input.fill("show one MCP warning");
  await input.press("Enter");
  await expect(warning).toBeVisible();
  await expect(warning).not.toHaveAttribute("title");
  await expect(warning).toHaveAttribute("aria-expanded", "false");
  await warning.focus();
  await page.keyboard.press("Enter");
  await expect(warning).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#warning-details")).toContainText(detail);
  await page.keyboard.press("Escape");
  await expect(page.locator("#warning-details")).toBeHidden();

  await input.fill("send with warning present");
  await input.press("Enter");
  await expect(page.locator(".assistant-text").last()).toHaveText("Canonical final answer.");
  await expect(warning).toBeVisible();
});

test("help opens as formatted Markdown and stays fixed when the warning icon appears or disappears", async ({ page }) => {
  await page.goto("/");
  const helpButton = page.getByRole("button", { name: "Help" });
  const initialX = (await helpButton.boundingBox())!.x;
  await helpButton.click();
  const dialog = page.getByRole("dialog", { name: "Pi-vot Help" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#help-content h1")).toHaveText("Using Pi-vot");
  await expect(dialog.getByRole("heading", { name: "Send, Steer, and Queue" })).toBeVisible();
  await expect(dialog.locator("#help-content pre code")).toContainText(";;;;;");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  const input = page.getByLabel("Message Pi");
  await input.fill("show one MCP warning");
  await input.press("Enter");
  await expect(page.locator("#warning-indicator")).toBeVisible();
  expect((await helpButton.boundingBox())!.x).toBeCloseTo(initialX, 0);
  await page.locator("#warning-indicator").click();
  await page.getByRole("button", { name: "Dismiss warnings" }).click();
  await expect(page.locator("#warning-indicator")).toBeHidden();
  expect((await helpButton.boundingBox())!.x).toBeCloseTo(initialX, 0);
});

test("warning popover opens on hover, follows the pointer, and closes unless pinned", async ({ page }) => {
  await page.goto("/");
  const warning = page.locator("#warning-indicator");
  const details = page.locator("#warning-details");
  const input = page.getByLabel("Message Pi");

  await input.fill("show one MCP warning");
  await input.press("Enter");
  await warning.hover();
  await expect(details).toBeVisible();
  await expect(warning).toHaveAttribute("aria-expanded", "true");
  await details.hover();
  await expect(details).toBeVisible();
  await page.mouse.move(8, 8);
  await expect(details).toBeHidden();
  await expect(warning).toHaveAttribute("aria-expanded", "false");

  await warning.click();
  await expect(details).toBeVisible();
  await expect(warning).toHaveAttribute("aria-expanded", "true");
  await page.mouse.move(8, 8);
  await expect(details).toBeVisible();
  await expect(warning).toHaveAttribute("aria-expanded", "true");
  await warning.click();
  await page.mouse.move(8, 8);
  await expect(details).toBeHidden();
  await expect(warning).toHaveAttribute("aria-expanded", "false");

  const current = page.locator(".session-row").filter({ hasText: "Current session" });
  // This session has Big Pi stats but no compression-conflict warning.
  const historical = page.locator(".session-row").filter({ hasText: "Find a parser regression" });
  await historical.locator(".session-switch").click();
  await expect(historical).toHaveAttribute("aria-current", "true");
  await expect(warning).toBeHidden();
  await current.locator(".session-switch").click();
  await expect(warning).toBeVisible();
  await warning.click();
  await expect(details).toContainText("MCP: Failed to connect to eclipse_coder: fetch failed —");
});

test("dismissing warnings stays dismissed across snapshots and resets for newly added warnings", async ({ page }) => {
  await page.goto("/");
  const warning = page.locator("#warning-indicator");
  const details = page.locator("#warning-details");
  const dismiss = page.getByRole("button", { name: "Dismiss warnings" });
  const input = page.getByLabel("Message Pi");

  await input.fill("show one MCP warning");
  await input.press("Enter");
  await expect(warning).toBeVisible();
  await warning.click();
  await expect(details).toBeVisible();
  await expect(dismiss).toBeVisible();
  await dismiss.focus();
  await expect(dismiss).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(warning).toBeHidden();
  await expect(details).toBeHidden();
  await expect(warning).toHaveAttribute("aria-expanded", "false");

  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(warning).toBeHidden();
  await expect(details).toBeHidden();

  await input.fill("show MCP warnings");
  await input.press("Enter");
  await expect(warning).toBeVisible();
  await warning.click();
  await expect(details).toContainText("MCP: The local browser tools server is unavailable.");
});

test("multiple non-fatal warnings are all available in a compact narrow-screen popover", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 640 });
  await page.goto("/");
  const warning = page.locator("#warning-indicator");
  const input = page.getByLabel("Message Pi");

  await expect(warning).toBeHidden();
  await input.fill("show MCP warnings");
  await input.press("Enter");
  await expect(warning).toBeVisible();
  await expect(page.locator("#warning-count")).toHaveText("2");
  await warning.click();
  const details = page.locator("#warning-details");
  await expect(details).toContainText("MCP: Failed to connect to eclipse_coder: fetch failed.");
  await expect(details).toContainText("MCP: The local browser tools server is unavailable.");
  const layout = await page.evaluate(() => {
    const toolbar = document.querySelector("#composer-toolbar-controls")!.getBoundingClientRect();
    const warningRect = document.querySelector("#warning-indicator")!.getBoundingClientRect();
    const model = document.querySelector("#model-trigger")!.getBoundingClientRect();
    const attach = document.querySelector("#attach-images")!.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      toolbarRight: toolbar.right,
      warningRight: warningRect.right,
      modelRight: model.right,
      attachRight: attach.right,
      detailWidth: document.querySelector("#warning-details")!.getBoundingClientRect().width,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.warningRight).toBeLessThanOrEqual(layout.toolbarRight + 1);
  expect(layout.modelRight).toBeGreaterThan(layout.attachRight);
  expect(layout.detailWidth).toBeLessThanOrEqual(layout.viewport - 16);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport);
});

test("warning popover stays within short and narrow viewports and scrolls long text", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const warning = page.locator("#warning-indicator");
  const details = page.locator("#warning-details");
  const input = page.getByLabel("Message Pi");
  const waitForResizeLayout = () => page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );

  await input.fill("show one MCP warning");
  await input.press("Enter");
  await expect(warning).toBeVisible();
  await details.locator("p").first().evaluate((item) => {
    item.textContent = "warning ".repeat(500);
  });
  await warning.evaluate((button: HTMLButtonElement) => button.click());

  const assertInsideViewport = async () => {
    const bounds = await page.evaluate(() => {
      const rect = document.querySelector("#warning-details")!.getBoundingClientRect();
      const icon = document.querySelector("#warning-indicator")!.getBoundingClientRect();
      const popover = document.querySelector("#warning-details")!;
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        iconTop: icon.top,
        iconBottom: icon.bottom,
        width: window.innerWidth,
        height: window.innerHeight,
        clientHeight: popover.clientHeight,
        scrollHeight: popover.scrollHeight,
        clientWidth: popover.clientWidth,
        scrollWidth: popover.scrollWidth,
        maxHeight: Number.parseFloat((popover as HTMLElement).style.maxHeight),
        availableHeight: Math.min(
          Math.max(
            Math.max(0, icon.top - 8 - 5),
            Math.max(0, window.innerHeight - 8 - icon.bottom - 5),
          ),
          280,
          window.innerHeight - 16,
        ),
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(7);
    expect(bounds.right, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.width - 7);
    expect(bounds.top).toBeGreaterThanOrEqual(7);
    expect(bounds.bottom, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.height - 7);
    expect(bounds.bottom <= bounds.iconTop || bounds.top >= bounds.iconBottom).toBe(true);
    expect(bounds.maxHeight).toBeLessThanOrEqual(bounds.availableHeight);
    expect(bounds.clientHeight).toBeLessThanOrEqual(bounds.maxHeight);
    expect(bounds.scrollHeight).toBeGreaterThan(bounds.clientHeight);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  };

  await expect(details).toBeVisible();
  await assertInsideViewport();
  await page.setViewportSize({ width: 640, height: 640 });
  await waitForResizeLayout();
  await assertInsideViewport();
  await page.setViewportSize({ width: 1280, height: 480 });
  await waitForResizeLayout();
  await assertInsideViewport();
  await page.setViewportSize({ width: 640, height: 480 });
  await waitForResizeLayout();
  await assertInsideViewport();
  await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
  await assertInsideViewport();
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
});

test("model picker avoids activating an inactive session and disables changes while Pi is busy", async ({ page }) => {
  await page.goto("/");
  const current = page.locator(".session-row").filter({ hasText: "Current session" });
  const trigger = page.getByRole("button", { name: /Current model:/ });
  await page.getByLabel("Message Pi").fill("long run");
  await page.getByLabel("Message Pi").press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await trigger.click();
  await expect(page.locator("#model-picker-message")).toHaveText("Model can be changed when the session is idle.");
  await expect(page.locator("#model-picker [role=option]").first()).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();

  await page.getByLabel("Message Pi").fill("arm slow compaction");
  await page.getByLabel("Message Pi").press("Enter");
  await page.locator("#compact").click();
  await expect(page.locator("#compact")).toBeDisabled();
  await trigger.click();
  await expect(page.locator("#model-picker-message")).toHaveText("Model can be changed when the session is idle.");
  await expect(page.locator("#model-picker [role=option]").first()).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#compact")).toBeEnabled();

  await current.locator(".session-actions summary").click();
  await current.getByRole("button", { name: "Close runtime for Current session" }).click();
  await trigger.click();
  await expect(page.locator("#model-picker-message")).toHaveText("Activate this session before changing models.");
  await expect(page.locator("#model-picker [role=option]")).toBeDisabled();
  await expect(current.locator(".session-active-dot")).toBeHidden();
});

test("a delayed model-list response from another session cannot repopulate the selected session picker", async ({ page }) => {
  let delayFirstList = true;
  await page.route("**/api/models", async (route) => {
    const response = await route.fetch();
    if (delayFirstList) {
      delayFirstList = false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.fulfill({ response });
  });
  await page.goto("/");
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await page.getByRole("button", { name: /Current model:/ }).click();
  await sessionB.locator(".session-switch").click();
  await expect(page.locator("#model-picker")).toBeHidden();
  await expect(page.locator("#model-name")).toHaveText("fake-provider / fake-model");
  await page.getByRole("button", { name: /Current model:/ }).click();
  await expect(page.locator("#model-picker [role=option]")).toHaveCount(1);
  await expect(page.locator("#model-picker [data-model-id=\"fake-model\"]")).toBeDisabled();
});

test("rapid selection ignores a late response while background work continues", async ({ page }) => {
  await page.goto("/");
  let mainFrameNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations++;
  });
  const sessionA = page.locator(".session-row").filter({ hasText: "Current session" });
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  const health = await (await page.request.get("/api/health")).json();
  const sessionAId = health.activeSessionId as string;
  const input = page.getByLabel("Message Pi");

  await input.fill("background stream");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await sessionB.locator(".session-switch").click();
  await expect(page.getByRole("button", { name: "Wake", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Wake", exact: true }).click();
  await expect(sessionB.locator(".session-active-dot")).toBeVisible();

  let delayedAResponse = false;
  let delayedAResponseFinished = false;
  await page.route("**/api/sessions/switch", async (route) => {
    const request = route.request().postDataJSON() as { sessionId?: string };
    const response = await route.fetch();
    const shouldDelay = !delayedAResponse && request.sessionId === sessionAId;
    if (shouldDelay) {
      delayedAResponse = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.fulfill({ response });
    if (shouldDelay) delayedAResponseFinished = true;
  });
  await sessionA.locator(".session-switch").click();
  await expect(sessionA).toHaveAttribute("aria-current", "true");
  await sessionB.locator(".session-switch").click();
  await expect(sessionB).toHaveAttribute("aria-current", "true");
  await expect(sessionA).toHaveAttribute("aria-current", "false");
  await expect.poll(() => delayedAResponseFinished).toBe(true);
  await expect(sessionB).toHaveAttribute("aria-current", "true");
  expect(mainFrameNavigations).toBe(0);

  await expect(sessionA).toHaveAttribute("data-runtime-state", "idle", { timeout: 5_000 });
  await sessionA.locator(".session-switch").click();
  await expect(sessionA).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".assistant-text").last()).toHaveText("Background response from A.");
});

test("session selection renders only the latest page of a large transcript", async ({ page }) => {
  await page.goto("/");
  const health = await (await page.request.get("/api/health")).json();
  const sessionBId = health.sessions.find((session: { name: string }) => session.name === "HDF5 debugging").id as string;
  const transcript = Array.from({ length: 4_000 }, (_, index) => ({
    id: `large-history-${index}`,
    type: "user",
    text: `History line ${index}`,
  }));
  const sessionA = page.locator(".session-row").filter({ hasText: "Current session" });
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await page.route("**/api/sessions/switch", async (route) => {
    const request = route.request().postDataJSON() as { sessionId?: string };
    if (request.sessionId === sessionBId) {
      const snapshot = {
        ...health,
        activeSessionId: request.sessionId,
        selectedSessionId: request.sessionId,
        activeSessionName: "HDF5 debugging",
        transcript: transcript.slice(-100),
        transcriptHasOlder: true,
        transcriptBeforeId: transcript.at(-100)!.id,
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
      return;
    }
    await route.continue();
  });

  await sessionB.locator(".session-switch").click();
  await expect(sessionB).toHaveAttribute("aria-current", "true");
  await expect.poll(() => page.locator(".message.user").count()).toBe(100);
  await expect(page.locator(".message.user").first()).toContainText("History line 3900");
  await expect(page.locator(".message.user").last()).toContainText("History line 3999");
  expect(await page.locator(".message.user").count()).toBeLessThan(4_000);
  await sessionA.locator(".session-switch").click();
  await expect(sessionA).toHaveAttribute("aria-current", "true");
});

test("lazy history pages preserve the anchor, chronology, timestamps, and structured entries", async ({ page }) => {
  const transcript: Array<Record<string, unknown>> = Array.from({ length: 250 }, (_, index) => ({
    id: `history-item-${index}`,
    type: "user",
    text: `History message ${index}`,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  }));
  transcript[100] = {
    id: "history-compaction",
    type: "compaction",
    createdAt: "2026-10-02T00:00:00.000Z",
    reason: "overflow",
    tokensBefore: 88_000,
    estimatedTokensAfter: 42_000,
  };
  transcript[148] = {
    id: "history-assistant-tool",
    type: "assistant",
    text: "Assistant before tool",
    thinking: `Initial thought.\n\n${"Detailed thought ".repeat(1_500)}\n\nLast thought line.`,
    createdAt: "2026-10-02T01:00:00.000Z",
  };
  transcript[149] = {
    id: "tool-history-call",
    type: "tool",
    toolCallId: "history-call",
    toolName: "read",
    input: '{"path":"history.txt"}',
    output: `Paginated tool result. ${"large output ".repeat(2_000)}`,
    isError: false,
  };
  const olderPageRequests: string[] = [];
  const baseSnapshot = await page.request.get("/api/health").then((response) => response.json());
  await page.goto("/");
  await page.route("**/api/sessions/switch", async (route) => {
    const request = route.request().postDataJSON() as { sessionId?: string };
    if (request.sessionId?.endsWith("/history-hydration.jsonl")) {
      const snapshot = {
        ...baseSnapshot,
        activeSessionId: request.sessionId,
        selectedSessionId: request.sessionId,
        activeSessionName: "HDF5 debugging",
        transcript: transcript.slice(-100),
        transcriptHasOlder: true,
        transcriptBeforeId: transcript.at(-100)!.id,
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/history?**", async (route) => {
    const url = new URL(route.request().url());
    const beforeId = url.searchParams.get("beforeId")!;
    olderPageRequests.push(beforeId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cursor = transcript.findIndex((item) => item.id === beforeId);
    const start = Math.max(0, cursor - 100);
    const items = transcript.slice(start, cursor);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: url.searchParams.get("sessionId"),
        historyRevision: url.searchParams.get("revision"),
        items,
        hasOlder: start > 0,
        ...(start > 0 ? { beforeId: items[0]!.id } : {}),
      }),
    });
  });
  await page.route("**/api/message", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ disposition: "started", messageId: "history-live-message" }),
    });
  });

  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historical.locator(".session-switch").click();
  const conversation = page.locator("#conversation");
  await expect(page.locator(".message.user")).toHaveCount(100);
  await expect(page.locator(".message.user").first()).toContainText("History message 150");
  await expect(page.locator(".message.user").last()).toContainText("History message 249");
  await expect.poll(() => conversation.evaluate((node) =>
    node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(80);

  const anchor = page.locator('[data-message-id="history-item-150"]');
  await conversation.evaluate((node) => { node.scrollTop = 0; });
  await expect.poll(() => olderPageRequests.length).toBe(1);
  const anchorTopBefore = (await anchor.boundingBox())!.y;
  await expect(page.locator(".message.user")).toHaveCount(197);
  const anchorTopAfter = (await anchor.boundingBox())!.y;
  expect(Math.abs(anchorTopAfter - anchorTopBefore)).toBeLessThan(1.5);
  await expect(page.locator("details.tool")).toHaveAttribute("data-state", "complete");
  await expect(page.locator("details.tool .tool-content")).toHaveText("");
  await page.locator("details.tool summary").click();
  await expect(page.locator("details.tool .tool-content")).toContainText("Paginated tool result.");
  await page.locator("details.tool summary").click();
  await expect(page.locator(".compaction-event")).toHaveCount(1);
  await expect(page.locator(".compaction-event-label")).toHaveAttribute(
    "title",
    "Pi compacted conversation context at this point. Reason: overflow. Estimated context: 88,000 tokens before, 42,000 after.",
  );

  await conversation.focus();
  await conversation.press("PageUp");
  await expect(page.locator(".message.user")).toHaveCount(247);
  await expect(page.locator(".message.user").first()).toContainText("History message 0");
  await expect(page.locator(".message.user").last()).toContainText("History message 249");
  expect(olderPageRequests).toEqual(["history-item-150", "history-item-50"]);
  const userTexts = (await page.locator(".message.user > .user-message-content").allTextContents()).map((text) => text.trim());
  const expectedTexts = transcript.filter((item) => item.type === "user").map((item) => item.text as string);
  expect(userTexts).toEqual(expectedTexts);
  await expect(page.locator('[data-message-id="history-item-0"] time')).toHaveAttribute(
    "datetime",
    "2026-10-01T00:00:00.000Z",
  );
  const historyThinking = page.locator("details.thinking").last();
  await expect(historyThinking.locator(".thinking-preview")).toHaveText("Last thought line.");
  await expect(historyThinking.locator(".thinking-content")).toHaveText("");
  await historyThinking.locator("summary").click();
  await expect(historyThinking.locator(".thinking-content")).toContainText("Detailed thought ");

  await conversation.evaluate((node) => { node.scrollTop = 0; });
  await page.waitForTimeout(100);
  expect(olderPageRequests).toHaveLength(2);
  const readingPosition = await conversation.evaluate((node) => node.scrollTop);
  await page.getByLabel("Message Pi").fill("live while reading older history");
  await page.getByLabel("Message Pi").press("Enter");
  await expect(page.locator(".message.user").last()).toContainText("live while reading older history");
  expect(await conversation.evaluate((node) => node.scrollTop)).toBeLessThan(readingPosition + 5);
});

test("a delayed older-history response is ignored after switching sessions", async ({ page }) => {
  const transcript = Array.from({ length: 250 }, (_, index) => ({
    id: `delayed-history-${index}`,
    type: "user",
    text: `Delayed history ${index}`,
  }));
  let pageRequestStarted = false;
  const baseSnapshot = await page.request.get("/api/health").then((response) => response.json());
  await page.goto("/");
  await page.route("**/api/sessions/switch", async (route) => {
    const request = route.request().postDataJSON() as { sessionId?: string };
    if (request.sessionId?.endsWith("/history-hydration.jsonl")) {
      const snapshot = {
        ...baseSnapshot,
        activeSessionId: request.sessionId,
        selectedSessionId: request.sessionId,
        activeSessionName: "HDF5 debugging",
        transcript: transcript.slice(-100),
        transcriptHasOlder: true,
        transcriptBeforeId: transcript.at(-100)!.id,
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
      return;
    }
    if (request.sessionId?.endsWith("/unnamed.jsonl")) {
      const snapshot = {
        ...baseSnapshot,
        activeSessionId: request.sessionId,
        selectedSessionId: request.sessionId,
        activeSessionName: null,
        transcript: [{ id: "unnamed-user", type: "user", text: "Find a parser regression" }],
        transcriptHasOlder: false,
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/history?**", async (route) => {
    pageRequestStarted = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const url = new URL(route.request().url());
    const cursor = transcript.findIndex((item) => item.id === url.searchParams.get("beforeId"));
    const start = Math.max(0, cursor - 100);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: url.searchParams.get("sessionId"),
        historyRevision: url.searchParams.get("revision"),
        items: transcript.slice(start, cursor),
        hasOlder: start > 0,
        ...(start > 0 ? { beforeId: transcript[start]!.id } : {}),
      }),
    });
  });
  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await expect.poll(() => page.locator(".message.user").count()).toBeGreaterThanOrEqual(100);
  await expect(page.locator(".message.user").last()).toContainText("Delayed history 249");
  await page.locator("#conversation").evaluate((node) => { node.scrollTop = 0; });
  await expect.poll(() => pageRequestStarted).toBe(true);
  await expect(page.locator("#history-loading")).toBeVisible();
  const otherSession = page.locator(".session-row").filter({ hasText: "Find a parser regression" });
  await otherSession.locator(".session-switch").click();
  await expect(otherSession).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".message.user").first()).toContainText("Find a parser regression");
  await page.waitForTimeout(350);
  await expect(page.locator("#conversation")).not.toContainText("Delayed history");
});

test("selected historical sessions show delayed loading progress until transcript rendering completes", async ({ page }) => {
  await page.addInitScript(() => {
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => requestFrame((time) => {
      window.setTimeout(() => callback(time), 200);
    });
  });
  const baseSnapshot = await page.request.get("/api/health").then((response) => response.json());
  const transcript = Array.from({ length: 300 }, (_, index) => {
    const type = ["user", "assistant", "tool", "compaction", "custom"][index % 5];
    return {
      id: `loading-history-${index}`,
      type,
      text: `Loading history ${index}`,
      toolCallId: `loading-tool-${index}`,
      toolName: "bash",
      input: "{}",
      output: "done",
      createdAt: "2026-10-08T00:00:00.000Z",
    };
  });
  let requestStarted = false;
  let allowResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { allowResponse = resolve; });
  await page.goto("/");
  await page.route("**/api/sessions/switch", async (route) => {
    requestStarted = true;
    await responseGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...baseSnapshot,
        activeSessionId: "/fake/project/history-hydration.jsonl",
        selectedSessionId: "/fake/project/history-hydration.jsonl",
        activeSessionName: "HDF5 debugging",
        historyRevision: "loading-history",
        transcript,
        transcriptHasOlder: false,
      }),
    });
  });
  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await expect.poll(() => requestStarted).toBe(true);

  const indicator = page.locator("#session-history-loading");
  await expect(indicator).toBeHidden();
  await page.waitForTimeout(2100);
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute("aria-live", "off");
  await expect(page.locator("#session-history-loading-count")).toHaveAttribute("aria-live", "off");
  await expect(page.locator("#session-history-loading-announcement")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#session-history-loading-announcement")).toHaveText("Loading session history.");
  await expect(page.locator("#session-history-loading-count")).toHaveText("Loaded 0 messages…");
  const bounds = await page.evaluate(() => {
    const area = document.querySelector("#conversation-area")!.getBoundingClientRect();
    const spinner = document.querySelector(".session-history-spinner")!.getBoundingClientRect();
    return {
      centerX: Math.abs(spinner.left + spinner.width / 2 - (area.left + area.width / 2)),
      centerYRatio: (spinner.top + spinner.height / 2 - area.top) / area.height,
      contained: spinner.left >= area.left && spinner.right <= area.right &&
        spinner.top >= area.top && spinner.bottom <= area.bottom,
    };
  });
  expect(bounds.centerX).toBeLessThan(2);
  expect(bounds.centerYRatio).toBeGreaterThan(0.65);
  expect(bounds.centerYRatio).toBeLessThan(0.9);
  expect(bounds.contained).toBe(true);

  allowResponse();
  const progress = page.locator("#session-history-loading-count");
  await expect.poll(async () => {
    const match = (await progress.textContent())?.match(/^Loaded (\d+) messages…$/);
    return match ? Number(match[1]) : 0;
  }).toBeGreaterThan(0);
  const progressCounts = new Set<number>();
  for (let attempt = 0; attempt < 20 && await indicator.isVisible(); attempt++) {
    const match = (await progress.textContent())?.match(/^Loaded (\d+) messages…$/);
    if (match)
      progressCounts.add(Number(match[1]));
    await page.waitForTimeout(150);
  }
  expect(progressCounts.size).toBeGreaterThan(1);
  await expect.poll(async () => {
    const match = (await progress.textContent())?.match(/^Loaded (\d+) messages…$/);
    return match ? Number(match[1]) : 180;
  }).toBeLessThan(180);
  await expect(indicator).toBeHidden({ timeout: 15000 });
  await expect(page.locator(".message.user")).toHaveCount(60);
  const lastVisibleCount = await progress.textContent();
  expect(Number(lastVisibleCount?.match(/^Loaded (\d+) messages…$/)?.[1])).toBeLessThanOrEqual(180);
  await expect(page.locator("#session-history-loading-announcement")).toHaveText("Loading session history.");
});

test("quick selected-history loads suppress the delayed indicator", async ({ page }) => {
  const baseSnapshot = await page.request.get("/api/health").then((response) => response.json());
  await page.goto("/");
  await page.route("**/api/sessions/switch", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...baseSnapshot,
        activeSessionId: "/fake/project/history-hydration.jsonl",
        selectedSessionId: "/fake/project/history-hydration.jsonl",
        activeSessionName: "HDF5 debugging",
        historyRevision: "quick-history",
        transcript: [{ id: "quick-history-user", type: "user", text: "Quick history" }],
        transcriptHasOlder: false,
      }),
    });
  });
  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  const indicator = page.locator("#session-history-loading");
  await expect(indicator).toBeHidden();
  await expect(page.locator(".message.user")).toContainText("Quick history");
  await page.waitForTimeout(2100);
  await expect(indicator).toBeHidden();
});

test("failed and superseded selected-history loads clean up only their own indicator", async ({ page }) => {
  const baseSnapshot = await page.request.get("/api/health").then((response) => response.json());
  let firstStarted = false;
  let secondStarted = false;
  let resolveFirst!: () => void;
  let resolveSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { resolveSecond = resolve; });
  await page.goto("/");
  await page.route("**/api/sessions/switch", async (route) => {
    const sessionId = (route.request().postDataJSON() as { sessionId?: string }).sessionId;
    if (sessionId?.endsWith("/history-hydration.jsonl")) {
      firstStarted = true;
      await firstGate;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...baseSnapshot,
          activeSessionId: sessionId,
          selectedSessionId: sessionId,
          activeSessionName: "HDF5 debugging",
          historyRevision: "stale-history",
          transcript: [{ id: "stale-history-user", type: "user", text: "Stale history" }],
          transcriptHasOlder: false,
        }),
      });
      return;
    }
    if (sessionId?.endsWith("/unnamed.jsonl")) {
      secondStarted = true;
      await secondGate;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...baseSnapshot,
          activeSessionId: sessionId,
          selectedSessionId: sessionId,
          activeSessionName: null,
          historyRevision: "current-history",
          transcript: [{ id: "current-history-user", type: "user", text: "Current history" }],
          transcriptHasOlder: false,
        }),
      });
      return;
    }
    await route.continue();
  });

  const indicator = page.locator("#session-history-loading");
  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await expect.poll(() => firstStarted).toBe(true);
  await page.waitForTimeout(2100);
  await expect(indicator).toBeVisible();

  const otherSession = page.locator(".session-row").filter({ hasText: "Find a parser regression" });
  await otherSession.locator(".session-switch").click();
  await expect.poll(() => secondStarted).toBe(true);
  await page.waitForTimeout(2100);
  await expect(indicator).toBeVisible();

  resolveFirst();
  await page.waitForTimeout(100);
  await expect(indicator).toBeVisible();
  resolveSecond();
  await expect(otherSession).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".message.user")).toContainText("Current history");
  await expect(indicator).toBeHidden();
});

test("a failed selected-history load hides the indicator and preserves the error message", async ({ page }) => {
  let requestStarted = false;
  let failRequest!: () => void;
  const responseGate = new Promise<void>((resolve) => { failRequest = resolve; });
  await page.goto("/");
  await page.route("**/api/sessions/switch", async (route) => {
    requestStarted = true;
    await responseGate;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "History is unavailable." }),
    });
  });
  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  const indicator = page.locator("#session-history-loading");
  await expect.poll(() => requestStarted).toBe(true);
  await page.waitForTimeout(2100);
  await expect(indicator).toBeVisible();
  failRequest();
  await expect(indicator).toBeHidden({ timeout: 3000 });
  await expect(page.locator("#status")).toContainText("History is unavailable.");
});

test("history refreshes reconcile changed entries, preserve loaded pages, and reject delayed old revisions", async ({ page }) => {
  const transcript: Array<Record<string, unknown>> = Array.from({ length: 250 }, (_, index) => ({
    id: `revision-history-${index}`,
    type: "user",
    text: `Revision history ${index}`,
  }));
  transcript[245] = {
    id: "revision-assistant",
    type: "assistant",
    text: "Assistant before refresh",
    thinking: "Old thinking",
  };
  transcript[246] = {
    id: "tool-revision-call",
    type: "tool",
    toolCallId: "revision-call",
    toolName: "read",
    input: '{"path":"old.txt"}',
    output: "Old tool output",
    isError: false,
  };
  const baseSnapshot = await page.request.get("/api/health").then((response) => response.json());
  const historicalId = "/fake/project/history-hydration.jsonl";
  const initialSnapshot = {
    ...baseSnapshot,
    activeSessionId: historicalId,
    selectedSessionId: historicalId,
    activeSessionName: "HDF5 debugging",
    historyRevision: "revision-a",
    transcript: transcript.slice(-100),
    transcriptHasOlder: true,
    transcriptBeforeId: transcript.at(-100)!.id,
  };
  let latestSnapshot = initialSnapshot;
  let historyPageCount = 0;
  let releaseDelayedPage!: () => void;
  let delayedPageStarted!: () => void;
  const delayedStarted = new Promise<void>((resolve) => { delayedPageStarted = resolve; });
  const delayedPage = new Promise<void>((resolve) => { releaseDelayedPage = resolve; });
  await page.goto("/");
  await page.route("**/api/sessions/switch", async (route) => {
    const request = route.request().postDataJSON() as { sessionId?: string };
    if (request.sessionId === historicalId) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(initialSnapshot) });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/sessions/refresh", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(latestSnapshot) });
  });
  await page.route("**/api/history?**", async (route) => {
    const url = new URL(route.request().url());
    const cursor = transcript.findIndex((item) => item.id === url.searchParams.get("beforeId"));
    const start = Math.max(0, cursor - 100);
    historyPageCount++;
    if (historyPageCount > 1) {
      delayedPageStarted();
      await delayedPage;
    }
    const items = transcript.slice(start, cursor);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: url.searchParams.get("sessionId"),
        historyRevision: url.searchParams.get("revision"),
        items,
        hasOlder: start > 0,
        ...(start > 0 ? { beforeId: items[0]!.id } : {}),
      }),
    });
  });

  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await expect(page.locator(".message.user")).toHaveCount(98);
  await page.locator("#conversation").evaluate((node) => { node.scrollTop = 0; });
  await expect.poll(() => historyPageCount).toBe(1);
  await expect(page.locator('[data-message-id="revision-history-50"]')).toHaveCount(1);

  const updatedTranscript = transcript.slice(-100).map((item) => ({ ...item }));
  updatedTranscript[95] = { ...updatedTranscript[95]!, text: "Updated assistant under same ID" };
  updatedTranscript[96] = { ...updatedTranscript[96]!, output: "Updated tool output" };
  updatedTranscript[99] = { ...updatedTranscript[99]!, text: "Updated user under same ID" };
  latestSnapshot = { ...initialSnapshot, transcript: updatedTranscript };
  const loadedAnchor = page.locator('[data-message-id="revision-history-50"]');
  const anchorTopBefore = (await loadedAnchor.boundingBox())!.y;
  await page.locator("#refresh-sessions").click();
  await expect(page.locator('[data-message-id="revision-assistant"]')).toContainText("Updated assistant under same ID");
  await expect(page.locator('[data-message-id="revision-history-249"]')).toContainText("Updated user under same ID");
  await expect(page.locator('[data-message-id="revision-history-50"]')).toHaveCount(1);
  expect(Math.abs((await loadedAnchor.boundingBox())!.y - anchorTopBefore)).toBeLessThan(1.5);
  await page.locator("details.tool summary").click();
  await expect(page.locator("details.tool .tool-content")).toContainText("Updated tool output");

  await page.locator("#conversation").evaluate((node) => { node.scrollTop = 0; });
  await delayedStarted;
  const nextBranch = Array.from({ length: 250 }, (_, index) => ({
    id: `replacement-branch-${index}`,
    type: "user",
    text: `Replacement branch ${index}`,
  }));
  latestSnapshot = {
    ...initialSnapshot,
    historyRevision: "revision-b",
    transcript: nextBranch.slice(-100),
    transcriptBeforeId: nextBranch.at(-100)!.id,
  };
  await page.locator("#refresh-sessions").click();
  await expect(page.locator(".message.user").first()).toContainText("Replacement branch 150");
  releaseDelayedPage();
  await page.waitForTimeout(100);
  await expect(page.locator("#conversation")).not.toContainText("Revision history 50");
  await expect(page.locator("#conversation")).not.toContainText("Updated assistant under same ID");
  await expect(page.locator(".message.user")).toHaveCount(100);
  await expect(page.locator(".message.user").last()).toContainText("Replacement branch 249");
});

test("a model-list failure stays local to the picker and reopening retries", async ({ page }) => {
  let failOnce = true;
  await page.route("**/api/models", async (route) => {
    if (failOnce) {
      failOnce = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fake model list unavailable." }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /Current model:/ });
  await trigger.click();
  await expect(page.locator("#model-picker-status")).toHaveText("Could not load models.");
  await expect(page.locator("#model-picker-message")).toHaveText("Fake model list unavailable.");
  await expect(page.locator("#model-name")).toHaveText("fake-provider / fake-model");
  await expect(page.locator("#status")).not.toHaveAttribute("data-state", "error");
  await trigger.click();
  await trigger.click();
  await expect(page.locator("#model-picker [role=option]")).toHaveCount(17);
});

test("a failed background runtime does not break another session and remains visibly failed", async ({ page }) => {
  await page.goto("/");
  const sessionA = page.locator(".session-row").filter({ hasText: "Current session" });
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  const input = page.getByLabel("Message Pi");

  await expect(sessionA).toHaveAttribute("aria-current", "true");
  await expect(sessionA.locator(".session-active-dot")).toBeVisible();
  await input.fill("background crash");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await sessionB.locator(".session-switch").click();
  await expect(sessionB).toHaveAttribute("aria-current", "true");
  await input.fill("long run");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(sessionB).toHaveAttribute("data-runtime-state", "running");
  await expect(sessionA.locator(".session-active-dot")).toBeHidden({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await sessionA.locator(".session-switch").click();
  await expect(page.getByRole("status")).toHaveText("Fake Pi process crashed.");
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await sessionA.locator(".session-actions summary").click();
  await expect(sessionA.getByRole("button", { name: "Close runtime for Current session" })).toBeVisible();
  await sessionA.getByRole("button", { name: "Close runtime for Current session" }).click();
  await expect(sessionA.locator(".session-active-dot")).toBeHidden();
  await sessionB.locator(".session-switch").click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
});

test("streams assistant output with collapsed thinking and tool details", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("hi");
  await page.getByRole("button", { name: "Send" }).click();

  const assistantText = page.locator(".assistant-text");
  await expect(assistantText).toHaveText("Streaming response ");
  await expect(page.locator("details.thinking")).toHaveCount(1);
  await expect(page.locator("details.tool")).toHaveCount(1);
  await expect(page.locator("details.thinking")).toHaveJSProperty("open", false);
  await expect(page.locator("details.tool")).toHaveJSProperty("open", false);
  await expect(page.locator("details.tool")).toHaveAttribute("data-state", "complete");
  await expect(input).toBeEnabled();
  await expect(assistantText).toHaveText("Canonical final answer.");
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
});

test("collapsed thinking previews stream plain-text latest lines and remain session-isolated", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("thinking preview");
  await input.press("Enter");
  const details = page.locator("details.thinking").last();
  const preview = details.locator(".thinking-preview");
  const content = details.locator(".thinking-content");
  const longLine = `Long thinking line ${"overflow ".repeat(32)}`;

  await expect(details).toHaveJSProperty("open", false);
  await expect(preview).toHaveText("First line");
  await expect(preview).toHaveText(longLine);
  const previewLayout = await preview.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      overflow: style.overflow,
      width: element.getBoundingClientRect().width,
    };
  });
  expect(previewLayout.height).toBeLessThanOrEqual(previewLayout.lineHeight + 1);
  expect(previewLayout.whiteSpace).toBe("nowrap");
  expect(previewLayout.textOverflow).toBe("ellipsis");
  expect(previewLayout.overflow).toBe("hidden");
  await expect(preview).toHaveAttribute("aria-hidden", "true");
  await expect(preview).not.toHaveAttribute("aria-live", "polite");
  await expect(preview).toHaveText("Current unfinished line");
  await expect(details).toHaveJSProperty("open", false);

  await details.locator("summary").click();
  await expect(details).toHaveJSProperty("open", true);
  await expect(preview).toBeHidden();
  await expect(content).toContainText(longLine);
  await expect(content).toContainText("Current unfinished line");
  await details.locator("summary").click();
  await expect(details).toHaveJSProperty("open", false);
  await expect(preview).toBeVisible();
  await expect(preview).toHaveText("Current unfinished line");
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await expect(preview).toHaveText("Current unfinished line");

  await input.fill("thinking session switch");
  await input.press("Enter");
  await expect(page.locator(".thinking-preview").last()).toHaveText("First line");
  const sessionA = page.locator(".session-row").filter({ hasText: "Current session" });
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await sessionB.locator(".session-switch").click();
  await expect(sessionB).toHaveAttribute("aria-current", "true");
  await expect(page.locator("#conversation")).not.toContainText("Current unfinished line");
  await page.waitForTimeout(4_500);
  await sessionA.locator(".session-switch").click();
  await expect(sessionA).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".thinking-preview").last()).toHaveText("Current unfinished line");
});

test("coalesces rapid assistant and thinking deltas without losing canonical content", async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { __assistantBodyMutations: number }).__assistantBodyMutations = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof Element && record.target.matches(".assistant-text, .thinking-content")) {
          (window as typeof window & { __assistantBodyMutations: number }).__assistantBodyMutations++;
        }
      }
    });
    observer.observe(document, { subtree: true, childList: true });
  });
  await page.goto("/");
  await page.evaluate(() => {
    (window as typeof window & { __assistantBodyMutations: number }).__assistantBodyMutations = 0;
  });
  await page.getByLabel("Message Pi").fill("rapid deltas");
  await page.getByLabel("Message Pi").press("Enter");

  const expected = Array.from({ length: 1_000 }, (_, index) => `token-${index}|`).join("");
  await expect(page.locator(".assistant-text")).toHaveText(expected);
  await expect(page.locator(".thinking-content")).toHaveText("Canonical thinking.");
  const renderMutations = await page.evaluate(() =>
    (window as typeof window & { __assistantBodyMutations: number }).__assistantBodyMutations,
  );
  expect(renderMutations).toBeLessThan(100);
});

test("assistant Markdown streams incomplete syntax, renders rich blocks, and uses canonical final text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("markdown response");
  await input.press("Enter");

  const body = page.locator(".assistant-text");
  await expect.poll(async () => body.textContent()).toContain("def f(");
  await expect(body.locator("pre code.language-python").first()).toContainText("def add(a, b):");
  await expect(body).toContainText("Canonical heading");
  await expect(body.locator("h1")).toHaveText("Canonical heading");
  await expect(body.locator("p").first()).toContainText("emphasis");
  await expect(body.locator("em")).toHaveText("emphasis");
  await expect(body.locator("strong")).toHaveText("strong text");
  await expect(body.locator("ol > li")).toHaveCount(2);
  await expect(body.locator("ol ul li")).toHaveText("Nested item");
  await expect(body.locator("blockquote")).toContainText("A quoted line.");
  await expect(body.locator("hr")).toHaveCount(1);
  await expect(body.locator(":not(pre) > code")).toHaveText("inline <code>");
  await expect(body.locator("table tbody tr")).toHaveCount(1);
  await expect(body.locator(".code-block")).toHaveCount(5);
  await expect(body.locator(".code-language")).toHaveText(["javascript", "python", "json", "not-a-real-language", "Code"]);
  await expect(body.locator(".code-block").nth(1).locator("pre > code")).toHaveText("def add(a, b):\n    return a + b");
  await expect(body.locator(".code-block").nth(1).locator("pre")).toHaveCSS("white-space", "pre");
  await expect(body.locator(".code-block").nth(1).locator("pre")).toHaveCSS("overflow-x", "auto");
  await expect(body.locator(".code-block").nth(0).locator(".hljs-keyword")).toHaveCount(1);
  await expect(body.locator(".code-block").nth(1).locator(".hljs-keyword")).toHaveCount(2);
  await expect(body.locator(".code-block").nth(2).locator(".hljs-attr")).toHaveCount(1);
  await expect(body.locator(".code-block").nth(3).locator("pre code")).toHaveText("  <tag> & exact text");
  await expect(body.locator(".code-block").nth(3).locator(".hljs")).toHaveCount(0);

  const copyButton = body.locator(".code-block").nth(1).getByRole("button", { name: "Copy code" });
  await copyButton.click();
  await expect(copyButton).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("def add(a, b):\n    return a + b");
  await expect(pageErrors).toEqual([]);
});

test("message copy controls copy raw message text and wait for assistant completion", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  const userSource = ["Copy *all* of this.", "", "```js", "const n = 42;", "```"].join("\n");
  await input.fill(userSource);
  await input.press("Enter");

  const userMessage = page.locator(".message.user").last();
  const userCopy = userMessage.getByRole("button", { name: "Copy your message" });
  await expect(userCopy).toBeVisible();
  await expect(userMessage.locator(".message-heading time")).toBeVisible();
  expect(await userCopy.evaluate((button) => ({
    inFirstTextBlock: Boolean(button.closest(".user-message-content")?.firstElementChild?.contains(button)),
    floatsRight: getComputedStyle(button).float === "right",
    outsideHeading: !button.closest(".message-heading"),
  }))).toEqual({ inFirstTextBlock: true, floatsRight: true, outsideHeading: true });
  await userCopy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(userSource);

  const assistant = page.locator(".message.assistant").last();
  const assistantCopy = assistant.getByRole("button", { name: "Copy assistant response" });
  await expect(assistant.locator(".assistant-text")).toContainText("Streaming response ");
  await expect(assistantCopy).toBeHidden();
  await expect(assistant.locator(".assistant-text")).toHaveText("Canonical final answer.");
  await expect(assistantCopy).toBeVisible();
  expect(await assistantCopy.evaluate((button) => ({
    inFirstTextBlock: Boolean(button.closest(".assistant-text")?.firstElementChild?.contains(button)),
    floatsRight: getComputedStyle(button).float === "right",
    outsideHeading: !button.closest(".message-heading"),
  }))).toEqual({ inFirstTextBlock: true, floatsRight: true, outsideHeading: true });
  await assistantCopy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Canonical final answer.");
  await expect(assistant).toContainText("I will inspect the request first.");
  await expect(assistant).toContainText("File read successfully.");
  await expect(page.locator(".message.assistant .message-copy-button")).toHaveCount(1);
});

test("Help hover label stays inset from the right edge", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto("/");
  const help = page.getByRole("button", { name: "Help" });
  await help.hover();
  const tooltip = page.getByRole("tooltip", { name: "Help" });
  await expect(tooltip).toBeVisible();
  const bounds = await tooltip.boundingBox();
  expect(bounds).not.toBeNull();
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewportWidth - 12);
});

test("raw model HTML stays inert and dangerous links are not rendered as anchors", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Message Pi").fill("markdown security");
  await page.getByLabel("Message Pi").press("Enter");

  const body = page.locator(".assistant-text");
  await expect(body).toContainText("<script>window.__modelScriptRan = true</script>");
  await expect(body).toContainText("onerror=");
  await expect(body.locator("script, img, iframe")).toHaveCount(0);
  await expect(body.locator("a")).toHaveCount(1);
  await expect(body.locator("a")).toHaveAttribute("href", "https://example.com/");
  await expect(body.locator("a")).toHaveAttribute("rel", "noopener noreferrer");
  expect(await page.evaluate(() => [
    (window as Window & { __modelScriptRan?: boolean }).__modelScriptRan,
    (window as Window & { __modelEventRan?: boolean }).__modelEventRan,
    (window as Window & { __modelFrameRan?: boolean }).__modelFrameRan,
  ])).toEqual([undefined, undefined, undefined]);
});

test("restrictive CSP permits Markdown, highlighting, Copy, SSE, context updates, and favicon status", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(response?.headers()["content-security-policy"]).toContain("style-src 'self'");
  expect(response?.headers()["content-security-policy"]).not.toContain("unsafe-inline");
  await expect.poll(() => page.evaluate(() => {
    const browserWindow = window as Window & { marked?: unknown; hljs?: unknown };
    return Boolean(browserWindow.marked && browserWindow.hljs);
  })).toBe(true);
  await expect(page.locator("#context-meter")).toHaveAttribute("aria-valuenow", "67.5");
  await expect(page.locator("#status-favicon")).toHaveAttribute("data-state", "idle");

  expect(await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__cspInlineScriptRan = true";
    document.head.append(script);
    return (window as Window & { __cspInlineScriptRan?: boolean }).__cspInlineScriptRan;
  })).toBeUndefined();

  await page.getByLabel("Message Pi").fill("markdown response");
  await page.getByLabel("Message Pi").press("Enter");
  const body = page.locator(".assistant-text");
  await expect(body.locator("h1")).toHaveText("Canonical heading");
  await expect(body.locator(".code-block").first().locator(".hljs-keyword")).toHaveCount(1);
  const copy = body.locator(".code-block").nth(1).getByRole("button", { name: "Copy code" });
  await copy.click();
  await expect(copy).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("def add(a, b):\n    return a + b");

  await page.getByRole("button", { name: "Compact" }).click();
  await expect(page.locator("#context-meter")).toHaveAttribute("aria-valuenow", "15.5");
  await expect(page.locator("#context-value")).toHaveText("31,000 / 200,000");
  await expect(page.locator("#status-favicon")).toHaveAttribute("href", /^data:image\/svg\+xml,/);
  await expect(page.locator("#status-favicon")).toHaveAttribute("data-state", "idle");
});

test("tool errors are distinguishable from successful tool completion", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("tool error");
  await input.press("Enter");
  await expect(page.locator("details.tool")).toHaveAttribute("data-state", "error");
  await expect(page.locator("details.tool summary")).toContainText("error");
});

test("Send steers an active run and Stop aborts it without disabling the composer", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long run");
  await page.getByRole("button", { name: "Send" }).click();

  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  const steer = page.getByRole("button", { name: "Steer", exact: true });
  await expect(steer).toBeVisible();
  await expect(input).toBeEnabled();
  await input.fill("redirect now");
  await steer.click();
  await expect(page.getByRole("status")).toHaveText("Message sent to steer the current run.");
  await stop.click();
  await expect(stop).toBeHidden();

  await input.fill("usable again");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".assistant-text")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
});

test("busy actions default to Steer and allow multiple FIFO queue submissions", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#queued-message-area")).toBeHidden();
  const input = page.getByLabel("Message Pi");
  const send = page.locator("#send");
  const picker = page.locator("#busy-mode-picker");

  await expect(send).toHaveText("Send");
  await input.fill("long run");
  await send.click();
  await expect(send).toHaveText("Steer");
  await picker.locator("summary").click();
  await page.locator("#busy-mode-options [data-mode='queue']").click();
  await expect(send).toHaveText("Queue");

  await input.fill("follow-up after this run");
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Message queued for its own Pi turn.");
  await expect(page.locator(".message-delivery").last()).toHaveText("Queued for its own Pi turn");

  await input.fill("second follow-up after this run");
  await expect(send).toBeEnabled();
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Message queued for its own Pi turn.");
  await expect(page.locator(".message-delivery")).toHaveCount(2);
  await expect(page.locator(".message-delivery").nth(0)).toHaveText("Queued for its own Pi turn");
  await expect(page.locator(".message-delivery").nth(1)).toHaveText("Queued for its own Pi turn");
  await expect(page.locator("#queued-message-area")).toBeVisible();
  const queuedToggle = page.locator("#queued-messages-toggle");
  await expect(queuedToggle).toHaveText("Queued Messages (2)");
  const disclosureSizes = await page.evaluate(() => ({
    queuedGroup: getComputedStyle(document.querySelector("#queued-messages-toggle")!, "::before").fontSize,
    queuedMessage: getComputedStyle(document.querySelector("#queued-messages .queued-message-details > summary")!, "::before").fontSize,
    project: getComputedStyle(document.querySelector("#project-directory-disclosure")!).fontSize,
  }));
  expect(disclosureSizes.queuedGroup).toBe(disclosureSizes.queuedMessage);
  expect(disclosureSizes.project).toBe(disclosureSizes.queuedMessage);
  await expect(queuedToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#queued-messages")).toBeHidden();
  await queuedToggle.click();
  await expect(queuedToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#queued-messages")).toBeVisible();
  await expect(page.locator(".queued-message-divider")).toHaveCSS("position", "sticky");
  await expect(page.locator("#queued-messages .queued-message-details")).toHaveCount(2);
  expect(await page.locator("#queued-messages .queued-message-details").evaluateAll((details) =>
    details.every((detail) => !(detail as HTMLDetailsElement).open),
  )).toBe(true);
  await expect(page.locator("#conversation")).not.toContainText("follow-up after this run");
  await expect(page.locator("#conversation")).not.toContainText("second follow-up after this run");
  await page.locator("#queued-messages .queued-message-cancel").first().click();
  await expect(page.locator("#queued-messages .queued-message-details")).toHaveCount(1);
  await expect(page.locator("#queued-messages")).toContainText("second follow-up after this run");
  await page.getByRole("button", { name: "Cancel all queued messages" }).click();
  await expect(page.locator("#queued-message-area")).toBeHidden();
});

test("a pasted prompt batch sends the first prompt and queues the rest in order", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long run\n;;;;;\nfollow-up one\n;;;;;\nfollow-up two");
  await input.press("Enter");

  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.locator("#queued-message-area")).toBeVisible();
  await expect(page.locator("#queued-messages .queued-message-details")).toHaveCount(2);
  await expect(page.locator("#queued-messages")).toContainText("follow-up one");
  await expect(page.locator("#queued-messages")).toContainText("follow-up two");
  await expect(page.locator("#conversation")).toContainText("long run");
  await expect(page.locator("#conversation")).not.toContainText("follow-up one");
  await expect(page.locator("#conversation")).not.toContainText("follow-up two");
});

test("a pasted prompt batch in Queue mode queues every prompt", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long run");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  const picker = page.locator("#busy-mode-picker");
  await picker.locator("summary").click();
  await page.locator("#busy-mode-options [data-mode='queue']").click();
  await input.fill("first queued\n;;;;;\nsecond queued");
  await input.press("Enter");

  await expect(page.locator("#queued-messages .queued-message-details")).toHaveCount(2);
  await expect(page.locator("#queued-messages")).toContainText("first queued");
  await expect(page.locator("#queued-messages")).toContainText("second queued");
  await expect(page.locator("#conversation")).not.toContainText("first queued");
  await expect(page.locator("#conversation")).not.toContainText("second queued");
});

test("busy-mode preference persists per session and idle always shows Send", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  const send = page.locator("#send");
  const current = page.locator(".session-row").filter({ hasText: "Current session" });
  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });

  await expect(send).toHaveText("Send");
  await input.fill("long run");
  await send.click();
  await expect(send).toHaveText("Steer");
  await page.locator("#busy-mode-picker summary").click();
  await page.locator("#busy-mode-options [data-mode='queue']").click();
  await expect(send).toHaveText("Queue");

  await historical.locator(".session-switch").click();
  await expect(send).toHaveText("Send");
  await input.fill("long run");
  await send.click();
  await expect(send).toHaveText("Steer");
  await page.locator("#busy-mode-picker summary").click();
  await page.locator("#busy-mode-options [data-mode='steer']").click();

  await current.locator(".session-switch").click();
  await expect(send).toHaveText("Queue");
  await historical.locator(".session-switch").click();
  await expect(send).toHaveText("Steer");
  const savedModes = await page.evaluate(() => JSON.parse(localStorage.getItem("pi-vot-busy-modes") ?? "{}"));
  expect(savedModes["/fake/project/current.jsonl"]).toBe("queue");
  expect(savedModes["/fake/project/history-hydration.jsonl"]).toBe("steer");
  await page.request.post("/api/stop", { data: { sessionId: "/fake/project/history-hydration.jsonl" } });
  await current.locator(".session-switch").click();
  await expect(send).toHaveText("Queue");
});

test("long conversations scroll independently and follow only while near the bottom", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long transcript");
  await page.getByRole("button", { name: "Send" }).click();

  const conversation = page.locator("#conversation");
  const assistantText = page.locator(".assistant-text");
  await expect.poll(async () => assistantText.evaluate((node) => node.textContent?.length ?? 0)).toBeGreaterThan(500);

  const layout = await page.evaluate(() => {
    const pane = document.querySelector("#conversation")!;
    const composer = document.querySelector("#message-form")!.getBoundingClientRect();
    return {
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      paneClientHeight: pane.clientHeight,
      paneScrollHeight: pane.scrollHeight,
      composerBottom: composer.bottom,
    };
  });
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.paneScrollHeight).toBeGreaterThan(layout.paneClientHeight);
  expect(layout.paneClientHeight).toBeGreaterThan(100);
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(await conversation.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(80);

  await conversation.evaluate((node) => {
    node.scrollTop = 0;
  });
  const beforeReading = await assistantText.evaluate((node) => node.textContent?.length ?? 0);
  await expect.poll(async () => assistantText.evaluate((node) => node.textContent?.length ?? 0)).toBeGreaterThan(beforeReading + 100);
  const readingPosition = await conversation.evaluate((node) => ({
    scrollTop: node.scrollTop,
    bottomGap: node.scrollHeight - node.clientHeight - node.scrollTop,
  }));
  expect(readingPosition.scrollTop).toBeGreaterThanOrEqual(0);
  expect(readingPosition.bottomGap).toBeGreaterThan(80);

  await conversation.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const beforeFollow = await assistantText.evaluate((node) => node.textContent?.length ?? 0);
  await expect.poll(async () => assistantText.evaluate((node) => node.textContent?.length ?? 0)).toBeGreaterThan(beforeFollow + 100);
  expect(await conversation.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(80);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
});

test("Enter sends, Shift+Enter inserts newlines, and composition Enter does not submit", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  const userMessages = page.locator(".message.user");
  await input.press("Enter");
  await expect(userMessages).toHaveCount(0);

  await input.fill("first line");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("first line\n");
  await expect(userMessages).toHaveCount(0);
  await input.type("second line");
  await input.press("Enter");
  await expect(userMessages).toHaveCount(1);
  await expect(userMessages.first()).toContainText("first line\nsecond line");
  await expect(page.locator(".assistant-text").last()).toHaveText("Canonical final answer.");

  await input.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
  });
  await expect(userMessages).toHaveCount(1);
  await expect(input).toBeFocused();
  await input.fill("   ");
  await input.press("Enter");
  await expect(userMessages).toHaveCount(1);

  await input.fill("click still works");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(userMessages).toHaveCount(2);
  await expect(userMessages.nth(1)).toContainText("click still works");
});

test("Enter steers while active and Shift+Enter remains a newline", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long run");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await input.fill("redirect");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("redirect\n");
  await expect(page.locator(".message.user")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await input.type("more");
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Message sent to steer the current run.");
  await expect(page.locator(".message.user").last()).toContainText("redirect\nmore");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
});

test("context/model display and manual compaction preserve drafts while submissions are disabled", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#model-info")).toContainText("fake-provider / fake-model");
  await expect(page.locator("#context-value")).toHaveText("134,982 / 200,000");
  await expect(page.locator("#context-percent")).toHaveText("68%");
  await expect(page.locator("#context-meter #context-percent")).toHaveCount(0);
  await expect(page.locator("#context-percent")).toHaveCSS("color", "rgb(241, 245, 249)");
  await expect(page.locator("#context-meter")).toHaveAttribute("aria-valuenow", "67.5");
  await expect.poll(() => page.locator("#context-meter").evaluate((element) => (element as HTMLMeterElement).value)).toBe(67.5);

  const input = page.getByLabel("Message Pi");
  const previousUserMessages = await page.locator(".message.user").count();
  const compact = page.locator("#compact");
  await compact.click();
  await expect(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  await expect(page.locator("#context-status")).toContainText("compacting");
  await expect(page).toHaveTitle("pi - Compacting");
  await expect(input).toBeEnabled();
  await page.locator("#image-picker").setInputFiles(imageFile("compaction-draft.png"));

  await input.fill("draft held during compaction");
  await input.press("Enter");
  await expect(page.locator("#send")).toBeDisabled();
  await expect(input).toHaveValue("draft held during compaction");
  await expect(page.locator(".message.user")).toHaveCount(previousUserMessages);

  await expect(page.locator("#context-value")).toHaveText("31,000 / 200,000", { timeout: 3_000 });
  await expect(page.locator("#context-percent")).toHaveText("16%");
  await expect(page).toHaveTitle("pi - Ready");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".message.user").first()).toContainText("draft held during compaction");
  await expect(page.locator(".message.user").first().locator(".image-message-attachments img")).toHaveCount(1);
  await expect(page.locator(".image-attachment")).toHaveCount(0);
  await expect(page.locator(".compaction-event")).toHaveCount(1);
  await expect(page.locator(".compaction-event-label")).toHaveText("Compaction Event");
  await expect(page.locator("#compact")).toBeEnabled();
});

test("compaction notice is transient while its timestamped history entry survives", async ({ page }) => {
  await page.goto("/");
  const initialCompactionCount = await page.locator(".compaction-event").count();
  await page.getByRole("button", { name: "Compact" }).click();
  await expect(page.locator("#context-status")).toHaveText("Compaction complete.", { timeout: 3_000 });
  await expect(page.locator(".compaction-event")).toHaveCount(initialCompactionCount + 1);
  await expect(page.locator(".compaction-event time").last()).toHaveAttribute("datetime", /\d{4}-\d\d-\d\dT/);

  const input = page.getByLabel("Message Pi");
  await input.fill("tool-only activity");
  await input.press("Enter");
  await expect(page.locator("#context-status")).toHaveText("Compaction complete.");
  await expect(page.locator("#context-value")).toHaveText("42,000 / 200,000");

  await input.fill("assistant delta only");
  await input.press("Enter");
  await expect(page.locator("#context-status")).toHaveText("Compaction complete.");

  await input.fill("accepted user delayed assistant");
  await input.press("Enter");
  await expect(page.locator("#context-status")).toBeEmpty();
  await expect(page.locator(".assistant-text")).toHaveCount(0);
  await expect(page.locator(".assistant-text")).toHaveCount(1);

  await input.fill("regular follow-up");
  await input.press("Enter");
  await expect(page.locator("#context-status")).toBeEmpty();
  await expect(page.locator(".compaction-event")).toHaveCount(initialCompactionCount + 1);
  await expect(page.locator(".message.user time").last()).toHaveAttribute("datetime", /\d{4}-\d\d-\d\dT/);
  await expect(page.locator(".message.assistant time").last()).toHaveAttribute("datetime", /\d{4}-\d\d-\d\dT/);

  const history = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await history.locator(".session-switch").click();
  await expect(history).toHaveAttribute("aria-current", "true");
  await page.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-switch").click();
  await expect(page.locator(".session-row").filter({ hasText: "Current session" })).toHaveAttribute("aria-current", "true");
  await expect(page.locator("#context-status")).toBeEmpty();
  await expect(page.locator(".compaction-event")).toHaveCount(initialCompactionCount + 1);

  const historicalTimestamp = page.locator(".message.user time").first();
  await history.locator(".session-switch").click();
  await expect(historicalTimestamp).toHaveAttribute("datetime", "2026-10-06T16:18:00.000Z");
  await expect(page.locator(".message.assistant time").first()).toHaveAttribute("datetime", "2026-10-06T16:19:00.000Z");
});

test("assistant messages clear the transient compaction notice when they arrive first", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compact" }).click();
  await expect(page.locator("#context-status")).toHaveText("Compaction complete.", { timeout: 3_000 });

  const input = page.getByLabel("Message Pi");
  await input.fill("tool-only activity");
  await input.press("Enter");
  await expect(page.locator("#context-status")).toHaveText("Compaction complete.");
  await input.fill("assistant delta only");
  await input.press("Enter");
  await expect(page.locator("#context-status")).toHaveText("Compaction complete.");

  await input.fill("assistant-only response");
  await input.press("Enter");
  await expect(page.locator("#context-status")).toBeEmpty();
  await expect(page.locator(".compaction-event")).toHaveCount(1);
});

test("automatic compaction uses the same state and a failed compaction leaves the composer usable", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("trigger automatic compaction");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  await expect(page.locator("#context-status")).toContainText("threshold compaction");
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled({ timeout: 3_000 });

  await input.fill("trigger failed compaction");
  await input.press("Enter");
  await expect(page.locator("#context-status")).toHaveText("Fake compaction failed safely.", { timeout: 3_000 });
  await expect(page.locator("#context-status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(input).toBeEnabled();
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled();
});

test("authoritative recovery clears stale compacting state and restores Send", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("recover stale compaction");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  await expect(page).toHaveTitle("pi - Compacting");

  await input.fill("send after recovered state");
  await input.press("Enter");
  await expect(page.locator("#send")).toBeDisabled();
  await expect(input).toHaveValue("send after recovered state");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 3_000 });
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled();
  await expect(page).toHaveTitle("pi - Ready");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".message.user").last()).toContainText("send after recovered state");
  await expect(page.locator(".compaction-event")).toHaveCount(0);
});

test("assistant and tool transcript updates wait until compaction finishes", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("trigger compaction with streamed agent output");
  await input.press("Enter");
  const compacting = page.getByRole("status");
  await expect(compacting).toContainText("Compacting");
  await expect(page.locator(".message.assistant")).toHaveCount(0);
  await expect(page.locator(".tool")).toHaveCount(0);

  await expect(compacting).toBeHidden({ timeout: 4_000 });
  const assistant = page.locator(".message.assistant").last();
  await expect(assistant.locator(".assistant-text")).toContainText("Response during compaction.");
  await expect(assistant).toContainText("Thinking during compaction.");
  const tool = page.locator(".tool");
  await expect(tool).toContainText("read");
  await expect(tool).toContainText("Tool completed during compaction.");
  await expect(page.locator(".message.assistant").last()).toHaveAttribute("data-message-id", /fake-compaction-agent/);
});

test("a session-too-small compaction result is shown as neutral information", async ({ page }) => {
  await page.goto("/");
  const initialContext = await page.locator("#context-value").innerText();
  const input = page.getByLabel("Message Pi");
  await input.fill("arm no-op compaction");
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText(
    "Pi handled that input without starting a normal agent response.",
  );
  await page.getByRole("button", { name: "Compact" }).click();

  await expect(page.locator("#context-status")).toHaveText("Nothing to compact yet.", { timeout: 3_000 });
  await expect(page.locator("#context-status")).toHaveAttribute("data-state", "info");
  await expect(page.locator("#status")).not.toHaveAttribute("data-state", "error");
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled();
  await expect(input).toBeEnabled();
  await expect(page.locator("#context-value")).toHaveText(initialContext);
});

test("model context window is metadata only when current Pi context usage is unavailable", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("show unavailable context");
  await input.press("Enter");
  await expect(page.locator("#context-value")).toHaveText("Context unavailable · 200,000 window");
  await expect(page.locator("#context-percent")).toHaveText("Unavailable");
  await expect(page.locator("#context-meter")).not.toHaveAttribute("aria-valuenow", /\d/);
  await expect(page.locator("#context-value")).not.toContainText("0 /");

  await input.fill("show incomplete context");
  await input.press("Enter");
  await expect(page.locator("#context-value")).toHaveText("Context unavailable · 200,000 window");
  await expect(page.locator("#context-value")).not.toContainText("100 /");
});

test("session sidebar hydrates Pi history and a browser refresh restores the active transcript", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#project-directory")).toHaveText("/fake/project");
  await expect(page.locator("#session-list .session-row")).toHaveCount(3);
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("Current session");

  const historicalSession = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historicalSession.locator(".session-switch").click();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await expect(page.locator(".message.user").first()).toContainText("Investigate persisted sessions");
  await expect(page.locator(".assistant-text").first()).toHaveText("I will inspect the saved history.");
  await expect(page.locator(".assistant-text h2")).toHaveText("Persisted heading");
  await expect(page.locator(".assistant-text strong")).toHaveText("rich");
  await expect(page.locator(".assistant-text .code-language")).toHaveText("typescript");
  await expect(page.locator("details.thinking")).toContainText("Reviewing the selected Pi session.");
  await expect(page.locator("details.tool")).toHaveAttribute("data-state", "complete");
  await expect(page.locator("details.tool .tool-content")).toContainText("Stored session message.");

  await page.reload();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await expect(page.locator(".message.user").last()).toContainText("Continue from the stored transcript.");
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("HDF5 debugging");
  await expect(page.locator(".assistant-text h2")).toHaveText("Persisted heading");
  await expect(page.locator(".assistant-text .code-block pre code")).toHaveText('const hydrated: string = "Pi";');
});

test("session groups use cwd metadata and preserve collapse state without releasing runtimes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".session-group")).toHaveCount(1);
  const group = page.locator('.session-group[data-cwd="/fake/project"]');
  const header = group.locator(".session-group-header");
  await expect(header).toContainText("/fake/project");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(group.locator(".session-row")).toHaveCount(3);

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(group.locator(".session-group-items")).toBeHidden();
  await expect(group.locator(".session-group-active")).toHaveText("1 active");
  await expect(group.locator('.session-row[aria-current="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(group.locator(".session-group-header")).toHaveAttribute("aria-expanded", "false");

  await page.reload();
  const reloadedGroup = page.locator('.session-group[data-cwd="/fake/project"]');
  await expect(reloadedGroup.locator(".session-group-header")).toHaveAttribute("aria-expanded", "false");
  await reloadedGroup.locator(".session-group-header").click();
  await expect(reloadedGroup.locator(".session-row")).toHaveCount(4);
  await expect(reloadedGroup.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-active-dot")).toBeVisible();
  await reloadedGroup.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-actions summary").click();
  await expect(reloadedGroup.getByRole("button", { name: "Close runtime for Current session" })).toBeVisible();
});

test("session action menus stay inside the sidebar and preserve vertical session scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto("/");
  const refresh = page.getByRole("button", { name: "Refresh sessions" });
  for (let index = 0; index < 10; index++) {
    await refresh.click();
  }

  const sessionList = page.locator("#session-list");
  // Keep enough vertical overflow to exercise scrolling at the supported minimum viewport.
  await sessionList.evaluate((element) => { (element as HTMLElement).style.maxHeight = "180px"; });
  await expect.poll(() => sessionList.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(sessionList).toHaveCSS("overflow-y", "auto");
  await expect(sessionList).toHaveCSS("overflow-x", "hidden");

  const measureMenu = async (menu: import("@playwright/test").Locator) => menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const sidebar = document.querySelector("#session-sidebar")!.getBoundingClientRect();
    const trigger = element.parentElement!.querySelector("summary")!.getBoundingClientRect();
    const list = document.querySelector("#session-list")!;
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      sidebarLeft: sidebar.left,
      sidebarRight: sidebar.right,
      triggerRight: trigger.right,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      listClientWidth: list.clientWidth,
      listScrollWidth: list.scrollWidth,
    };
  });
  const expectMenuVisible = async (menu: import("@playwright/test").Locator) => {
    await expect.poll(async () => {
      const bounds = await measureMenu(menu);
      return bounds.left >= bounds.sidebarLeft &&
        bounds.right <= bounds.sidebarRight &&
        bounds.top >= 0 &&
        bounds.bottom <= bounds.viewportHeight;
    }).toBe(true);
    const bounds = await measureMenu(menu);
    expect(bounds.left).toBeGreaterThanOrEqual(bounds.sidebarLeft);
    expect(bounds.right).toBeLessThanOrEqual(bounds.sidebarRight);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    expect(bounds.width).toBeLessThanOrEqual(bounds.sidebarRight - bounds.sidebarLeft);
    expect(bounds.right).toBeLessThanOrEqual(bounds.triggerRight);
    expect(bounds.listScrollWidth).toBeLessThanOrEqual(bounds.listClientWidth);
  };

  const current = page.locator(".session-row").filter({ hasText: "Current session" });
  const actions = current.locator(".session-actions");
  const menu = actions.locator(".session-menu");
  await actions.locator("summary").click();
  await expect(menu).toBeVisible();
  await expect(current.getByRole("button", { name: "Rename Current session" })).toBeVisible();
  await expect(current.getByRole("button", { name: "Close runtime for Current session" })).toBeVisible();
  await expectMenuVisible(menu);

  await page.keyboard.press("Escape");
  await expect(actions).not.toHaveAttribute("open", "");
  await actions.locator("summary").click();
  await page.locator("#session-toolbar").click();
  await expect(actions).not.toHaveAttribute("open", "");

  await actions.locator("summary").click();
  page.once("dialog", (dialog) => {
    void dialog.accept("Renamed from menu");
  });
  await current.getByRole("button", { name: "Rename Current session" }).click();
  await expect(page.locator(".session-row").filter({ hasText: "Renamed from menu" })).toHaveCount(1);

  await sessionList.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => sessionList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const lastRow = page.locator(".session-row").last();
  const lastActions = lastRow.locator(".session-actions");
  const lastMenu = lastActions.locator(".session-menu");
  await lastActions.locator("summary").click();
  await expect(lastMenu).toBeVisible();
  await expectMenuVisible(lastMenu);
  await expect.poll(() => sessionList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("sessions from separate working directories render in separate selectable groups", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-vot-recent-projects", JSON.stringify(["/fake/other-project"])));
  await page.goto("/");
  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();

  await expect(page.locator(".session-group")).toHaveCount(2);
  const originalProject = page.locator('.session-group[data-cwd="/fake/project"]');
  const otherProject = page.locator('.session-group[data-cwd="/fake/other-project"]');
  await expect(originalProject.locator(".session-row").filter({ hasText: "HDF5 debugging" })).toHaveCount(1);
  await expect(originalProject.locator(".session-group-active")).toHaveText("1 active");
  await expect(otherProject.locator(".session-row").filter({ hasText: "Current session" })).toHaveCount(1);
  await expect(page.locator(".session-group").first()).toHaveAttribute("data-cwd", "/fake/other-project");
  await otherProject.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-switch").click();
  await originalProject.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await expect(originalProject.locator('.session-row[aria-current="true"]')).toContainText("HDF5 debugging");
  await expect(page.locator("#project-directory")).toHaveText("/fake/project");
});

test("project directory menu deduplicates paths, supports keyboard navigation, and persists recent choices", async ({ page }) => {
  const longPath = `/fake/${"a-very-long-directory-segment/".repeat(8)}end`;
  await page.addInitScript((longPath) => {
    localStorage.setItem("pi-vot-recent-projects", JSON.stringify([
      "/fake/project/./",
      "/fake/other-project",
      "C:\\Work\\Repo",
      "c:/work/repo/",
      longPath,
      "/fake/recent-three",
      "/fake/recent-four",
    ]));
  }, longPath);
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Project directory" });
  await expect(page.locator("#project-directory")).toHaveText("/fake/project");
  await expect(trigger).toHaveAttribute("title", "/fake/project");
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Project directories" });
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveCount(7);
  await expect(items.nth(0)).toHaveText("/fake/project");
  await expect(items.nth(1)).toHaveText("/fake/other-project");
  await expect(items.nth(2)).toHaveText("C:\\Work\\Repo");
  await expect(items.nth(3)).toHaveText(longPath);
  await expect(items.nth(6)).toHaveText("Choose directory…");
  await expect(menu.getByRole("separator")).toHaveCount(1);
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  const longItem = items.nth(3);
  await expect(longItem).toHaveAttribute("title", longPath);
  await expect(longItem).toHaveCSS("text-overflow", "ellipsis");
  await items.nth(1).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/other-project");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-vot-recent-projects")))
    .toContain("/fake/project");
  await page.reload();
  await expect(page.locator("#project-directory")).toHaveText("/fake/other-project");
  await trigger.click();
  await expect(items.nth(1)).toHaveText("/fake/project/./");
});

test("Windows project roots, drive paths, and UNC paths deduplicate after normalization", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pi-vot-recent-projects", JSON.stringify([
      "C:\\",
      "c:/",
      "C:\\Work\\Repo\\..\\Repo\\",
      "c:/work/repo",
      "\\\\server\\share\\",
      "//SERVER/share",
      "\\\\server\\share\\folder\\..",
    ]));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Project directory" }).click();
  const items = page.getByRole("menu", { name: "Project directories" }).getByRole("menuitem");
  await expect(items).toHaveCount(5);
  await expect(items.nth(1)).toHaveText("C:\\");
  await expect(items.nth(2)).toHaveText("C:\\Work\\Repo\\..\\Repo\\");
  await expect(items.nth(3)).toHaveText("\\\\server\\share\\");
});

test("an open keyboard-focused project menu retains focus across snapshots and closes when focus leaves", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-vot-recent-projects", JSON.stringify(["/fake/other-project"])));
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Project directory" });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Project directories" });
  const focused = menu.getByRole("menuitem", { name: "/fake/other-project", exact: true });
  await expect(focused).toBeFocused();
  await page.evaluate(() => {
    (window as Window & { focusedProjectItem?: Element }).focusedProjectItem = document.activeElement ?? undefined;
  });
  await page.request.post("/api/sessions/refresh", { data: {} });
  await expect.poll(() => page.evaluate(() => (
    (window as Window & { focusedProjectItem?: Element }).focusedProjectItem === document.activeElement
  ))).toBe(true);
  await expect(menu).toBeVisible();

  await page.request.post("/api/project/select", { data: { directory: "/fake/new-project" } });
  await expect(menu.getByRole("menuitem", { name: "/fake/other-project", exact: true })).toBeFocused();

  await menu.getByRole("menuitem", { name: "Choose directory…" }).focus();
  await page.keyboard.press("Tab");
  await expect(menu).toBeHidden();
});

test("project picker confirmation opens and remembers its directory while cancellation changes nothing", async ({ page }) => {
  let pickerCalls = 0;
  let projectOpenCalls = 0;
  await page.route("**/api/project/pick", async (route) => {
    pickerCalls++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ directory: pickerCalls === 1 ? "/fake/chosen-project" : null }),
    });
  });
  await page.route("**/api/project/select", async (route) => {
    projectOpenCalls++;
    await route.continue();
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Project directory" });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Choose directory…" }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/chosen-project");
  await expect.poll(() => projectOpenCalls).toBe(1);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-vot-recent-projects")))
    .toContain("/fake/project");

  const selectedSessionId = (await (await page.request.get("/api/health")).json()).selectedSessionId;
  await trigger.click();
  await page.getByRole("menuitem", { name: "Choose directory…" }).click();
  await expect.poll(() => pickerCalls).toBe(2);
  await expect(page.locator("#project-directory")).toHaveText("/fake/chosen-project");
  expect(projectOpenCalls).toBe(1);
  expect(selectedSessionId).toBeNull();
  expect((await (await page.request.get("/api/health")).json()).selectedSessionId).toBeNull();
});

test("recent project selection defers creation and sends only to its new session", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-vot-recent-projects", JSON.stringify(["/fake/other-project"])));
  await page.goto("/");
  const oldHistory = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await oldHistory.locator(".session-switch").click();
  await expect(page.locator("#conversation .message.user")).toHaveCount(2);
  const before = await (await page.request.get("/api/health")).json();

  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/other-project");
  await expect(page.locator("#conversation .message")).toHaveCount(0);
  await expect(page.locator('.session-row[aria-current="true"]')).toHaveCount(0);
  const selected = await (await page.request.get("/api/health")).json();
  expect(selected.selectedSessionId).toBeNull();
  expect(selected.sessions.filter((session: { active: boolean }) => session.active))
    .toEqual(before.sessions.filter((session: { active: boolean }) => session.active));
  expect(selected.sessions.filter((session: { cwd: string }) => session.cwd === "/fake/other-project"))
    .toHaveLength(1);

  await page.locator("#image-picker").setInputFiles(imageFile("pending-project.png"));
  const input = page.getByLabel("Message Pi");
  await input.fill("first project message");
  await expect(page.locator("#send")).toBeEnabled();
  await input.press("Enter");

  await expect(page.locator(".assistant-text").last()).toHaveText("Canonical final answer.");
  await expect.poll(async () => {
    const snapshot = await (await page.request.get("/api/health")).json();
    return snapshot.selectedSessionId;
  }).not.toBeNull();
  const afterFirst = await (await page.request.get("/api/health")).json();
  const newSessionId = afterFirst.selectedSessionId;
  expect(afterFirst.sessions.filter((session: { cwd: string }) => session.cwd === "/fake/other-project"))
    .toHaveLength(2);
  expect(afterFirst.sessions.find((session: { id: string }) => session.id === newSessionId).cwd)
    .toBe("/fake/other-project");
  expect(afterFirst.sessions.some((session: { id: string }) => session.id === before.selectedSessionId)).toBe(true);
  await expect(page.locator(".message.user").last()).toContainText("first project message");
  await expect(page.locator(".message.user").last().locator(".image-message-attachments img")).toHaveCount(1);

  await input.fill("second project message");
  await input.press("Enter");
  await expect(page.locator(".assistant-text").last()).toHaveText("Canonical final answer.");
  const afterSecond = await (await page.request.get("/api/health")).json();
  expect(afterSecond.selectedSessionId).toBe(newSessionId);
  expect(afterSecond.sessions.filter((session: { cwd: string }) => session.cwd === "/fake/other-project"))
    .toHaveLength(2);
  await expect(page.locator(".message.user")).toHaveCount(2);
  await expect(oldHistory).toHaveCount(1);

  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();
  await expect(page.locator("#conversation .message")).toHaveCount(0);
  await expect(page.locator('.session-row[aria-current="true"]')).toHaveCount(0);
  expect((await (await page.request.get("/api/health")).json()).selectedSessionId).toBeNull();
});

test("directory picker enters a deferred project view; cancellation and failed selection preserve it", async ({ page }) => {
  let pickerCalls = 0;
  let failSelection = false;
  await page.addInitScript(() => {
    localStorage.setItem("pi-vot-recent-projects", JSON.stringify(["/fake/failing-project"]));
  });
  await page.route("**/api/project/pick", async (route) => {
    pickerCalls++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ directory: pickerCalls === 1 ? "/fake/picker-project" : null }),
    });
  });
  await page.route("**/api/project/select", async (route) => {
    const request = route.request().postDataJSON();
    if (failSelection && request.directory === "/fake/failing-project") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Select an existing project directory." }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historical.locator(".session-switch").click();
  const original = (await (await page.request.get("/api/health")).json()).selectedSessionId;
  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "Choose directory…" }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/picker-project");
  await expect(page.locator("#conversation .message")).toHaveCount(0);
  await expect(page.locator('.session-row[aria-current="true"]')).toHaveCount(0);
  const afterSelection = await (await page.request.get("/api/health")).json();
  expect(afterSelection.selectedSessionId).toBeNull();
  expect(afterSelection.sessions.some((session: { id: string }) => session.id === original)).toBe(true);

  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "Choose directory…" }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/picker-project");
  expect((await (await page.request.get("/api/health")).json()).selectedSessionId).toBeNull();

  failSelection = true;
  await page.getByRole("button", { name: "Project directory" }).click();
  const beforeFailure = await (await page.request.get("/api/health")).json();
  await page.getByRole("menuitem", { name: "/fake/failing-project", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Select an existing project directory.");
  const afterFailure = await (await page.request.get("/api/health")).json();
  expect(afterFailure.projectDirectory).toBe(beforeFailure.projectDirectory);
  expect(afterFailure.selectedSessionId).toBe(beforeFailure.selectedSessionId);
  await expect(page.locator("#project-directory")).toHaveText("/fake/picker-project");

  const input = page.getByLabel("Message Pi");
  await input.fill("picker project message");
  await input.press("Enter");
  await expect(page.locator(".assistant-text").last()).toHaveText("Canonical final answer.");
  const sent = await (await page.request.get("/api/health")).json();
  expect(sent.sessions.find((session: { id: string }) => session.id === sent.selectedSessionId).cwd)
    .toBe("/fake/picker-project");
  expect(pickerCalls).toBe(2);
});

test("failed deferred delivery keeps its draft and image and retries the same new session", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-vot-recent-projects", JSON.stringify(["/fake/other-project"])));
  await page.goto("/");
  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/other-project");
  await expect(page.locator('.session-row[aria-current="true"]')).toHaveCount(0);
  await page.locator("#image-picker").setInputFiles(imageFile("retry-image.png"));
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  const input = page.getByLabel("Message Pi");
  await input.fill("fail message");
  await input.press("Enter");
  await expect(page.locator("#status")).toContainText("Fake Pi rejected the prompt.");
  await expect(input).toHaveValue("fail message");
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  const failedSessionId = (await (await page.request.get("/api/health")).json()).selectedSessionId;
  expect(failedSessionId).toBeNull();
  const failedCount = (await (await page.request.get("/api/health")).json()).sessions
    .filter((session: { cwd: string }) => session.cwd === "/fake/other-project").length;

  await input.fill("retry message");
  await input.press("Enter");
  await expect(page.locator(".assistant-text").last()).toHaveText("Canonical final answer.");
  const afterRetry = await (await page.request.get("/api/health")).json();
  expect(afterRetry.sessions.filter((session: { cwd: string }) => session.cwd === "/fake/other-project"))
    .toHaveLength(failedCount);
  expect(afterRetry.sessions.find((session: { id: string }) => session.id === afterRetry.selectedSessionId).cwd)
    .toBe("/fake/other-project");
  await expect(page.locator(".image-attachment")).toHaveCount(0);
});

test("a deferred Send response cannot update another pending project's conversation", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-vot-recent-projects", JSON.stringify([
    "/fake/other-project",
    "/fake/project-b",
  ])));
  let releaseRequest!: () => void;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const held = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/api/message", async (route) => {
    const body = route.request().postDataJSON();
    if (body.projectDirectory === "/fake/other-project") {
      requestStarted();
      await held;
    }
    await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/other-project");
  await expect(page.locator('.session-row[aria-current="true"]')).toHaveCount(0);
  const input = page.getByLabel("Message Pi");
  await page.locator("#image-picker").setInputFiles(imageFile("project-b.png"));
  await input.fill("deliver in B");
  await input.press("Enter");
  await started;

  const navigation = await page.request.post("/api/project/select", { data: { directory: "/fake/project-b" } });
  expect(navigation.ok()).toBe(true);
  await expect(page.locator("#project-directory")).toHaveText("/fake/project-b");
  await expect(page.locator("#conversation .message")).toHaveCount(0);
  await page.locator("#image-picker").setInputFiles(imageFile("project-c.png"));
  await input.fill("draft in C");
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/message") && response.request().method() === "POST");
  releaseRequest();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  await waitForResponseHandling(page, response);

  await expect(page.locator("#project-directory")).toHaveText("/fake/project-b");
  await expect(page.locator('.session-row[aria-current="true"]')).toHaveCount(0);
  await expect(input).toHaveValue("draft in C");
  await expect(page.locator(".image-attachment")).toContainText("project-c.png");
  await expect(page.locator("#status")).toBeHidden();
  await expect(page.locator("#conversation .message")).toHaveCount(0);
  const snapshot = await (await page.request.get("/api/health")).json();
  expect(snapshot.projectDirectory).toBe("/fake/project-b");
  expect(snapshot.selectedSessionId).toBeNull();
  expect(snapshot.sessions.some((session: { cwd: string; preview: string }) =>
    session.cwd === "/fake/other-project" && session.preview === "deliver in B")).toBe(true);

  const created = page.locator(".session-row").filter({ hasText: "deliver in B" });
  await created.locator(".session-switch").click();
  await expect(page.locator("#conversation .message.user")).toContainText("deliver in B");
  await expect(page.locator("#conversation .message.user .image-message-placeholder")).toHaveText("[Image attachment]");
});

test("a delayed failed Send stays with its project draft and image after navigation", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-vot-recent-projects", JSON.stringify([
    "/fake/other-project",
    "/fake/project-b",
  ])));
  let releaseRequest!: () => void;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const held = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/api/message", async (route) => {
    if (route.request().postDataJSON().projectDirectory === "/fake/other-project") {
      requestStarted();
      await held;
    }
    await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/other-project");
  await page.locator("#image-picker").setInputFiles(imageFile("failed-project-b.png"));
  const input = page.getByLabel("Message Pi");
  await input.fill("fail message");
  await input.press("Enter");
  await started;

  await page.request.post("/api/project/select", { data: { directory: "/fake/project-b" } });
  await expect(page.locator("#project-directory")).toHaveText("/fake/project-b");
  await page.locator("#image-picker").setInputFiles(imageFile("project-c.png"));
  await input.fill("draft in C");
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/message") && response.request().method() === "POST");
  releaseRequest();
  const response = await responsePromise;
  expect(response.status()).toBe(500);
  await waitForResponseHandling(page, response);

  await expect(page.locator("#conversation .message")).toHaveCount(0);
  await expect(page.locator("#status")).toBeHidden();
  await expect(input).toHaveValue("draft in C");
  await expect(page.locator(".image-attachment")).toContainText("project-c.png");
  const failedSessionCount = (await (await page.request.get("/api/health")).json()).sessions
    .filter((session: { cwd: string }) => session.cwd === "/fake/other-project").length;

  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();
  await expect(input).toHaveValue("fail message");
  await expect(page.locator(".image-attachment")).toContainText("failed-project-b.png");
  await input.fill("retry recovered B");
  await input.press("Enter");
  await expect(page.locator("#conversation .message.user")).toContainText("retry recovered B");
  const afterRetry = await (await page.request.get("/api/health")).json();
  expect(afterRetry.sessions.filter((session: { cwd: string }) => session.cwd === "/fake/other-project"))
    .toHaveLength(failedSessionCount);
  await expect(page.locator("#conversation .message.user .image-message-attachments img")).toHaveCount(1);
});

test("a deferred Send cannot alter a selected history session after its response", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-vot-recent-projects", JSON.stringify([
    "/fake/other-project",
  ])));
  let releaseRequest!: () => void;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const held = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/api/message", async (route) => {
    if (route.request().postDataJSON().projectDirectory === "/fake/other-project") {
      requestStarted();
      await held;
    }
    await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/other-project");
  await page.locator("#image-picker").setInputFiles(imageFile("background-send.png"));
  const input = page.getByLabel("Message Pi");
  await input.fill("background project message");
  await input.press("Enter");
  await started;

  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await expect(page.locator("#conversation .message.user").first()).toContainText("Investigate persisted sessions");
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/message") && response.request().method() === "POST");
  releaseRequest();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  await waitForResponseHandling(page, response);

  await expect(page.locator('.session-row[aria-current="true"]')).toContainText("HDF5 debugging");
  await expect(page.locator("#conversation")).not.toContainText("background project message");
  await expect(page.locator("#status")).toBeHidden();
  await expect(input).toHaveValue("");

  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();
  const created = page.locator(".session-row").filter({ hasText: "background project message" });
  await created.locator(".session-switch").click();
  await expect(page.locator("#conversation .message.user")).toContainText("background project message");
  await expect(page.locator("#conversation .message.user .image-message-placeholder")).toHaveText("[Image attachment]");
});

test("opening the browsed project updates the dropdown from confirmation while viewing inactive history", async ({ page }) => {
  let pickerCalls = 0;
  let projectOpenCalls = 0;
  await page.route("**/api/project/pick", async (route) => {
    pickerCalls++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ directory: pickerCalls === 1 ? "/fake/project-b" : "/fake/project" }),
    });
  });
  await page.route("**/api/project/select", async (route) => {
    projectOpenCalls++;
    await route.continue();
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "Choose directory…" }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/project-b");

  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "Choose directory…" }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/project");

  const historical = page.locator(".session-group[data-cwd='/fake/project-b'] .session-row").first();
  await historical.locator(".session-switch").click();
  await expect(historical).toHaveAttribute("aria-current", "true");
  await expect(historical.locator(".session-active-dot")).toBeHidden();
  await expect(page.locator("#project-directory")).toHaveText("/fake/project-b");

  const beforeOpen = await (await page.request.get("/api/health")).json();
  const activeBeforeOpen = beforeOpen.sessions.filter((session: { active: boolean }) => session.active);
  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/project", exact: true }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/project");
  await expect.poll(() => projectOpenCalls).toBe(3);
  const afterRecent = await (await page.request.get("/api/health")).json();
  expect(afterRecent.projectDirectory).toBe("/fake/project");
  expect(afterRecent.selectedSessionId).toBeNull();
  expect(afterRecent.sessions).toHaveLength(beforeOpen.sessions.length);
  expect(afterRecent.sessions.filter((session: { active: boolean }) => session.active)).toEqual(activeBeforeOpen);
  expect(projectOpenCalls).toBe(3);

  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "Choose directory…" }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/project");
  await expect.poll(() => projectOpenCalls).toBe(4);
  const afterPicker = await (await page.request.get("/api/health")).json();
  expect(afterPicker.projectDirectory).toBe("/fake/project");
  expect(afterPicker.selectedSessionId).toBeNull();
  expect(afterPicker.sessions).toHaveLength(beforeOpen.sessions.length);
  expect(afterPicker.sessions.filter((session: { active: boolean }) => session.active)).toEqual(activeBeforeOpen);
  expect(projectOpenCalls).toBe(4);
  expect(pickerCalls).toBe(3);

  await page.getByRole("button", { name: "Project directory" }).click();
  const recentItems = page.getByRole("menu", { name: "Project directories" }).getByRole("menuitem");
  await expect(recentItems.nth(0)).toHaveText("/fake/project");
  await expect(recentItems.nth(1)).toHaveText("/fake/project-b");
});

test("switching to inactive history synchronizes the directory dropdown without opening a project", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-vot-recent-projects", JSON.stringify(["/fake/other-project"])));
  let projectOpenCalls = 0;
  await page.route("**/api/project/select", async (route) => {
    projectOpenCalls++;
    await route.continue();
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Project directory" });
  await trigger.click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/other-project");
  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historical.locator(".session-switch").click();
  await expect(historical).toHaveAttribute("aria-current", "true");
  await expect(historical.locator(".session-active-dot")).toBeHidden();
  await expect(page.locator("#project-directory")).toHaveText("/fake/project");
  const snapshot = await (await page.request.get("/api/health")).json();
  expect(snapshot.projectDirectory).toBe("/fake/other-project");
  expect(snapshot.sessions.find((session: { id: string }) => session.id === snapshot.selectedSessionId).cwd)
    .toBe("/fake/project");
  expect(projectOpenCalls).toBe(1);
  await page.reload();
  await expect(page.locator("#project-directory")).toHaveText("/fake/project");
  await expect(page.locator(".session-row").filter({ hasText: "HDF5 debugging" })).toHaveAttribute("aria-current", "true");
  expect((await (await page.request.get("/api/health")).json()).selectedSessionId).toBe(snapshot.selectedSessionId);
  expect(projectOpenCalls).toBe(1);
});

test("session visits update recent projects newest first and persist without opening or activating sessions", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#project-directory")).toHaveText("/fake/project");

  for (const directory of ["/fake/project-b", "/fake/project-c", "/fake/project"]) {
    const response = await page.request.post("/api/project/select", { data: { directory } });
    expect(response.ok()).toBe(true);
  }
  await expect(page.locator("#project-directory")).toHaveText("/fake/project");

  let projectOpenCalls = 0;
  await page.route("**/api/project/select", async (route) => {
    projectOpenCalls++;
    await route.continue();
  });
  const selectProjectSession = async (directory: string) => {
    const group = page.locator(`.session-group[data-cwd="${directory}"]`);
    await expect(group).toBeVisible();
    const row = group.locator(".session-row").first();
    await row.locator(".session-switch").click();
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(row.locator(".session-active-dot")).toBeHidden();
  };

  await selectProjectSession("/fake/project-b");
  await expect(page.locator("#project-directory")).toHaveText("/fake/project-b");
  await selectProjectSession("/fake/project-c");
  await expect(page.locator("#project-directory")).toHaveText("/fake/project-c");
  await page.getByRole("button", { name: "Project directory" }).click();
  const items = page.getByRole("menu", { name: "Project directories" }).getByRole("menuitem");
  await expect(items.nth(0)).toHaveText("/fake/project-c");
  await expect(items.nth(1)).toHaveText("/fake/project-b");
  await expect(items.nth(2)).toHaveText("/fake/project");

  const beforeReload = await (await page.request.get("/api/health")).json();
  expect(beforeReload.projectDirectory).toBe("/fake/project");
  expect(beforeReload.sessions.find((session: { id: string }) => session.id === beforeReload.selectedSessionId).cwd)
    .toBe("/fake/project-c");
  expect(beforeReload.sessions.filter((session: { active: boolean }) => session.active)).toHaveLength(1);
  expect(projectOpenCalls).toBe(0);

  await page.reload();
  await expect(page.locator("#project-directory")).toHaveText("/fake/project-c");
  await expect(page.locator(".session-group[data-cwd='/fake/project-c'] .session-row[aria-current='true']"))
    .toContainText("Current session");
  await page.getByRole("button", { name: "Project directory" }).click();
  const reloadedItems = page.getByRole("menu", { name: "Project directories" }).getByRole("menuitem");
  await expect(reloadedItems.nth(0)).toHaveText("/fake/project-c");
  await expect(reloadedItems.nth(1)).toHaveText("/fake/project-b");
  await expect(reloadedItems.nth(2)).toHaveText("/fake/project");
  const afterReload = await (await page.request.get("/api/health")).json();
  expect(afterReload.sessions.filter((session: { active: boolean }) => session.active)).toHaveLength(1);
  expect(afterReload.selectedSessionId).toBe(beforeReload.selectedSessionId);
  expect(projectOpenCalls).toBe(0);
});

test("favicon follows the selected session with distinct idle, running, and error shapes", async ({ page }) => {
  await page.goto("/");
  const favicon = page.locator("#status-favicon");
  const svg = async () => favicon.evaluate((element) => decodeURIComponent((element as HTMLLinkElement).href.split(",")[1] ?? ""));
  await expect(favicon).toHaveAttribute("data-state", "idle");
  await expect.poll(svg).toContain("M5 12.5");

  const input = page.getByLabel("Message Pi");
  await input.fill("long run");
  await input.press("Enter");
  await expect(favicon).toHaveAttribute("data-state", "running");
  await expect.poll(svg).toContain('r="5"');

  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await expect(favicon).toHaveAttribute("data-state", "idle");
  await expect.poll(svg).toContain("M5 12.5");
  await expect.poll(svg).not.toContain('r="5"');
  await expect(page.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-active-dot")).toBeVisible();

  await input.fill("background crash");
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Fake Pi process crashed.");
  await expect(favicon).toHaveAttribute("data-state", "error");
  await expect.poll(svg).toContain("M6 6l12 12M18 6L6 18");
});

test("Refresh discovers a session created outside Pi-vot", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".session-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(page.locator(".session-row")).toHaveCount(4);
  await expect(page.locator(".session-row").filter({ hasText: "Created in terminal Pi" })).toHaveCount(1);
});

test("New Session clears the transcript and selects a new persisted session", async ({ page }) => {
  await page.goto("/");
  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await page.getByRole("button", { name: "+ New Session" }).click();
  await expect(page.locator(".message")).toHaveCount(0);
  await expect(page.locator(".session-row")).toHaveCount(4);
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("New session");
  await expect(page.locator("#model-info")).toContainText("fake-provider / fake-model");
  await expect(page.locator("#context-value")).toHaveText("Context unavailable · 200,000 window");
});

test("Sending to Pi is shown only on the latest user message", async ({ page }) => {
  await page.addInitScript(() => {
    let source: { onopen?: () => void; onmessage?: (event: { data: string }) => void } | undefined;
    class MockEventSource {
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      constructor() {
        source = this;
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
      send(event: unknown) {
        this.onmessage?.({ data: JSON.stringify(event) });
      }
    }
    Object.defineProperty(window, "EventSource", { value: MockEventSource, configurable: true });
    Object.defineProperty(window, "__pushPiEvent", {
      value: (event: unknown) => (source as MockEventSource | undefined)?.send(event),
      configurable: true,
    });
  });
  await page.goto("/");
  await page.evaluate(() => {
    const article = document.createElement("article");
    article.className = "message user";
    article.dataset.messageId = "stale-sending-message";
    const delivery = document.createElement("p");
    delivery.className = "message-delivery";
    delivery.dataset.state = "sending";
    delivery.textContent = "Sending to Pi…";
    article.append(delivery);
    document.querySelector("#conversation")!.append(article);
  });

  const input = page.getByLabel("Message Pi");
  await input.fill("newer message");
  await input.press("Enter");
  const staleDelivery = page.locator('[data-message-id="stale-sending-message"] .message-delivery');
  await expect(staleDelivery).toBeHidden();

  const currentDelivery = page.locator(".message.user").last().locator(".message-delivery");
  await page.evaluate(() => {
    const latestUser = document.querySelector("#conversation .message.user:last-of-type");
    if (!latestUser) throw new Error("Expected a current user message.");
    const delivery = document.createElement("p");
    delivery.className = "message-delivery";
    delivery.dataset.state = "sending";
    delivery.textContent = "Sending to Pi…";
    latestUser.append(delivery);
    (window as Window & { __pushPiEvent?: (event: unknown) => void }).__pushPiEvent?.({
      type: "assistant_start",
      messageId: "new-assistant-message",
      createdAt: new Date().toISOString(),
    });
  });
  await expect(currentDelivery).toBeHidden();
});

test("New Session opens another session in the same project while the selected session is running", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long run");
  await input.press("Enter");
  await expect(page.getByRole("status")).toContainText("Running read ·");

  const runningSession = page.locator(".session-row[aria-current='true']");
  const runningTitle = await runningSession.locator(".session-title").innerText();
  await page.getByRole("button", { name: "+ New Session" }).click();

  await expect(page.locator(".session-row")).toHaveCount(4);
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("New session");
  const previousSession = page.locator(".session-row").filter({ has: page.locator(".session-title", { hasText: runningTitle }) });
  await expect(previousSession).toBeVisible();
  await expect(previousSession).toHaveAttribute("data-runtime-state", "running");
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(2);

  await previousSession.locator(".session-switch").click();
  await expect(page.getByRole("status")).toContainText("Running read ·");
});

test("New Session opens in a project with a background session running", async ({ page }) => {
  await page.goto("/");
  const idleSession = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  const busySession = page.locator(".session-row").filter({ hasText: "Find a parser regression" });
  await busySession.locator(".session-switch").click();
  await expect(busySession).toHaveAttribute("aria-current", "true");
  const input = page.getByLabel("Message Pi");
  await input.fill("long background run");
  await input.press("Enter");
  await expect(page.getByRole("status")).toContainText("Running read ·");
  await expect(busySession).toHaveAttribute("data-runtime-state", "running");

  await idleSession.locator(".session-switch").click();
  await expect(idleSession).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "+ New Session" }).click();

  await expect(page.locator(".session-row")).toHaveCount(4);
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("New session");
  await expect(busySession).toHaveAttribute("data-runtime-state", "running");
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(3);
});

test("session rename persists its displayed name and delete confirms one selected Pi session", async ({ page }) => {
  await page.goto("/");
  const unnamed = page.locator(".session-row").filter({ hasText: "Find a parser regression" });
  page.once("dialog", (dialog) => {
    expect(dialog.type()).toBe("prompt");
    void dialog.accept("Parser follow-up");
  });
  await unnamed.locator(".session-actions summary").click();
  await unnamed.getByRole("button", { name: "Rename Find a parser regression" }).click();
  await expect(page.locator(".session-row").filter({ hasText: "Parser follow-up" })).toHaveCount(1);

  let confirmation = "";
  page.once("dialog", (dialog) => {
    confirmation = dialog.message();
    void dialog.accept();
  });
  const renamed = page.locator(".session-row").filter({ hasText: "Parser follow-up" });
  await renamed.locator(".session-actions summary").click();
  await renamed.getByRole("button", { name: "Delete Parser follow-up" }).click();
  expect(confirmation).toContain("This removes the persisted Pi session.");
  await expect(page.locator(".session-row")).toHaveCount(2);
  await expect(page.locator(".session-row").filter({ hasText: "HDF5 debugging" })).toHaveCount(1);
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("Current session");
});

test("a background session remains active and selectable while another session is compacting", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long run");
  await page.getByRole("button", { name: "Send" }).click();
  const historicalSwitch = page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch");
  await expect(historicalSwitch).toBeEnabled();
  const activity = page.getByRole("status");
  await expect(activity).toContainText("Running read ·");
  await expect(activity).toContainText("elapsed");
  await expect(activity).toHaveAttribute("data-state", "running");
  await expect(activity).toHaveCSS("position", "absolute");
  await historicalSwitch.click();
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("HDF5 debugging");
  await expect(page.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-active-dot")).toBeVisible();
  await expect(page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-active-dot")).toBeHidden();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();

  await historicalSwitch.click();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await page.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-switch").click();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(historicalSwitch).toBeEnabled();

  await page.locator("#compact").click();
  await expect(page.locator("#compact")).toBeDisabled();
  await expect(page).toHaveTitle("pi - Compacting");
  await expect(historicalSwitch).toBeEnabled();
  await historicalSwitch.click();
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("HDF5 debugging");
  await expect(page).toHaveTitle("pi - Ready");
  await expect(page.getByRole("button", { name: "Compact" })).toBeDisabled();
  await expect(page.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-active-dot")).toBeVisible();
  await page.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-switch").click();
  await expect(page).toHaveTitle("pi - Compacting");
  await expect(page).toHaveTitle("pi - Ready", { timeout: 3_000 });
});

test("two sessions stream independently and Stop on B leaves background A running", async ({ page }) => {
  await page.goto("/");
  const sessionA = page.locator(".session-row").filter({ hasText: "Current session" });
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  const input = page.getByLabel("Message Pi");

  await input.fill("background stream");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await sessionB.locator(".session-switch").click();
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("HDF5 debugging");
  await expect(page.locator("#context-value")).toContainText("Context unavailable");
  await input.fill("long run");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(sessionA).toHaveAttribute("data-runtime-state", "idle", { timeout: 5_000 });
  await expect(page.locator("#context-value")).toHaveText("80,000 / 200,000");

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await sessionA.locator(".session-actions summary").click();
  await expect(sessionA.getByRole("button", { name: "Close runtime for Current session" })).toBeVisible();
  await expect(sessionA.locator(".session-active-dot")).toBeVisible();
  await expect(sessionB.locator(".session-active-dot")).toBeVisible();
  await expect(sessionA).toHaveAttribute("data-runtime-state", "idle", { timeout: 5_000 });
  await sessionA.locator(".session-actions summary").click();
  await expect(sessionA.getByRole("button", { name: "Stop Current session" })).toBeHidden();

  await expect(page.locator(".assistant-text").filter({ hasText: "Background response from A." })).toHaveCount(0);
  await sessionA.locator(".session-switch").click();
  await expect(page.locator(".assistant-text").filter({ hasText: "Background response from A." })).toHaveCount(1);
  await expect(page.locator("details.thinking").last()).toContainText("Thinking for session A.");
  await expect(page.locator("details.tool").last()).toContainText("Session A tool result");
  await expect(page.locator("#context-value")).toHaveText("81,000 / 200,000");
});

test("deleting an active session closes its runtime and removes only that session row", async ({ page }) => {
  await page.goto("/");
  const row = page.locator(".session-row").filter({ hasText: "Current session" });
  await row.locator(".session-actions summary").click();
  page.once("dialog", (dialog) => void dialog.accept());
  await row.getByRole("button", { name: "Delete Current session" }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator(".session-row")).toHaveCount(2);
  await expect(page.locator(".session-row").filter({ hasText: "HDF5 debugging" })).toHaveCount(1);
});

test("project browsing preserves active session access and the fixed conversation layout", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-vot-recent-projects", JSON.stringify(["/fake/other-project"])));
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/");
  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await page.getByRole("button", { name: "Project directory" }).click();
  await page.getByRole("menuitem", { name: "/fake/other-project", exact: true }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/other-project");
  await expect(page.locator("#session-list .session-row")).toHaveCount(4);
  const backgroundSession = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await expect(backgroundSession.locator(".session-active-dot")).toBeHidden();
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(backgroundSession.locator(".session-active-dot")).toBeHidden();
  await expect(page.locator(".message.user")).toHaveCount(0);

  const layout = await page.evaluate(() => {
    const sidebar = document.querySelector("#session-sidebar")!.getBoundingClientRect();
    const workspace = document.querySelector("#workspace")!.getBoundingClientRect();
    const conversation = document.querySelector("#conversation")!;
    const composer = document.querySelector("#message-form")!.getBoundingClientRect();
    return {
      sidebarRatio: sidebar.width / workspace.width,
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      paneHeight: conversation.clientHeight,
      paneScrollHeight: conversation.scrollHeight,
      composerBottom: composer.bottom,
    };
  });
  expect(layout.sidebarRatio).toBeLessThan(0.3);
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.paneHeight).toBeGreaterThan(100);
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewportHeight);

  const input = page.getByLabel("Message Pi");
  await input.fill("after session and project switch");
  await input.press("Enter");
  await expect(page.locator(".assistant-text").last()).toHaveText("Canonical final answer.");
  await expect(page.locator("#model-info")).toContainText("fake-provider / fake-model");
  await backgroundSession.locator(".session-switch").click();
  await expect(backgroundSession).toHaveAttribute("aria-current", "true");
  await backgroundSession.locator(".session-actions summary").click();
  await expect(backgroundSession.getByRole("button", { name: "Wake session HDF5 debugging" })).toBeVisible();
});

test("drag, clipboard, and picker inputs preserve ordering and reject unsupported or oversized images", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const form = page.locator("#message-form");
  const pngBase64 = TEST_PNG.toString("base64");
  const drop = await form.evaluate((element, data) => {
    const file = new File([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], "dropped.png", {
      type: "image/png",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const enter = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(enter);
    const highlightVisible = !(document.querySelector("#drop-overlay") as HTMLElement).hidden;
    const dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(dropEvent);
    return { highlightVisible, prevented: dropEvent.defaultPrevented, url: location.href };
  }, pngBase64);
  expect(drop.highlightVisible).toBe(true);
  expect(drop.prevented).toBe(true);
  expect(drop.url).toBe(page.url());
  await expect(page.locator("#drop-overlay")).toBeHidden();
  await expect(page.locator(".image-attachment-name")).toHaveText("dropped.png");

  const paste = await page.getByLabel("Message Pi").evaluate((element, data) => {
    const file = new File([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], "pasted.png", {
      type: "image/png",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, pngBase64);
  expect(paste).toBe(true);
  await expect(page.locator(".image-attachment-name")).toHaveText(["dropped.png", "pasted.png"]);

  await page.evaluate(async () => navigator.clipboard.writeText("ordinary clipboard text"));
  await page.getByLabel("Message Pi").focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await expect(page.getByLabel("Message Pi")).toHaveValue("ordinary clipboard text");

  const longName = `${"long-filename-".repeat(12)}.png`;
  await page.locator("#image-picker").setInputFiles([
    imageFile(longName),
    imageFile("second.png"),
  ]);
  await expect(page.locator(".image-attachment")).toHaveCount(4);
  await expect(page.getByRole("button", { name: `Remove image ${longName}` })).toBeVisible();
  await expect(page.locator(".image-attachment-name").last()).toHaveAttribute("title", "second.png");
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
  await page.getByRole("button", { name: `Remove image ${longName}` }).click();
  await expect(page.locator(".image-attachment")).toHaveCount(3);

  await page.locator("#image-picker").setInputFiles({
    name: "document.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF"),
  });
  await expect(page.locator("#status")).toHaveText("Unsupported image type.");
  await expect(page.locator(".image-attachment")).toHaveCount(3);

  await page.locator("#image-picker").evaluate((element) => {
    const bytes = new Uint8Array(10 * 1024 * 1024 + 1);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = new File([bytes], "large.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    (element as HTMLInputElement).files = transfer.files;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#status")).toHaveText("Image is too large.");
  await expect(page.locator(".image-attachment")).toHaveCount(3);
});

test("attachment thumbnails report loading, success, failure, and removal independently", async ({ page }) => {
  await page.addInitScript(() => {
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const previewUrls = { created: [] as string[], revoked: [] as string[] };
    (window as Window & { __attachmentPreviewUrls?: typeof previewUrls }).__attachmentPreviewUrls = previewUrls;
    URL.createObjectURL = (object) => {
      const url = originalCreateObjectURL(object);
      previewUrls.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      previewUrls.revoked.push(url);
      originalRevokeObjectURL(url);
    };
    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      enumerable: src.enumerable,
      get() {
        return src.get!.call(this);
      },
      set(value: string) {
        if ((this as HTMLImageElement).classList.contains("image-thumbnail-image")) {
          (this as HTMLImageElement).dataset.thumbnailTestSrc = value;
          return;
        }
        src.set!.call(this, value);
      },
    });
  });
  await page.goto("/");
  await page.locator("#image-picker").setInputFiles([
    imageFile("loaded.png"),
    imageFile("failed.png"),
  ]);

  const cards = page.locator(".image-attachment");
  const loaded = cards.filter({ hasText: "loaded.png" });
  const failed = cards.filter({ hasText: "failed.png" });
  await expect(cards).toHaveCount(2);
  await expect(loaded.locator(".image-thumbnail-spinner")).toBeVisible();
  await expect(failed.locator(".image-thumbnail-spinner")).toBeVisible();
  await expect(loaded.locator("img")).toHaveCSS("opacity", "0.58");
  await expect(loaded.getByRole("button", { name: "Remove image loaded.png" })).toBeEnabled();

  await loaded.locator("img").evaluate((image) => image.dispatchEvent(new Event("load")));
  await expect(loaded.locator(".image-thumbnail-spinner")).toBeHidden();
  await expect(loaded.locator(".image-thumbnail")).toHaveAttribute("data-thumbnail-state", "loaded");
  await expect(loaded.locator("img")).toHaveCSS("opacity", "1");
  await expect(failed.locator(".image-thumbnail-spinner")).toBeVisible();

  await failed.locator("img").evaluate((image) => image.dispatchEvent(new Event("error")));
  await expect(failed.locator(".image-thumbnail-spinner")).toBeHidden();
  await expect(failed.locator(".image-thumbnail")).toHaveAttribute("data-thumbnail-state", "failed");
  await expect(failed.locator(".image-thumbnail")).toHaveCSS("background-color", "rgb(37, 46, 59)");
  await expect(failed.locator(".image-attachment-name")).toHaveText("failed.png");
  await expect(failed.getByRole("button", { name: "Remove image failed.png" })).toBeEnabled();

  await page.locator("#image-picker").setInputFiles(imageFile("remove-loading.png"));
  const removing = cards.filter({ hasText: "remove-loading.png" });
  const removedImage = await removing.locator("img").elementHandle();
  expect(removedImage).not.toBeNull();
  await expect(removing.locator(".image-thumbnail-spinner")).toBeVisible();
  const previewUrl = await removedImage!.getAttribute("data-thumbnail-test-src");
  expect(previewUrl).toMatch(/^blob:/);
  await removing.getByRole("button", { name: "Remove image remove-loading.png" }).click();
  await expect(cards).toHaveCount(2);
  expect(await page.evaluate((url) => {
    const state = (window as Window & {
      __attachmentPreviewUrls?: { created: string[]; revoked: string[] };
    }).__attachmentPreviewUrls;
    return state?.revoked.filter((revokedUrl) => revokedUrl === url).length;
  }, previewUrl)).toBe(1);
  await removedImage!.evaluate((image) => image.dispatchEvent(new Event("load")));
  await expect(removing).toHaveCount(0);
  expect(await removedImage!.evaluate((image) => image.parentElement?.getAttribute("data-thumbnail-state"))).toBe("loading");
  await expect(page.locator(".image-thumbnail[data-thumbnail-state='loaded']")).toHaveCount(1);
});

test("image capability follows Pi model metadata and accepted sends include ordered native image payloads", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/message", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue();
  });
  await page.goto("/");
  await page.locator("#image-picker").setInputFiles([
    imageFile("first.png"),
    imageFile("second.png"),
  ]);
  await expect(page.locator(".image-attachment")).toHaveCount(2);
  const input = page.getByLabel("Message Pi");
  await input.fill("describe both");

  const trigger = page.getByRole("button", { name: /Current model:/ });
  await trigger.click();
  await page.locator('#model-options [data-model-id="available-1"]').click();
  await expect(page.locator("#attachment-warning")).toHaveText("The selected model does not support image input.");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.locator(".image-attachment")).toHaveCount(2);

  await trigger.click();
  await page.locator('#model-options [data-model-id="available-0"]').click();
  await expect(page.locator("#attachment-warning")).toBeHidden();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await input.press("Enter");
  await expect.poll(() => submitted).toBeDefined();
  expect(submitted?.message).toBe("describe both");
  const sentImages = submitted?.images as Array<{ mimeType: string; data: string; name: string }>;
  expect(sentImages.map(({ name }) => name)).toEqual(["first.png", "second.png"]);
  expect(sentImages.every(({ mimeType, data }) => mimeType === "image/png" && data === TEST_PNG.toString("base64"))).toBe(true);
  await expect(page.locator(".image-attachment")).toHaveCount(0);
  await expect(page.locator(".message.user").last().locator(".image-message-attachments img")).toHaveCount(2);
});

test("inactive-session image drafts stay isolated and activate only when sent", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/message", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue();
  });
  await page.goto("/");
  const current = page.locator(".session-row").filter({ hasText: "Current session" });
  const history = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await history.locator(".session-switch").click();
  await expect(history).toHaveAttribute("aria-current", "true");
  await expect(history.locator(".session-active-dot")).toBeHidden();
  await page.locator("#image-picker").setInputFiles(imageFile("history.png"));
  await expect(history.locator(".session-active-dot")).toBeHidden();
  await expect(page.locator(".session-row .session-active-dot:visible")).toHaveCount(1);

  await current.locator(".session-switch").click();
  await expect(current).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".image-attachment")).toHaveCount(0);
  await history.locator(".session-switch").click();
  await expect(history).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".image-attachment-name")).toHaveText("history.png");
  await page.getByLabel("Message Pi").fill("inspect this screenshot");
  await page.getByLabel("Message Pi").press("Enter");
  await expect.poll(() => submitted).toBeDefined();
  expect(submitted?.sessionId).toBe("/fake/project/history-hydration.jsonl");
  expect((submitted?.images as unknown[]).length).toBe(1);
  await expect(history.locator(".session-active-dot")).toBeVisible();
  await expect(page.locator(".image-attachment")).toHaveCount(0);
});

test("failed image sends preserve drafts, and image submissions remain disabled during compaction", async ({ page }) => {
  const submissions: Array<Record<string, unknown>> = [];
  await page.route("**/api/message", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    submissions.push(payload);
    if (payload.message === "reject image") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fake Pi rejected the prompt." }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await page.locator("#image-picker").setInputFiles(imageFile("retry.png"));
  await input.fill("reject image");
  await input.press("Enter");
  await expect(page.locator("#status")).toHaveText("Fake Pi rejected the prompt.");
  await expect(input).toHaveValue("reject image");
  await expect(page.locator(".image-attachment-name")).toHaveText("retry.png");

  await input.fill("arm slow compaction");
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Pi handled that input without starting a normal agent response.");
  await expect(input).toHaveValue("");
  const previousUserMessages = await page.locator(".message.user").count();
  await page.locator("#compact").click();
  await expect(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  const compactionActivity = page.getByRole("status");
  await expect(compactionActivity).toHaveText("Compacting · 00:00 elapsed");
  await expect.poll(() => compactionActivity.evaluate((element) => getComputedStyle(element, "::before").animationName)).toBe("status-spin");
  await expect.poll(() => compactionActivity.textContent()).toContain("00:01 elapsed");
  await page.locator("#image-picker").setInputFiles(imageFile("queued.png"));
  await input.fill("queued image");
  await input.press("Enter");
  await expect(page.locator("#send")).toBeDisabled();
  await expect(page.locator(".message.user")).toHaveCount(previousUserMessages);
  await expect(input).toHaveValue("queued image");
  await expect(page.locator(".image-attachment-name")).toHaveText("queued.png");
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled({ timeout: 4_000 });
  await expect(compactionActivity).toBeHidden();
  await page.getByRole("button", { name: "Send" }).click();
  const acceptedMessage = page.locator(".message.user").last();
  await expect(acceptedMessage.locator(".image-message-attachments img")).toHaveCount(1);
  expect((submissions.at(-1)?.images as unknown[]).length).toBe(1);
  await expect(page.locator(".image-attachment")).toHaveCount(0);
});

test("compaction elapsed time survives switching away and back", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("arm navigation compaction");
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Pi handled that input without starting a normal agent response.");
  await page.locator("#compact").click();
  const activity = page.getByRole("status");
  await expect(activity).toHaveText("Compacting · 00:00 elapsed");
  await expect.poll(() => activity.textContent()).toContain("00:01 elapsed");
  const elapsedSeconds = await activity.evaluate((element) => {
    const match = element.textContent?.match(/(\d+):(\d+) elapsed/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
  });

  const compactingSession = page.locator(".session-row").filter({ hasText: "Current session" });
  const previousSession = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await previousSession.locator(".session-switch").click();
  await expect(previousSession).toHaveAttribute("aria-current", "true");
  await compactingSession.locator(".session-switch").click();
  await expect(compactingSession).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("Current session");
  await expect(activity).toContainText("Compacting ·");
  const resumedElapsedSeconds = await activity.evaluate((element) => {
    const match = element.textContent?.match(/(\d+):(\d+) elapsed/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
  });
  expect(resumedElapsedSeconds).toBeGreaterThanOrEqual(elapsedSeconds);
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled({ timeout: 7_000 });
});

test("running tool elapsed time survives switching away and back", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long run");
  await input.press("Enter");
  const activity = page.getByRole("status");
  await expect(activity).toContainText("Running read · 00:00 elapsed");
  await expect.poll(() => activity.textContent()).toContain("00:01 elapsed");
  const elapsedSeconds = await activity.evaluate((element) => {
    const match = element.textContent?.match(/(\d+):(\d+) elapsed/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
  });

  const runningSession = page.locator(".session-row").filter({ hasText: "Current session" });
  const previousSession = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await previousSession.locator(".session-switch").click();
  await expect(previousSession).toHaveAttribute("aria-current", "true");
  await runningSession.locator(".session-switch").click();
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("Current session");
  await expect(activity).toContainText("Running read ·");
  const resumedElapsedSeconds = await activity.evaluate((element) => {
    const match = element.textContent?.match(/(\d+):(\d+) elapsed/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
  });
  expect(resumedElapsedSeconds).toBeGreaterThanOrEqual(elapsedSeconds);
  await page.getByRole("button", { name: "Stop" }).click();
});

test("a failed image send after compaction keeps its local thumbnail, attachment, and draft", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("arm slow compaction");
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Pi handled that input without starting a normal agent response.");
  await expect(input).toHaveValue("");
  const previousUserMessages = await page.locator(".message.user").count();
  await page.locator("#compact").click();
  await expect(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  await page.locator("#image-picker").setInputFiles(imageFile("queued-retry.png"));
  await input.fill("fail queued image");
  await input.press("Enter");

  await expect(page.locator("#send")).toBeDisabled();
  await expect(page.locator(".message.user")).toHaveCount(previousUserMessages);
  await expect(page.locator(".image-attachment-name")).toHaveText("queued-retry.png");
  await expect(input).toHaveValue("fail queued image");
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled({ timeout: 4_000 });
  await page.getByRole("button", { name: "Send" }).click();
  const failedMessage = page.locator(".message.user").last();
  await expect(failedMessage.locator(".message-delivery")).toHaveText(
    "Not sent: Fake Pi rejected the queued image.",
  );
  await expect(input).toHaveValue("fail queued image");
  await expect(page.locator(".image-attachment-name")).toHaveText("queued-retry.png");
  await expect(failedMessage.locator(".image-message-attachments img")).toHaveCount(1);
});

test("attachment previews and compact controls fit at minimum and maximum composer heights", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 640 });
  await page.goto("/");
  await page.getByLabel("Message Pi").fill("long run");
  await page.getByLabel("Message Pi").press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.locator("#image-picker").setInputFiles(
    Array.from({ length: 12 }, (_, index) => imageFile(`image-${index}.png`)),
  );
  const splitter = page.getByRole("separator", { name: "Resize message composer" });
  await splitter.focus();
  await page.keyboard.press("Home");
  const minimum = await page.evaluate(() => ({
    viewport: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
    form: document.querySelector("#message-form")!.getBoundingClientRect(),
    send: document.querySelector("#send")!.getBoundingClientRect(),
    stop: document.querySelector("#stop")!.getBoundingClientRect(),
    strip: {
      scrollWidth: document.querySelector("#attachment-strip")!.scrollWidth,
      clientWidth: document.querySelector("#attachment-strip")!.clientWidth,
    },
  }));
  expect(minimum.documentHeight).toBeLessThanOrEqual(minimum.viewport + 1);
  expect(minimum.send.bottom).toBeLessThanOrEqual(minimum.viewport + 1);
  expect(minimum.stop.bottom).toBeLessThanOrEqual(minimum.viewport + 1);
  expect(minimum.form.height).toBeGreaterThanOrEqual(96);
  expect(minimum.strip.scrollWidth).toBeGreaterThan(minimum.strip.clientWidth);

  await page.keyboard.press("End");
  const maximum = await page.evaluate(() => ({
    viewport: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
    form: document.querySelector("#message-form")!.getBoundingClientRect(),
    send: document.querySelector("#send")!.getBoundingClientRect(),
    stop: document.querySelector("#stop")!.getBoundingClientRect(),
    strip: document.querySelector("#attachment-strip")!.getBoundingClientRect(),
  }));
  expect(maximum.documentHeight).toBeLessThanOrEqual(maximum.viewport + 1);
  expect(maximum.send.height).toBeLessThan(50);
  expect(maximum.stop.height).toBeLessThan(50);
  expect(Math.abs(maximum.send.bottom - maximum.stop.top + 6)).toBeLessThan(2);
  expect(Math.abs(maximum.stop.bottom - maximum.form.bottom)).toBeLessThan(2);
  expect(maximum.strip.right).toBeLessThanOrEqual(maximum.form.right + 1);
});
