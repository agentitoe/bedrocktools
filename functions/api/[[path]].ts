import type { PagesFunction } from "@cloudflare/workers-types";
import { createApp } from "./app";
import { bindAssets } from "./lib/assets";
import type { Env } from "./lib/env";

/**
 * Catch-all Pages Function for every `/api/*` route.
 *
 * The Elysia app is created ONCE per isolate at module scope (startup): its
 * ahead-of-time compilation uses `new Function`, which the Workers runtime
 * only allows during startup (compatibility flag `allow_eval_during_startup`,
 * default since compatibility date 2025-06-01). The ASSETS binding is not
 * available at startup, so it is bound per request here.
 */
const app = createApp();

export const onRequest: PagesFunction<Env> = ({ request, env }) => {
	bindAssets(env.ASSETS);
	return Promise.resolve(app.handle(request));
};
