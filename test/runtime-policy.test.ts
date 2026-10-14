import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMUM_NODE_VERSION,
  TESTED_NODE_MAJOR,
  nodeVersionDecision,
  nodeVersionError,
  SUPPORTED_NODE_VERSION_RANGE,
} from "../src/runtime-policy.ts";

test("Node 22.18.x remains below the minimum", () => {
  for (const version of ["22.18.0", "22.18.9"]) {
    assert.equal(nodeVersionDecision(version).status, "blocked", version);
    assert.match(nodeVersionError(version) ?? "", /requires Node\.js >=22\.19\.0/);
  }
});

test("Node 22.19.0 and later Node 22 versions are supported", () => {
  for (const version of ["22.19.0", "22.19.1", "22.23.3"]) {
    assert.deepEqual(nodeVersionDecision(version), { status: "supported" }, version);
    assert.equal(nodeVersionError(version), null);
  }
});

test("newer Node majors are allowed without the override and produce an advisory", () => {
  for (const version of ["23.2.0", "24.21.0", "99.0.0"]) {
    const decision = nodeVersionDecision(version);
    assert.equal(decision.status, "newer", version);
    if (decision.status === "newer") {
      assert.equal(
        decision.warning,
        `WARNING: Pi-vot is running on Node ${version}.\n` +
          `The recommended/tested runtime is Node ${MINIMUM_NODE_VERSION} or newer within Node ${TESTED_NODE_MAJOR}.\n` +
          "Continuing because newer Node versions are permitted.",
      );
    }
  }
});

test("recommended/tested Node 22 has no newer-version warning", () => {
  for (const version of ["22.19.0", "22.23.3"]) {
    assert.deepEqual(nodeVersionDecision(version), { status: "supported" }, version);
  }
});

test("versions below the minimum are blocked without an override", () => {
  for (const version of ["20.19.0", "21.7.0", "22.18.9"]) {
    const decision = nodeVersionDecision(version);
    assert.equal(decision.status, "blocked", version);
    if (decision.status === "blocked") {
      assert.equal(
        decision.error,
        `Pi-vot requires Node.js ${SUPPORTED_NODE_VERSION_RANGE}.\nDetected: ${version}`,
      );
    }
  }
});

test("the exact override allows older Node versions with a warning", () => {
  const decision = nodeVersionDecision("20.19.0", "1");
  assert.equal(decision.status, "allowed");
  if (decision.status === "allowed") {
    assert.equal(
      decision.warning,
      "WARNING: Pi-vot is running on Node 20.19.0 below the minimum 22.19.0.\n" +
        "PI_VOT_ALLOW_UNSUPPORTED_NODE=1 is set; continuing anyway.",
    );
  }
});

test("only the exact override value bypasses the minimum-version check", () => {
  for (const value of ["true", "yes", "0", "on", "1 ", ""]) {
    assert.equal(nodeVersionDecision("20.19.0", value).status, "blocked", `override value: ${value}`);
  }
  assert.equal(nodeVersionDecision("20.19.0").status, "blocked", "override unset");
});

test("the override is irrelevant for supported and newer Node versions", () => {
  assert.deepEqual(nodeVersionDecision("22.19.0", "1"), { status: "supported" });
  const newer = nodeVersionDecision("24.21.0");
  assert.equal(newer.status, "newer");
});

test("unparseable Node version strings are rejected", () => {
  assert.match(nodeVersionError("unknown") ?? "", /Could not determine the Node\.js version/);
  assert.match(nodeVersionError("v22.19.0-rc.1") ?? "", /Could not determine the Node\.js version/);
  assert.match(nodeVersionError("999999999999999999999.0.0") ?? "", /Could not determine the Node\.js version/);
  assert.equal(nodeVersionDecision("unknown", "1").status, "blocked");
});
