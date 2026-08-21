import type { R2Bucket, DurableObjectNamespace, Ai } from "@cloudflare/workers-types";
import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  BACKUP_BUCKET: R2Bucket;
  AI: Ai;
  ACCESS_AUD_TAG: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  UPLOAD_TOKEN: string;
}
