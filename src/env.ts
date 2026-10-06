import type { R2Bucket, KVNamespace, DurableObjectNamespace } from "@cloudflare/workers-types";
import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  BACKUP_BUCKET: R2Bucket;
  /** Credentials store (V9): tunnel token, dashboard session token, gateway
   *  JWT. Kept OUT of the R2 backup bucket so third-party R2 backups never
   *  carry usable credentials. Write-once/read-many fits KV's eventual
   *  consistency (~60s propagation) — credentials are written at provision
   *  time and read on wake, never rewritten mid-flight. */
  CREDENTIALS_KV: KVNamespace;
  ACCESS_AUD_TAG: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_API_TOKEN: string;
  SNAPSHOT_INTERVAL_MINUTES: string;
  /** Per-user tunnel hostnames are `<TUNNEL_NAME_PREFIX>-<userId>.<TUNNEL_BASE_DOMAIN>`.
   *  TUNNEL_BASE_DOMAIN is required (fail-fast at client-init when absent);
   *  TUNNEL_NAME_PREFIX defaults to "hermes". Both live in wrangler vars —
   *  they are tenant-specific, not code. */
  TUNNEL_BASE_DOMAIN: string;
  TUNNEL_NAME_PREFIX?: string;
  /** Access team domain (e.g. "myteam.cloudflareaccess.com") that issues the
   *  Access JWTs this worker validates. Required: JWT validation fetches
   *  signing certs from https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs and
   *  rejects tokens whose iss doesn't match. */
  ACCESS_TEAM_DOMAIN: string;
  /** V8: CF API token with Workers AI:Read — credential for mode=api_token
   *  provider entries (account-scoped AI Gateway REST endpoint). Optional at
   *  type level so jwt-only setups don't need it; unset entries are skipped
   *  with a logged error. */
  CLOUDFLARE_AI_API_TOKEN?: string;
}
