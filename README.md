# Bookstore website

Static pages built from `catalog.json` by `build.py` into `public/`, plus a small checkout in
`functions/` (Cloudflare Pages Functions + D1) that serves the PDF only after payment is confirmed.

Buyers pay into a monobank jar on your personal account with an order code in the comment.
Payments are matched via the monobank personal API (webhook + polling backup).

    python3 build.py                 # needs Python 3 + Pillow
    python3 tools/monobank.py jars   # find your jar's account_id

Full step-by-step launch guide: [PIPELINE.md](PIPELINE.md).

Secrets live only in Cloudflare → Pages → Settings → Variables and Secrets
(`MONO_PERSONAL_TOKEN`, `MONO_HOOK_SECRET`). The GitHub repo contains the PDFs, so it **must stay private**.
