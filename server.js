/**
 * Helicon 7 RTSP-to-HLS Backend
 * ----------------------------
 * Browsers cannot play RTSP directly. This server takes an institution's
 * RTSP camera link, spins up an ffmpeg process that converts it into HLS
 * (HTTP Live Streaming) segments, and serves those segments over plain
 * HTTP/HTTPS so the Helicon 7 frontend can play them in a normal <video> tag
 * (via hls.js) and run AI detection on the frames exactly like a webcam.
 *
 * Each active camera gets its own ffmpeg process + its own folder of
 * .m3u8/.ts files under /tmp/streams/<streamId>/.
 *
 * Institution approval and alert notifications go out over EMAIL (via the
 * free Resend API) instead of a chat app — no Telegram/Discord signup needed.
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', 1); // required behind Bonto/SnapDeploy's proxy, otherwise express-rate-limit crashes on the X-Forwarded-For header
app.use(cors());
app.use(express.json({ limit: '5mb' })); // proof screenshots are base64 in JSON

// ---- API safety: rate limiting ----
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down and try again shortly.' }
}));

// Tighter limiter for endpoints that spend real AI/API quota (Groq/Gemini/
// Mistral/Z.AI/Roboflow calls), applied individually to those routes below.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests in a short time — please wait a moment and try again.' }
});

const STREAMS_DIR = path.join('/tmp', 'streams');
if (!fs.existsSync(STREAMS_DIR)) fs.mkdirSync(STREAMS_DIR, { recursive: true });

const activeStreams = {};

app.use('/streams', express.static(STREAMS_DIR));

// ============================================================
// EMAIL (Resend) — replaces the old Telegram bot entirely
// ============================================================
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
// Resend's free tier lets you send from this address with zero setup.
// Once you verify your own domain on resend.com, swap this for your own address.
const FROM_EMAIL = process.env.FROM_EMAIL || 'Helicon 7 <onboarding@resend.dev>';

async function sendEmail({ to, subject, html, attachments }) {
  if (!RESEND_API_KEY) {
    console.log('[Resend not configured] Would email:', to, subject);
    return;
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject,
        html,
        attachments: attachments || []
      })
    });
  } catch (err) {
    console.error('Failed to send email:', err.message);
  }
}

function baseUrlFromRequest(req) {
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * POST /api/streams
 * body: { rtspUrl, institutionId, cameraName }
 * Starts converting an RTSP feed to HLS. Returns the playback URL.
 */
app.post('/api/streams', (req, res) => {
  const { rtspUrl, institutionId, cameraName } = req.body;

  if (!rtspUrl || !rtspUrl.startsWith('rtsp://')) {
    return res.status(400).json({ error: 'A valid rtsp:// URL is required.' });
  }

  const streamId = uuidv4();
  const outDir = path.join(STREAMS_DIR, streamId);
  fs.mkdirSync(outDir, { recursive: true });
  const playlistPath = path.join(outDir, 'index.m3u8');

  // Try "stream copy" first: most IP/CCTV cameras already output H.264, so we
  // just repackage into HLS without re-encoding. This uses a fraction of the
  // CPU that full transcoding (libx264) needs — critical for running several
  // cameras at once on a small free-tier container. If the camera's format
  // isn't HLS-compatible, ffmpeg will fail fast and we automatically retry
  // with full transcoding as a fallback.
  function buildFfmpegArgs(mode) {
    const videoCodec = mode === 'copy' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'];
    return [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      ...videoCodec,
      '-c:a', 'aac',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '4',
      '-hls_flags', 'delete_segments+omit_endlist',
      playlistPath
    ];
  }

  function startFfmpeg(mode) {
    const proc = spawn(ffmpegPath, buildFfmpegArgs(mode));
    let sawOutput = false;

    proc.stderr.on('data', (data) => {
      // Any real progress output means the copy/format worked — no fallback needed.
      if (data.toString().includes('frame=')) sawOutput = true;
    });

    proc.on('exit', (code) => {
      if (mode === 'copy' && !sawOutput && code !== 0) {
        // Stream copy failed outright (incompatible source format) — retry with transcoding.
        console.log(`Stream ${streamId}: copy mode failed, falling back to transcode.`);
        activeStreams[streamId].process = startFfmpeg('transcode');
        return;
      }
      console.log(`Stream ${streamId} ffmpeg process exited with code ${code}`);
      delete activeStreams[streamId];
    });

    proc.on('error', (err) => {
      console.error(`Stream ${streamId} failed to start:`, err.message);
      delete activeStreams[streamId];
    });

    return proc;
  }

  activeStreams[streamId] = {
    process: null,
    rtspUrl,
    institutionId: institutionId || 'unknown',
    cameraName: cameraName || 'Unnamed Camera',
    startedAt: new Date().toISOString()
  };
  activeStreams[streamId].process = startFfmpeg('copy');

  setTimeout(() => {
    res.json({
      streamId,
      hlsUrl: `/streams/${streamId}/index.m3u8`,
      cameraName: activeStreams[streamId]?.cameraName
    });
  }, 3000);
});

