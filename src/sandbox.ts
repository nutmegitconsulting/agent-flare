import type { Env } from "./env";
import type { Sandbox } from "@cloudflare/sandbox";

export interface HermesSandbox extends Sandbox<Env> {}
