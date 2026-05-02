global.crypto = require("crypto");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const express = require("express");
const { Pool } = require("pg");
const pino = require("pino");
const fs = require("fs");

const app = express();
app.use(express.json());

const CONFIG = {
  DATABASE_URL: process.env.DATABASE_URL,
  ADMIN_PHONE: process.env.ADMIN_PHONE || "212675823517",
  AUTH_DIR: process.env.AUTH_DIR || "/app/.baileys_auth",
};

const db = new Pool({ connectionString: CONFIG.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let sock = null;
let connectionState = "disconnected";
let pairingCode = null;

async function initBaileys() {
  if (!fs.existsSync(CONFIG.AUTH_DIR)) fs.mkdirSync(CONFIG.AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "120.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(CONFIG.ADMIN_PHONE);
        pairingCode = code;
        console.log("\n\n========================================");
        console.log("PAIRING CODE: " + code);
        console.log("========================================");
        console.log("WhatsApp -> Settings -> Linked Devices");
        console.log("-> Link a Device -> Link with phone number");
        console.log("========================================\n\n");
      } catch (e) {
        console.error("Pairing error:", e.message);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      connectionState = "disconnected";
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      setTimeout(initBaileys, 5000);
    }
    if (connection === "open") {
      connectionState = "connected";
      console.log("WhatsApp connected!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.includes("@g.us")) continue;
      try {
        await sock.sendMessage(msg.key.remoteJid, { text: "Hello from Stichai bot! Bot is working." });
      } catch (e) {
        console.error("Send error:", e.message);
      }
    }
  });
}

app.get("/health", (_, res) => {
  res.json({ status: "ok", version: "5.0", whatsapp: connectionState, pairingCode });
});

app.get("/", (_, res) => res.send("Stichai Bot v5.0"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Stichai Bot v5.0 on port " + PORT);
  initBaileys().catch(e => console.error("Baileys error:", e.message));
});
