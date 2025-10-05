import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;
const VONAGE_RATE = process.env.VONAGE_RATE || "16000";

// --- enkel healthcheck (bra för Render) ---
app.get("/", (_req, res) => res.status(200).send("ok"));

// --- NCCO: talk → connect (websocket) ---
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

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session") || req.headers["x-session"] || "no-session";
  console.log("📞 WS connected:", sessionId);

  // keepalive så Vonage inte lägger på
  const keepAlive = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }, 25000);

  // === ElevenLabs Realtime TTS ===
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    console.error("Missing ELEVEN_* env vars");
  }
  const elevenUrl =
    `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream-input?optimize_streaming_latency=2`;
  const ttsWS = new WebSocket(elevenUrl, { headers: { "xi-api-key": ELEVEN_API_KEY } });

  ttsWS.on("open", () => {
    console.log("🔊 ElevenLabs connected");
    // Skicka en hälsning för att bevisa att TTS → Vonage funkar
    ttsWS.send(JSON.stringify({
      text: "Hej! Nu hör du ElevenLabs rösten. Vi kopplar logiken strax.",
      try_trigger_generation: true
    }));
  });

  // ElevenLabs → Vonage (audio)
  ttsWS.on("message", (data, isBinary) => {
    // ElevenLabs kan skicka binär PCM eller JSON med base64
    if (isBinary) {
      ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(data) } }));
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.audio) {
          ws.send(JSON.stringify({ type: "media", media: { payload: msg.audio } }));
        }
      } catch {
        // ignorera icke-JSON
      }
    }
  });

  // Hantera Vonage ping/pong + stängning
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      if (m.type === "stop" || m.type === "hangup") { try { ws.close(); } catch {} }
    } catch {}
  });

  const clean = () => {
    clearInterval(keepAlive);
    try { ttsWS.close(); } catch {}
  };
  ws.on("close", clean);
  ws.on("error", clean);
  ttsWS.on("close", () => { try { ws.close(); } catch {} });
  ttsWS.on("error", (e) => console.error("ElevenLabs WS error:", e));
});

server.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
