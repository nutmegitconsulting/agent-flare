import { describe, expect, it } from "vitest";
import { chooseTheme, clearCustomCookie, contrast, contrastWarnings, customCookie, isHex, parseCustomCookie, parseTheme, safeBack, themeCookie, themeFromCookies, THEME_NAMES, THEMES, validateCustom } from "../../src/themes";

const ember = THEMES.ember;
const fields = { bg: "#000000", surface: "#111111", fg: "#ffffff", muted: "#cccccc", line: "#333333", warn: "#ffcc00", link: "#66ccff", accent: "#ffcc00", onAccent: "#000000", accentHover: "#ffdd33" };
const good = "000000-111111-ffffff-cccccc-333333-ffcc00-66ccff-ffcc00-000000-ffdd33";

describe("themes", () => {
  it("accepts only the listed names, and falls back to Ember", () => {
    expect(parseTheme("lantern")).toBe("lantern");
    for (const bad of ["", "LANTERN", "constructor", "__proto__", "lantern;x", null, undefined, 1]) expect(parseTheme(bad)).toBe("ember");
  });
  it("reads only its own cookie", () => {
    expect(themeFromCookies("a=b; af_admin_theme=lantern; c=d").name).toBe("lantern");
    expect(themeFromCookies("xaf_admin_theme=lantern").name).toBe("ember");
    expect(themeFromCookies("af_admin_theme=evil").name).toBe("ember");
    expect(themeFromCookies(null).name).toBe("ember");
  });
  it("sets the cookie as specified", () => {
    expect(themeCookie("lantern")).toBe("af_admin_theme=lantern; Secure; HttpOnly; SameSite=Strict; Path=/__af/admin; Max-Age=31536000");
  });
  it("accepts only #rrggbb", () => {
    for (const ok of ["#000000", "#AbCdEf"]) expect(isHex(ok)).toBe(true);
    for (const bad of ["000000", "#fff", "#00000g", "#0000000", " #000000", "#000000\n", "red", "", null, undefined, 1]) expect(isHex(bad)).toBe(false);
  });
  it("refuses injection on save, naming the field", () => {
    for (const attack of ["#000000;}</style><script>x</script>", "</style>", "#000000;color:red", "url(https://evil.example)", "red", "#000000 !important"]) {
      expect(validateCustom({ ...fields, bg: attack })).toEqual({ invalid: ["Page background"] });
    }
    expect(validateCustom({ ...fields, accent: undefined })).toEqual({ invalid: ["Buttons"] });
    expect("theme" in validateCustom(fields)).toBe(true);
  });
  it("round-trips a saved theme, on the same flags", () => {
    const result = validateCustom(fields);
    const cookie = "theme" in result ? customCookie(result.theme) : "";
    expect(cookie).toBe(`af_admin_custom=${good}; Secure; HttpOnly; SameSite=Strict; Path=/__af/admin; Max-Age=31536000`);
    expect(parseCustomCookie(good)?.fg).toBe("#ffffff");
  });
  it("treats a tampered cookie as invalid, and gives the whole page Ember", () => {
    const attacks = ["000000</style>-111111-ffffff-cccccc-333333-ffcc00-66ccff-ffcc00-000000-ffdd33", "000000;x-111111-ffffff-cccccc-333333-ffcc00-66ccff-ffcc00-000000-ffdd33",
      "url(x)-111111-ffffff-cccccc-333333-ffcc00-66ccff-ffcc00-000000-ffdd33", good.slice(0, -7), `${good}-000000`, "", "---------"];
    for (const attack of attacks) {
      expect(parseCustomCookie(attack)).toBeNull();
      const theme = themeFromCookies(`af_admin_theme=custom; af_admin_custom=${attack}`);
      expect(theme.name).toBe("ember");
      expect(theme.tokens).toEqual(ember);
    }
  });
  it("only ever outputs #rrggbb from a valid cookie", () => {
    const { name, tokens } = themeFromCookies(`af_admin_theme=custom; af_admin_custom=${good}`);
    expect(name).toBe("custom");
    for (const value of Object.values(tokens)) expect(isHex(value)).toBe(true);
  });
  it("warns about unreadable colours without blocking them", () => {
    const result = validateCustom({ ...fields, fg: "#000000", onAccent: "#ffcc00" });
    expect("theme" in result).toBe(true);
    if ("theme" in result) {
      expect(contrastWarnings(result.theme).join()).toContain("Text on the page");
      expect(contrastWarnings(result.theme).join()).toContain("Text on buttons");
    }
    const ok = validateCustom(fields);
    if ("theme" in ok) expect(contrastWarnings(ok.theme)).toEqual([]);
  });
  it("resets to Ember, clearing saved colours, whatever else is sent", () => {
    const { cookies, location } = chooseTheme({ reset: "1", theme: "lantern", back: "/__af/admin/roles" }, `af_admin_custom=${good}`);
    expect(cookies).toEqual([themeCookie("ember"), clearCustomCookie]);
    expect(location).toBe("/__af/admin/roles");
  });
  it("sends Custom to the settings page if nothing valid is saved", () => {
    expect(chooseTheme({ theme: "custom" }, null)).toEqual({ cookies: [], location: "/__af/admin/theme" });
    expect(chooseTheme({ theme: "custom", back: "/__af/admin" }, `af_admin_custom=${good}`).cookies).toEqual([themeCookie("custom")]);
    expect(chooseTheme({ theme: "evil", back: "https://evil.example" }, null)).toEqual({ cookies: [themeCookie("ember")], location: "/__af/admin" });
  });
  it("redirects only within the admin screens", () => {
    expect(safeBack("/__af/admin")).toBe("/__af/admin");
    expect(safeBack("/__af/admin/u/abc?x=1")).toBe("/__af/admin/u/abc?x=1");
    for (const bad of ["https://evil.example/__af/admin", "//evil.example/__af/admin", "/\\evil.example", "\\\\evil.example", "/__af/adminx", "/", "/__af/admin/../../x", "/__af/admin\r\nx", "javascript:alert(1)", "", null]) {
      expect(safeBack(bad)).toBe("/__af/admin");
    }
  });
  for (const name of THEME_NAMES) {
    const t = THEMES[name];
    it(`${name}: text is at least 4.5:1 everywhere it's used`, () => {
      for (const bg of [t.bg, t.surface, t.surface2]) for (const fg of [t.fg, t.muted, t.warn, t.link]) expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.onAccent, t.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.onAccent, t.accentHover)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: controls and the focus ring stand out at 3:1`, () => {
      for (const bg of [t.bg, t.surface2]) { expect(contrast(t.fieldLine, bg)).toBeGreaterThanOrEqual(3); expect(contrast(t.link, bg)).toBeGreaterThanOrEqual(3); }
    });
  }
  it("doesn't name anyone", () => expect(JSON.stringify(THEMES).toLowerCase()).not.toContain("nutmeg"));
});
