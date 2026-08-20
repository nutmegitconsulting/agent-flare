import type { Env } from "./env";

export class HermesAgent {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/status" && request.method === "GET") {
      const token = await this.state.storage.get<string>("TUNNEL_TOKEN");
      const hostname = await this.state.storage.get<string>("TUNNEL_HOSTNAME");
      return Response.json({
        provisioned: !!token,
        hostname: hostname || null,
      });
    }

    if (url.pathname === "/internal/get-tunnel" && request.method === "GET") {
      const token = await this.state.storage.get<string>("TUNNEL_TOKEN");
      const hostname = await this.state.storage.get<string>("TUNNEL_HOSTNAME");
      if (!token || !hostname) {
        return new Response("Tunnel not configured", { status: 404 });
      }
      return Response.json({ token, hostname });
    }

    if (url.pathname === "/internal/set-tunnel" && request.method === "POST") {
      const { hostname, token } = (await request.json()) as { hostname: string; token: string };
      await this.state.storage.put("TUNNEL_TOKEN", token);
      await this.state.storage.put("TUNNEL_HOSTNAME", hostname);
      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
}
