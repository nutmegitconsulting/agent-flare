import type { R2Bucket, DurableObjectNamespace, Ai } from "@cloudflare/workers-types";
import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  BACKUP_BUCKET: R2Bucket;
  AI: Ai;
  ACCESS_AUD_TAG: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_API_TOKEN: string;
  SNAPSHOT_INTERVAL_MINUTES: string;
  /** V8: CF API token with Workers AI:Read — credential for mode=api_token
   *  provider entries (account-scoped AI Gateway REST endpoint). Optional at
   *  type level so jwt-only setups don't need it; unset entries are skipped
   *  with a logged error. */
  CLOUDFLARE_AI_API_TOKEN?: string;
}
