import { spawn } from "node:child_process";

export function browserOpenCommand(platform, url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Pi-vot can only open an HTTP or HTTPS URL.");
  }

  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "linux") return { command: "xdg-open", args: [url] };
  return null;
}

export function openDefaultBrowser(url, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  const onError = options.onError ?? ((error) => console.error(`Could not open Pi-vot in the default browser: ${error.message}`));
  const command = browserOpenCommand(platform, url);
  if (!command) {
    onError(new Error(`Automatic browser opening is not supported on ${platform}.`));
    return false;
  }

  try {
    const child = spawnProcess(command.command, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", onError);
    child.unref();
    return true;
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}