/**
 * DELETE /api/streams/:id
 */
app.delete('/api/streams/:id', (req, res) => {
  const { id } = req.params;
  const entry = activeStreams[id];
  if (!entry) return res.status(404).json({ error: 'Stream not found or already stopped.' });

  entry.process.kill('SIGKILL');
  delete activeStreams[id];

  const outDir = path.join(STREAMS_DIR, id);
  fs.rm(outDir, { recursive: true, force: true }, () => {});

  res.json({ stopped: true });
});

app.get('/api/streams', (req, res) => {
  const list = Object.entries(activeStreams).map(([id, s]) => ({
    id,
    cameraName: s.cameraName,
    institutionId: s.institutionId,
    startedAt: s.startedAt
  }));
  res.json(list);
});

// ============================================================
// ROBOFLOW DETECTION PROXY
// ============================================================
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_MODEL_ENDPOINTS = {
  'vape-cigarette': 'https://detect.roboflow.com/sabtain-butt/cigarette-vape-detection-gsw55/1',
  'violence-weapon': 'https://detect.roboflow.com/sabtain-butt/violence-weapon-detection-meoco/1'
};

app.post('/api/detect/:modelKey', aiLimiter, async (req, res) => {
  const endpoint = ROBOFLOW_MODEL_ENDPOINTS[req.params.modelKey];
  if (!endpoint) return res.status(400).json({ error: 'Unknown model key.' });
  if (!ROBOFLOW_API_KEY) return res.status(500).json({ error: 'Server is missing ROBOFLOW_API_KEY.' });

  const { image, confidence } = req.body;
  if (!image) return res.status(400).json({ error: 'image (base64) is required.' });

  try {
    const roboflowRes = await fetch(`${endpoint}?api_key=${ROBOFLOW_API_KEY}&confidence=${confidence || 45}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: image
    });
    const data = await roboflowRes.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Roboflow request failed', detail: err.message });
  }
});

// ============================================================
// CENTRALIZED ALERTS (Super Admin visibility, via email)
// ============================================================
const allAlerts = [];

app.post('/api/alerts', async (req, res) => {
  const { institutionName, alertType, confidence, cameraName, image } = req.body;
  if (!institutionName || !alertType) {
    return res.status(400).json({ error: 'institutionName and alertType are required.' });
  }

  const alert = {
    id: uuidv4(),
    institutionName,
    alertType,
    confidence: confidence || null,
    cameraName: cameraName || 'Unknown Camera',
    imageBase64: image || null,
    timestamp: new Date().toISOString()
  };
  allAlerts.unshift(alert);
  if (allAlerts.length > 500) allAlerts.pop();

  if (ADMIN_EMAIL) {
    const html = `
      <h2 style="color:#C81E3A;">🚨 ${alertType}</h2>
      <p><b>Institution:</b> ${institutionName}</p>
      <p><b>Camera:</b> ${alert.cameraName}</p>
      ${confidence ? `<p><b>Confidence:</b> ${Math.round(confidence * 100)}%</p>` : ''}
      <p><b>Time:</b> ${new Date(alert.timestamp).toLocaleString()}</p>
      ${image ? '<p>Proof snapshot attached.</p>' : ''}
    `;
    const attachments = image
      ? [{ filename: 'proof.jpg', content: image }] // Resend accepts base64 content directly
      : [];
    await sendEmail({ to: ADMIN_EMAIL, subject: `Helicon 7 Alert: ${alertType} — ${institutionName}`, html, attachments });
  }

  res.json({ stored: true, id: alert.id });
});

app.get('/api/alerts', (req, res) => {
  res.json(allAlerts.slice(0, 100));
});

app.get('/health', (req, res) => res.json({ status: 'ok', activeStreams: Object.keys(activeStreams).length }));

// ============================================================
// AI ASSISTANT — scene logging + tool-calling chatbot (Groq, free tier)
// ============================================================
// Everything here operates at the GROUP/PATTERN level only — headcounts,
// short activity descriptions, alert history. It never identifies or tracks
// a specific named individual. If an Administrator needs to know WHO a headcount
// drop refers to, the flow is: AI flags the drop + attaches the camera
// screenshot from that moment -> a human looks at the screenshot. The AI
// itself never does face-matching or identity tracking.
const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Groq's free-tier model lineup changes fairly often — check
// https://console.groq.com/docs/models and update these env vars if a
// model gets retired, rather than editing code.
const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile';
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_TEXT_MODEL = process.env.MISTRAL_TEXT_MODEL || 'mistral-small-latest';
const MISTRAL_VISION_MODEL = process.env.MISTRAL_VISION_MODEL || 'pixtral-12b-2409';

const ZAI_API_KEY = process.env.ZAI_API_KEY;
const ZAI_TEXT_MODEL = process.env.ZAI_TEXT_MODEL || 'glm-4.5-flash';
const ZAI_VISION_MODEL = process.env.ZAI_VISION_MODEL || 'glm-4.5v';

// All three of these speak the same OpenAI-compatible chat-completions
// shape, so one generic caller covers all of them — only base URL / key /
// model differ. Gemini is handled separately below (different API shape).
const OPENAI_COMPAT_PROVIDERS = [
  { name: 'groq', apiKey: GROQ_API_KEY, baseUrl: 'https://api.groq.com/openai/v1/chat/completions', textModel: GROQ_TEXT_MODEL, visionModel: GROQ_VISION_MODEL },
  { name: 'mistral', apiKey: MISTRAL_API_KEY, baseUrl: 'https://api.mistral.ai/v1/chat/completions', textModel: MISTRAL_TEXT_MODEL, visionModel: MISTRAL_VISION_MODEL },
  { name: 'zai', apiKey: ZAI_API_KEY, baseUrl: 'https://api.z.ai/api/paas/v4/chat/completions', textModel: ZAI_TEXT_MODEL, visionModel: ZAI_VISION_MODEL }
];

async function openAiCompatChat(provider, body) {
  const res = await fetch(provider.baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `${provider.name} request failed (${res.status})`);
  return data;
}

// ---- Gemini — second free provider, used as a fallback when Groq is down
// or rate-limited (same idea as the Bonto/SnapDeploy backend failover). ----
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Check https://ai.google.dev/gemini-api/docs/models for current free-tier
// model names if this one ever gets retired/renamed.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

async function geminiGenerate(parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini request failed (${res.status})`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text (may have been blocked by safety filters).');
  return text;
}

function noAiProviderError() {
  return new Error('Server is missing an AI provider key — set at least one of GROQ_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY, ZAI_API_KEY.');
}

async function visionDescribeWithProvider(provider, prompt, image) {
  const data = await openAiCompatChat(provider, {
    model: provider.visionModel,
    temperature: 0.2,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
      ]
    }]
  });
  return data.choices[0].message.content;
}

