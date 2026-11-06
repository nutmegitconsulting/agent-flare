import { describe, expect, it } from "vitest";
import { capacityPage, parkedPage, startingPage } from "../../src/pages";

const pages = {
  starting: startingPage({ state: "starting", step: "waking" }),
  failed: startingPage({ state: "failed", error: "<boom>" }),
  parked: parkedPage(),
  capacity: capacityPage(),
};

describe("waiting screens", () => {
  for (const [name, html] of Object.entries(pages)) {
    it(`${name} is dark before anything else paints, whatever the device prefers`, () => {
      expect(html).toContain('<html lang="en" style="background:#0d1015">');
      expect(html).toContain('<meta name="color-scheme" content="dark">');
      expect(html).toContain("color-scheme: dark;");
      expect(html).not.toContain("prefers-color-scheme");
    });
  }
  it("still escapes an error", () => expect(pages.failed).not.toContain("<boom>"));
});
