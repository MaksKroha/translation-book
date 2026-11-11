// Cloudflare Worker entry: routes checkout URLs to the handlers in functions/,
// everything else is served from the static files in public/ (env.ASSETS).
// The cron trigger (wrangler.jsonc → triggers.crons) runs scheduled() to poll the jar and to
// email translation requests that are still waiting.
import { pollJar } from "../lib/jar.js";
import { requestsCron } from "../lib/requests.js";
import * as buy from "../functions/buy/[slug].js";
import * as pay from "../functions/pay/index.js";
import * as order from "../functions/api/order.js";
import * as hook from "../functions/api/mono-hook/[secret].js";
import * as download from "../functions/download/index.js";
import * as translationRequest from "../functions/api/translation-request.js";

const routes = [
  [/^\/buy\/([^/]+)\/?$/, buy, (m) => ({ slug: decodeURIComponent(m[1]) })],
  [/^\/pay\/?$/, pay, () => ({})],
  [/^\/api\/order\/?$/, order, () => ({})],
  [/^\/api\/mono-hook\/([^/]+)\/?$/, hook, (m) => ({ secret: decodeURIComponent(m[1]) })],
  [/^\/download\/?$/, download, () => ({})],
  [/^\/api\/translation-request\/?$/, translationRequest, () => ({})],
];

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/protected/")) return new Response("Not found", { status: 404 });
    for (const [re, mod, getParams] of routes) {
      const m = pathname.match(re);
      if (!m) continue;
      const method = request.method === "HEAD" ? "GET" : request.method;
      const handler = mod[`onRequest${method[0]}${method.slice(1).toLowerCase()}`] || mod.onRequest;
      if (!handler) return new Response("Method not allowed", { status: 405 });
      return handler({ request, env, params: getParams(m), waitUntil: (p) => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },

  // Every 5 minutes: read the jar statement, so payments are matched even when the webhook
  // failed or was switched off and no buyer has their /pay/ page open.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(pollJar(env));
    // Translation requests: email the ones whose email failed or waited for the daily cap,
    // and delete requests older than 180 days (lib/requests.js).
    ctx.waitUntil(requestsCron(env).catch((e) => console.error("translation requests cron:", e)));
  },
};