/**
 * Describes one camera frame as {headcount, description}. Provider order:
 * Groq -> Gemini -> Mistral -> Z.AI, skipping any not configured and falling
 * through to the next on any failure (down/rate-limited/error). Only one
 * provider needs to be configured for this to work at all.
 */
async function describeSceneFrame(image) {
  const prompt = 'Look at this classroom/hallway camera frame. Reply with ONLY compact JSON, no other text: ' +
    '{"headcount": <integer, number of people visible>, "description": "<one short factual sentence about general activity/posture/objects visible, no names, no identity guesses>"}';

  const groq = OPENAI_COMPAT_PROVIDERS.find(p => p.name === 'groq');
  if (groq.apiKey) {
    try { return await visionDescribeWithProvider(groq, prompt, image); }
    catch (err) { console.error('Groq scene description failed, trying next provider:', err.message); }
  }
  if (GEMINI_API_KEY) {
    try {
      return await geminiGenerate([
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: image } }
      ]);
    } catch (err) { console.error('Gemini scene description failed, trying next provider:', err.message); }
  }
  for (const provider of OPENAI_COMPAT_PROVIDERS.filter(p => p.name !== 'groq')) {
    if (!provider.apiKey) continue;
    try { return await visionDescribeWithProvider(provider, prompt, image); }
    catch (err) { console.error(`${provider.name} scene description failed, trying next provider:`, err.message); }
  }
  throw noAiProviderError();
}

// Rolling scene log — text only (headcount + short description), never the
// raw image, so this stays cheap on memory and doesn't accumulate a photo
// archive. Kept for 24h per institution, capped so it can't grow unbounded.
const sceneLogs = []; // { institutionId, cameraName, headcount, description, timestamp }
const SCENE_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SCENE_LOG_MAX_ENTRIES = 2000;

