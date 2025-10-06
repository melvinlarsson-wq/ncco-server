// server.js  (ESM – se till att package.json har: { "type": "module" })
import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CONNECTOR_WS_URI = process.env.CONNECTOR_WS_URI;              // wss://elevenlabs-agent-ws-connector-1.onrender.com/media
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || "";  // t.ex. agent_8801k2ypbd8ae41acdw590tc5mgy

// Healthcheck
app.get("/", (_req, res) => res.type("text/plain").send("OK - NCCO server is running"));

// Vonage events (valfritt)
app.post("/event", (req, res) => {
  try { console.log("📟 Vonage event:", JSON.stringify(req.body)); } catch {}
  res.sendStatus(200);
});

// *** VIKTIGT: NCCO som Vonage hämtar ***
app.get("/ncco", (_req, res) => {
  if (!CONNECTOR_WS_URI) return res.status(500).json({ error: "CONNECTOR_WS_URI is not set" });
  res.json([
    {
      action: "connect",
      endpoint: [
        {
          type: "websocket",
          uri: CONNECTOR_WS_URI,
          "content-type": "audio/l16;rate=16000",
          headers: { agentId: ELEVENLABS_AGENT_ID }
        }
      ]
    }
  ]);
});

// (alt. route om du vill använda /answer)
app.get("/answer", (_req, res) => {
  if (!CONNECTOR_WS_URI) return res.status(500).json({ error: "CONNECTOR_WS_URI is not set" });
  res.json([
    {
      action: "connect",
      endpoint: [
        {
          type: "websocket",
          uri: CONNECTOR_WS_URI,
          "content-type": "audio/l16;rate=16000",
          headers: { agentId: ELEVENLABS_AGENT_ID }
        }
      ]
    }
  ]);
});

app.listen(PORT, () => {
  console.log(`✅ NCCO server listening on :${PORT}`);
  console.log(`   CONNECTOR_WS_URI      = ${CONNECTOR_WS_URI}`);
  console.log(`   ELEVENLABS_AGENT_ID   = ${ELEVENLABS_AGENT_ID ? "[set]" : "(empty!)"}`);
});
