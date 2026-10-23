---
title: Helicon 7 Backend
emoji: 🛡️
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Helicon 7 RTSP Backend

Converts an institution's RTSP camera feed into an HLS stream that the
Helicon 7 web app (or any browser) can play, so live AI detection (phone,
vape, cigarette, fight/weapon) can run on real CCTV footage. Also handles
institution approval and alert notifications by **email** (via Resend —
no Telegram/Discord account needed), the Roboflow detection proxy (keeps
the API key server-side), and centralized alert logging.

## Setting up email notifications (free, no card)

1. Go to **resend.com** and sign up (free — no credit card).
2. Go to **API Keys** in the dashboard → **Create API Key** → copy it.
3. Add these as environment variables / secrets on your hosting platform:
   - `RESEND_API_KEY` = the key you just copied
   - `ADMIN_EMAIL` = the email address that should receive institution requests and alerts (e.g. your Gmail)
   - `ROBOFLOW_API_KEY` = your Roboflow private API key
4. That's it — no bot, no phone number, no chat app signup. Resend's free tier
   sends from `onboarding@resend.dev` by default, which works immediately
   with zero setup. (Later, if you want emails to come from your own domain
   instead, you can verify a domain in Resend's dashboard — optional.)

Now, whenever an institution submits the Helicon 7 signup form, an email
arrives at `ADMIN_EMAIL` with **Approve** / **Decline** buttons (just links —
click either one, no login needed). Approving instantly generates the three
staff access codes and shows them right there in the browser.

Detection alerts (with the proof snapshot attached as an image) also arrive
by email the same way.

## AI Assistant setup — pick any one (or more) of these free providers, no card needed

The Assistant tries providers in this order and automatically falls through
to the next if one fails or isn't configured: **Groq → Gemini → Mistral → Z.AI**.
You only need to set ONE of the keys below to make it work at all — the rest
are optional extra redundancy.

1. **Groq** — console.groq.com → API Keys → Create. Env vars: `GROQ_API_KEY`
   (optional: `GROQ_TEXT_MODEL`, `GROQ_VISION_MODEL` — check `console.groq.com/docs/models`
   if a model gets retired)
2. **Gemini** — aistudio.google.com → Get API Key. Env vars: `GEMINI_API_KEY`
   (optional: `GEMINI_MODEL`, default `gemini-3.6-flash`)
3. **Mistral** — console.mistral.ai → API Keys. Env vars: `MISTRAL_API_KEY`
   (optional: `MISTRAL_TEXT_MODEL` default `mistral-small-latest`, `MISTRAL_VISION_MODEL` default `pixtral-12b-2409`)
4. **Z.AI** (GLM models) — z.ai → API Keys. Env vars: `ZAI_API_KEY`
   (optional: `ZAI_TEXT_MODEL` default `glm-4.5-flash`, `ZAI_VISION_MODEL` default `glm-4.5v`)

This gives the "Assistant" tab in the app: a chatbot that can answer things
like "what happened in the last 30 minutes" or "did the headcount drop
before break" using logged headcounts + activity descriptions and the
alert history. It intentionally never identifies or tracks a specific named
individual — only group-level counts and activity, plus pointing staff to a
screenshot for anything that needs a human to actually look and confirm who.

Note: the Gemini path answers using pre-fetched log/alert data rather than
real tool-calling (kept simple on purpose, since Gemini's function-calling
schema differs from the others) — slightly less precise than Groq/Mistral/Z.AI,
but keeps the Assistant working during an outage of the other three.This gives the "Assistant" tab in the app: a chatbot that can answer things
like "what happened in the last 30 minutes" or "did the headcount drop
before break" using logged headcounts + activity descriptions and the
alert history. It intentionally never identifies or tracks a specific named
individual — only group-level counts and activity, plus pointing staff to a
screenshot for anything that needs a human to actually look and confirm who.

## Why this exists
Browsers cannot play `rtsp://` links directly. This small server:
1. Receives an RTSP URL from the Helicon 7 "Add Camera" screen.
2. Runs `ffmpeg` (via the `ffmpeg-static` npm package — no system install needed) to continuously convert that feed into HLS (`.m3u8` + `.ts` segments).
3. Serves those segments over HTTPS so the frontend can load them into a normal `<video>` tag using `hls.js`.

## Deploying
This repo works on any Node.js host (Bonto, SnapDeploy, Hugging Face Spaces
with Docker, etc.). It listens on `process.env.PORT`, falling back to `7860`.

## Persistent storage (Supabase) — set this up, or institution signups get wiped on every restart

Without this, approved institutions and their staff access codes live only in
memory — a free-tier sleep/restart erases them and locks everyone out. Setup
(free, no card):
1. Go to **supabase.com** → sign up → **New Project** (free tier).
2. In the project's **SQL Editor**, run:
   ```sql
   create table institutions (
     id uuid primary key,
     name text not null,
     email text not null,
     contact text not null,
     phone text,
     status text not null default 'pending',
     codes jsonb,
     approve_token text not null,
     created_at timestamptz not null default now()
   );
   ```
3. Go to **Project Settings → API** → copy the **Project URL** and the
   **service_role** secret key (NOT the public `anon` key — this server
   writes data and only ever runs server-side).
4. Set env vars: `SUPABASE_URL` = the Project URL, `SUPABASE_KEY` = the
   service_role key.

Without these two env vars set, the server still runs — it just falls back
to the old in-memory behavior (works until the next restart/sleep).

## API safety
Two rate limits protect the free-tier host and AI quotas:
- General: 300 requests / 15 min per IP, across all routes
- AI-costing routes (`/api/detect/:modelKey`, `/api/scene/log`, `/api/agent/ask`): 20 requests / minute per IP

## API

- `POST /api/streams` — body: `{ "rtspUrl": "rtsp://...", "institutionId": "kips", "cameraName": "Main Gate" }` → returns `{ streamId, hlsUrl }`
- `DELETE /api/streams/:id` — stops a camera stream
- `GET /api/streams` — lists all currently active streams
- `POST /api/institutions` — body: `{ name, email, contact, phone }` → creates a pending request, emails admin an approve/decline link
- `GET /api/institutions/:id/approve?token=...` — approving link from the email
- `GET /api/institutions/:id/decline?token=...` — declining link from the email
- `GET /api/institutions/:id/status` — frontend polls this to detect approval
- `POST /api/detect/:modelKey` — proxies to Roboflow, keeping the API key server-side
- `POST /api/alerts` — logs a detection alert and emails Super Admin with the proof image
- `GET /api/alerts` — lists recent alerts across all institutions
- `POST /api/scene/log` — body: `{ institutionId, cameraName, image }` → logs a headcount + short text description (text only, no image stored) for the Assistant to draw on
- `POST /api/agent/ask` — body: `{ institutionId, institutionName, question }` → the chatbot; runs a tool-calling loop over scene logs + alerts and returns `{ answer }`
- `GET /api/insights?institutionId=...&minutes=1440` — proactive findings Helicon 7 surfaced on its own (no one asked), most recent first. A background pass runs every 20 minutes per active institution, looking at the last hour of data; it only records something if it judges it genuinely noteworthy (most passes find nothing, by design — this is meant to be rare and real, not a constant stream)
- `GET /health` — health check
