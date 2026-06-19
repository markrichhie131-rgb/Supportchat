require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);

// Optimizing buffers for heavy Base64 media assets
const io = new Server(server, {
  maxHttpBufferSize: 2e7, // 20MB limit
  pingTimeout: 30000,
  pingInterval: 25000,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
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
    console.log("Database successfully loaded into memory.");
  } catch (e) {
    console.error("Failed to parse db.json, starting fresh:", e.message);
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

// Generates a lightweight map for the admin dashboard list sidebar to prevent network memory freezes
function getLightweightConversations() {
  const lightMap = {};
  for (const id in db.conversations) {
    const convo = db.conversations[id];
    const messagesLight = (convo.messages || []).map(msg => ({
      id: msg.id,
      sender: msg.sender,
      text: msg.text,
      image: msg.image ? "__HAS_IMAGE__" : null, // Strip high payload strings out of lists
      read: msg.read,
      time: msg.time
    }));

    lightMap[id] = {
      ...convo,
      messages: messagesLight
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

app.get("/conversation/:customerId", (req, res) => {
  const customerId = req.params.customerId;
  const convo = db.conversations[customerId];
  if (!convo) return res.json({ messages: [] });
  res.json(convo);
});

io.on("connection", (socket) => {
  console.log("Socket connection established:", socket.id);

  socket.on("customer-start", ({ customerId }) => {
    const id = customerId || createCustomerId();
    socket.customerId = id;
    socket.join(id);

    const convo = ensureConversation(id);

    socket.emit("customer-ready", {
      customerId: id,
      conversation: convo,
      adminOnline: db.adminOnline
    });

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
    if (!customerId) return;
    if (!text && !image) return;

    const cleanText = text ? String(text).trim() : "";
    const convo = ensureConversation(customerId);

    const message = {
      id: Date.now().toString(),
      sender: "customer",
      text: cleanText,
      image: image || null,
      read: false,
      time: new Date().toLocaleTimeString()
    };

    convo.messages.push(message);
    convo.unread += 1;
    convo.updatedAt = new Date().toISOString();
    saveDb();

    // FIXED: Emits to global admin summary list AND pushes real-time payload updates cleanly down the exact customer ID data line
    io.to("admin").emit("conversations", getLightweightConversations());
    io.to(customerId).emit("customer-message-received", {
      customerId,
      conversation: convo
    });

    let telegramAlert = `📩 New Bashapp Support Message\n\nName: ${convo.name}\nEmail: ${convo.email || "Not provided"}`;
    if (cleanText) telegramAlert += `\nMessage: ${cleanText}`;
    if (image) telegramAlert += `\n🖼️ [Contains attached image file]`;

    await sendTelegram(telegramAlert);
  });

  socket.on("customer-typing", ({ customerId, isTyping }) => {
    io.to("admin").emit("customer-typing-status", { customerId, isTyping });
  });

  socket.on("admin-typing", ({ customerId, isTyping }) => {
    io.to(customerId).emit("admin-typing-status", isTyping);
  });

  socket.on("mark-read", (customerId) => {
    if (!customerId || !db.conversations[customerId]) return;

    db.conversations[customerId].unread = 0;
    db.conversations[customerId].messages.forEach(msg => {
      if (msg.sender === "customer") msg.read = true;
    });
    saveDb();

    io.to(customerId).emit("messages-marked-read");
    io.to("admin").emit("conversations", getLightweightConversations());
  });

  socket.on("customer-read-receipt", ({ customerId }) => {
    if (!customerId || !db.conversations[customerId]) return;
    db.conversations[customerId].messages.forEach(msg => {
      if (msg.sender === "support") msg.read = true;
    });
    saveDb();
    io.to("admin").emit("conversations", getLightweightConversations());
  });

  // ADMIN LOGIN CHANNEL WITH ROBUST EXPLICIT LOGGING
  socket.on("admin-login", (password) => {
    console.log("Admin login attempt processing...");
    if (!ADMIN_PASSWORD) {
      console.error("CRITICAL error: ADMIN_PASSWORD variable is empty inside your .env configuration!");
    }
    
    if (password !== ADMIN_PASSWORD) {
      console.warn("Unauthorized admin verification handshake rejected.");
      socket.emit("admin-login-failed");
      return;
    }

    console.log("Admin authentication successful. Joining pipeline context.");
    socket.join("admin");
    db.adminOnline = true;
    saveDb();

    socket.emit("admin-login-success", getLightweightConversations());
    io.emit("admin-status", true);
  });

  // Admin explicit room target request for complete conversation loading maps
  socket.on("select-customer-thread", (customerId) => {
    if (!customerId || !db.conversations[customerId]) return;
    
    // Clean escape route out of previous custom threads to avoid trailing listener leak anomalies
    const rooms = Array.from(socket.rooms);
    rooms.forEach(r => { if (r !== socket.id && r !== "admin") socket.leave(r); });
    
    // FIXED: Admin joins the matching customerId room stream channel directly
    socket.join(customerId);
    socket.emit("thread-data", db.conversations[customerId]);
  });

  socket.on("admin-message", ({ customerId, text, image }) => {
    if (!customerId) return;
    if (!text && !image) return;

    const cleanText = text ? String(text).trim() : "";
    const convo = ensureConversation(customerId);

    const message = {
      id: Date.now().toString(),
      sender: "support",
      text: cleanText,
      image: image || null,
      read: false,
      time: new Date().toLocaleTimeString()
    };

    convo.messages.push(message);
    convo.updatedAt = new Date().toISOString();
    saveDb();

    // FIXED: Uniformly dispatches data states out across shared target channels
    io.to(customerId).emit("support-message", message);
    io.to("admin").emit("conversations", getLightweightConversations());
    io.to(customerId).emit("admin-message-sent", {
      customerId,
      conversation: convo
    });
  });

  socket.on("admin-logout", () => {
    db.adminOnline = false;
    saveDb();
    io.emit("admin-status", false);
  });

  socket.on("disconnect", () => {
    console.log("Closed data line channel connector execution path:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Bashapp Support running safely on http://localhost:${PORT}`);
});
