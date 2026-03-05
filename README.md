### Discovery AI Backend Server     

#### Deploy on Railway (GitHub → auto redeploy)

1. **Connect GitHub** in Railway: New Project → Deploy from GitHub repo → select your repo.
2. **Set root directory** (if your repo root is not this backend):
   - In the service → **Settings** → **Root Directory** = `discovery-ai-backend` (or the folder that contains this `Dockerfile`).
3. **Environment variables** (Railway → Variables): add `MONGO_URI`, `JWT_SECRET`, and any others your app needs.
4. **Deploy**: Railway will use the **Dockerfile** and **railway.toml** in this folder. Every **push to GitHub** triggers a new build and redeploy.

#### OCR (100% local, no external APIs)

Screenshot OCR uses **Tesseract.js** with intelligent zone-based layout detection (HEADER / SIDEBAR / BODY / FOOTER). All processing runs inside Node — no Python service required.

The OCR output includes:
- **Structured blocks/lines** from Tesseract's native layout engine
- **Zone detection** that identifies page regions (header, sidebar, body, footer) using gap analysis
- **HTML-like structured text** for downstream claim extraction
- **OCR text cleaning** that fixes common Tesseract artefacts (e.g. camelCase joins, letter/digit splits)

#### Reprocess claims

Open the app → **Claims (OCR)** (PM dashboard) → click **Reprocess Claims**. The API returns **202 immediately** and runs OCR + claim extraction in the background (so the request does not hit gateway timeouts). If you see a **CORS error** or "Failed to fetch" when clicking Reprocess, ensure the **latest backend is deployed** so that this 202 response is used; otherwise the long-running request can time out at the proxy and the browser reports CORS. After reprocess starts, refresh the claims list in a few minutes.
