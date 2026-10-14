export const MINIMUM_NODE_VERSION = "22.19.0";
export const TESTED_NODE_MAJOR = 22;
export const SUPPORTED_NODE_VERSION_RANGE = `>=${MINIMUM_NODE_VERSION}`;

export type NodeVersionDecision =
  | { status: "supported" }
  | { status: "blocked"; error: string }
  | { status: "allowed"; warning: string }
  | { status: "newer"; warning: string };

function parseNodeVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parsed.every(Number.isSafeInteger)) return null;
  return parsed as [number, number, number];
}

function isBelowMinimum(version: [number, number, number]): boolean {
  const minimum = MINIMUM_NODE_VERSION.split(".").map(Number) as [number, number, number];
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index]! !== minimum[index]!) return version[index]! < minimum[index]!;
  }
  return false;
}

export function nodeVersionError(version: string): string | null {
  const parsedVersion = parseNodeVersion(version);
  if (!parsedVersion) return `Could not determine the Node.js version. Detected: ${version || "unknown"}`;
  if (isBelowMinimum(parsedVersion)) {
    return `Pi-vot requires Node.js ${SUPPORTED_NODE_VERSION_RANGE}.\nDetected: ${version}`;
  }
  return null;
}

export function nodeVersionDecision(version: string, allowUnsupportedValue?: string): NodeVersionDecision {
  const parsedVersion = parseNodeVersion(version);
  if (!parsedVersion) {
    return {
      status: "blocked",
      error: `Could not determine the Node.js version. Detected: ${version || "unknown"}`,
    };
  }
  if (isBelowMinimum(parsedVersion)) {
    const error = nodeVersionError(version)!;
    if (allowUnsupportedValue === "1") {
      return {
        status: "allowed",
        warning: `WARNING: Pi-vot is running on Node ${version} below the minimum ${MINIMUM_NODE_VERSION}.\n` +
          "PI_VOT_ALLOW_UNSUPPORTED_NODE=1 is set; continuing anyway.",
      };
    }
    return { status: "blocked", error };
  }
  if (parsedVersion[0] > TESTED_NODE_MAJOR) {
    return {
      status: "newer",
      warning: `WARNING: Pi-vot is running on Node ${version}.\n` +
        `The recommended/tested runtime is Node ${MINIMUM_NODE_VERSION} or newer within Node ${TESTED_NODE_MAJOR}.\n` +
        "Continuing because newer Node versions are permitted.",
    };
  }
  return { status: "supported" };
}
