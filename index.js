const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto
} = require("@fizzxydev/baileys-pro");
const express = require("express");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const https = require("https");

const responder = require("./autoresponder");
const buttonResponder = require("./buttonresponder");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(__dirname));

let sock = null;
let presenceInterval = null;
let heartbeatInterval = null;

const SESSION_ID = "session1";
const authDir = path.join(__dirname, "storage", `auth_info_${SESSION_ID}`);

let connectedAt = null;
function getUptime() {
  if (!connectedAt) return null;
  const ms = Date.now() - connectedAt;
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24;
  const d = Math.floor(ms / 86400000);
  return (
    (d > 0 ? d + "d " : "") +
    (h > 0 ? h + "h " : "") +
    (m > 0 ? m + "m " : "") +
    s + "s"
  );
}

if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}

process.on("uncaughtException", err => console.error("Uncaught Exception:", err));
process.on("unhandledRejection", reason => console.error("Unhandled Rejection:", reason));

async function initializeBot() {
  if (presenceInterval) clearInterval(presenceInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      keepAliveIntervalMs: 60_000,
    });

    // Handle incoming text messages
    sock.ev.on("messages.upsert", async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      const from = msg.key.remoteJid;
      let txt = "";
      if (msg.message.conversation) txt = msg.message.conversation.trim();
      else if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) txt = msg.message.extendedTextMessage.text.trim();
      else return;

      // --- BUTTON RESPONDER (case-insensitive) ---
      const { idx: btnIdx, entry: btnPair } = buttonResponder.findButtonInsensitive(txt);
      if (btnPair) {
        // Use Baileys button format (buttonsMessage, not newType)
        const buttons = btnPair.buttons.slice(0, 3).map((b, j) => ({
          buttonId: `btn_${btnIdx}_${j}`,
          buttonText: { displayText: b.label },
          type: 1
        }));

        const buttonMsg = {
          text: "Choose an option:",
          buttons,
          headerType: 1
        };
        await sock.sendMessage(from, buttonMsg, { quoted: msg });
        return;
      }

      // --- AUTO-RESPONDER (case-insensitive) ---
      const found = responder.findPairInsensitive(txt);
      if (found) {
        await sock.sendMessage(from, { text: found.answer }, { quoted: msg });
        return;
      }
    });

    // Handle button reply for ButtonResponder (case-insensitive)
    sock.ev.on("messages.upsert", async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      if (!msg.message.buttonsResponseMessage) return;
      const from = msg.key.remoteJid;
      const btnId = msg.message.buttonsResponseMessage.selectedButtonId;
      const m = btnId.match(/^btn_(\d+)_(\d+)$/);
      if (!m) return;
      const [ , pairIdx, btnIdx ] = m.map(Number);
      const buttonPairs = buttonResponder.loadButtons();
      const reply = buttonPairs?.[pairIdx]?.buttons?.[btnIdx]?.reply;
      if (reply) {
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
      }
    });

    // Presence update every 3 min
    presenceInterval = setInterval(() => sock.sendPresenceUpdate("available"), 3 * 60_000);

    // Heartbeat every 4 min
    heartbeatInterval = setInterval(async () => {
      try {
        await sock.onWhatsApp(`${sock.user.id}@s.whatsapp.net`);
      } catch (e) {
        sock.ws.close();
      }
    }, 4 * 60_000);

    // Connection updates
    sock.ev.on("connection.update", async update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrImage = await qrcode.toDataURL(qr);
        fs.writeFileSync("qr.txt", qrImage);
      }

      if (connection === "open") {
        await saveCreds();
        if (fs.existsSync("qr.txt")) fs.unlinkSync("qr.txt");
        if (!connectedAt) connectedAt = Date.now();
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (loggedOut) {
          fs.rmSync(authDir, { recursive: true, force: true });
          if (fs.existsSync("qr.txt")) fs.unlinkSync("qr.txt");
          connectedAt = null;
        }
        setTimeout(initializeBot, 5_000);
      }
    });

    sock.ev.on("creds.update", saveCreds);
  } catch (err) {
    setTimeout(initializeBot, 10_000);
  }
}

setInterval(() => {
  if (!sock?.user) {
    initializeBot();
  }
}, 60_000);

initializeBot();

// --- HTTP Endpoints ---

app.get("/ping", (req, res) => {
  if (!sock?.user) initializeBot();
  res.send("OK");
});

app.get("/qr", (req, res) => {
  res.send(fs.existsSync("qr.txt") ? fs.readFileSync("qr.txt", "utf-8") : "QR not available");
});

