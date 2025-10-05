import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 10000;

// NCCO som Vonage hämtar när någon ringer
app.get("/ncco", (req, res) => {
  const session = req.query.uuid || "no-session";
  const ncco = [
    { action: "talk", text: "Hej! Kopplar dig till AI-receptionisten.", language: "sv-SE" },
    {
      action: "connect",
      endpoint: [
        {
          type: "websocket",
          uri: `wss://${req.get("host")}/vonage-media?session=${encodeURIComponent(session)}`,
          "content-type": "audio/l16;rate=16000",
          headers: { "x-session": session }
        }
      ]
    }
  ];
  res.json(ncco);
});

const server = http.createServer(app);

// WebSocket som tar emot/returnerar Vonage audio (JSON + base64)
const wss = new WebSocketServer({ server, path: "/vonage-media" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("session") || req.headers["x-session"] || "no-session";
  console.log("📞 WS connected:", sessionId);

  // Keepalive så Vonage inte lägger på
  const keepAlive = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }, 25000);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "media":
        // EKO: skicka tillbaka samma audio (bevis på att stream funkar)
        ws.send(JSON.stringify({ type: "media", media: { payload: msg.media.payload } }));
        break;
      case "stop":
      case "hangup":
        try { ws.close(); } catch {}
        break;
    }
  });

  ws.on("close", () => { clearInterval(keepAlive); console.log("🔚 WS closed:", sessionId); });
  ws.on("error", (e) => console.error("WS error:", e));
});

server.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
