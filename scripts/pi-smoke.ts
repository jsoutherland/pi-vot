import { PiService } from "../src/pi-service.ts";

const pi = new PiService(process.cwd());
let reply: string | undefined;
let agentStarted = false;
let resolveSettled: (() => void) | undefined;
let rejectSettled: ((error: Error) => void) | undefined;
const settled = new Promise<void>((resolve, reject) => {
  resolveSettled = resolve;
  rejectSettled = reject;
});
void settled.catch(() => {});
const unsubscribe = pi.subscribe((event) => {
  if (event.type === "assistant_end") reply = event.text;
  if (event.type === "state" && event.state === "running") agentStarted = true;
  if (event.type === "state" && event.state === "idle" && agentStarted) resolveSettled?.();
  if (event.type === "state" && event.state === "failed") {
    rejectSettled?.(new Error(event.error ?? "Pi disconnected during the smoke test."));
  }
});

try {
  const disposition = await pi.sendMessage("Reply with exactly: PI_VOT_SMOKE_OK");
  if (disposition === "handled") throw new Error("Pi handled the smoke prompt without starting an agent response.");
  await settled;
  if (reply?.trim() !== "PI_VOT_SMOKE_OK") {
    throw new Error(`Unexpected Pi response: ${reply ?? "(no assistant response)"}`);
  }
  console.log("Pi RPC smoke test passed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Pi RPC smoke test failed.");
  process.exitCode = 1;
} finally {
  unsubscribe();
  await pi.stop();
}
