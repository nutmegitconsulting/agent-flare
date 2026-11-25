/**
 * The Hermes config.yaml, one document per account, kept in R2. It is the only copy that gets
 * written into a container: hydration writes it after the snapshot restore, and snapshots copy the
 * container's version back here, so Hermes' own changes (a /model switch) survive a restart.
 *
 * R2 layout (BACKUP_BUCKET):
 *   config/users/<sub>/config.yaml     the account's document, edited on the user's admin page
 *   templates/<role>/config.yaml       the role's document, which seeds a user in that role who has none yet
 *   config/base/config.yaml            the base document, which seeds everyone else who has none yet
 *
 * The file is stored as text. Nothing here reads a secret value. A document an admin saves is refused
 * when it has an inline secret: credentials belong in .env, named by key_env. The container's own file
 * is not held to that: it wins at every snapshot, so that what the user left is what R2 holds.
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

/**
 * Whether a config.yaml can be written into a container and load there. This is all that's asked of the
 * container's own file, at a snapshot and when a restored file seeds an account: that file is the user's
 * working copy and it wins, whatever it holds. A file that fails this would stop the next boot.
 */
export function checkLoadable(text: string): ConfigCheck {
  let doc: unknown;
  try {
    doc = parse(text, { uniqueKeys: true });
  } catch (err) {
    return { ok: false, error: `not valid YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "config.yaml must be a mapping of keys at the top level" };
  }
  return { ok: true, text };
}

/** Whether a document an admin edits or uploads can be stored: loadable, within the size limit, no inline credential. */
export function checkConfigText(text: string): ConfigCheck {
  if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) {
    return { ok: false, error: `config.yaml is larger than ${MAX_CONFIG_BYTES / 1024} KB` };
  }
  const loadable = checkLoadable(text);
  if (!loadable.ok) return loadable;
  const secrets = inlineSecrets(parse(text));
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

const BASE_KEY = "config/base/config.yaml";

export async function loadBaseConfig(bucket: R2Bucket): Promise<string | null> {
  const object = await bucket.get(BASE_KEY);
  return object ? await object.text() : null;
}

export async function saveBaseConfig(bucket: R2Bucket, text: string): Promise<void> {
  await bucket.put(BASE_KEY, text);
}

/**
 * The config.yaml a boot writes into the container, for an account with or without a document in R2.
 * `restored` reads the file the snapshot restore brought back, or null when there was none. It's only
 * called when that file is needed.
 *
 * R2's document is the one that counts. The restored file takes its place in two cases: the account has no
 * document yet, or `restoredWins`, which the caller sets when the last snapshot couldn't copy the
 * container's file to R2, so R2 is behind what the user left. A restored file is never replaced by the
 * role's. If it can't load, the answer is null: the container keeps it, where af_state sets a broken one
 * aside, and nothing is saved. Only an account that came back with no config.yaml at all, which is a
 * new user, is seeded from a shared document: its role's if the role has one, else the base document.
 */
export async function accountConfigFor(
  bucket: R2Bucket, sub: string, restored: () => Promise<string | null>, role: string | null, restoredWins = false,
): Promise<{ text: string | null; warning?: string }> {
  const stored = await loadUserConfig(bucket, sub);
  if (stored !== null && !restoredWins) return { text: stored };
  const file = await restored();
  if (file !== null) {
    if (file === stored) return { text: stored };
    const check = checkLoadable(file);
    if (!check.ok) return { text: null, warning: `your restored config.yaml was not kept as the account's document: ${check.error}` };
    await saveUserConfig(bucket, sub, file);
    return { text: file };
  }
  if (stored !== null) return { text: stored };
  const seed = (role ? await loadRoleConfig(bucket, role) : null) ?? (await loadBaseConfig(bucket));
  if (seed !== null) await saveUserConfig(bucket, sub, seed);
  return { text: seed };
}

/**
 * A snapshot's copy of the container's config.yaml back to R2. The container's file wins: Hermes and the
 * user change it while they work, and R2 has to hold what they left. Only a file that couldn't load at the
 * next boot is held back. Returns what happened, for the logs.
 */
export async function syncAccountConfig(bucket: R2Bucket, sub: string, text: string | null): Promise<"unchanged" | "saved" | { refused: string }> {
  if (text === null || text === (await loadUserConfig(bucket, sub))) return "unchanged";
  const check = checkLoadable(text);
  if (!check.ok) return { refused: check.error };
  await saveUserConfig(bucket, sub, text);
  return "saved";
}
