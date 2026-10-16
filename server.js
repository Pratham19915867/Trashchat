
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MESSAGE_TTL_SECONDS = 600;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_SIZE = 8 * 1024 * 1024;

const rooms = new Map();
const uploadDir = path.join(__dirname, "uploads");

fs.mkdirSync(uploadDir, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 15);
    cb(null, crypto.randomUUID() + ext);
  }
});

const allowedExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".pdf", ".txt", ".zip", ".docx", ".xlsx"
]);

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.has(ext)) {
      return cb(new Error("This file type is not allowed."));
    }

    cb(null, true);
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    publicRooms: [...rooms.values()].filter(r => r.isPublic).length,
    uptime: Math.floor(process.uptime())
  });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, error => {
    if (error) {
      return res.status(400).json({
        error: error.code === "LIMIT_FILE_SIZE"
          ? "File must be 8 MB or smaller."
          : error.message
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Choose a file first." });
    }

    res.json({
      ok: true,
      file: {
        name: path.basename(req.file.originalname),
        url: "/uploads/" + encodeURIComponent(req.file.filename),
        size: req.file.size,
        mime: req.file.mimetype
      }
    });
  });
});

app.use("/uploads", express.static(uploadDir, {
  fallthrough: false,
  dotfiles: "deny",
  index: false
}));

function createRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let attempt = 0; attempt < 30; attempt++) {
    let code = "";

    for (let i = 0; i < 6; i++) {
      code += chars[crypto.randomInt(chars.length)];
    }

    if (!rooms.has(code)) return code;
  }

  throw new Error("Could not generate a room code. Try again.");
}

function cleanName(value) {
  if (typeof value !== "string") return "Guest";

  const name = value.trim().replace(/\s+/g, " ").slice(0, 24);
  return name || "Guest";
}

function makeSnapshot(room) {
  return {
    messageTtlSeconds: MESSAGE_TTL_SECONDS,
    isPublic: room.isPublic,
    members: [...room.members.values()].map(member => ({
      id: member.id,
      name: member.name,
      color: member.color
    })),
    messages: room.messages
  };
}

function publicRoomList() {
  return [...rooms.values()]
    .filter(room => room.isPublic)
    .map(room => ({
      code: room.code,
      members: room.members.size,
      createdAt: room.createdAt
    }))
    .sort((a, b) => b.members - a.members);
}

function broadcastPublicRooms() {
  io.emit("rooms:public:update", publicRoomList());
}

function getSocketRoom(socket) {
  if (!socket.data.roomCode) return null;
  return rooms.get(socket.data.roomCode) || null;
}

function getMember(room, socket) {
  return room?.members.get(socket.id) || null;
}

function broadcastMembers(code, room) {
  io.to(code).emit(
    "members:update",
    [...room.members.values()].map(member => ({
      id: member.id,
      name: member.name,
      color: member.color
    }))
  );
}

function stopTyping(socket, room, member) {
  if (!room || !member) return;

  socket.to(room.code).emit("typing:update", {
    id: socket.id,
    name: member.name,
    typing: false
  });
}

function removeMember(socket) {
  const code = socket.data.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  socket.data.roomCode = null;

  if (!room) {
    socket.leave(code);
    return;
  }

  const member = room.members.get(socket.id);

  if (member) stopTyping(socket, room, member);

  room.members.delete(socket.id);
  socket.leave(code);

  broadcastMembers(code, room);

  if (room.members.size === 0) {
    room.lastEmptyAt = Date.now();
  }

  if (room.isPublic) broadcastPublicRooms();
}

function enterRoom(socket, code, name, callback = () => {}) {
  const room = rooms.get(code);

  if (!room) {
    return callback({
      ok: false,
      error: "Room not found. Check the code or create a new room."
    });
  }

  removeMember(socket);

  const member = {
    id: socket.id,
    name: cleanName(name),
    color: "#" + crypto.randomBytes(3).toString("hex")
  };

  room.members.set(socket.id, member);
  room.lastEmptyAt = null;
  room.updatedAt = Date.now();

  socket.data.roomCode = code;
  socket.join(code);

  socket.to(code).emit("system:message", {
    text: `${member.name} joined the room.`
  });

  broadcastMembers(code, room);
  if (room.isPublic) broadcastPublicRooms();

  callback({
    ok: true,
    code,
    snapshot: makeSnapshot(room)
  });
}

function cleanExpiredMessages(room) {
  const cutoff = Date.now() - MESSAGE_TTL_SECONDS * 1000;

  room.messages = room.messages.filter(
    message => message.createdAt > cutoff
  );
}

