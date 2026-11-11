// Checks shared by the forms that write to the database: the Buy button (functions/buy/[slug].js)
// and the translation request form (functions/api/translation-request.js).
//   1. fromOwnSite: the form must come from our own pages, so other sites can't make their
//      visitors' browsers send it.
//   2. passedTurnstile: the form carries a one-time token from the Cloudflare Turnstile widget,
//      verified with Cloudflare. Stops scripts sending the form in bulk.
// Each form uses its own Turnstile action (data-action in build.py), so a token made for one form
// can't be used on the other.

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function fromOwnSite(request) {
  const ownOrigin = new URL(request.url).origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin" || request.headers.get("Origin") === ownOrigin;
}

// true = human, false = token missing/invalid/used. Throws if Cloudflare can't be reached.
export async function passedTurnstile(request, env, token, action) {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);
  const res = await fetch(SITEVERIFY, { method: "POST", body: form, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`turnstile siteverify HTTP ${res.status}`);
  const out = await res.json();
  const ok = out.success === true && out.action === action
    && out.hostname === new URL(request.url).hostname;
  if (!ok) console.warn("turnstile rejected", JSON.stringify({ codes: out["error-codes"], action: out.action, hostname: out.hostname }));
  return ok;
}
