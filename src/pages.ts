import type { ReadyState } from "./sandbox";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Shown while a container wakes. Polls until the webapp answers, then reloads into it. */
export function startingPage(status: ReadyState): string {
  const failed = status.state === "failed";
  const message = status.state === "starting" ? status.step : "ready";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Flare</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f8; --fg: #1a1a1d; --muted: #6b6b73; --accent: #f6821f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #131316; --fg: #ececf0; --muted: #8b8b93; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
         background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 32rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
  .bar { height: 2px; width: 100%; margin-top: 1rem; background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .bar { animation: none; } }
</style></head>
<body><main>
${failed
    ? `<h1>Your agent couldn't start</h1><p>${escapeHtml(status.error)}</p><p>Your saved state hasn't been changed. Reload to try again.</p>`
    : `<h1>Starting your agent</h1><p id="step">${escapeHtml(message)}…</p><div class="bar"></div>
<script>
  async function poll() {
    try {
      const response = await fetch("/__af/status", { cache: "no-store" });
      const { status } = await response.json();
      if (status.state === "ready") return location.reload();
      if (status.state === "failed") return location.reload();
      document.getElementById("step").textContent = status.step + "\\u2026";
    } catch {}
    setTimeout(poll, 1500);
  }
  setTimeout(poll, 1500);
</script>`}
</main></body></html>`;
}
