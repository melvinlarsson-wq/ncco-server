import express from "express";
import http from "http";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

const ELEVEN_API_KEY  = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;
const VONAGE_RATE     = parseInt(process.env.VONAGE_RATE || "16000", 10); // 16000 eller 24000

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

// 20 ms tystnad @ VONAGE_RATE, 16-bit mono (LE)
const SILENCE_20MS = Buffer.alloc(Math.round(VONAGE_RATE * 2 * 0.02));

// 1s pip @440 Hz i 20ms-chunks (verifierar att ljud->Vonage funkar)
async function playBeep(ws, sr = VONAGE_RATE, ms = 800, freq = 440) {
  const samplesPerChunk = Math.round(sr * 0.02);
  const totalChunks = Math.ceil(ms / 20);
  let t = 0;
  for (let i = 0; i < totalChunks; i++) {
    const buf = Buffer.alloc(samplesPerChunk * 2);
    for (let n = 0; n < samplesPerChunk; n++) {
      const s = Math.sin(2 * Math.PI * freq * (t / sr));
      const val = Math.max(-1, Math.min(1, s)) * 6000;
      buf.writeInt16LE(val | 0, n * 2);
      t++;
    }
    ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(buf) } }));
    await new Promise(r => setTimeout(r, 20));
  }
}

// ---- Audio utils ----
function swap16(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i += 2) { const b = out[i]; out[i] = out[i+1]; out[i+1] = b; }
  return out;
}
function rmsInt16LE(buf) {
  let sum = 0, n = buf.length / 2;
  for (let i = 0; i < buf.length; i += 2) { const v = buf.readInt16LE(i); sum += v * v; }
  return Math.sqrt(sum / Math.max(1, n)) / 32768;
}
function applyGain(frameLE, targetRms = 0.12, maxGain = 12) {
  // räkna RMS och räkna fram gain för att nå target
  const current = rmsInt16LE(frameLE);
  const gain = Math.max(1, Math.min(maxGain, targetRms / Math.max(current, 1e-6)));
  const out = Buffer.from(frameLE);
  for (let i = 0; i < out.length; i += 2) {
    let v = out.readInt16LE(i);
    v = Math.max(-32768, Math.min(32767, Math.round(v * gain)));
    out.writeInt16LE(v, i);
  }
  return { out, gain: Number(gain.toFixed(2)), current: Number(current.toFixed(4)) };
}

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session") || req.headers["x-session"] || "no-session";
  console.log("📞 WS connected:", sessionId);

  // WS keepalive
  const keepAlive = setInterval(() => { try { ws.send(JSON.stringify({ type: "ping" })); } catch {} }, 25000);

  // Skicka tystnad var 40 ms tills vi börjar spela riktig audio
  let sendingSilence = true;
  const silenceTimer = setInterval(() => {
    if (sendingSilence && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(SILENCE_20MS) } }));
    }
  }, 40);

  // ❶ Pip först
  await playBeep(ws).catch(e => console.error("Beep error:", e));
  console.log("✅ Beep sent");

  // ❷ ElevenLabs HTTP stream (PCM) -> 20ms frames, endian-auto + auto-gain
  try {
    if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) throw new Error("Missing ELEVEN_API_KEY or ELEVEN_VOICE_ID");

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream?output_format=pcm_${VONAGE_RATE}`;
    const body = JSON.stringify({ text: "Hej! Nu borde du höra ElevenLabs rösten via telefon." });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "accept": `audio/x-pcm;bit=16;rate=${VONAGE_RATE}`,
        "content-type": "application/json",
        "xi-api-key": ELEVEN_API_KEY
      },
      body
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      console.error("ElevenLabs HTTP stream failed", res.status, res.statusText, errText);
    } else {
      const FRAME_MS = 20;
      const FRAME_BYTES = Math.round(VONAGE_RATE * 2 * (FRAME_MS / 1000)); // 640@16k / 960@24k
      let carry = Buffer.alloc(0);
      let framesSent = 0;
      let first = true;
      let useSwap = false;
      let decided = false;

      for await (const chunk of res.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        carry = Buffer.concat([carry, buf]);

        if (first && carry.length >= 44 && carry.slice(0,4).toString() === "RIFF") {
          carry = carry.subarray(44); // om det råkar komma en WAV-header
        }
        first = false;

        while (carry.length >= FRAME_BYTES) {
          let frame = carry.subarray(0, FRAME_BYTES);
          carry = carry.subarray(FRAME_BYTES);

          // endian-detektering en gång
          if (!decided) {
            const rLE = rmsInt16LE(frame);
            const rBE = rmsInt16LE(swap16(frame));
            useSwap = rBE > rLE * 2 && rBE > 0.0005;
            decided = true;
            console.log(`🎛️ endian chosen: ${useSwap ? "BE->LE swap" : "LE"} (rLE=${rLE.toFixed(4)} rBE=${rBE.toFixed(4)})`);
          }
          if (useSwap) frame = swap16(frame);

          // auto-gain till tydlig nivå
          const { out, gain, current } = applyGain(frame, 0.18, 16); // lite högre target
          if (framesSent === 0) console.log(`🔊 first frame rms=${current} gain=${gain}x`);

          ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(out) } }));
          framesSent++;
          sendingSilence = false;
          await new Promise(r => setTimeout(r, FRAME_MS));
        }
      }

      if (carry.length > 0) {
        let pad = Buffer.alloc(FRAME_BYTES);
        carry.copy(pad);
        if (decided && useSwap) pad = swap16(pad);
        const { out } = applyGain(pad, 0.18, 16);
        ws.send(JSON.stringify({ type: "media", media: { payload: bufToB64(out) } }));
        framesSent++;
      }

      console.log(`🟢 ElevenLabs HTTP stream done (framesSent=${framesSent})`);
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

  const clean = () => { clearInterval(keepAlive); clearInterval(silenceTimer); };
  ws.on("close", clean);
  ws.on("error", clean);
});

server.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