function pruneSceneLogs() {
  const cutoff = Date.now() - SCENE_LOG_MAX_AGE_MS;
  while (sceneLogs.length && new Date(sceneLogs[0].timestamp).getTime() < cutoff) sceneLogs.shift();
  while (sceneLogs.length > SCENE_LOG_MAX_ENTRIES) sceneLogs.shift();
}

/**
 * POST /api/scene/log
 * body: { institutionId, cameraName, image (base64 jpeg, no data: prefix) }
 * Takes one frame, asks a vision model for a headcount + a short factual
 * description, and stores that TEXT (not the image) in the rolling log.
 * Call this every few minutes from the frontend — not every frame.
 */
app.post('/api/scene/log', aiLimiter, async (req, res) => {
  const { institutionId, cameraName, image } = req.body;
  if (!image) return res.status(400).json({ error: 'image (base64) is required.' });
  const anyAiConfigured = OPENAI_COMPAT_PROVIDERS.some(p => p.apiKey) || GEMINI_API_KEY;
  if (!anyAiConfigured) return res.status(500).json({ error: noAiProviderError().message });

  try {
    const rawText = await describeSceneFrame(image);
    let parsed = { headcount: null, description: 'Could not parse scene.' };
    try {
      const raw = rawText.trim().replace(/^```json|```$/g, '').trim();
      parsed = JSON.parse(raw);
    } catch (e) { /* keep fallback */ }

    const entry = {
      institutionId: institutionId || 'unknown',
      cameraName: cameraName || 'Unnamed Camera',
      headcount: parsed.headcount,
      description: parsed.description,
      timestamp: new Date().toISOString()
    };
    sceneLogs.push(entry);
    pruneSceneLogs();

    res.json({ logged: true, ...entry });
  } catch (err) {
    res.status(502).json({ error: 'Scene logging failed', detail: err.message });
  }
});

// ---- Tools the assistant can call. Group/pattern-level data only. ----
function toolGetSceneLogs({ institutionId, minutes }) {
  const cutoff = Date.now() - (minutes || 30) * 60 * 1000;
  return sceneLogs
    .filter(l => l.institutionId === institutionId && new Date(l.timestamp).getTime() >= cutoff)
    .map(({ cameraName, headcount, description, timestamp }) => ({ cameraName, headcount, description, timestamp }));
}

function toolGetAlerts({ institutionName, minutes }) {
  const cutoff = Date.now() - (minutes || 30) * 60 * 1000;
  return allAlerts
    .filter(a => a.institutionName === institutionName && new Date(a.timestamp).getTime() >= cutoff)
    .map(({ id, alertType, cameraName, confidence, timestamp, imageBase64 }) => ({ id, alertType, cameraName, confidence, timestamp, hasScreenshot: !!imageBase64 }));
}

// Given a list of alert IDs the assistant looked at, pull the actual proof
// screenshots for up to 3 of them (keeps the chat response light — the
// Administrator is asking a question, not requesting a full photo dump).
function getAlertScreenshots(alertIds) {
  if (!alertIds || alertIds.length === 0) return [];
  return allAlerts
    .filter(a => alertIds.includes(a.id) && a.imageBase64)
    .slice(0, 3)
    .map(a => ({ alertType: a.alertType, cameraName: a.cameraName, timestamp: a.timestamp, image: a.imageBase64 }));
}

// ============================================================
// PROACTIVE INVESTIGATION — runs on its own, unprompted
// ============================================================
// Periodically re-examines each institution's recent data looking for a
// genuinely non-obvious pattern (not routine single events) worth a
// Administrator's attention, even though nobody asked. This is the "discovers
// things its operator didn't explicitly ask about" behavior — but it only
// ever OBSERVES and reports; it never takes or proposes taking any action,
// and it never identifies individuals, same hard boundaries as the chat agent.
const PROACTIVE_INTERVAL_MS = 20 * 60 * 1000; // one pass every 20 minutes
const PROACTIVE_WINDOW_MINUTES = 60;          // looks at the last hour each pass
const insights = []; // { institutionId, summary, confidence, timestamp }
const INSIGHTS_MAX = 200;

function getActiveInstitutionIds() {
  const ids = new Set();
  sceneLogs.forEach(l => ids.add(l.institutionId));
  allAlerts.forEach(a => ids.add(a.institutionName));
  return Array.from(ids).filter(Boolean);
}

