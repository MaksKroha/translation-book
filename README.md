# Bookstore website

Static pages built from `catalog.json` by `build.py` into `public/`, plus a small checkout in
`functions/` (run by the Cloudflare Worker in `src/worker.js`, with D1) that serves the PDF only after payment is confirmed.

Buyers pay into a monobank jar on your personal account with an order code in the comment.
Payments are matched via the monobank personal API (webhook + a jar poll every 5 minutes as backup).
The Buy button is protected by Cloudflare Turnstile and an Origin check.

    python3 build.py                 # needs Python 3 + Pillow
    python3 tools/monobank.py jars   # find your jar's account_id

Full step-by-step launch guide: [PIPELINE.md](PIPELINE.md).

Secrets live only in Cloudflare → your Worker → Settings → Variables and Secrets
(`MONO_PERSONAL_TOKEN`, `MONO_HOOK_SECRET`, `TURNSTILE_SECRET_KEY`). The GitHub repo contains the PDFs, so it **must stay private**.
