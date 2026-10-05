export function runPackageValidationChecks({ runSmoke, runPowerShellLauncher }) {
  const smoke = runSmoke();
  if (smoke.error || smoke.status !== 0) {
    throw smoke.error ?? new Error("Assembled release smoke test failed.");
  }

  const launcher = runPowerShellLauncher();
  if (launcher.error || launcher.status !== 0) {
    throw launcher.error ?? new Error("PowerShell launcher integration tests failed or were blocked by local policy.");
  }
}