io.on("connection", socket => {
  // Send the current public-room list to this client.
  socket.emit("rooms:public:update", publicRoomList());

  // Client can request a fresh list at any time.
  socket.on("rooms:public:list", (callback = () => {}) => {
    const list = publicRoomList();
    socket.emit("rooms:public:update", list);

    if (typeof callback === "function") {
      callback({ ok: true, rooms: list });
    }
  });

  // Typing indicator.
  socket.on("typing:update", (data = {}) => {
    const room = getSocketRoom(socket);
    const member = getMember(room, socket);

    if (!room || !member) return;

    socket.to(room.code).emit("typing:update", {
      id: socket.id,
      name: member.name,
      typing: data.typing === true
    });
  });

  // Create a room. Public is opt-in; rooms are private by default.
  socket.on("room:create", (data = {}, callback = () => {}) => {
    try {
      const code = createRoomCode();

      const room = {
        code,
        isPublic: data.isPublic === true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastEmptyAt: null,
        members: new Map(),
        messages: []
      };

      rooms.set(code, room);

      enterRoom(socket, code, data.name, result => {
        if (room.isPublic) broadcastPublicRooms();
        callback(result);
      });
    } catch (error) {
      callback({
        ok: false,
        error: error.message || "Could not create room."
      });
    }
  });

  // Join by code (works for both public and private rooms).
  socket.on("room:join", (data = {}, callback = () => {}) => {
    const code = String(data.code || "").trim().toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return callback({
        ok: false,
        error: "Enter a valid 6-character room code."
      });
    }

    enterRoom(socket, code, data.name, callback);
  });

  // Send a text message.
  socket.on("message:send", (data = {}, callback = () => {}) => {
    const room = getSocketRoom(socket);
    const member = getMember(room, socket);
    const text = typeof data.text === "string"
      ? data.text.trim()
      : "";

    if (!room || !member) {
      return callback({ ok: false, error: "Join a room first." });
    }

    if (!text || text.length > 2000) {
      return callback({
        ok: false,
        error: "Message must be 1–2000 characters."
      });
    }

    stopTyping(socket, room, member);
    cleanExpiredMessages(room);

    const message = {
      id: crypto.randomUUID(),
      senderId: socket.id,
      senderName: member.name,
      senderColor: member.color,
      text,
      createdAt: Date.now(),
      reactions: {}
    };

    room.messages.push(message);
    room.updatedAt = Date.now();

    io.to(room.code).emit("message:new", message);
    callback({ ok: true, id: message.id });
  });

  // Share an uploaded file.
  socket.on("file:share", (data = {}, callback = () => {}) => {
    const room = getSocketRoom(socket);
    const member = getMember(room, socket);
    const file = data.file;

    if (!room || !member) {
      return callback({ ok: false, error: "Join a room first." });
    }

    if (
      !file ||
      typeof file.url !== "string" ||
      !file.url.startsWith("/uploads/") ||
      typeof file.name !== "string"
    ) {
      return callback({
        ok: false,
        error: "Invalid file information."
      });
    }

    const message = {
      id: crypto.randomUUID(),
      senderId: socket.id,
      senderName: member.name,
      senderColor: member.color,
      text: "",
      file: {
        name: path.basename(file.name).slice(0, 200),
        url: file.url,
        size: Number(file.size) || 0,
        mime: String(file.mime || "application/octet-stream")
      },
      createdAt: Date.now(),
      reactions: {}
    };

    room.messages.push(message);
    room.updatedAt = Date.now();

    io.to(room.code).emit("message:new", message);
    callback({ ok: true, id: message.id });
  });

  // Toggle message reaction.
  socket.on("reaction:toggle", (data = {}, callback = () => {}) => {
    const room = getSocketRoom(socket);

    if (!room) {
      return callback({ ok: false, error: "Join a room first." });
    }

    const message = room.messages.find(
      item => item.id === data.messageId
    );

    const emoji = String(data.emoji || "");
    const allowed = [
      "👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"
    ];

    if (!message || !allowed.includes(emoji)) {
      return callback({ ok: false, error: "Invalid reaction." });
    }

    if (!message.reactions[emoji]) message.reactions[emoji] = [];

    const users = message.reactions[emoji];
    const index = users.indexOf(socket.id);

    if (index >= 0) users.splice(index, 1);
    else users.push(socket.id);

    if (users.length === 0) delete message.reactions[emoji];

    io.to(room.code).emit("reaction:update", {
      messageId: message.id,
      reactions: message.reactions
    });

    callback({ ok: true });
  });

  // Clear the room's messages.
  socket.on("room:reset", (callback = () => {}) => {
    const room = getSocketRoom(socket);

    if (!room) {
      return callback({ ok: false, error: "Join a room first." });
    }

    room.messages = [];
    room.updatedAt = Date.now();

    io.to(room.code).emit("room:cleared");
    callback({ ok: true });
  });

  socket.on("disconnect", () => {
    removeMember(socket);
  });
});

// Expire old messages and remove abandoned rooms.
setInterval(() => {
  const now = Date.now();
  let publicListChanged = false;

  for (const [code, room] of rooms) {
    cleanExpiredMessages(room);

    if (room.members.size === 0) {
      if (!room.lastEmptyAt) room.lastEmptyAt = now;

      if (now - room.lastEmptyAt > ROOM_TTL_MS) {
        rooms.delete(code);
        if (room.isPublic) publicListChanged = true;
      }
    }
  }

  if (publicListChanged) broadcastPublicRooms();
}, 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TempChat server listening on port ${PORT}`);
});
