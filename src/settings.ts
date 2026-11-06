/** Settings an admin changes on screen. Non-secret, in R2. */
const SETTINGS_KEY = "config/settings.json";

export interface Settings {
  /** Containers awake at once. 0 means no limit. */
  maxAwake: number;
}

export async function loadSettings(bucket: R2Bucket): Promise<Settings> {
  const object = await bucket.get(SETTINGS_KEY);
  const value = object ? ((await object.json()) as Partial<Settings>) : {};
  return { maxAwake: Number.isInteger(value.maxAwake) && value.maxAwake! > 0 ? value.maxAwake! : 0 };
}

export async function saveSettings(bucket: R2Bucket, settings: Settings): Promise<void> {
  await bucket.put(SETTINGS_KEY, JSON.stringify(settings));
}

/** Containers awake now, from the active/ markers each one sets. A stale marker clears at the next cron. */
export async function awakeCount(bucket: R2Bucket, except?: string): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "active/", cursor });
    count += page.objects.filter((o) => o.key !== `active/${except}`).length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return count;
}

export async function underAwakeCap(bucket: R2Bucket, sub: string): Promise<boolean> {
  const { maxAwake } = await loadSettings(bucket);
  return maxAwake === 0 || (await awakeCount(bucket, sub)) < maxAwake;
}