const PROACTIVE_SYSTEM_PROMPT = `You are Helicon 7 running a periodic, unprompted self-check over the last ${PROACTIVE_WINDOW_MINUTES} minutes of institutional monitoring data.
Look for a genuinely noteworthy pattern or anomaly an Administrator would want to know about even though nobody asked —
e.g. a recurring headcount dip around the same time, a cluster of alerts, or something that doesn't add up between
the alerts and the activity logs. Be conservative: most periods have NOTHING worth flagging — a single routine alert
or a normal headcount is not noteworthy. Only report a finding if it is a real, non-obvious pattern.
Hard boundaries: never identify individuals; only observe and optionally recommend that a human check something —
never claim or propose taking an action yourself.
Reply with ONLY compact JSON, no other text:
{"noteworthy": <true|false>, "summary": "<one or two sentences, only meaningful if noteworthy is true>", "confidence": "<low|medium|high>"}`;

async function runProactiveInvestigation(institutionId) {
  const sceneData = toolGetSceneLogs({ institutionId, minutes: PROACTIVE_WINDOW_MINUTES });
  const alertData = toolGetAlerts({ institutionName: institutionId, minutes: PROACTIVE_WINDOW_MINUTES });
  if (sceneData.length === 0 && alertData.length === 0) return; // nothing to investigate yet

  const prompt = `${PROACTIVE_SYSTEM_PROMPT}\n\nScene logs: ${JSON.stringify(sceneData)}\nAlerts: ${JSON.stringify(alertData)}`;
  let raw = null;

  try {
    const groq = OPENAI_COMPAT_PROVIDERS.find(p => p.name === 'groq');
    if (groq.apiKey) {
      const data = await openAiCompatChat(groq, { model: groq.textModel, temperature: 0.4, max_tokens: 200, messages: [{ role: 'user', content: prompt }] });
      raw = data.choices[0].message.content;
    } else if (GEMINI_API_KEY) {
      raw = await geminiGenerate([{ text: prompt }]);
    } else {
      for (const provider of OPENAI_COMPAT_PROVIDERS.filter(p => p.name !== 'groq')) {
        if (!provider.apiKey) continue;
        const data = await openAiCompatChat(provider, { model: provider.textModel, temperature: 0.4, max_tokens: 200, messages: [{ role: 'user', content: prompt }] });
        raw = data.choices[0].message.content;
        break;
      }
    }
  } catch (err) {
    console.error('Proactive investigation failed for', institutionId, err.message);
    return;
  }
  if (!raw) return;

  let parsed;
  try { parsed = JSON.parse(raw.trim().replace(/^```json|```$/g, '').trim()); }
  catch (e) { return; }

  if (parsed.noteworthy) {
    insights.push({
      institutionId,
      summary: parsed.summary,
      confidence: parsed.confidence || 'medium',
      timestamp: new Date().toISOString()
    });
    while (insights.length > INSIGHTS_MAX) insights.shift();
  }
}

async function proactiveInvestigationTick() {
  for (const id of getActiveInstitutionIds()) {
    await runProactiveInvestigation(id);
  }
  setTimeout(proactiveInvestigationTick, PROACTIVE_INTERVAL_MS);
}
setTimeout(proactiveInvestigationTick, PROACTIVE_INTERVAL_MS); // first pass after one interval, not on cold start

/**
 * GET /api/insights?institutionId=...&minutes=1440
 * Proactive findings Helicon 7 has surfaced on its own, most recent first.
 */
app.get('/api/insights', (req, res) => {
  const { institutionId, minutes } = req.query;
  const cutoff = Date.now() - (parseInt(minutes, 10) || 24 * 60) * 60 * 1000;
  const results = insights
    .filter(i => (!institutionId || i.institutionId === institutionId) && new Date(i.timestamp).getTime() >= cutoff)
    .slice(-20)
    .reverse();
  res.json({ insights: results });
});

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_scene_logs',
      description: 'Get logged headcounts and short activity descriptions over a recent time window. Use this for questions about what was happening, how many people were present, or whether the count changed (e.g. someone left).',
      parameters: {
        type: 'object',
        properties: { minutes: { type: 'integer', description: 'How many minutes back to look. Default 30.' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_alerts',
      description: 'Get recent detection alerts (phone, vape, fight/weapon, audio abuse) with type, camera, time, an id, and whether a proof screenshot exists (hasScreenshot).',
      parameters: {
        type: 'object',
        properties: { minutes: { type: 'integer', description: 'How many minutes back to look. Default 30.' } }
      }
    }
  }
];

