import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "./env";

export class HermesSandbox extends Sandbox<Env> {}
