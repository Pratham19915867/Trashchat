const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

const PORT = Number(process.env.PORT || 3000);
const MESSAGE_TTL_SECONDS = clampInt(process.env.MESSAGE_TTL_SECONDS, 60, 86400, 600);
const MAX_UPLOAD_MB = clampInt(process.env.MAX_UPLOAD_MB, 1, 20, 8);
const MAX_ROOM_MEMBERS = clampInt(process.env.MAX_ROOM_MEMBERS, 2, 100, 30);
const UPLOAD_DIR = path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// This version is intentionally memory-based: uploaded files from a previous
// process are removed on startup so old attachments do not linger.
for (const file of fs.readdirSync(UPLOAD_DIR)) {
  if (file !== ".gitkeep") {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, file)); } catch {}
  }
}

app.disable("x-powered-by");
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOAD_DIR, {
  dotfiles: "deny",
  index: false,
  maxAge: "1h"
}));

const allowedMime = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf", "text/plain",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12).replace(/[^.\w-]/g, "");
    cb(null, crypto.randomBytes(18).toString("hex") + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (allowedMime.has(file.mimetype)) return cb(null, true);
    cb(new Error("File type not allowed. Upload an image, PDF, TXT, ZIP, DOCX or XLSX."));
  }
});

const rooms = new Map(); // roomCode -> { members: Map(socketId -> member), messages: [], expiresAt }
const socketInfo = new Map(); // socketId -> { roomCode, member }
const messageTimers = new Map(); // messageId -> timer

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
function cleanText(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}
function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function publicMember(member) {
  return { id: member.id, name: member.name, color: member.color };
}
function roomSnapshot(room) {
  return {
    members: [...room.members.values()].map(publicMember),
    messages: room.messages.map(m => ({ ...m, reactions: { ...m.reactions } })),
    expiresAt: room.expiresAt,
    messageTtlSeconds: MESSAGE_TTL_SECONDS
  };
}
function emitMembers(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit("members:update", [...room.members.values()].map(publicMember));
}
function removeFile(fileUrl) {
  if (!fileUrl || !fileUrl.startsWith("/uploads/")) return;
  const name = path.basename(fileUrl);
  fs.unlink(path.join(UPLOAD_DIR, name), () => {});
}
function removeMessage(code, messageId) {
  const room = rooms.get(code);
  if (!room) return;
  const index = room.messages.findIndex(m => m.id === messageId);
  if (index === -1) return;
  const [message] = room.messages.splice(index, 1);
  if (message.file) removeFile(message.file.url);
  messageTimers.delete(messageId);
  io.to(code).emit("message:deleted", { id: messageId });
}
function scheduleMessageExpiry(code, message) {
  const timer = setTimeout(() => removeMessage(code, message.id), MESSAGE_TTL_SECONDS * 1000);
  timer.unref?.();
  messageTimers.set(message.id, timer);
}
function getSocketRoom(socket) {
  const info = socketInfo.get(socket.id);
  if (!info) return null;
  const room = rooms.get(info.roomCode);
  if (!room) return null;
  return { ...info, room };
}
function leaveCurrentRoom(socket) {
  const info = socketInfo.get(socket.id);
  if (!info) return;
  const room = rooms.get(info.roomCode);
  socket.leave(info.roomCode);
  socketInfo.delete(socket.id);
  if (room) {
    room.members.delete(socket.id);
    if (room.members.size === 0) {
      for (const message of room.messages) {
        const timer = messageTimers.get(message.id);
        if (timer) clearTimeout(timer);
        messageTimers.delete(message.id);
        if (message.file) removeFile(message.file.url);
      }
      rooms.delete(info.roomCode);
    } else {
      emitMembers(info.roomCode);
      io.to(info.roomCode).emit("system:message", {
        id: crypto.randomUUID(), text: `${info.member.name} left the room`,
        createdAt: Date.now(), expiresAt: Date.now() + MESSAGE_TTL_SECONDS * 1000
      });
    }
  }
}
function addMessage(code, payload) {
  const room = rooms.get(code);
  if (!room) return null;
  const message = {
    id: crypto.randomUUID(),
    senderId: payload.senderId,
    senderName: payload.senderName,
    senderColor: payload.senderColor,
    text: payload.text || "",
    file: payload.file || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + MESSAGE_TTL_SECONDS * 1000,
    reactions: {}
  };
  room.messages.push(message);
  scheduleMessageExpiry(code, message);
  io.to(code).emit("message:new", message);
  return message;
}

app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, err => {
    if (err) {
      const tooLarge = err.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? `File is too large. Maximum size is ${MAX_UPLOAD_MB} MB.` : err.message
      });
    }
    if (!req.file) return res.status(400).json({ error: "Choose a file first." });
    const file = {
      name: path.basename(req.file.originalname).slice(0, 120),
      url: `/uploads/${req.file.filename}`,
      mime: req.file.mimetype,
      size: req.file.size
    };
    res.json({ file });
  });
});