app.get("/status", (req, res) => {
  res.json({ connected: !!sock?.user, uptime: getUptime() });
});

app.post("/send-message", async (req, res) => {
  const { phoneNumber, message, apiKey } = req.body;
  if (apiKey !== "123456") return res.status(401).json({ status: false, message: "Unauthorized" });
  if (!sock?.user) return res.status(503).json({ status: false, message: "WhatsApp not connected" });
  if (!phoneNumber || !message) return res.status(400).json({ status: false, message: "Missing phone or message" });

  const cleaned = phoneNumber.replace(/\D/g, "");
  const jid = cleaned.includes("@s.whatsapp.net") ? cleaned : `${cleaned}@s.whatsapp.net`;

  try {
    await sock.sendMessage(jid, { text: message });
    res.json({ status: true, message: "Sent" });
  } catch (err) {
    res.status(500).json({ status: false, message: "Failed", error: err.toString() });
  }
});

app.post("/send-media", async (req, res) => {
  const { phoneNumber, mediaUrl, caption = "", mediaType, apiKey } = req.body;
  if (apiKey !== "123456") return res.status(401).json({ status: false, message: "Unauthorized" });
  if (!sock?.user) return res.status(503).json({ status: false, message: "WhatsApp not connected" });
  if (!phoneNumber || !mediaUrl) return res.status(400).json({ status: false, message: "Missing phone or mediaUrl" });

  let buffer;
  try {
    const resp = await axios.get(mediaUrl, { responseType: "arraybuffer", httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
    buffer = Buffer.from(resp.data, "binary");
  } catch (e) {
    return res.status(400).json({ status: false, message: "Download failed", error: e.toString() });
  }

  const msg = {
    image: mediaType === "image" ? { buffer, mimetype: "image/jpeg" } : undefined,
    video: mediaType === "video" ? { buffer, mimetype: "video/mp4" } : undefined,
    audio: mediaType === "audio" ? { buffer, mimetype: "audio/mpeg" } : undefined,
    document: !["image","video","audio"].includes(mediaType) ? { buffer, mimetype: "application/pdf", fileName: "file.pdf" } : undefined,
    caption
  };

  try {
    await sock.sendMessage(`${phoneNumber.replace(/\D/g,"")}@s.whatsapp.net`, msg);
    res.json({ status: true, message: "Media sent" });
  } catch (err) {
    res.status(500).json({ status: false, message: "Failed", error: err.toString() });
  }
});

// ---- AUTO RESPONDER ENDPOINTS ----
app.get('/autoresponder', (req, res) => {
  res.json(responder.loadPairs());
});
app.post('/autoresponder', (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ status: false, message: "Missing data" });
  responder.addPair(question.trim(), answer.trim());
  res.json({ status: true });
});
app.delete('/autoresponder/:index', (req, res) => {
  responder.removePair(Number(req.params.index));
  res.json({ status: true });
});
app.put('/autoresponder/:index', (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ status: false, message: "Missing data" });
  responder.updatePair(Number(req.params.index), question.trim(), answer.trim());
  res.json({ status: true });
});

// ---- BUTTON RESPONDER ENDPOINTS ----
app.get('/buttonresponder', (req, res) => {
  res.json(buttonResponder.loadButtons());
});
app.post('/buttonresponder', (req, res) => {
  const { question, buttons } = req.body;
  if (!question || !buttons || !Array.isArray(buttons) || buttons.length === 0)
    return res.status(400).json({ status: false, message: "Missing or invalid data" });
  buttonResponder.addButton(question.trim(), buttons.map(b => ({
    label: b.label.trim(),
    reply: b.reply.trim()
  })));
  res.json({ status: true });
});
app.delete('/buttonresponder/:index', (req, res) => {
  buttonResponder.removeButton(Number(req.params.index));
  res.json({ status: true });
});
app.put('/buttonresponder/:index', (req, res) => {
  const { question, buttons } = req.body;
  if (!question || !buttons || !Array.isArray(buttons) || buttons.length === 0)
    return res.status(400).json({ status: false, message: "Missing or invalid data" });
  buttonResponder.updateButton(Number(req.params.index), question.trim(), buttons.map(b => ({
    label: b.label.trim(),
    reply: b.reply.trim()
  })));
  res.json({ status: true });
});

function clearSession() {
  if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
  if (fs.existsSync("qr.txt")) fs.unlinkSync("qr.txt");
  sock = null;
  connectedAt = null;
}

app.get("/clear-session", (req, res) => {
  clearSession();
  res.json({ status: true, message: "Session cleared. Restart to scan QR again." });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));