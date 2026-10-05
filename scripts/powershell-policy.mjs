export function isPowerShellExecutionPolicyBlock(output) {
  return /running scripts is disabled on this system/i.test(output.replace(/\s+/g, " ").trim());
}

export function classifyPowerShellAvailability(executable) {
  return executable
    ? { status: "available" }
    : { status: "skipped", reason: "PowerShell is unavailable." };
}

export function classifyPowerShellLauncherExit(exitCode, output) {
  if (exitCode === 0) return { status: "passed" };
  if (isPowerShellExecutionPolicyBlock(output)) {
    return { status: "skipped", reason: "script execution blocked by local execution policy." };
  }
  return {
    status: "failed",
    message: `PowerShell launcher exited early (${exitCode}):\n${output}`,
  };
}
