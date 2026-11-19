/**
 * The Hermes config.yaml, one document per account, kept in R2. It is the only copy that gets
 * written into a container: hydration writes it after the snapshot restore, and snapshots copy the
 * container's version back here, so Hermes' own changes (a /model switch) survive a restart.
 *
 * R2 layout (BACKUP_BUCKET):
 *   config/users/<sub>/config.yaml     the account's document, edited on the user's admin page
 *   templates/<role>/config.yaml       the role's document, which seeds a user who has none yet
 *
 * The file is stored as text. Nothing here reads a secret value, and a document with an inline secret
 * is refused: credentials belong in .env, named by key_env.
 */
import { parse } from "yaml";

export const MAX_CONFIG_BYTES = 256 * 1024;

const userKey = (sub: string) => `config/users/${sub}/config.yaml`;
const roleKey = (role: string) => `templates/${role}/config.yaml`;

/** Key names that hold a credential when they carry a literal value. */
const SECRET_KEYS = new Set(["api_key", "apikey", "access_token", "password", "secret", "token"]);

export type ConfigCheck = { ok: true; text: string } | { ok: false; error: string };

/** Every key path whose value is a literal credential. Environment references are fine. */
export function inlineSecrets(node: unknown, path = ""): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => inlineSecrets(item, `${path}[${i}]`));
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => {
    const here = path ? `${path}.${key}` : key;
    if (SECRET_KEYS.has(key.toLowerCase()) && typeof value === "string" && value.trim() && !/^\$\{/.test(value.trim())) {
      return [here];
    }
    return inlineSecrets(value, here);
  });
}

/** Whether a document can be stored and written into a container. */
export function checkConfigText(text: string): ConfigCheck {
  if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) {
    return { ok: false, error: `config.yaml is larger than ${MAX_CONFIG_BYTES / 1024} KB` };
  }
  let doc: unknown;
  try {
    doc = parse(text, { uniqueKeys: true });
  } catch (err) {
    return { ok: false, error: `not valid YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "config.yaml must be a mapping of keys at the top level" };
  }
  const secrets = inlineSecrets(doc);
  if (secrets.length) {
    return { ok: false, error: `put these in .env and name them with key_env instead: ${secrets.join(", ")}` };
  }
  return { ok: true, text };
}

export async function loadUserConfig(bucket: R2Bucket, sub: string): Promise<string | null> {
  const object = await bucket.get(userKey(sub));
  return object ? await object.text() : null;
}

export async function saveUserConfig(bucket: R2Bucket, sub: string, text: string): Promise<void> {
  await bucket.put(userKey(sub), text);
}

export async function loadRoleConfig(bucket: R2Bucket, role: string): Promise<string | null> {
  const object = await bucket.get(roleKey(role));
  return object ? await object.text() : null;
}

export async function saveRoleConfig(bucket: R2Bucket, role: string, text: string): Promise<void> {
  await bucket.put(roleKey(role), text);
}
