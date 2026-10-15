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

  // Animation styles and typing indicator are created automatically.
  const enhancementStyles = document.createElement("style");
  enhancementStyles.textContent = `
    #tempchatTyping {
      min-height: 18px;
      padding: 2px 14px 6px;
      color: var(--muted, #9ca3af);
      font-size: 12px;
    }

    #tempchatTyping[hidden] {
      display: none !important;
    }

    #tempchatTyping .typing-dots {
      display: inline-flex;
      gap: 3px;
      margin-left: 5px;
      vertical-align: middle;
    }

    #tempchatTyping .typing-dots i {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: currentColor;
      animation: tcTypingDot 1s infinite ease-in-out;
    }

    #tempchatTyping .typing-dots i:nth-child(2) {
      animation-delay: .15s;
    }

    #tempchatTyping .typing-dots i:nth-child(3) {
      animation-delay: .3s;
    }

    .message-row,
    .system-message {
      animation: tcMessageIn .22s ease-out both;
    }

    .message-row.tc-new-message {
      animation: tcMessageIn .26s cubic-bezier(.2,.8,.2,1) both;
    }

    @keyframes tcTypingDot {
      0%, 60%, 100% {
        transform: translateY(0);
        opacity: .45;
      }
      30% {
        transform: translateY(-3px);
        opacity: 1;
      }
    }

    @keyframes tcMessageIn {
      from {
        opacity: 0;
        transform: translateY(8px) scale(.99);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .message-row,
      .system-message,
      #tempchatTyping .typing-dots i {
        animation: none !important;
      }
    }
  `;
  document.head.appendChild(enhancementStyles);

  const typingIndicator = document.createElement("div");
  typingIndicator.id = "tempchatTyping";
  typingIndicator.setAttribute("aria-live", "polite");
  typingIndicator.hidden = true;

  if (ui.messageForm?.parentNode) {
    ui.messageForm.parentNode.insertBefore(
      typingIndicator,
      ui.messageForm
    );
  }

  // Small notification sounds using the browser's Web Audio API.
  function playSound(kind = "message") {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      audioContext ||= new AudioCtx();

      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }

      const presets = {
        room: [[660, 0], [880, 0.09]],
        sent: [[620, 0]],
        received: [[740, 0]],
        system: [[520, 0], [660, 0.08]]
      };

      (presets[kind] || presets.received).forEach(([frequency, delay]) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const startAt = audioContext.currentTime + delay;

        oscillator.type = "sine";
        oscillator.frequency.value = frequency;

        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.07, startAt + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.12);

        oscillator.connect(gain);
        gain.connect(audioContext.destination);

        oscillator.start(startAt);
        oscillator.stop(startAt + 0.13);
      });
    } catch (_) {
      // Audio is optional; chat keeps working if sound is unavailable.
    }
  }

  function sendTypingState(typing) {
    if (!currentCode || isTyping === typing) return;

    isTyping = typing;
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

    const label = names.length === 1
      ? `${names[0]} is typing`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing`
        : `${names.length} people are typing`;

    typingIndicator.replaceChildren(document.createTextNode(label));

    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.setAttribute("aria-hidden", "true");

    for (let i = 0; i < 3; i++) {
      dots.appendChild(document.createElement("i"));
    }

    typingIndicator.appendChild(dots);
  }

  // Keep messages visible when the message area changes size.
  const messageResizeObserver = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => {
        if (!ui.chat.classList.contains("hidden")) {
          scrollToBottom();
        }
      })
    : null;

  messageResizeObserver?.observe(ui.messages);

  socket.on("connect", () => {
    ui.connectionLabel.textContent = "Connected";
  });

  socket.on("disconnect", () => {
    ui.connectionLabel.textContent = "Reconnecting…";
    typingUsers.clear();
    renderTypingUsers();
  });

  socket.on("connect_error", () => {
    ui.connectionLabel.textContent = "Connection issue";
  });

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      ui.toast.classList.remove("show");
    }, 2400);
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

    if (!(snapshot.messages || []).length) {
      showEmptyState();
    }

    history.replaceState({}, "", `/?room=${encodeURIComponent(code)}`);
    ui.messageInput.focus();
    scrollToBottom();
  }

  function enterRoom(eventName, data, target = "lobbyError") {
    showError("", target);

    socket.emit(eventName, data, result => {
      if (!result?.ok) {
        showError(result?.error || "Something went wrong.", target);
        return;
      }

      setRoom(result.code, result.snapshot);
    });
  }

  ui.createBtn.addEventListener("click", () => {
    enterRoom("room:create", {
      name: nameValue("createName")
    });
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
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);
  });

  ui.roomCode.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      ui.joinBtn.click();
    }
  });

  function leaveRoom() {
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
    if (currentCode) {
      copyText(`${location.origin}/?room=${currentCode}`);
    }
  });

  const sidebar = document.querySelector(".room-sidebar");

  ui.mobileMembersBtn.addEventListener("click", () => {
    sidebar?.classList.toggle("show-mobile");
  });

  document.addEventListener("click", event => {
    if (
      innerWidth <= 620 &&
      sidebar?.classList.contains("show-mobile") &&
      !sidebar.contains(event.target) &&
      event.target !== ui.mobileMembersBtn
    ) {
      sidebar.classList.remove("show-mobile");
    }
  });

  ui.resetBtn.addEventListener("click", () => {
    if (!confirm("Clear every message and attachment in this room for everyone?")) {
      return;
    }

    socket.emit("room:reset", result => {
      if (!result?.ok) {
        showError(result?.error || "Could not clear messages.", "chatError");
        return;
      }

      showToast("Room messages cleared");
    });
  });

  // Typing indicator: send updates while the user types.
  ui.messageInput.addEventListener("input", () => {
    if (!currentCode) return;

    const hasText = ui.messageInput.value.trim().length > 0;
    sendTypingState(hasText);

    clearTimeout(typingTimer);

    if (hasText) {
      typingTimer = setTimeout(() => {
        sendTypingState(false);
      }, 1800);
    }
  });

  ui.messageInput.addEventListener("blur", () => {
    clearTimeout(typingTimer);
    sendTypingState(false);
  });

  // Submit a text message.
  ui.messageForm.addEventListener("submit", event => {
    event.preventDefault();

    const text = ui.messageInput.value.trim();

    if (!text || !currentCode) return;

    socket.emit("message:send", { text }, result => {
      if (!result?.ok) {
        showError(result?.error || "Message could not be sent.", "chatError");
        return;
      }

      ui.messageInput.value = "";
      showError("", "chatError");

      clearTimeout(typingTimer);
      sendTypingState(false);
      playSound("sent");
    });
  });

  ui.attachBtn.addEventListener("click", () => {
    ui.fileInput.click();
  });

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

      if (!response.ok) {
        throw new Error(result.error || "Upload failed.");
      }

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
        playSound("sent");
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

  socket.on("message:new", message => {
    addMessage(message);
  });

  socket.on("system:message", data => {
    addSystemMessage(data.text);
    playSound("system");
  });

  // The server must emit this event to other users in the same room.
  socket.on("typing:update", data => {
    if (!data || data.id === socket.id) return;

    if (data.typing) {
      typingUsers.set(data.id, data.name || "Someone");
    } else {
      typingUsers.delete(data.id);
    }

    renderTypingUsers();
  });

  socket.on("message:deleted", ({ id }) => {
    const node = document.querySelector(
      `[data-message-id="${CSS.escape(id)}"]`
    );

    if (node) node.remove();

    if (!ui.messages.querySelector(".message-row")) {
      showEmptyState();
    }
  });

  socket.on("reaction:update", ({ messageId, reactions: data }) => {
    const node = document.querySelector(
      `[data-message-id="${CSS.escape(messageId)}"]`
    );

    if (!node) return;

    const bar = node.querySelector(".reaction-bar");

    if (bar) {
      renderReactionCounts(bar, messageId, data);
    }
  });

  socket.on("room:cleared", () => {
    ui.messages.innerHTML = "";
    showEmptyState();
    showToast("Room messages cleared");
  });

  socket.on("room:expired", () => {
    leaveRoom();
    showToast("This room expired. Create a new one to continue.");
  });

  function initials(name) {
    return (name || "G")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(part => part[0] || "")
      .join("")
      .toUpperCase();
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
    if (ui.messages.querySelector(".empty-state")) {
      ui.messages.innerHTML = "";
    }

    const node = document.createElement("div");
    node.className = "system-message";
    node.textContent = text;

    ui.messages.append(node);
    scrollToBottom();
  }

  function addMessage(message) {
    if (
      document.querySelector(
        `[data-message-id="${CSS.escape(message.id)}"]`
      )
    ) {
      return;
    }

    if (ui.messages.querySelector(".empty-state")) {
      ui.messages.innerHTML = "";
    }

    const mine = message.senderId === socket.id;

    const row = document.createElement("article");
    row.className = `message-row${mine ? " mine" : ""}`;
    row.dataset.messageId = message.id;
    row.classList.add("tc-new-message");

    if (!mine) {
      playSound("received");
    }

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
      hour: "2-digit",
      minute: "2-digit"
    });

    meta.append(name, time);
    content.append(meta);

    if (message.text) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = message.text;
      content.append(bubble);
    }

    if (message.file) {
      content.append(renderFile(message.file));
    }

    const reactionBar = document.createElement("div");
    reactionBar.className = "reaction-bar";

    renderReactionCounts(
      reactionBar,
      message.id,
      message.reactions || {}
    );

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
        socket.emit("reaction:toggle", {
          messageId: message.id,
          emoji
        });
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

      img.addEventListener("load", scrollToBottom);

      img.addEventListener("error", () => {
        img.replaceWith(fileLink(file));
        scrollToBottom();
      });

      wrap.append(img);
    } else {
      wrap.append(fileLink(file));
    }

    const caption = document.createElement("div");
    caption.style.cssText =
      "font-size:9px;color:var(--muted);margin-top:5px";

    caption.textContent =
      `${file.name} · ${formatBytes(file.size || 0)}`;

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
        socket.emit("reaction:toggle", {
          messageId,
          emoji
        });
      });

      container.append(button);
    });
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      ui.messages.scrollTop = ui.messages.scrollHeight;

      requestAnimationFrame(() => {
        ui.messages.scrollTop = ui.messages.scrollHeight;
      });
    });
  }

  // Theme popup and selection.
  const themeModal = $("themeModal");
  const openThemes = $("openThemes");
  const closeThemes = $("closeThemes");

  const themeOptions = [
    ...document.querySelectorAll("[data-theme-choice]")
  ];

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
    if (
      event.key === "Escape" &&
      themeModal.classList.contains("open")
    ) {
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

      showToast(
        `${option.querySelector("strong").textContent} theme applied`
      );

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
})();
