import express from "express";
import http from "http";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY  = process.env.ELEVEN_API_KEY;   // krävs
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;  // krävs
const VONAGE_RATE     = parseInt(process.env.VONAGE_RATE || "24000", 10); // vi kör 24 kHz nu

app.use(express.json());

// Healthcheck + (valfritt) eventlogg
app.get("/", (_req, res) => res.status(200).send("ok"));
app.post("/event", (req, res) => { console.log("📟 Vonage event:", req.body); res.sendStatus(200); });

// NCCO: talk -> connect(websocket)
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
          "content-type": `audio/l16;rate=${VONAGE_RATE};channels=1`, // <-- channels=1
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

// 1s pip @440 Hz (20 ms-chunks)
async function playBeep(ws, sr = VONAGE_RATE, ms = 600, freq = 440) {
  const samplesPerChunk = Math.round(sr * 0.02);
  const totalChunks = Math.ceil(ms / 20);
  let t = 0;
  for (let i = 0; i < totalChunks; i++) {
    const buf = Buffer.alloc(samplesPerChunk * 2);
    for (let n = 0; n < samplesPerChunk; n++) {
      const s = Math.sin(2 * Math.PI * freq * (t / sr));
      const val = Math.max(-1, Math.min(1, s)) * 9000;
      buf.writeInt16LE(val | 0, n * 2);
      t++;
    }
    ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(buf) } }));
    await new Promise(r => setTimeout(r, 20));
  }
}

// RMS + gain
function rmsInt16LE(buf) {
  let sum = 0, n = buf.length / 2;
  for (let i = 0; i < buf.length; i += 2) { const v = buf.readInt16LE(i); sum += v * v; }
  return Math.sqrt(sum / Math.max(1, n)) / 32768;
}
function applyGain(frameLE, targetRms = 0.45, maxGain = 80) {
  const current = Math.max(1e-6, rmsInt16LE(frameLE));
  const gain = Math.max(1, Math.min(maxGain, targetRms / current));
  const out = Buffer.from(frameLE);
  for (let i = 0; i < out.length; i += 2) {
    let v = out.readInt16LE(i);
    v = Math.max(-32768, Math.min(32767, Math.round(v * gain)));
    out.writeInt16LE(v, i);
  }
  return out;
}

// MP3 → FFmpeg → PCM → 20ms-frames → Vonage
async function streamMp3ThroughFfmpegToVonage(ws, mp3Readable, rate) {
  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", "pipe:0",
    "-af", "volume=12",       // <-- extra boost redan i ffmpeg
    "-ac", "1",
    "-ar", String(rate),
    "-f", "s16le",
    "pipe:1"
  ]);

  ff.stderr.on("data", d => console.error("ffmpeg:", d.toString().trim()));
  ff.on("close", code => console.log("ffmpeg closed:", code));

  // pumpa MP3 in
  (async () => {
    const iterIn = mp3Readable[Symbol.asyncIterator]
      ? mp3Readable
      : mp3Readable?.getReader?.() && {
          async *[Symbol.asyncIterator]() {
            const reader = mp3Readable.getReader();
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                yield Buffer.from(value);
              }
            } finally { reader.releaseLock(); }
          }
        };
    for await (const chunk of iterIn) ff.stdin.write(chunk);
    ff.stdin.end();
  })().catch(e => console.error("ffmpeg stdin error:", e));

  // läs PCM och skicka i 20ms
  const FRAME_MS = 20;
  const FRAME_BYTES = Math.round(rate * 2 * (FRAME_MS / 1000)); // 960 @ 24k
  let carry = Buffer.alloc(0);
  let framesSent = 0;

  for await (const chunk of ff.stdout) {
    carry = Buffer.concat([carry, Buffer.from(chunk)]);
    while (carry.length >= FRAME_BYTES) {
      let frame = carry.subarray(0, FRAME_BYTES);
      carry = carry.subarray(FRAME_BYTES);
      frame = applyGain(frame, 0.45, 80);
      ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(frame) } }));
      framesSent++;
      await new Promise(r => setTimeout(r, FRAME_MS));
    }
  }
  if (carry.length > 0) {
    let pad = Buffer.alloc(FRAME_BYTES);
    carry.copy(pad);
    pad = applyGain(pad, 0.45, 80);
    ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(pad) } }));
    framesSent++;
  }
  console.log(`🟢 FFmpeg stream done (framesSent=${framesSent})`);
}

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session") || req.headers["x-session"] || "no-session";
  console.log("📞 WS connected:", sessionId);

  // WS keepalive + tystnad
  const keepAlive = setInterval(() => { try { ws.send(JSON.stringify({ type: "ping" })); } catch {} }, 25000);
  let sendingSilence = true;
  const silenceTimer = setInterval(() => {
    if (sendingSilence && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(SILENCE_20MS) } }));
    }
  }, 40);

  // pip
  await playBeep(ws).catch(e => console.error("Beep error:", e));
  console.log("✅ Beep sent");

  // ElevenLabs → MP3 → FFmpeg → PCM
  try {
    if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) throw new Error("Missing ELEVEN_API_KEY or ELEVEN_VOICE_ID");

    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream?optimize_streaming_latency=2`;
    const res = await fetch(ttsUrl, {
      method: "POST",
      headers: {
        "accept": "audio/mpeg",
        "content-type": "application/json",
        "xi-api-key": ELEVEN_API_KEY
      },
      body: JSON.stringify({
        text: "Hej! Nu ska du höra ElevenLabs-rösten klart och tydligt.",
      })
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      console.error("ElevenLabs MP3 stream failed", res.status, res.statusText, errText);
    } else {
      sendingSilence = false;
      await streamMp3ThroughFfmpegToVonage(ws, res.body, VONAGE_RATE);
    }
  } catch (e) {
    console.error("ElevenLabs error:", e);
  }

  // Vonage ping/hangup
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    if (m.type === "stop" || m.type === "hangup") { try { ws.close(); } catch {} }
  });

  const clean = () => { clearInterval(keepAlive); clearInterval(silenceTimer); };
  ws.on("close", clean);
  ws.on("error", clean);
});

server.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
