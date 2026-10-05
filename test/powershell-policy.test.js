import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPowerShellAvailability,
  classifyPowerShellLauncherExit,
  isPowerShellExecutionPolicyBlock,
} from "../scripts/powershell-policy.mjs";
import { runPackageValidationChecks } from "../scripts/release-validation.mjs";

test("classifies whitespace-wrapped policy-blocked PowerShell exits as skips", () => {
  const policyMessages = [
    "running scripts is disabled on this system",
    "running scripts is\ndisabled on this system",
    "running scripts is\r\ndisabled on this system",
    "running   scripts\tis \t disabled on this system",
  ];
  for (const message of policyMessages) {
    const output = `cannot be loaded because ${message}.`;
    assert.equal(isPowerShellExecutionPolicyBlock(output), true, JSON.stringify(message));
    assert.deepEqual(
      classifyPowerShellLauncherExit(1, output),
      { status: "skipped", reason: "script execution blocked by local execution policy." },
    );
  }
});

test("keeps arbitrary early PowerShell failures fatal and includes output", () => {
  const output = "Unexpected launcher failure.";
  assert.deepEqual(classifyPowerShellLauncherExit(1, output), {
    status: "failed",
    message: `PowerShell launcher exited early (1):\n${output}`,
  });
});

test("classifies successful launcher execution as a pass", () => {
  assert.deepEqual(classifyPowerShellLauncherExit(0, ""), { status: "passed" });
});

test("classifies unavailable PowerShell as a skip", () => {
  assert.deepEqual(classifyPowerShellAvailability(null), {
    status: "skipped",
    reason: "PowerShell is unavailable.",
  });
  assert.deepEqual(classifyPowerShellAvailability("pwsh"), { status: "available" });
});

test("package validation continues after a successful PowerShell skip result", () => {
  const calls = [];
  runPackageValidationChecks({
    runSmoke: () => {
      calls.push("smoke");
      return { status: 0 };
    },
    runPowerShellLauncher: () => {
      calls.push("launcher");
      return { status: 0 };
    },
  });
  calls.push("package");
  assert.deepEqual(calls, ["smoke", "launcher", "package"]);
});

test("direct-Node smoke failure remains fatal and prevents packaging", () => {
  let launcherCalled = false;
  assert.throws(() => runPackageValidationChecks({
    runSmoke: () => ({ status: 1 }),
    runPowerShellLauncher: () => {
      launcherCalled = true;
      return { status: 0 };
    },
  }), /Assembled release smoke test failed/);
  assert.equal(launcherCalled, false);
});
