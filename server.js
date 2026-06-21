require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 2e7,
  pingTimeout: 30000,
  pingInterval: 25000,
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let db = { conversations: {}, adminOnline: false };

if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (e) {
    console.error("Failed to parse db.json:", e.message);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("Database save failed:", e.message);
  }
}

function createCustomerId() {
  return "customer_" + Date.now() + "_" + Math.floor(Math.random() * 9999);
}

function ensureConversation(customerId) {
  if (!db.conversations[customerId]) {
    db.conversations[customerId] = {
      id: customerId,
      name: "Guest",
      email: "",
      unread: 0,
      messages: [],
      updatedAt: new Date().toISOString()
    };
    saveDb();
  }
  return db.conversations[customerId];
}

function getLightweightConversations() {
  const lightMap = {};
  for (const id in db.conversations) {
    const convo = db.conversations[id];
    lightMap[id] = {
      ...convo,
      messages: (convo.messages || []).map(msg => ({
        id: msg.id,
        sender: msg.sender,
        text: msg.text,
        image: msg.image ? "__HAS_IMAGE__" : null,
        read: msg.read,
        time: msg.time
      }))
    };
  }
  return lightMap;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });
  } catch (err) {
    console.log("Telegram alert error:", err.message);
  }
}

app.use(express.static("public"));

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/conversation/:customerId", (req, res) => {
  const customerId = req.params.customerId;
  const convo = db.conversations[customerId];
  if (!convo) return res.json({ messages: [] });
  res.json(convo);
});

io.on("connection", (socket) => {
  // FULL PROFILE DELETION HANDLER
  socket.on("delete-conversation", (customerId) => {
    if (db.conversations[customerId]) {
      delete db.conversations[customerId];
      saveDb();
      io.to("admin").emit("conversations", getLightweightConversations());
    }
  });

  socket.on("customer-start", ({ customerId }) => {
    const id = customerId || createCustomerId();
    socket.customerId = id;
    socket.join(id);
    const convo = ensureConversation(id);
    socket.emit("customer-ready", { customerId: id, conversation: convo, adminOnline: db.adminOnline });
    io.to("admin").emit("conversations", getLightweightConversations());
  });

  socket.on("customer-profile", ({ customerId, name, email }) => {
    if (!customerId) return;
    const convo = ensureConversation(customerId);
    convo.name = name || "Guest";
    convo.email = email || "";
    convo.updatedAt = new Date().toISOString();
    saveDb();
    io.to("admin").emit("conversations", getLightweightConversations());
  });

  socket.on("customer-message", async ({ customerId, text, image }) => {
    if (!customerId || (!text && !image)) return;
    const convo = ensureConversation(customerId);
    const message = { id: Date.now().toString(), sender: "customer", text: text ? String(text).trim() : "", image: image || null, read: false, time: new Date().toLocaleTimeString() };
    convo.messages.push(message);
    convo.unread += 1;
    convo.updatedAt = new Date().toISOString();
    saveDb();
    io.to("admin").emit("conversations", getLightweightConversations());
    io.to(customerId).emit("customer-message-received", { customerId, conversation: convo });
    let telegramAlert = `📩 New Bashapp Support Message\nName: ${convo.name}\nEmail: ${convo.email || "Not provided"}`;
    if (message.text) telegramAlert += `\nMessage: ${message.text}`;
    if (image) telegramAlert += `\n🖼️ [Contains attached image file]`;
    await sendTelegram(telegramAlert);
  });

  socket.on("admin-login", (password) => {
    if (password !== ADMIN_PASSWORD) {
      socket.emit("admin-login-failed");
      return;
    }
    socket.join("admin");
    db.adminOnline = true;
    saveDb();
    socket.emit("admin-login-success", getLightweightConversations());
    io.emit("admin-status", true);
  });

  socket.on("select-customer-thread", (customerId) => {
    if (!customerId || !db.conversations[customerId]) return;
    const rooms = Array.from(socket.rooms);
    rooms.forEach(r => { if (r !== socket.id && r !== "admin") socket.leave(r); });
    socket.join(customerId);
    socket.emit("thread-data", db.conversations[customerId]);
  });

  socket.on("admin-message", ({ customerId, text, image }) => {
    if (!customerId || (!text && !image)) return;
    const convo = ensureConversation(customerId);
    const message = { id: Date.now().toString(), sender: "support", text: text ? String(text).trim() : "", image: image || null, read: false, time: new Date().toLocaleTimeString() };
    convo.messages.push(message);
    saveDb();
    io.to(customerId).emit("support-message", message);
    io.to("admin").emit("conversations", getLightweightConversations());
  });

  socket.on("admin-logout", () => {
    db.adminOnline = false;
    saveDb();
    io.emit("admin-status", false);
  });
});

server.listen(PORT, () => {
  console.log(`Bashapp Support running safely on http://localhost:${PORT}`);
});
