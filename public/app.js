(() => {
  const socket = io();
  const $ = id => document.getElementById(id);

  const ui = {
    lobby: $("lobby"),
    chat: $("chat"),
    createName: $("createName"),
    joinName: $("joinName"),
    roomCode: $("roomCode"),
    createBtn: $("createBtn"),
    joinBtn: $("joinBtn"),
    lobbyError: $("lobbyError"),
    connectionLabel: $("connectionLabel"),
    activeRoomCode: $("activeRoomCode"),
    copyCodeBtn: $("copyCodeBtn"),
    copyInviteBtn: $("copyInviteBtn"),
    backBtn: $("backBtn"),
    memberCount: $("memberCount"),
    membersList: $("membersList"),
    headerMembers: $("headerMembers"),
    ttlLabel: $("ttlLabel"),
    messages: $("messages"),
    messageForm: $("messageForm"),
    messageInput: $("messageInput"),
    fileInput: $("fileInput"),
    attachBtn: $("attachBtn"),
    uploadPreview: $("uploadPreview"),
    chatError: $("chatError"),
    resetBtn: $("resetBtn"),
    mobileMembersBtn: $("mobileMembersBtn"),
    toast: $("toast")
  };

  const reactions = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"];
  const themes = [
    "midnight", "aurora", "ocean", "sakura", "desert",
    "dark", "mono", "graphite", "ice", "ember"
  ];

  let currentCode = null;
  let toastTimer = null;
  let typingTimer = null;
  let isTyping = false;
  let audioContext = null;
  const typingUsers = new Map();

  // Small UI additions/styles are created here so index.html does not need edits.
  const enhancementStyles = document.createElement("style");
  enhancementStyles.textContent = `
    #tempchatTyping { min-height: 18px; padding: 2px 14px 6px; color: var(--muted, #9ca3af); font-size: 12px; }
    #tempchatTyping .typing-dots { display:inline-flex; gap:3px; margin-left:5px; vertical-align:middle; }
    #tempchatTyping .typing-dots i { width:4px; height:4px; border-radius:50%; background:currentColor; animation:tcTypingDot 1s infinite ease-in-out; }
    #tempchatTyping .typing-dots i:nth-child(2) { animation-delay:.15s; }
    #tempchatTyping .typing-dots i:nth-child(3) { animation-delay:.3s; }
    .message-row, .system-message { animation:tcMessageIn .22s ease-out both; }
    .message-row.tc-new-message { animation:tcMessageIn .26s cubic-bezier(.2,.8,.2,1) both; }
    @keyframes tcTypingDot { 0%,60%,100% { transform:translateY(0); opacity:.45 } 30% { transform:translateY(-3px); opacity:1 } }
    @keyframes tcMessageIn { from { opacity:0; transform:translateY(8px) scale(.99) } to { opacity:1; transform:translateY(0) scale(1) } }
    @media (prefers-reduced-motion: reduce) { .message-row, .system-message, #tempchatTyping .typing-dots i { animation:none !important; } }
  `;
  document.head.appendChild(enhancementStyles);

  const typingIndicator = document.createElement("div");
  typingIndicator.id = "tempchatTyping";
  typingIndicator.setAttribute("aria-live", "polite");
  typingIndicator.hidden = true;
  if (ui.messageForm?.parentNode) ui.messageForm.parentNode.insertBefore(typingIndicator, ui.messageForm);

  function playSound(kind = "message") {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      audioContext ||= new AudioCtx();
      if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
      const presets = {
        room: [[660, 0], [880, 0.09]],
        sent: [[620, 0]],
        received: [[740, 0]],
        system: [[520, 0], [660, 0.08]]
      };
      (presets[kind] || presets.received).forEach(([frequency, delay]) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, audioContext.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.07, audioContext.currentTime + delay + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + delay + 0.12);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(audioContext.currentTime + delay);
        oscillator.stop(audioContext.currentTime + delay + 0.13);
      });
    } catch (_) { /* Audio is optional; chat must keep working if blocked. */ }
  }

  function sendTypingState(typing) {
    if (!currentCode || isTyping === typing) return;
    isTyping = typing;
    // The server must relay this event to other sockets in the current room.
    socket.emit("typing:update", { typing });
  }

  function renderTypingUsers() {
    const names = [...typingUsers.values()];
    if (!names.length) {
      typingIndicator.hidden = true;
      typingIndicator.textContent = "";
      return;
    }
    typingIndicator.hidden = false;
    const label = names.length === 1 ? `${names[0]} is typing` : names.length === 2
      ? `${names[0]} and ${names[1]} are typing`
      : `${names.length} people are typing`;
    typingIndicator.replaceChildren(document.createTextNode(label));
    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("i"));
    typingIndicator.appendChild(dots);
  }

  // Keep the latest message visible as the message list grows or images load.
  const messageResizeObserver = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => {})
    : null;
  messageResizeObserver?.observe(ui.messages);

  socket.on("connect", () => {
    ui.connectionLabel.textContent = "Connected";
  });

  socket.on("disconnect", () => {
    ui.connectionLabel.textContent = "Reconnecting…";
  });

  socket.on("connect_error", () => {
    ui.connectionLabel.textContent = "Connection issue";
  });

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 2400);
  }

  function showError(message, target = "lobbyError") {
    $(target).textContent = message || "";
  }

  function nameValue(id) {
    return $(id).value.trim().replace(/\s+/g, " ").slice(0, 24) || "Guest";
  }

  function formatDuration(seconds) {
    if (seconds % 3600 === 0) return `${seconds / 3600} hr`;
    if (seconds % 60 === 0) return `${seconds / 60} min`;
    return `${seconds} sec`;
  }

  function setRoom(code, snapshot) {
    currentCode = code;
    isTyping = false;
    typingUsers.clear();
    renderTypingUsers();
    playSound("room");
    ui.activeRoomCode.textContent = code;
    ui.lobby.classList.add("hidden");
    ui.chat.classList.remove("hidden");
    ui.chatError.textContent = "";
    ui.messages.innerHTML = "";

    if (snapshot.messageTtlSeconds) {
      ui.ttlLabel.textContent = formatDuration(snapshot.messageTtlSeconds);
    }

    (snapshot.messages || []).forEach(addMessage);
    renderMembers(snapshot.members || []);

    if (!(snapshot.messages || []).length) showEmptyState();

    history.replaceState({}, "", `/?room=${encodeURIComponent(code)}`);
    ui.messageInput.focus();
  }

  function enterRoom(eventName, data, target = "lobbyError") {
    showError("", target);

    if (!socket.connected) {
      showError("Server se connection nahi hai. Thodi der baad refresh karke try karo.", target);
      return;
    }

    const button = eventName === "room:create" ? ui.createBtn : ui.joinBtn;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Please wait…";

    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      button.disabled = false;
      button.textContent = originalText;
    };

    // Socket.IO v4 supports acknowledgement timeouts. This prevents the
    // button from appearing frozen if the server never acknowledges the event.
    socket.timeout(8000).emit(eventName, data, (error, result) => {
      finish();

      if (error) {
        showError("Server se response nahi aaya. Render Logs aur server.js check karo.", target);
        return;
      }

      if (!result?.ok) {
        showError(result?.error || "Something went wrong.", target);
        return;
      }

      if (!result.code || !result.snapshot) {
        showError("Server ka response incomplete hai. server.js check karo.", target);
        return;
      }

      setRoom(result.code, result.snapshot);
    });
  }

  ui.createBtn.addEventListener("click", () => {
    enterRoom("room:create", { name: nameValue("createName") });
  });

  ui.joinBtn.addEventListener("click", () => {
    const code = ui.roomCode.value.trim().toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(code)) {
      showError("Enter the 6-character room code.");
      return;
    }

    enterRoom("room:join", {
      name: nameValue("joinName"),
      code
    });
  });

  ui.roomCode.addEventListener("input", () => {
    ui.roomCode.value = ui.roomCode.value
      .toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  });

  ui.roomCode.addEventListener("keydown", event => {
    if (event.key === "Enter") ui.joinBtn.click();
  });

  function leaveRoom() {
    if (typeof cleanupCall === "function" && callState.id) cleanupCall(true);
    sendTypingState(false);
    currentCode = null;
    typingUsers.clear();
    renderTypingUsers();
    clearTimeout(typingTimer);
    ui.uploadPreview.classList.add("hidden");
    ui.uploadPreview.innerHTML = "";
    ui.chat.classList.add("hidden");
    ui.lobby.classList.remove("hidden");
    document.querySelector(".room-sidebar")?.classList.remove("show-mobile");
    history.replaceState({}, "", "/");
  }

  ui.backBtn.addEventListener("click", leaveRoom);

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied to clipboard");
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      document.body.appendChild(input);
      input.select();

      try {
        document.execCommand("copy");
        showToast("Copied to clipboard");
      } catch {
        showToast(text);
      }

      input.remove();
    }
  }

  ui.copyCodeBtn.addEventListener("click", () => {
    if (currentCode) copyText(currentCode);
  });

  ui.copyInviteBtn.addEventListener("click", () => {
    if (currentCode) copyText(`${location.origin}/?room=${currentCode}`);
  });

  const sidebar = document.querySelector(".room-sidebar");

  ui.mobileMembersBtn.addEventListener("click", () => {
    sidebar.classList.toggle("show-mobile");
  });

  document.addEventListener("click", event => {
    if (
      innerWidth <= 620 &&
      sidebar.classList.contains("show-mobile") &&
      !sidebar.contains(event.target) &&
      event.target !== ui.mobileMembersBtn
    ) {
      sidebar.classList.remove("show-mobile");
    }
  });

  ui.resetBtn.addEventListener("click", () => {
    if (!confirm("Clear every message and attachment in this room for everyone?")) return;

    socket.emit("room:reset", result => {
      if (!result?.ok) {
        showError(result?.error || "Could not clear messages.", "chatError");
        return;
      }

      showToast("Room messages cleared");
    });
  });

  ui.messageInput.addEventListener("input", () => {
    if (!currentCode) return;
    sendTypingState(ui.messageInput.value.trim().length > 0);
    clearTimeout(typingTimer);
    if (ui.messageInput.value.trim()) {
      typingTimer = setTimeout(() => sendTypingState(false), 1200);
    } else {
      sendTypingState(false);
    }
  });

  ui.messageForm.addEventListener("submit", event => {
    event.preventDefault();

    const text = ui.messageInput.value.trim();
    if (!text || !currentCode) return;
    sendTypingState(false);
    clearTimeout(typingTimer);

    socket.emit("message:send", { text }, result => {
      if (!result?.ok) {
        showError(result?.error || "Message could not be sent.", "chatError");
        return;
      }

      ui.messageInput.value = "";
      sendTypingState(false);
      playSound("sent");
      showError("", "chatError");
    });
  });

  ui.attachBtn.addEventListener("click", () => ui.fileInput.click());

  ui.fileInput.addEventListener("change", () => {
    const file = ui.fileInput.files?.[0];
    if (!file) return;

    ui.uploadPreview.innerHTML = "";

    const label = document.createElement("span");
    label.textContent = `Selected: ${file.name} (${formatBytes(file.size)})`;

    const send = document.createElement("button");
    send.type = "button";
    send.textContent = "Upload & send";
    send.addEventListener("click", () => uploadAndSend(file));

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "×";
    cancel.setAttribute("aria-label", "Cancel attachment");
    cancel.addEventListener("click", clearSelectedFile);

    ui.uploadPreview.append(label, send, cancel);
    ui.uploadPreview.classList.remove("hidden");
  });

  function clearSelectedFile() {
    ui.fileInput.value = "";
    ui.uploadPreview.classList.add("hidden");
    ui.uploadPreview.innerHTML = "";
  }

  async function uploadAndSend(file) {
    const button = ui.uploadPreview.querySelector("button");

    if (button) {
      button.disabled = true;
      button.textContent = "Uploading…";
    }

    showError("", "chatError");

    try {
      const body = new FormData();
      body.append("file", file);

      const response = await fetch("/api/upload", {
        method: "POST",
        body
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Upload failed.");

      socket.emit("file:share", { file: result.file }, answer => {
        if (!answer?.ok) {
          showError(answer?.error || "Could not share file.", "chatError");

          if (button) {
            button.disabled = false;
            button.textContent = "Try again";
          }

          return;
        }

        clearSelectedFile();
      });
    } catch (error) {
      showError(error.message || "Upload failed.", "chatError");

      if (button) {
        button.disabled = false;
        button.textContent = "Try again";
      }
    }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  socket.on("members:update", renderMembers);
  socket.on("message:new", addMessage);
  socket.on("system:message", data => {
    addSystemMessage(data.text);
    playSound("system");
  });

  socket.on("typing:update", data => {
    if (!data) return;
    // Ignore own typing event if the server echoes it back.
    if (data.userId && data.userId === socket.id) return;
    const userId = data.userId || data.id;
    if (!userId) return;
    if (data.typing) {
      typingUsers.set(userId, data.name || "Someone");
    } else {
      typingUsers.delete(userId);
    }
    renderTypingUsers();
  });

  socket.on("message:deleted", ({ id }) => {
    const node = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    if (node) node.remove();
    if (!ui.messages.querySelector(".message-row")) showEmptyState();
  });

  socket.on("reaction:update", ({ messageId, reactions: data }) => {
    const node = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!node) return;

    const bar = node.querySelector(".reaction-bar");
    if (bar) renderReactionCounts(bar, messageId, data);
  });

  socket.on("room:cleared", () => {
    ui.messages.innerHTML = "";
    playSound("system");
    showEmptyState();
  });

  socket.on("room:expired", () => {
    leaveRoom();
    showToast("This room expired. Create a new one to continue.");
  });

  function initials(name) {
    return (name || "G").trim().split(/\s+/).slice(0, 2)
      .map(part => part[0] || "").join("").toUpperCase();
  }

  function renderMembers(members) {
    ui.memberCount.textContent = members.length;
    ui.headerMembers.textContent =
      `${members.length} ${members.length === 1 ? "person" : "people"} here`;

    ui.membersList.innerHTML = "";

    members.forEach(member => {
      const row = document.createElement("div");
      row.className = "member";

      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.style.color = member.color;
      avatar.style.background = `${member.color}20`;
      avatar.textContent = initials(member.name);

      const info = document.createElement("div");
      info.className = "member-info";

      const name = document.createElement("div");
      name.className = "member-name";
      name.textContent = member.name;

      const status = document.createElement("div");
      status.className = "member-status";
      status.textContent = "● Online";

      info.append(name, status);
      row.append(avatar, info);

      if (member.id === socket.id) {
        const you = document.createElement("span");
        you.className = "you-tag";
        you.textContent = "YOU";
        row.append(you);
      }

      ui.membersList.append(row);
    });
  }

  function showEmptyState() {
    if (ui.messages.querySelector(".empty-state")) return;

    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML =
      '<div class="empty-orbit"><span>✧</span></div>' +
      '<h3>Your conversation starts here</h3>' +
      '<p>Say hello. Share a thought. This space is yours.</p>';

    ui.messages.append(empty);
  }

  function addSystemMessage(text) {
    if (ui.messages.querySelector(".empty-state")) ui.messages.innerHTML = "";

    const node = document.createElement("div");
    node.className = "system-message";
    node.textContent = text;
    ui.messages.append(node);
    scrollToBottom();
  }

  function addMessage(message) {
    if (document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;

    if (ui.messages.querySelector(".empty-state")) ui.messages.innerHTML = "";

    const mine = message.senderId === socket.id;
    const row = document.createElement("article");
    row.className = `message-row${mine ? " mine" : ""}`;
    row.dataset.messageId = message.id;
    row.classList.add("tc-new-message");
    if (!mine) playSound("received");

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = initials(message.senderName || "Guest");
    avatar.style.color = message.senderColor || "var(--accent)";
    avatar.style.background = `${message.senderColor || "#a78bfa"}20`;

    const content = document.createElement("div");
    content.className = "message-content";

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const name = document.createElement("strong");
    name.textContent = message.senderName || "Guest";

    const time = document.createElement("time");
    time.textContent = new Date(message.createdAt).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit"
    });

    meta.append(name, time);
    content.append(meta);

    if (message.text) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = message.text;
      content.append(bubble);
    }

    if (message.file) content.append(renderFile(message.file));

    const reactionBar = document.createElement("div");
    reactionBar.className = "reaction-bar";
    renderReactionCounts(reactionBar, message.id, message.reactions || {});
    content.append(reactionBar);

    const picker = document.createElement("div");
    picker.className = "reaction-picker";

    reactions.forEach(emoji => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = emoji;
      btn.title = `React ${emoji}`;
      btn.setAttribute("aria-label", `React ${emoji}`);
      btn.addEventListener("click", () => {
        socket.emit("reaction:toggle", { messageId: message.id, emoji });
      });
      picker.append(btn);
    });

    content.append(picker);
    row.append(avatar, content);
    ui.messages.append(row);
    scrollToBottom();
  }

  function renderFile(file) {
    const wrap = document.createElement("div");

    if ((file.mime || "").startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "attachment";
      img.src = file.url;
      img.alt = file.name;
      img.loading = "lazy";
      img.addEventListener("error", () => img.replaceWith(fileLink(file)));
      wrap.append(img);
    } else {
      wrap.append(fileLink(file));
    }

    const caption = document.createElement("div");
    caption.style.cssText = "font-size:9px;color:var(--muted);margin-top:5px";
    caption.textContent = `${file.name} · ${formatBytes(file.size || 0)}`;
    wrap.append(caption);

    return wrap;
  }

  function fileLink(file) {
    const link = document.createElement("a");
    link.className = "attachment-link";
    link.href = file.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.download = file.name;

    const icon = document.createElement("span");
    icon.textContent = "↧";

    const name = document.createElement("strong");
    name.textContent = file.name;

    link.append(icon, name);
    return link;
  }

  function renderReactionCounts(container, messageId, data) {
    container.innerHTML = "";

    Object.entries(data || {}).forEach(([emoji, ids]) => {
      if (!ids || !ids.length) return;

      const button = document.createElement("button");
      button.className = "reaction-btn";
      button.type = "button";
      button.textContent = `${emoji} ${ids.length}`;
      button.title = "Click to toggle your reaction";
      button.addEventListener("click", () => {
        socket.emit("reaction:toggle", { messageId, emoji });
      });

      container.append(button);
    });
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      ui.messages.scrollTop = ui.messages.scrollHeight;
      // A second pass catches layout changes from newly rendered attachments.
      requestAnimationFrame(() => { ui.messages.scrollTop = ui.messages.scrollHeight; });
    });
  }

  // Theme popup and selection.
  const themeModal = $("themeModal");
  const openThemes = $("openThemes");
  const closeThemes = $("closeThemes");
  const themeOptions = [...document.querySelectorAll("[data-theme-choice]")];

  function applyTheme(theme) {
    const safeTheme = themes.includes(theme) ? theme : "midnight";
    document.body.dataset.theme = safeTheme;

    themeOptions.forEach(option => {
      const selected = option.dataset.themeChoice === safeTheme;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });

    const themeColors = {
      midnight: "#071522",
      aurora: "#092a2b",
      ocean: "#071b32",
      sakura: "#281222",
      desert: "#29170b",
      dark: "#050505",
      mono: "#111111",
      graphite: "#141821",
      ice: "#08252e",
      ember: "#270f0b"
    };

    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", themeColors[safeTheme]);
  }

  function openThemeModal() {
    themeModal.classList.add("open");
    themeModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("theme-modal-open");
    closeThemes.focus();
  }

  function closeThemeModal() {
    themeModal.classList.remove("open");
    themeModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("theme-modal-open");
    openThemes.focus();
  }

  openThemes.addEventListener("click", openThemeModal);
  closeThemes.addEventListener("click", closeThemeModal);

  themeModal.querySelectorAll("[data-close-themes]").forEach(element => {
    element.addEventListener("click", closeThemeModal);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && themeModal.classList.contains("open")) {
      closeThemeModal();
    }
  });

  themeOptions.forEach(option => {
    option.addEventListener("click", () => {
      const theme = option.dataset.themeChoice;
      applyTheme(theme);

      try {
        localStorage.setItem("tempchat-theme", theme);
      } catch (_) {}

      showToast(`${option.querySelector("strong").textContent} theme applied`);
      closeThemeModal();
    });
  });

  let savedTheme = "midnight";

  try {
    savedTheme = localStorage.getItem("tempchat-theme") || "midnight";
  } catch (_) {}

  applyTheme(savedTheme);

  // Pre-fill room code from an invite link.
  const params = new URLSearchParams(location.search);
  const inviteCode = (params.get("room") || "").toUpperCase();

  if (/^[A-Z0-9]{6}$/.test(inviteCode)) {
    ui.roomCode.value = inviteCode;
    setTimeout(() => ui.joinName.focus(), 100);
  }


  // --------------------------------------------------
  // VOICE + VIDEO CALLS (WebRTC)
  // --------------------------------------------------
  const callState = {
    id: null,
    type: "audio",
    mode: "private",
    incoming: null,
    stream: null,
    peers: new Map(),
    muted: false,
    cameraOff: false
  };

  const callStyles = document.createElement("style");
  callStyles.textContent = `
    #tcCallBar { display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border,#4444); }
    #tcCallBar button,#tcCallModal button { border:1px solid var(--border,#4444);border-radius:10px;padding:9px 12px;background:var(--panel,rgba(255,255,255,.06));color:inherit;cursor:pointer; }
    #tcCallBar button:disabled { opacity:.5;cursor:not-allowed; }
    #tcCallStatus { font-size:12px;opacity:.75;flex:1;min-width:120px; }
    #tcCallModal { position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);padding:16px; }
    #tcCallModal.open { display:flex; }
    #tcCallCard { width:min(760px,100%);max-height:90vh;overflow:auto;background:var(--panel,#111827);color:var(--text,#fff);border:1px solid var(--border,#4444);border-radius:18px;padding:18px;box-shadow:0 20px 80px #0008; }
    #tcCallVideos { display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:14px 0; }
    #tcCallVideos video { width:100%;aspect-ratio:4/3;object-fit:cover;background:#050505;border-radius:12px; }
    #tcCallControls { display:flex;flex-wrap:wrap;gap:8px; }
    #tcCallIncomingText { margin:12px 0 18px; }
    #tcCallStatusText { font-size:13px;opacity:.75;margin:8px 0; }
  `;
  document.head.appendChild(callStyles);

  const callBar = document.createElement("div");
  callBar.id = "tcCallBar";
  const callModeSelect = document.createElement("select");
  callModeSelect.id = "tcCallMode";
  callModeSelect.style.cssText = "padding:9px;border-radius:10px;max-width:160px;";
  callModeSelect.innerHTML = '<option value="private">Private call</option><option value="group">Group call</option>';
  const callTargetSelect = document.createElement("select");
  callTargetSelect.id = "tcCallTarget";
  callTargetSelect.style.cssText = "padding:9px;border-radius:10px;max-width:180px;";
  const audioCallBtn = document.createElement("button");
  audioCallBtn.type = "button";
  audioCallBtn.textContent = "☎ Voice call";
  const videoCallBtn = document.createElement("button");
  videoCallBtn.type = "button";
  videoCallBtn.textContent = "▣ Video call";
  const callStatus = document.createElement("span");
  callStatus.id = "tcCallStatus";
  callStatus.textContent = "Calls are available when you join a room.";
  callBar.append(callModeSelect, callTargetSelect, audioCallBtn, videoCallBtn, callStatus);
  if (ui.chat) ui.chat.insertBefore(callBar, ui.chat.firstChild);

  const callModal = document.createElement("div");
  callModal.id = "tcCallModal";
  callModal.innerHTML = `
    <div id="tcCallCard" role="dialog" aria-modal="true" aria-label="TempChat call">
      <h2 id="tcCallTitle" style="margin:0">TempChat Call</h2>
      <p id="tcCallStatusText">Connecting…</p>
      <div id="tcCallVideos"></div>
      <p id="tcCallIncomingText" hidden></p>
      <div id="tcCallControls">
        <button id="tcAcceptCall" type="button" hidden>Accept</button>
        <button id="tcRejectCall" type="button" hidden>Decline</button>
        <button id="tcMuteCall" type="button">Mute mic</button>
        <button id="tcCameraCall" type="button">Turn camera off</button>
        <button id="tcEndCall" type="button">End call</button>
      </div>
    </div>`;
  document.body.append(callModal);

  const callUI = {
    title: $("tcCallTitle"), status: $("tcCallStatusText"), videos: $("tcCallVideos"),
    incomingText: $("tcCallIncomingText"), accept: $("tcAcceptCall"),
    reject: $("tcRejectCall"), mute: $("tcMuteCall"), camera: $("tcCameraCall"),
    end: $("tcEndCall")
  };

  const rtcConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  };

  function refreshCallTargets(members = []) {
    const previous = callTargetSelect.value;
    callTargetSelect.replaceChildren();
    members.filter(member => member.id !== socket.id).forEach(member => {
      const option = document.createElement("option");
      option.value = member.id;
      option.textContent = member.name;
      callTargetSelect.append(option);
    });
    if ([...callTargetSelect.options].some(option => option.value === previous)) {
      callTargetSelect.value = previous;
    }
    const privateMode = callModeSelect.value === "private";
    callTargetSelect.disabled = !privateMode || callState.id !== null;
    audioCallBtn.disabled = callState.id !== null || !currentCode || (privateMode && !callTargetSelect.value);
    videoCallBtn.disabled = audioCallBtn.disabled;
  }

  const oldRenderMembers = renderMembers;
  renderMembers = function(members) {
    oldRenderMembers(members);
    refreshCallTargets(members);
  };

  callModeSelect.addEventListener("change", () => {
    callTargetSelect.disabled = callModeSelect.value !== "private" || callState.id !== null;
    refreshCallTargets([...ui.membersList.querySelectorAll(".member")].map(row => ({
      id: row.querySelector(".you-tag") ? socket.id : row.dataset.memberId,
      name: row.querySelector(".member-name")?.textContent || "Member"
    })).filter(member => member.id));
    // Rebuild from the latest member event cache below if the sidebar has no IDs.
    audioCallBtn.disabled = callState.id !== null || !currentCode || (callModeSelect.value === "private" && !callTargetSelect.value);
    videoCallBtn.disabled = audioCallBtn.disabled;
  });

  let lastMembers = [];
  socket.on("members:update", members => {
    lastMembers = Array.isArray(members) ? members : [];
    refreshCallTargets(lastMembers);
  });

  function showCallModal() {
    callModal.classList.add("open");
    callModal.setAttribute("aria-hidden", "false");
  }

  function hideCallModal() {
    callModal.classList.remove("open");
    callModal.setAttribute("aria-hidden", "true");
  }

  function setCallStatus(text) {
    callUI.status.textContent = text;
    callStatus.textContent = text;
  }

  function addCallVideo(stream, label, muted = false) {
    const tile = document.createElement("div");
    tile.style.cssText = "min-width:0;position:relative;";
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = muted;
    video.srcObject = stream;
    const caption = document.createElement("div");
    caption.textContent = label;
    caption.style.cssText = "font-size:12px;margin-top:4px;opacity:.8;";
    tile.append(video, caption);
    callUI.videos.append(tile);
    video.play().catch(() => {});
    return tile;
  }

  function updateCallControls() {
    callUI.mute.textContent = callState.muted ? "Unmute mic" : "Mute mic";
    callUI.camera.textContent = callState.cameraOff ? "Turn camera on" : "Turn camera off";
    callUI.camera.hidden = callState.type !== "video";
  }

  async function acquireMedia(type) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Calls need HTTPS and browser microphone/camera support.");
    }
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === "video"
        ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }
        : false
    });
  }

  function createPeer(peerId, peerName, shouldOffer = false) {
    if (!callState.id || !callState.stream) return null;
    if (callState.peers.has(peerId)) return callState.peers.get(peerId).pc;

    const pc = new RTCPeerConnection(rtcConfig);
    const remoteStream = new MediaStream();
    const tile = addCallVideo(remoteStream, peerName || "Participant", true);
    callState.stream.getTracks().forEach(track => pc.addTrack(track, callState.stream));

    pc.ontrack = event => {
      const streams = event.streams;
      if (streams && streams[0]) {
        streams[0].getTracks().forEach(track => {
          if (!remoteStream.getTracks().some(existing => existing.id === track.id)) {
            remoteStream.addTrack(track);
          }
        });
      } else if (!remoteStream.getTracks().some(existing => existing.id === event.track.id)) {
        remoteStream.addTrack(event.track);
      }
      if (callState.type === "audio") tile.querySelector("video").style.display = "none";
    };

    pc.onicecandidate = event => {
      if (event.candidate && callState.id) {
        socket.emit("call:signal", {
          callId: callState.id,
          targetId: peerId,
          signal: { candidate: event.candidate }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        setCallStatus("Connection failed. Network may require a TURN server.");
      }
    };

    callState.peers.set(peerId, { pc, stream: remoteStream, tile, name: peerName || "Participant" });

    if (shouldOffer) {
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => socket.emit("call:signal", {
          callId: callState.id,
          targetId: peerId,
          signal: { description: pc.localDescription }
        }))
        .catch(error => setCallStatus(`Could not start media connection: ${error.message}`));
    }

    return pc;
  }

  async function handleCallSignal(data) {
    if (!callState.id || data.callId !== callState.id) return;
    const entry = callState.peers.get(data.fromId);
    const pc = entry?.pc;
    if (!pc || !data.signal) return;

    try {
      if (data.signal.description) {
        const description = data.signal.description;
        await pc.setRemoteDescription(new RTCSessionDescription(description));
        if (description.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("call:signal", {
            callId: callState.id,
            targetId: data.fromId,
            signal: { description: pc.localDescription }
          });
        }
      } else if (data.signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.signal.candidate));
      }
    } catch (error) {
      setCallStatus(`Call connection error: ${error.message}`);
    }
  }

  async function beginCall(type) {
    if (!currentCode) return showToast("Join a room before calling.");
    if (callState.id) return showToast("You are already in a call.");

    const mode = callModeSelect.value;
    const targetId = callTargetSelect.value;
    if (mode === "private" && !targetId) return showToast("Choose an online member first.");

    audioCallBtn.disabled = true;
    videoCallBtn.disabled = true;
    setCallStatus("Requesting microphone/camera permission…");

    try {
      callState.stream = await acquireMedia(type);
      callState.type = type;
      callState.mode = mode;
      callState.muted = false;
      callState.cameraOff = false;
      callUI.videos.replaceChildren();
      addCallVideo(callState.stream, "You", true);
      callUI.title.textContent = type === "video" ? "Video call" : "Voice call";
      callUI.incomingText.hidden = true;
      callUI.accept.hidden = true;
      callUI.reject.hidden = true;
      callUI.mute.hidden = false;
      callUI.camera.hidden = type !== "video";
      callUI.end.hidden = false;
      showCallModal();
      updateCallControls();

      socket.timeout(8000).emit("call:start", { type, mode, targetId }, (error, result) => {
        if (error || !result?.ok) {
          setCallStatus(result?.error || "Could not start call. Check server connection.");
          cleanupCall(false);
          return;
        }
        callState.id = result.callId;
        setCallStatus(mode === "group" ? "Calling room members…" : "Calling member…");
        refreshCallTargets(lastMembers);
      });
    } catch (error) {
      if (callState.stream) callState.stream.getTracks().forEach(track => track.stop());
      callState.stream = null;
      setCallStatus(error.message || "Could not access microphone/camera.");
      showCallModal();
      audioCallBtn.disabled = false;
      videoCallBtn.disabled = false;
    }
  }

  function cleanupCall(notifyServer = true) {
    const oldCallId = callState.id;
    if (notifyServer && oldCallId) socket.emit("call:leave", { callId: oldCallId });
    for (const { pc, tile } of callState.peers.values()) {
      try { pc.ontrack = null; pc.close(); } catch (_) {}
      tile.remove();
    }
    callState.peers.clear();
    if (callState.stream) callState.stream.getTracks().forEach(track => track.stop());
    callState.stream = null;
    callState.id = null;
    callState.incoming = null;
    callState.muted = false;
    callState.cameraOff = false;
    callUI.videos.replaceChildren();
    callUI.incomingText.hidden = true;
    callUI.accept.hidden = true;
    callUI.reject.hidden = true;
    callUI.mute.hidden = false;
    callUI.end.hidden = false;
    hideCallModal();
    setCallStatus("Not in a call.");
    refreshCallTargets(lastMembers);
  }

  async function acceptIncomingCall() {
    const incoming = callState.incoming;
    if (!incoming) return;

    callUI.accept.disabled = true;
    callUI.reject.disabled = true;
    try {
      callState.stream = await acquireMedia(incoming.type);
      callState.id = incoming.callId;
      callState.type = incoming.type;
      callState.mode = incoming.mode;
      callState.muted = false;
      callState.cameraOff = false;
      callUI.videos.replaceChildren();
      addCallVideo(callState.stream, "You", true);
      callUI.incomingText.hidden = true;
      callUI.accept.hidden = true;
      callUI.reject.hidden = true;
      callUI.mute.hidden = false;
      callUI.camera.hidden = incoming.type !== "video";
      callUI.end.hidden = false;
      updateCallControls();

      socket.timeout(8000).emit("call:accept", { callId: incoming.callId }, (error, result) => {
        callUI.accept.disabled = false;
        callUI.reject.disabled = false;
        if (error || !result?.ok) {
          setCallStatus(result?.error || "Call is no longer available.");
          cleanupCall(false);
          return;
        }
        callState.id = result.callId;
        (result.participants || []).forEach(peer => createPeer(peer.id, peer.name, false));
        setCallStatus("Connected to call. Waiting for media…");
        callState.incoming = null;
      });
    } catch (error) {
      callUI.accept.disabled = false;
      callUI.reject.disabled = false;
      setCallStatus(error.message || "Could not access microphone/camera.");
    }
  }

  audioCallBtn.addEventListener("click", () => beginCall("audio"));
  videoCallBtn.addEventListener("click", () => beginCall("video"));
  callUI.accept.addEventListener("click", acceptIncomingCall);
  callUI.reject.addEventListener("click", () => {
    const incoming = callState.incoming;
    if (incoming) socket.emit("call:reject", { callId: incoming.callId });
    cleanupCall(false);
  });
  callUI.end.addEventListener("click", () => cleanupCall(true));
  callUI.mute.addEventListener("click", () => {
    callState.muted = !callState.muted;
    callState.stream?.getAudioTracks().forEach(track => { track.enabled = !callState.muted; });
    updateCallControls();
  });
  callUI.camera.addEventListener("click", () => {
    callState.cameraOff = !callState.cameraOff;
    callState.stream?.getVideoTracks().forEach(track => { track.enabled = !callState.cameraOff; });
    updateCallControls();
  });

  socket.on("call:incoming", incoming => {
    if (callState.id) {
      socket.emit("call:reject", { callId: incoming.callId });
      return;
    }
    callState.incoming = incoming;
    callUI.title.textContent = incoming.type === "video" ? "Incoming video call" : "Incoming voice call";
    callUI.status.textContent = `${incoming.callerName} is calling…`;
    callUI.incomingText.textContent = `${incoming.callerName} invited you to a ${incoming.mode} ${incoming.type} call in room ${incoming.roomCode}.`;
    callUI.incomingText.hidden = false;
    callUI.accept.hidden = false;
    callUI.reject.hidden = false;
    callUI.mute.hidden = true;
    callUI.camera.hidden = true;
    callUI.end.hidden = true;
    callUI.videos.replaceChildren();
    showCallModal();
    playSound("system");
  });

  socket.on("call:peer-joined", data => {
    if (!callState.id || data.callId !== callState.id || !data.peer) return;
    // The existing participant creates the offer; the joining peer waits for it.
    createPeer(data.peer.id, data.peer.name, true);
    setCallStatus(`${data.peer.name} joined the call.`);
  });

  socket.on("call:signal", handleCallSignal);

  socket.on("call:peer-left", data => {
    if (!callState.id || data.callId !== callState.id) return;
    const entry = callState.peers.get(data.peerId);
    if (entry) {
      try { entry.pc.close(); } catch (_) {}
      entry.tile.remove();
      callState.peers.delete(data.peerId);
    }
    setCallStatus("A participant left the call.");
    if (callState.mode === "private" && callState.peers.size === 0 && callState.id) {
      // Keep the UI open so the user can explicitly end the call.
      setCallStatus("Other participant left. You can end this call.");
    }
  });

  socket.on("call:rejected", data => {
    if (data.callId === callState.id) setCallStatus(`${data.peerName || "Member"} declined the call.`);
  });

  callModeSelect.addEventListener("change", () => {
    const privateMode = callModeSelect.value === "private";
    callTargetSelect.disabled = !privateMode || callState.id !== null;
    refreshCallTargets(lastMembers);
  });

  refreshCallTargets([]);

})();
// Theme popup click fix
(() => {
  const modal = document.getElementById("themeModal");
  const open = document.getElementById("openThemes");
  const close = document.getElementById("closeThemes");

  if (!modal || !open || !close) return;

  open.addEventListener("click", () => {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  });

  close.addEventListener("click", () => {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  });

  modal.querySelectorAll("[data-close-themes]").forEach(el => {
    el.addEventListener("click", () => {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    });
  });
})();