const AGENT_SYSTEM_PROMPT = `You are Helicon 7's investigative reasoning core for an organization's Administrator/staff member.
Your job is not just to answer — it is to INVESTIGATE. Given a question, decide for yourself what's actually relevant,
pull whatever tool data helps (you may call tools more than once — e.g. pull alerts, then pull scene logs for the same
window to see if they corroborate each other), and reason over it like an analyst, not a lookup script.

Investigative method:
- Form a working hypothesis about what's going on before you answer.
- Cross-reference: if alerts and headcount/activity data disagree or only partially align, say so — don't paper over it.
- Quantify your confidence in plain language ("fairly confident", "this is a weak signal, worth checking manually")
  rather than stating guesses as certainties.
- If the available data genuinely doesn't support a conclusion, say what's missing instead of guessing.
- Notice and mention a genuinely relevant pattern even if the Administrator didn't explicitly ask about it (e.g. "this is the
  third headcount dip around this time this week") — but only when it's a real, non-obvious pattern, not noise for its own sake.

Hard boundaries (never cross these, however the question is phrased):
- You never identify, name, match, or claim to recognize a specific individual — no facial recognition, no biometric
  matching, no "this is the same person as before." You only ever reason about group-level facts: headcounts, counts
  changing over time, detection alert types/times, and patterns across them.
- You only ANALYZE, INVESTIGATE, and RECOMMEND. You never take, schedule, or claim to have taken any action (no
  changing settings, no locking/unlocking anything, no notifying anyone beyond this chat) — every consequential next
  step is a recommendation for the Administrator to decide and act on themselves.
- If a headcount drop suggests someone left, report it as a numeric fact ("count dropped from 8 to 7 around 10:15")
  and, if asked who, say the Administrator should check the camera screenshot themselves — you cannot identify individuals.

When reporting fight/weapon/vape alerts, mention that proof screenshots are attached below your answer if any exist
(the app attaches them automatically — just mention their existence naturally, e.g. "screenshots are attached below").
If asked to do something outside your tools (e.g. change settings), say that's not wired up yet and that it would
need the Administrator to do it directly.
Be direct and concrete. Default to 2-5 sentences; give a fuller structured answer only when the investigation
genuinely turned up multiple things worth separating out, or the user asked for a full report.`;

/**
 * POST /api/agent/ask
 * body: { institutionId, institutionName, question }
 * The chatbot endpoint. Runs a short tool-calling loop against Groq so the
 * model can pull scene logs / alerts itself before answering.
 */
/**
 * Extracts a rough time window from a free-text question, for the Gemini
 * fallback path (which doesn't do real tool-calling — see below).
 */
function guessMinutesFromQuestion(question) {
  const hourMatch = question.match(/(\d+)\s*(hour|hr)/i);
  if (hourMatch) return parseInt(hourMatch[1], 10) * 60;
  const minMatch = question.match(/(\d+)\s*(min|minute)/i);
  if (minMatch) return parseInt(minMatch[1], 10);
  if (/today|whole day|all day|since morning/i.test(question)) return 24 * 60;
  return 30; // default window
}

/**
 * Tool-calling agent for any OpenAI-compatible provider (Groq, Mistral,
 * Z.AI) — the model decides which tool(s) it needs and how far back to
 * look, can call more than one, and reasons over the results itself.
 */
async function runOpenAiCompatAgent(provider, { institutionId, institutionName, question }) {
  const messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: question }
  ];
  const seenAlertIds = [];

  let finalAnswer = null;
  for (let i = 0; i < 6 && finalAnswer === null; i++) { // up to 6 steps, so it can cross-reference tools (e.g. alerts, then scene logs for the same window) instead of answering off one lookup
    const data = await openAiCompatChat(provider, {
      model: provider.textModel,
      temperature: 0.3,
      max_tokens: 400,
      messages,
      tools: AGENT_TOOLS,
      tool_choice: 'auto'
    });
    const msg = data.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalAnswer = msg.content;
      break;
    }

    for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
      let result;
      if (call.function.name === 'get_scene_logs') {
        result = toolGetSceneLogs({ institutionId, minutes: args.minutes });
      } else if (call.function.name === 'get_alerts') {
        result = toolGetAlerts({ institutionName, minutes: args.minutes });
        result.forEach(a => { if (a.hasScreenshot) seenAlertIds.push(a.id); });
      } else {
        result = { error: 'Unknown tool' };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return {
    answer: finalAnswer || "Sorry, I couldn't work that out from the available data.",
    alertIds: seenAlertIds
  };
}

/**
 * Gemini path — simplified on purpose — instead of real tool-calling (which
 * would need a separate Gemini-specific function-calling schema), it guesses
 * the time window from the question text with guessMinutesFromQuestion(),
 * pre-fetches BOTH tools' data for that window, and hands it all to Gemini
 * as context to write the answer from. Slightly less precise than the
 * tool-calling providers, but keeps the assistant working during an outage.
 */
