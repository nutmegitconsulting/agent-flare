/**
 * Gateway for the per-user dev-sandbox sidecar (route A / internal path).
 *
 * The container's plugin speaks plain HTTP to a fake internal hostname; the
 * AgentSandbox DO registers ctx.container.interceptOutboundHttp() for that
 * hostname during hydrate(), routing the request HERE with props {sub}. The
 * sub comes from the DO that verified the user's Access JWT — never from
 * anything the container sends — so the only name-forming input for the
 * sandbox DO is the verified identity. The sidecar Worker is reachable only
 * through the DEV_SANDBOX service binding (workers_dev: false, no routes).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";

/** Fake hostname the container plugin targets. Must match the intercept in hydrate(). */
export const DEV_SANDBOX_INTERNAL_HOST = "cfsandbox.internal";

const KEY_RE = /[^a-z0-9_-]/g;

/** Sandbox key derived only from the verified sub. Opaque, stable, per-user. */
export function sandboxKeyFor(sub: string): string {
  const key = "af-" + (sub || "").toLowerCase().replace(KEY_RE, "-");
  // DO names cap at 64 chars; subs are UUID-shaped so truncation is safe here.
  return key.length > 64 ? key.slice(0, 64) : key;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export class SandboxGateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const binding = this.env.DEV_SANDBOX;
    if (!binding) {
      return json({ error: "dev sandbox feature is off (no DEV_SANDBOX binding)" }, 503);
    }
    const props = (this.ctx as unknown as { props?: { sub?: string } }).props;
    const sub = props?.sub;
    if (!sub) {
      return json({ error: "gateway started without an identity" }, 500);
    }

    // Identity is stamped here and never taken from the request: overwrite any
    // client-supplied key and strip anything that could carry credentials.
    const headers = new Headers(request.headers);
    headers.set("X-Sandbox-Key", sandboxKeyFor(sub));
    headers.delete("Authorization");
    headers.delete("CF-Access-Client-Id");
    headers.delete("CF-Access-Client-Secret");

    // Bodies are JSON commands the sidecar caps, so buffer rather than stream; the plugin never
    // sends a streaming body. The `sandbox` command's shell is a WebSocket upgrade (GET /pty): it
    // has no body, and the binding's 101 response goes back as it is.
    const body = request.method === "GET" ? undefined : await request.arrayBuffer();
    return binding.fetch(new Request(request, { headers, body }));
  }
}
