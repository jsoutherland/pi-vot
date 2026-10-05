import assert from "node:assert/strict";
import test from "node:test";
import {
  nodeVersionDecision,
  nodeVersionError,
  SUPPORTED_NODE_VERSION_RANGE,
} from "../src/runtime-policy.ts";

const unsupportedVersion = "24.21.0";

test("supported Node versions are accepted without an override", () => {
  assert.deepEqual(nodeVersionDecision("22.19.0"), { status: "supported" });
});

test("unsupported Node versions are blocked without an override", () => {
  const decision = nodeVersionDecision(unsupportedVersion);
  assert.equal(decision.status, "blocked");
  if (decision.status === "blocked") {
    assert.equal(decision.error, "Pi-vot currently supports Node 22.x only.\nDetected: 24.21.0");
  }
});

test("the exact override value allows an unsupported Node version with a warning", () => {
  const decision = nodeVersionDecision(unsupportedVersion, "1");
  assert.equal(decision.status, "allowed");
  if (decision.status === "allowed") {
    assert.equal(
      decision.warning,
      `WARNING: Running Pi-vot with unsupported Node version ${unsupportedVersion}.\n` +
        `Supported range: ${SUPPORTED_NODE_VERSION_RANGE}\n` +
        "PI_VOT_ALLOW_UNSUPPORTED_NODE=1 is set; continuing anyway.",
    );
  }
});

test("only the exact override value bypasses unsupported Node rejection", () => {
  for (const value of ["0", "true", "TRUE", "yes", ""]) {
    assert.equal(nodeVersionDecision(unsupportedVersion, value).status, "blocked", `override value: ${value}`);
  }
  assert.equal(nodeVersionDecision(unsupportedVersion).status, "blocked", "override unset");
});

test("supported Node versions do not produce an unsupported-runtime warning", () => {
  assert.deepEqual(nodeVersionDecision("22.19.0", "1"), { status: "supported" });
});

test("Node 22.19 and newer within Node 22 are supported", () => {
  assert.equal(nodeVersionError("v22.19.0"), null);
  assert.equal(nodeVersionError("22.19.1"), null);
  assert.equal(nodeVersionError("v22.23.3"), null);
});

test("Node versions below the minimum have an actionable diagnostic", () => {
  assert.equal(
    nodeVersionError("v22.8.0"),
    "Pi-vot requires Node 22.19 or newer within the Node 22 release line.\nDetected: v22.8.0",
  );
  assert.match(nodeVersionError("22.18.9") ?? "", /Node 22\.19 or newer/);
});

test("Node releases outside the supported major version are rejected", () => {
  assert.equal(
    nodeVersionError("v23.2.0"),
    "Pi-vot currently supports Node 22.x only.\nDetected: v23.2.0",
  );
  assert.match(nodeVersionError("v21.7.0") ?? "", /supports Node 22\.x only/);
});

test("unparseable Node version strings are rejected", () => {
  assert.match(nodeVersionError("unknown") ?? "", /Could not determine the Node\.js version/);
  assert.match(nodeVersionError("v22.19.0-rc.1") ?? "", /Could not determine the Node\.js version/);
});