async function runGeminiAgent({ institutionId, institutionName, question }) {
  const minutes = guessMinutesFromQuestion(question);
  const sceneData = toolGetSceneLogs({ institutionId, minutes });
  const alertData = toolGetAlerts({ institutionName, minutes });
  const alertIds = alertData.filter(a => a.hasScreenshot).map(a => a.id);
  const prompt = `${AGENT_SYSTEM_PROMPT}

Scene logs, last ${minutes} minutes: ${JSON.stringify(sceneData)}
Detection alerts, last ${minutes} minutes: ${JSON.stringify(alertData)}

Administrator's question: ${question}`;
  const answer = await geminiGenerate([{ text: prompt }]);
  return { answer, alertIds };
}

/**
 * Free-form vision Q&A — used when the Administrator attaches a photo in the
 * Assistant chat (e.g. "how many chairs are in this picture?"). Runs a
 * single vision call (no tool-calling, no scene-log involved) against
 * whichever provider is configured, tried in order: Groq -> Gemini -> Mistral -> Z.AI.
 */
async function askVisionQuestion(question, image) {
  const prompt = `You are Helicon 7's assistant. Answer this question about the attached photo directly and concisely (a number if it's a counting question). Do not identify or describe any specific person. Question: ${question}`;

  const groq = OPENAI_COMPAT_PROVIDERS.find(p => p.name === 'groq');
  if (groq.apiKey) {
    try { return await visionDescribeWithProvider(groq, prompt, image); }
    catch (err) { console.error('Groq vision-QA failed, trying next provider:', err.message); }
  }
  if (GEMINI_API_KEY) {
    try {
      return await geminiGenerate([
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: image } }
      ]);
    } catch (err) { console.error('Gemini vision-QA failed, trying next provider:', err.message); }
  }
  for (const provider of OPENAI_COMPAT_PROVIDERS.filter(p => p.name !== 'groq')) {
    if (!provider.apiKey) continue;
    try { return await visionDescribeWithProvider(provider, prompt, image); }
    catch (err) { console.error(`${provider.name} vision-QA failed, trying next provider:`, err.message); }
  }
  throw noAiProviderError();
}

/**
 * POST /api/agent/ask
 * body: { institutionId, institutionName, question, image? }
 * The chatbot endpoint. If `image` (base64) is attached, this is a one-off
 * vision question about that photo (e.g. counting chairs) — no tool-calling,
 * no scene-log involved. Otherwise it's the normal log/alert Q&A agent.
 * Provider order: Groq -> Gemini -> Mistral -> Z.AI — each tried only if
 * configured, falling through to the next on any failure.
 */
app.post('/api/agent/ask', aiLimiter, async (req, res) => {
  const { institutionId, institutionName, question, image } = req.body;
  if (!question) return res.status(400).json({ error: 'question is required.' });
  if (question.length > 1000) return res.status(400).json({ error: 'Question is too long (max 1000 characters).' });

  const groq = OPENAI_COMPAT_PROVIDERS.find(p => p.name === 'groq');
  const anyConfigured = OPENAI_COMPAT_PROVIDERS.some(p => p.apiKey) || GEMINI_API_KEY;
  if (!anyConfigured) return res.status(500).json({ error: noAiProviderError().message });

  if (image) {
    try {
      const answer = await askVisionQuestion(question, image);
      return res.json({ answer });
    } catch (err) {
      return res.status(502).json({ error: 'Assistant request failed', detail: err.message });
    }
  }

  let result = null;
  let lastErr = null;

  if (groq.apiKey) {
    try { result = await runOpenAiCompatAgent(groq, { institutionId, institutionName, question }); }
    catch (err) { lastErr = err; console.error('Groq agent failed, trying next provider:', err.message); }
  }
  if (result === null && GEMINI_API_KEY) {
    try { result = await runGeminiAgent({ institutionId, institutionName, question }); }
    catch (err) { lastErr = err; console.error('Gemini agent failed, trying next provider:', err.message); }
  }
  if (result === null) {
    for (const provider of OPENAI_COMPAT_PROVIDERS.filter(p => p.name !== 'groq')) {
      if (!provider.apiKey) continue;
      try { result = await runOpenAiCompatAgent(provider, { institutionId, institutionName, question }); break; }
      catch (err) { lastErr = err; console.error(`${provider.name} agent failed, trying next provider:`, err.message); }
    }
  }

  if (result === null) {
    return res.status(502).json({ error: 'Assistant request failed', detail: lastErr?.message || 'All configured providers failed.' });
  }
  const images = getAlertScreenshots(result.alertIds);
  res.json({ answer: result.answer, images });
});

