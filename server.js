import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY  = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;
const ELEVEN_MODEL_ID = process.env.ELEVEN_MODEL_ID || "eleven_turbo_v2_5";
const VONAGE_RATE     = parseInt(process.env.VONAGE_RATE || "16000", 10);

// --- Healthcheck ---
app.get("/", (_req, res) => res.status(200).send("ok"));

// --- NCCO: talk -> connect(websocket) ---
app.get("/ncco", (req, res) => {
  const session = req.query.uuid || "no-session";
  res.json([
    { action: "talk", text: "Hej! Kopplar dig till AI-receptionisten.", language: "sv-SE" },
    {
      action: "connect",
      endpoint: [
        {
          type: "websocket",
          uri: `wss://${req.get("host")}/vonage-media?session=${encodeURIComponent(session)}`,
          "content-type": `audio/l16;rate=${VONAGE_RATE}`,
          headers: { "x-session": session }
        }
      ]
    }
  ]);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/vonage-media" });

// Helpers
const bufToB64 = (buf) => Buffer.from(buf).toString("base64");

// 20 ms tystnad @ VONAGE_RATE, 16-bit mono (little-endian)
const SILENCE_20MS = Buffer.alloc(Math.round(VONAGE_RATE * 2 * 0.02));

// Generera 1 sekund 440 Hz pip, skickat i 20 ms-chunks
async function playBeep(ws, sr = VONAGE_RATE, ms = 1000, freq = 440) {
  const samplesPerChunk = Math.round(sr * 0.02);
  const totalChunks = Math.ceil(ms / 20);
  let t = 0;
  for (let i = 0; i < totalChunks; i++) {
    const buf = Buffer.alloc(samplesPerChunk * 2);
    for (let n = 0; n < samplesPerChunk; n++) {
      const sample = Math.sin(2 * Math.PI * freq * (t / sr));
      const val = Math.max(-1, Math.min(1, sample)) * 6000; // låg volym
      buf.writeInt16LE(val | 0, n * 2);
      t++;
    }
    ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(buf) } }));
    await new Promise(r => setTimeout(r, 20));
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session") || req.headers["x-session"] || "no-session";
  console.log("📞 WS connected:", sessionId);

  // --- Keepalive (WS ping/pong) ---
  const keepAlive = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }, 25000);

  // Skicka tystnad var 40 ms tills vi får riktigt ljud
  let sendingSilence = true;
  const silenceTimer = setInterval(() => {
    if (sendingSilence && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(SILENCE_20MS) } }));
    }
  }, 40);

  // --- ❶ Testa ljudvägen: 1 sekund pip ---
  (async () => {
    try {
      await playBeep(ws);
      console.log("✅ Beep sent");
    } catch (e) {
      console.error("Beep error:", e);
    }
  })();

  // --- ❷ ElevenLabs Realtime WS (PCM 16 kHz) ---
  let ttsWS = null;
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    console.error("❌ Missing ELEVEN_* env vars");
  } else {
    const qs = new URLSearchParams({
      optimize_streaming_latency: "2",
      output_format: `pcm_${VONAGE_RATE}`,
      model_id: ELEVEN_MODEL_ID
    }).toString();

    const elevenUrl =
      `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream-input?${qs}`;

    ttsWS = new WebSocket(elevenUrl, { headers: { "xi-api-key": ELEVEN_API_KEY } });

    ttsWS.on("open", () => {
      console.log("🔊 ElevenLabs connected");
      // Vissa versioner kräver explicit start—vi skickar båda sätten för säkerhets skull
      try {
        ttsWS.send(JSON.stringify({
          event: "start_session",
          model_id: ELEVEN_MODEL_ID,
          voice_id: ELEVEN_VOICE_ID,
          output_format: `pcm_${VONAGE_RATE}`
        }));
      } catch {}

      // Testreplik (ska höras direkt efter pipet)
      ttsWS.send(JSON.stringify({
        text: "Hej! Nu borde du höra ElevenLabs rösten. Perfekt!",
        try_trigger_generation: true
      }));
    });

    // ElevenLabs → Vonage (binära PCM-chunks eller JSON med base64)
    ttsWS.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          sendingSilence = false;
          ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(data) } }));
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg?.audio) {
          sendingSilence = false;
          ws.send(JSON.stringify({ type: "media", media: { payload: msg.audio } }));
        }
      } catch {
        // non-JSON → ignorera
      }
    });

    ttsWS.on("error", (e) => console.error("ElevenLabs WS error:", e));
    ttsWS.on("close", () => console.warn("ElevenLabs closed; keeping call alive with silence"));
  }

  // Vonage → server (ping/hangup)
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    if (m.type === "stop" || m.type === "hangup") {
      try { ws.close(); } catch {}
    }
    // m.type === "media": här kopplar vi STT i nästa steg
  });

  const clean = () => {
    clearInterval(keepAlive);
    clearInterval(silenceTimer);
    try { ttsWS?.close(); } catch {}
  };
  ws.on("close", clean);
  ws.on("error", clean);
});

server.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
