import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;
const ELEVEN_MODEL_ID = process.env.ELEVEN_MODEL_ID || "eleven_turbo_v2_5";
const VONAGE_RATE = parseInt(process.env.VONAGE_RATE || "16000", 10);

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

const bufToB64 = (buf) => Buffer.from(buf).toString("base64");

// 20 ms tystnad @ VONAGE_RATE, 16-bit mono
const SILENCE_20MS = Buffer.alloc(Math.round(VONAGE_RATE * 2 * 0.02));

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session") || req.headers["x-session"] || "no-session";
  console.log("📞 WS connected:", sessionId);

  // --- Keepalive (WS ping/pong) ---
  const keepAlive = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }, 25000);

  // --- ElevenLabs Realtime WS ---
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    console.error("❌ Missing ELEVEN_* env vars"); // fortsätter ändå så vi ser fel tidigt
  }
  const elevenUrl =
    `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream-input?optimize_streaming_latency=2`;

  const ttsWS = new WebSocket(elevenUrl, { headers: { "xi-api-key": ELEVEN_API_KEY } });

  // Skicka tystnad tills TTS levererar ljud (hindrar Vonage timeouts)
  let sendSilence = true;
  const silenceTimer = setInterval(() => {
    if (sendSilence && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(SILENCE_20MS) } }));
    }
  }, 40); // var ~40ms

  ttsWS.on("open", () => {
    console.log("🔊 ElevenLabs connected");
    // Viktigt: initiera sessionen med PCM-16000
    ttsWS.send(JSON.stringify({
      event: "start_session",
      model_id: ELEVEN_MODEL_ID,
      voice_id: ELEVEN_VOICE_ID,
      output_format: "pcm_16000" // matchar Vonage rate 16000
    }));
    // Testreplik så vi direkt hör rösten
    ttsWS.send(JSON.stringify({
      text: "Hej! Nu hör du ElevenLabs-rösten. Säg något om du hör mig.",
      try_trigger_generation: true
    }));
  });

  // ElevenLabs -> Vonage (audio frames)
  ttsWS.on("message", (data, isBinary) => {
    try {
      if (isBinary) {
        sendSilence = false;
        ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(data) } }));
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg?.audio) {
        sendSilence = false;
        ws.send(JSON.stringify({ type: "media", media: { payload: msg.audio } }));
      }
    } catch (e) {
      // icke-JSON eller annat – ignorera
    }
  });

  // Vonage -> server (ping, hangup, ev. media från användaren)
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    if (m.type === "stop" || m.type === "hangup") {
      try { ws.close(); } catch {}
    }
    // m.type === "media": här kan vi i nästa steg skicka till STT
  });

  const clean = () => {
    clearInterval(keepAlive);
    clearInterval(silenceTimer);
    try { ttsWS.close(); } catch {}
  };
  ws.on("close", clean);
  ws.on("error", clean);
  ttsWS.on("close", () => { try { ws.close(); } catch {} });
  ttsWS.on("error", (e) => console.error("ElevenLabs WS error:", e));
});

server.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
