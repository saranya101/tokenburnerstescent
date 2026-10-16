export function publicPasskeyExecutionEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.PARLANCE_PUBLIC_PASSKEY_ENROLLMENT_ENABLED === "true" &&
    environment.PARLANCE_PUBLIC_PASSKEY_EXECUTION_ENABLED === "true" &&
    environment.PARLANCE_BANK_DURABLE_EXECUTION === "true" &&
    environment.PARLANCE_ISOLATED_SYNTHETIC_EXECUTION_APPROVED === "true";
}
