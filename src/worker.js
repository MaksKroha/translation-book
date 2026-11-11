// Cloudflare Worker entry: routes checkout URLs to the handlers in functions/,
// everything else is served from the static files in public/ (env.ASSETS).
import * as buy from "../functions/buy/[slug].js";
import * as pay from "../functions/pay/index.js";
import * as order from "../functions/api/order.js";
import * as hook from "../functions/api/mono-hook/[secret].js";
import * as download from "../functions/download/index.js";

const routes = [
  [/^\/buy\/([^/]+)\/?$/, buy, (m) => ({ slug: decodeURIComponent(m[1]) })],
  [/^\/pay\/?$/, pay, () => ({})],
  [/^\/api\/order\/?$/, order, () => ({})],
  [/^\/api\/mono-hook\/([^/]+)\/?$/, hook, (m) => ({ secret: decodeURIComponent(m[1]) })],
  [/^\/download\/?$/, download, () => ({})],
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
};
