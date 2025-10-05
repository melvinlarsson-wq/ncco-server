import express from "express";
import http from "http";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY  = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;
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
const SILENCE_20MS = Buffer.alloc(Math.round(VONAGE_RATE * 2 * 0.02));

// 1s pip @440 Hz i 20ms-chunks (för att verifiera ljudvägen)
async function playBeep(ws, sr = VONAGE_RATE, ms = 800, freq = 440) {
  const samplesPerChunk = Math.round(sr * 0.02);
  const totalChunks = Math.ceil(ms / 20);
  let t = 0;
  for (let i = 0; i < totalChunks; i++) {
    const buf = Buffer.alloc(samplesPerChunk * 2);
    for (let n = 0; n < samplesPerChunk; n++) {
      const sample = Math.sin(2 * Math.PI * freq * (t / sr));
      const val = Math.max(-1, Math.min(1, sample)) * 6000;
      buf.writeInt16LE(val | 0, n * 2);
      t++;
    }
    ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(buf) } }));
    await new Promise(r => setTimeout(r, 20));
  }
}

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session") || req.headers["x-session"] || "no-session";
  console.log("📞 WS connected:", sessionId);

  // WS keepalive
  const keepAlive = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }, 25000);

  // Skicka tystnad var 40 ms tills TTS strömmar
  let sendingSilence = true;
  const silenceTimer = setInterval(() => {
    if (sendingSilence && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(SILENCE_20MS) } }));
    }
  }, 40);

  // ❶ Pip först
  await playBeep(ws).catch(e => console.error("Beep error:", e));
  console.log("✅ Beep sent");

  // ❷ ElevenLabs HTTP stream (PCM)
  try {
    if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
      throw new Error("Missing ELEVEN_API_KEY or ELEVEN_VOICE_ID");
    }
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream?output_format=pcm_${VONAGE_RATE}`;
    const body = JSON.stringify({
      text: "Hej! Nu borde du höra ElevenLabs-rösten via HTTP-stream. Perfekt!",
      // kort text för snabb start
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "accept": "audio/x-pcm;bit=16;rate=" + VONAGE_RATE,
        "content-type": "application/json",
        "xi-api-key": ELEVEN_API_KEY
      },
      body
    });

    if (!res.ok || !res.body) {
      console.error("ElevenLabs HTTP stream failed", res.status, res.statusText);
    } else {
      sendingSilence = false;
      // Läs chunkar och skicka direkt till Vonage
      for await (const chunk of res.body) {
        ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(chunk) } }));
        // ingen 20ms-chunkning strikt nödvändig, men vi kan throttla lite:
        await new Promise(r => setTimeout(r, 10));
      }
      console.log("🟢 ElevenLabs HTTP stream done");
    }
  } catch (e) {
    console.error("ElevenLabs HTTP error:", e);
  }

  // Vonage ping/hangup
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    if (m.type === "stop" || m.type === "hangup") { try { ws.close(); } catch {} }
  });

  const clean = () => {
    clearInterval(keepAlive);
    clearInterval(silenceTimer);
  };
  ws.on("close", clean);
  ws.on("error", clean);
});

server.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