// ============================================================
// INSTITUTION SIGNUP + EMAIL APPROVAL WORKFLOW
// ============================================================
const institutions = {}; // { id, name, email, contact, phone, status, codes, approveToken, createdAt }

function generateCode(prefix) {
  return prefix.slice(0, 4).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
}

function generateToken() {
  return uuidv4().replace(/-/g, '');
}

/**
 * POST /api/institutions
 * body: { name, email, contact, phone }
 * Creates a pending institution request and emails the admin a link to
 * approve or decline — no chat app needed.
 */
app.post('/api/institutions', async (req, res) => {
  const { name, email, contact, phone } = req.body;
  if (!name || !email || !contact) {
    return res.status(400).json({ error: 'name, email and contact are required.' });
  }

  const id = uuidv4();
  const approveToken = generateToken();
  institutions[id] = {
    id, name, email, contact, phone,
    status: 'pending', codes: null, approveToken,
    createdAt: new Date().toISOString()
  };

  const base = baseUrlFromRequest(req);
  const approveLink = `${base}/api/institutions/${id}/approve?token=${approveToken}`;
  const declineLink = `${base}/api/institutions/${id}/decline?token=${approveToken}`;

  if (ADMIN_EMAIL) {
    const html = `
      <h2>🏫 New Institution Request</h2>
      <p><b>Name:</b> ${name}</p>
      <p><b>Contact:</b> ${contact}</p>
      <p><b>Email:</b> ${email}</p>
      <p><b>Phone:</b> ${phone || '—'}</p>
      <p style="margin-top:20px;">
        <a href="${approveLink}" style="background:#1E7A46; color:#fff; padding:10px 20px; text-decoration:none; border-radius:6px; margin-right:10px;">✅ Approve</a>
        <a href="${declineLink}" style="background:#C81E3A; color:#fff; padding:10px 20px; text-decoration:none; border-radius:6px;">✕ Decline</a>
      </p>
    `;
    await sendEmail({ to: ADMIN_EMAIL, subject: `New Helicon 7 Institution Request: ${name}`, html });
  }

  res.json({ id, status: 'pending' });
});

/**
 * GET /api/institutions/:id/approve  and  /decline
 * The admin clicks these links directly from the email — no dashboard login
 * needed. Approving auto-generates the three staff access codes.
 */
app.get('/api/institutions/:id/approve', (req, res) => {
  const inst = institutions[req.params.id];
  if (!inst) return res.status(404).send('<h2>Request not found.</h2>');
  if (req.query.token !== inst.approveToken) return res.status(403).send('<h2>Invalid or expired link.</h2>');

  inst.status = 'approved';
  inst.codes = {
    Administrator: generateCode('PRIN'),
    'Deputy Administrator': generateCode('VP'),
    'Monitoring Officer': generateCode('DISC')
  };

  res.send(`
    <html><body style="font-family:sans-serif; padding:40px; text-align:center;">
      <h2 style="color:#1E7A46;">✅ Approved: ${inst.name}</h2>
      <p>Staff access codes (share these privately with ${inst.contact}):</p>
      <p><b>Administrator:</b> ${inst.codes.Administrator}</p>
      <p><b>Deputy Administrator:</b> ${inst.codes['Deputy Administrator']}</p>
      <p><b>Monitoring Officer:</b> ${inst.codes['Monitoring Officer']}</p>
    </body></html>
  `);
});

app.get('/api/institutions/:id/decline', (req, res) => {
  const inst = institutions[req.params.id];
  if (!inst) return res.status(404).send('<h2>Request not found.</h2>');
  if (req.query.token !== inst.approveToken) return res.status(403).send('<h2>Invalid or expired link.</h2>');

  inst.status = 'declined';
  res.send(`<html><body style="font-family:sans-serif; padding:40px; text-align:center;"><h2 style="color:#C81E3A;">✕ Declined: ${inst.name}</h2></body></html>`);
});

/**
 * GET /api/institutions/:id/status
 * Frontend polls this so the "Pending Approval" screen updates automatically
 * once the admin clicks Approve/Decline in their email.
 */
app.get('/api/institutions/:id/status', (req, res) => {
  const inst = institutions[req.params.id];
  if (!inst) return res.status(404).json({ error: 'Not found' });
  res.json({ status: inst.status, codes: inst.status === 'approved' ? inst.codes : undefined });
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Helicon 7 RTSP backend listening on port ${PORT}`);
});
