// server.js  (ESM)
// Kräver: express (npm i express)

import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CONNECTOR_WS_URI = process.env.CONNECTOR_WS_URI; // t.ex. wss://elevenlabs-agent-ws-connector-1.onrender.com/media
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || "";
const CONTENT_TYPE = "audio/l16;rate=16000;channels=1"; // 16 kHz mono

// Healthcheck
app.get("/", (_req, res) => {
  res.type("text/plain").send("OK - NCCO server is running");
});

// (Valfritt) fånga Vonage event-callbacks
app.post("/event", (req, res) => {
  try { console.log("📟 Vonage event:", JSON.stringify(req.body)); } catch {}
  res.sendStatus(200);
});

// NCCO – använd denna som Answer URL i Vonage
function nccoPayload() {
  if (!CONNECTOR_WS_URI) {
    return null;
  }
  return [
    {
      action: "connect",
      endpoint: [
        {
          type: "websocket",
          uri: CONNECTOR_WS_URI,
          contentType: CONTENT_TYPE,
          headers: { agentId: ELEVENLABS_AGENT_ID }
        }
      ]
    }
  ];
}

// GET /ncco (rekommenderad)
app.get("/ncco", (_req, res) => {
  const ncco = nccoPayload();
  if (!ncco) return res.status(500).json({ error: "CONNECTOR_WS_URI is not set" });
  res.json(ncco);
});

// GET /answer (fallback – samma som /ncco)
app.get("/answer", (_req, res) => {
  const ncco = nccoPayload();
  if (!ncco) return res.status(500).json({ error: "CONNECTOR_WS_URI is not set" });
  res.json(ncco);
});

app.listen(PORT, () => {
  console.log(`✅ NCCO server listening on :${PORT}`);
  console.log(`   Using CONNECTOR_WS_URI = ${CONNECTOR_WS_URI || "(not set!)"}`);
});
