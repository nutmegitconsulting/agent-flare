/**
 * The local test switches: simulated Access keys and the backup stand-in. On a deployed Worker either would be a
 * hole, so the Worker refuses to serve if it finds one anywhere but localhost, and scripts/check-deploy.mjs refuses
 * to deploy a config that sets one.
 */
export const TEST_SETTINGS = ["ALLOW_TEST_JWKS", "TEST_JWKS", "TEST_BACKUPS"] as const;

export function forbiddenTestSettings(env: Partial<Record<(typeof TEST_SETTINGS)[number], unknown>>, hostname: string): string[] {
  if (hostname === "localhost" || hostname === "127.0.0.1") return [];
  return TEST_SETTINGS.filter((name) => env[name] !== undefined && env[name] !== "");
}
