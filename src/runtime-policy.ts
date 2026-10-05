export const MINIMUM_NODE_VERSION = "22.19.0";
export const MAXIMUM_NODE_VERSION_EXCLUSIVE = "23.0.0";
export const SUPPORTED_NODE_VERSION_RANGE = `>=${MINIMUM_NODE_VERSION} <${MAXIMUM_NODE_VERSION_EXCLUSIVE}`;
const [minimumMajor, minimumMinor, minimumPatch] = MINIMUM_NODE_VERSION.split(".").map(Number);
const maximumMajor = Number(MAXIMUM_NODE_VERSION_EXCLUSIVE.split(".", 1)[0]);

export type NodeVersionDecision =
  | { status: "supported" }
  | { status: "blocked"; error: string }
  | { status: "allowed"; warning: string };

export function nodeVersionError(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return `Could not determine the Node.js version. Detected: ${version || "unknown"}`;
  const [, majorText, minorText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(match[3]);
  if (major !== minimumMajor || major >= maximumMajor) {
    return `Pi-vot currently supports Node ${minimumMajor}.x only.\nDetected: ${version}`;
  }
  if (major < minimumMajor || minor < minimumMinor || (minor === minimumMinor && patch < minimumPatch)) {
    return `Pi-vot requires Node ${minimumMajor}.${minimumMinor} or newer within the Node ${minimumMajor} release line.\nDetected: ${version}`;
  }
  return null;
}

export function nodeVersionDecision(version: string, allowUnsupportedValue?: string): NodeVersionDecision {
  const error = nodeVersionError(version);
  if (!error) return { status: "supported" };
  if (allowUnsupportedValue === "1") {
    return {
      status: "allowed",
      warning: `WARNING: Running Pi-vot with unsupported Node version ${version || "unknown"}.\n` +
        `Supported range: ${SUPPORTED_NODE_VERSION_RANGE}\n` +
        "PI_VOT_ALLOW_UNSUPPORTED_NODE=1 is set; continuing anyway.",
    };
  }
  return { status: "blocked", error };
}
