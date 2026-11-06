/** Admin page themes. Chosen per browser, in a cookie the admin screens alone can see. */
export interface Theme {
  bg: string; surface: string; surface2: string; fg: string; muted: string; line: string; fieldLine: string;
  warn: string; link: string; accent: string; onAccent: string; accentHover: string;
}

export const THEMES = {
  lantern: {
    bg: "#070722", surface: "#0d1b45", surface2: "#082e6c", fg: "#f6f9fe", muted: "#a9b8d6", line: "#2c4688", fieldLine: "#5f7ec4",
    warn: "#fcc021", link: "#3bdfff", accent: "#fcc021", onAccent: "#070722", accentHover: "#fcb700",
  },
  ember: {
    bg: "#0b0b0c", surface: "#131316", surface2: "#1a1a1e", fg: "#e8e6e3", muted: "#8b8b93", line: "#26262b", fieldLine: "#6e6e78",
    warn: "#d29922", link: "#f6821f", accent: "#f6821f", onAccent: "#0b0b0c", accentHover: "#ff9a45",
  },
} satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];
export const DEFAULT_THEME: ThemeName = "ember";
export const THEME_COOKIE = "af_admin_theme";
export const CUSTOM_COOKIE = "af_admin_custom";
const COOKIE_FLAGS = "Secure; HttpOnly; SameSite=Strict; Path=/__af/admin";

/** Anything not on the list falls back. Own keys only, so "constructor" isn't a theme. */
export function parseTheme(value: unknown): ThemeName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(THEMES, value) ? (value as ThemeName) : DEFAULT_THEME;
}

function readCookie(header: string | null | undefined, name: string): string | undefined {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header ?? "")?.[1];
}

export function themeCookie(name: ThemeName | "custom"): string {
  return `${THEME_COOKIE}=${name}; ${COOKIE_FLAGS}; Max-Age=31536000`;
}

// ---- Custom colours. These go into a <style> block, so nothing but #rrggbb may ever reach it.

export const CUSTOM_FIELDS = [
  ["bg", "Page background"], ["surface", "Fields and table headers"], ["fg", "Text"], ["muted", "Quieter text"],
  ["line", "Lines"], ["warn", "Warnings"], ["link", "Links"], ["accent", "Buttons"], ["onAccent", "Text on buttons"],
  ["accentHover", "Buttons, on hover"],
] as const;
export type CustomField = (typeof CUSTOM_FIELDS)[number][0];

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHex = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

/** All the fields, or the names of those that aren't valid. */
export function validateCustom(form: Record<string, unknown>): { theme: Theme } | { invalid: string[] } {
  const invalid = CUSTOM_FIELDS.filter(([key]) => !isHex(form[key])).map(([, label]) => label);
  if (invalid.length) return { invalid };
  const v = form as Record<CustomField, string>;
  return { theme: {
    bg: v.bg, surface: v.surface, surface2: v.surface, fg: v.fg, muted: v.muted, line: v.line, fieldLine: v.line,
    warn: v.warn, link: v.link, accent: v.accent, onAccent: v.onAccent, accentHover: v.accentHover,
  } };
}

export function customCookie(theme: Theme): string {
  const value = CUSTOM_FIELDS.map(([key]) => theme[key].slice(1)).join("-");
  return `${CUSTOM_COOKIE}=${value}; ${COOKIE_FLAGS}; Max-Age=31536000`;
}

export const clearCustomCookie = `${CUSTOM_COOKIE}=; ${COOKIE_FLAGS}; Max-Age=0`;

/** A cookie is untrusted input: checked every time it's read. */
export function parseCustomCookie(value: string | undefined): Theme | null {
  const parts = (value ?? "").split("-");
  if (parts.length !== CUSTOM_FIELDS.length) return null;
  const form = Object.fromEntries(CUSTOM_FIELDS.map(([key], i) => [key, `#${parts[i]}`]));
  const result = validateCustom(form);
  return "theme" in result ? result.theme : null;
}

/** The whole page's colours. Anything invalid means Ember for the whole page. */
export function themeFromCookies(header: string | null | undefined): { name: ThemeName | "custom"; tokens: Theme; savedCustom: Theme | null } {
  const savedCustom = parseCustomCookie(readCookie(header, CUSTOM_COOKIE));
  const chosen = readCookie(header, THEME_COOKIE);
  if (chosen === "custom") {
    if (savedCustom) return { name: "custom", tokens: savedCustom, savedCustom };
    return { name: DEFAULT_THEME, tokens: THEMES[DEFAULT_THEME], savedCustom };
  }
  const name = parseTheme(chosen);
  return { name, tokens: THEMES[name], savedCustom };
}

const luminance = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** Text and background pairs under 4.5:1. A warning, never a block. */
export function contrastWarnings(t: Theme): string[] {
  const pairs: [string, string, string][] = [
    ["Text on the page", t.fg, t.bg], ["Quieter text on the page", t.muted, t.bg], ["Warnings on the page", t.warn, t.bg],
    ["Links on the page", t.link, t.bg], ["Text in fields", t.fg, t.surface], ["Links on the bar", t.link, t.surface2],
    ["Text on buttons", t.onAccent, t.accent], ["Text on buttons, on hover", t.onAccent, t.accentHover],
  ];
  return pairs.filter(([, a, b]) => contrast(a, b) < 4.5).map(([label, a, b]) => `${label}: ${contrast(a, b).toFixed(1)}:1`);
}

/** A choice from the picker. Reset drops the saved colours too, so nothing can leave an admin stuck. */
export function chooseTheme(form: { theme?: unknown; reset?: unknown; back?: unknown }, header: string | null | undefined): { cookies: string[]; location: string } {
  const back = safeBack(form.back);
  if (form.reset) return { cookies: [themeCookie(DEFAULT_THEME), clearCustomCookie], location: back };
  if (form.theme === "custom") {
    if (!parseCustomCookie(readCookie(header, CUSTOM_COOKIE))) return { cookies: [], location: "/__af/admin/theme" };
    return { cookies: [themeCookie("custom")], location: back };
  }
  return { cookies: [themeCookie(parseTheme(form.theme))], location: back };
}

/** Where to go after choosing: an admin path on this site, and nothing else. */
export function safeBack(value: unknown): string {
  const fallback = "/__af/admin";
  if (typeof value !== "string" || !value.startsWith("/") || /[\\\r\n\t]/.test(value) || value.startsWith("//")) return fallback;
  try {
    const url = new URL(value, "https://same.invalid");
    if (url.origin !== "https://same.invalid") return fallback;
    if (url.pathname !== fallback && !url.pathname.startsWith(`${fallback}/`)) return fallback;
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}
