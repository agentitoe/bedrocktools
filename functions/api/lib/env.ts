import type { Fetcher } from "@cloudflare/workers-types";

/** Environment bindings available to the Pages Functions. */
export interface Env {
	/** Static assets of the current deployment (injected by Cloudflare Pages). */
	readonly ASSETS: Fetcher;
}