io.on("connection", socket => {
  socket.on("room:create", (data = {}, callback = () => {}) => {
    leaveCurrentRoom(socket);
    const name = cleanText(data.name, 24) || "Guest";
    const code = makeCode();
    const member = { id: socket.id, name, color: colorFor(name) };
    const room = { members: new Map([[socket.id, member]]), messages: [], expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
    rooms.set(code, room);
    socket.join(code);
    socketInfo.set(socket.id, { roomCode: code, member });
    callback({ ok: true, code, snapshot: roomSnapshot(room) });
  });

  socket.on("room:join", (data = {}, callback = () => {}) => {
    leaveCurrentRoom(socket);
    const code = cleanText(data.code, 6).toUpperCase();
    const room = rooms.get(code);
    if (!room) return callback({ ok: false, error: "Room not found. Check the code or create a new room." });
    if (room.members.size >= MAX_ROOM_MEMBERS) return callback({ ok: false, error: "This room is full." });
    const name = cleanText(data.name, 24) || "Guest";
    const member = { id: socket.id, name, color: colorFor(name) };
    room.members.set(socket.id, member);
    socket.join(code);
    socketInfo.set(socket.id, { roomCode: code, member });
    callback({ ok: true, code, snapshot: roomSnapshot(room) });
    emitMembers(code);
    io.to(code).emit("system:message", {
      id: crypto.randomUUID(), text: `${name} joined the room`,
      createdAt: Date.now(), expiresAt: Date.now() + MESSAGE_TTL_SECONDS * 1000
    });
  });

  socket.on("message:send", (data = {}, callback = () => {}) => {
    const current = getSocketRoom(socket);
    if (!current) return callback({ ok: false, error: "Join a room first." });
    const text = cleanText(data.text, 2000);
    if (!text) return callback({ ok: false, error: "Write a message first." });
    if (current.room.messages.filter(m => m.senderId === socket.id && Date.now() - m.createdAt < 5000).length >= 8) {
      return callback({ ok: false, error: "Slow down a little before sending more messages." });
    }
    const message = addMessage(current.roomCode, {
      senderId: socket.id, senderName: current.member.name,
      senderColor: current.member.color, text
    });
    callback({ ok: Boolean(message) });
  });

  socket.on("file:share", (data = {}, callback = () => {}) => {
    const current = getSocketRoom(socket);
    if (!current) return callback({ ok: false, error: "Join a room first." });
    const file = data.file;
    if (!file || typeof file.url !== "string" || !file.url.startsWith("/uploads/")) {
      return callback({ ok: false, error: "Invalid attachment." });
    }
    const safeName = path.basename(String(file.name || "attachment")).slice(0, 120);
    const urlName = path.basename(file.url);
    const diskPath = path.join(UPLOAD_DIR, urlName);
    if (!fs.existsSync(diskPath)) return callback({ ok: false, error: "Attachment expired or not found." });
    const stat = fs.statSync(diskPath);
    if (stat.size > MAX_UPLOAD_MB * 1024 * 1024) return callback({ ok: false, error: "Attachment is too large." });
    const message = addMessage(current.roomCode, {
      senderId: socket.id, senderName: current.member.name,
      senderColor: current.member.color, text: "",
      file: { name: safeName, url: file.url, mime: String(file.mime || ""), size: stat.size }
    });
    callback({ ok: Boolean(message) });
  });

  socket.on("reaction:toggle", (data = {}, callback = () => {}) => {
    const current = getSocketRoom(socket);
    if (!current) return callback({ ok: false });
    const message = current.room.messages.find(m => m.id === data.messageId);
    const emoji = String(data.emoji || "");
    const allowed = new Set(["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"]);
    if (!message || !allowed.has(emoji)) return callback({ ok: false });
    message.reactions[emoji] ||= [];
    const ids = message.reactions[emoji];
    const index = ids.indexOf(socket.id);
    if (index >= 0) ids.splice(index, 1); else ids.push(socket.id);
    if (!ids.length) delete message.reactions[emoji];
    io.to(current.roomCode).emit("reaction:update", { messageId: message.id, reactions: message.reactions });
    callback({ ok: true });
  });

  socket.on("room:reset", (callback = () => {}) => {
    const current = getSocketRoom(socket);
    if (!current) return callback({ ok: false, error: "Join a room first." });
    for (const message of current.room.messages) {
      const timer = messageTimers.get(message.id);
      if (timer) clearTimeout(timer);
      messageTimers.delete(message.id);
      if (message.file) removeFile(message.file.url);
    }
    current.room.messages = [];
    io.to(current.roomCode).emit("room:cleared");
    callback({ ok: true });
  });

  socket.on("disconnect", () => leaveCurrentRoom(socket));
});

function colorFor(name) {
  const colors = ["#b8a1ff", "#7dd3fc", "#f9a8d4", "#86efac", "#fcd34d", "#c4b5fd"];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

// Remove stale empty rooms if an unusual disconnect path leaves one behind.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.expiresAt < now) {
      for (const message of room.messages) {
        const timer = messageTimers.get(message.id);
        if (timer) clearTimeout(timer);
        messageTimers.delete(message.id);
        if (message.file) removeFile(message.file.url);
      }
      for (const socketId of room.members.keys()) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.leave(code);
          socketInfo.delete(socketId);
          socket.emit("room:expired");
        }
      }
      rooms.delete(code);
    }
  }
}, 60_000).unref?.();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TempChat 2.0 running at http://localhost:${PORT}`);
  console.log(`Message lifetime: ${MESSAGE_TTL_SECONDS}s | Upload limit: ${MAX_UPLOAD_MB}MB`);
});
