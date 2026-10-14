import assert from "node:assert/strict";
import test from "node:test";
import { browserOpenCommand, openDefaultBrowser } from "../browser-launch.js";

test("default browser launch command is selected for supported operating systems", () => {
  const url = "http://127.0.0.1:17361";
  assert.deepEqual(browserOpenCommand("win32", url), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });
  assert.deepEqual(browserOpenCommand("darwin", url), { command: "open", args: [url] });
  assert.deepEqual(browserOpenCommand("linux", url), { command: "xdg-open", args: [url] });
  assert.equal(browserOpenCommand("freebsd", url), null);
});

test("browser launcher starts detached and rejects non-web protocols", () => {
  let launch;
  const child = { once() {}, unref() {} };
  const started = openDefaultBrowser("http://127.0.0.1:17361", {
    platform: "linux",
    spawnProcess: (...args) => { launch = args; return child; },
  });
  assert.equal(started, true);
  assert.equal(launch[0], "xdg-open");
  assert.deepEqual(launch[1], ["http://127.0.0.1:17361"]);
  assert.deepEqual(launch[2], { detached: true, stdio: "ignore", windowsHide: true });
  assert.throws(() => browserOpenCommand("linux", "file:///etc/passwd"), /HTTP or HTTPS/);
});
