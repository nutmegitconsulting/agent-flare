import type { HermesSandbox } from "./sandbox";

export interface Env {
  Sandbox: DurableObjectNamespace<HermesSandbox>;
  /** Snapshots, indexes, templates and assignments. No secrets. */
  BACKUP_BUCKET: R2Bucket;
  /** Per-user secrets, always encrypted with MASTER_KEY. See secrets.ts. */
  CREDENTIALS_KV: KVNamespace;

  /** Access application audience tag. */
  ACCESS_AUD_TAG: string;
  /** e.g. "myteam.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN: string;
  /** Comma-separated emails allowed on /__af/admin/*. Empty means no admins. */
  ADMIN_EMAILS?: string;
  /** Idle time before a container sleeps, e.g. "30m". */
  SLEEP_AFTER?: string;
  SNAPSHOT_INTERVAL_MINUTES?: string;
  /** Comma-separated Worker secret names that templates may reference as "$NAME". */
  TEMPLATE_SECRETS?: string;

  /** Worker secret, 32+ characters. Root of all per-user secrets. Rotating it invalidates them. */
  MASTER_KEY: string;
  /** Optional Worker secret: credential for api_token providers. */
  CLOUDFLARE_AI_API_TOKEN?: string;

  /**
   * Local tests only. When ALLOW_TEST_JWKS is "1", Access keys come from TEST_JWKS instead of
   * Cloudflare. Set in .dev.vars for `wrangler dev`; never set these on a deployed Worker.
   */
  ALLOW_TEST_JWKS?: string;
  TEST_JWKS?: string;
}
