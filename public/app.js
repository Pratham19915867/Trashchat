(() => {
  const socket = io();
  const $ = id => document.getElementById(id);
  const ui = {
    lobby: $("lobby"), chat: $("chat"), createName: $("createName"), joinName: $("joinName"),
    roomCode: $("roomCode"), createBtn: $("createBtn"), joinBtn: $("joinBtn"),
    lobbyError: $("lobbyError"), connectionLabel: $("connectionLabel"), activeRoomCode: $("activeRoomCode"),
    copyCodeBtn: $("copyCodeBtn"), copyInviteBtn: $("copyInviteBtn"), backBtn: $("backBtn"),
    memberCount: $("memberCount"), membersList: $("membersList"), headerMembers: $("headerMembers"),
    ttlLabel: $("ttlLabel"), messages: $("messages"), emptyState: $("emptyState"),
    messageForm: $("messageForm"), messageInput: $("messageInput"), fileInput: $("fileInput"),
    attachBtn: $("attachBtn"), uploadPreview: $("uploadPreview"), chatError: $("chatError"),
    resetBtn: $("resetBtn"), mobileMembersBtn: $("mobileMembersBtn"), toast: $("toast"),
    onlineRoomsSection: $("onlineRoomsSection"), publicRoomsList: $("publicRoomsList"), refreshRoomsBtn: $("refreshRoomsBtn"),
    roomRequestsPanel: $("roomRequestsPanel"), roomRequestsList: $("roomRequestsList"), pendingRequestCount: $("pendingRequestCount")
  };
  const reactions = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"];
  let currentCode = null;
  let currentName = "Guest";
  let selectedFile = null;
  let toastTimer = null;

  // Small UI sounds made with Web Audio (no external audio files needed).
  let uiAudioContext = null;
  function playUiSound(kind) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      uiAudioContext ||= new AudioContextClass();
      if (uiAudioContext.state === "suspended") uiAudioContext.resume().catch(() => {});
      const patterns = {
        roomCreate: [{ f: 620, t: 0 }, { f: 830, t: 0.09 }, { f: 1040, t: 0.18 }],
        roomJoin: [{ f: 660, t: 0 }, { f: 880, t: 0.10 }],
        message: [{ f: 740, t: 0 }]
      };
      (patterns[kind] || patterns.message).forEach(({ f, t }) => {
        const osc = uiAudioContext.createOscillator();
        const gain = uiAudioContext.createGain();
        const start = uiAudioContext.currentTime + t;
        osc.type = "sine";
        osc.frequency.setValueAtTime(f, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.055, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
        osc.connect(gain);
        gain.connect(uiAudioContext.destination);
        osc.start(start);
        osc.stop(start + 0.14);
      });
    } catch (_) { /* Sound is optional; never interrupt chat if unavailable. */ }
  }

  socket.on("connect", () => { ui.connectionLabel.textContent = "Connected"; });
  socket.on("disconnect", () => { ui.connectionLabel.textContent = "Reconnecting…"; });
  socket.on("connect_error", () => { ui.connectionLabel.textContent = "Connection issue"; });

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 2400);
  }
  function showError(message, target = "lobbyError") { $(target).textContent = message || ""; }
  function nameValue(input) {
    const value = $(input).value.trim().replace(/\s+/g, " ").slice(0, 24);
    return value || "Guest";
  }
  function setRoom(code, snapshot) {
    currentCode = code;
    requestingRoomCode = null;
    ui.activeRoomCode.textContent = code;
    ui.lobby.classList.add("hidden");
    ui.chat.classList.remove("hidden");
    ui.chat.classList.add("chat-layout");
    ui.lobbyError.textContent = "";
    ui.chatError.textContent = "";
    ui.messages.innerHTML = "";
    ui.emptyState = null;
    if (snapshot.messageTtlSeconds) ui.ttlLabel.textContent = formatDuration(snapshot.messageTtlSeconds);
    (snapshot.messages || []).forEach(addMessage);
    renderMembers(snapshot.members || []);
    if (!snapshot.messages?.length) showEmptyState();
    window.history.replaceState({}, "", `/?room=${encodeURIComponent(code)}`);
    ui.messageInput.focus();
  }
  function formatDuration(seconds) {
    if (seconds % 3600 === 0) return `${seconds / 3600} hr`;
    if (seconds % 60 === 0) return `${seconds / 60} min`;
    return `${seconds} sec`;
  }
  function enterRoom(eventName, data, errorTarget = "lobbyError") {
    showError("", errorTarget);
    socket.emit(eventName, data, result => {
      if (!result?.ok) return showError(result?.error || "Something went wrong.", errorTarget);
      if (eventName === "room:create") playUiSound("roomCreate");
      else if (eventName === "room:join") playUiSound("roomJoin");
      setRoom(result.code, result.snapshot);
    });
  }
  ui.createBtn.addEventListener("click", () => {
    currentName = nameValue("createName");
    enterRoom("room:create", { name: currentName, isPublic: true });
  });
  ui.joinBtn.addEventListener("click", () => {
    currentName = nameValue("joinName");
    const code = ui.roomCode.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return showError("Enter the 6-character room code.");
    enterRoom("room:join", { name: currentName, code });
  });
  ui.roomCode.addEventListener("input", () => {
    ui.roomCode.value = ui.roomCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  });
  ui.roomCode.addEventListener("keydown", e => { if (e.key === "Enter") ui.joinBtn.click(); });

  function leaveRoom() {
    currentCode = null;
    socket.emit("rooms:public:list");
    selectedFile = null;
    ui.uploadPreview.classList.add("hidden");
    ui.chat.classList.add("hidden");
    ui.chat.classList.remove("chat-layout");
    ui.lobby.classList.remove("hidden");
    ui.roomSidebar?.classList.remove("show-mobile");
    window.history.replaceState({}, "", "/");
  }
  ui.backBtn.addEventListener("click", leaveRoom);
  window.addEventListener("beforeunload", () => {});

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied to clipboard");
    } catch {
      const input = document.createElement("textarea");
      input.value = text; document.body.appendChild(input); input.select();
      try { document.execCommand("copy"); showToast("Copied to clipboard"); }
      catch { showToast(text); }
      input.remove();
    }
  }
  ui.copyCodeBtn.addEventListener("click", () => copyText(currentCode || ""));
  ui.copyInviteBtn.addEventListener("click", () => copyText(`${location.origin}/?room=${currentCode}`));

  const sidebar = document.querySelector(".room-sidebar");
  ui.mobileMembersBtn.addEventListener("click", () => sidebar.classList.toggle("show-mobile"));
  document.addEventListener("click", e => {
    if (window.innerWidth <= 620 && sidebar.classList.contains("show-mobile") &&
        !sidebar.contains(e.target) && e.target !== ui.mobileMembersBtn) sidebar.classList.remove("show-mobile");
  });
  ui.resetBtn.addEventListener("click", () => {
    if (!confirm("Clear every message and attachment in this room for everyone?")) return;
    socket.emit("room:reset", result => {
      if (!result?.ok) return showError(result?.error || "Could not clear messages.", "chatError");
      showToast("Room messages cleared");
    });
  });

  ui.messageForm.addEventListener("submit", e => {
    e.preventDefault();
    const text = ui.messageInput.value.trim();
    if (!text) return;
    socket.emit("message:send", { text }, result => {
      if (!result?.ok) return showError(result?.error || "Message could not be sent.", "chatError");
      ui.messageInput.value = "";
      playUiSound("message");
      showError("", "chatError");
    });
  });
  ui.attachBtn.addEventListener("click", () => ui.fileInput.click());
  ui.fileInput.addEventListener("change", async () => {
    const file = ui.fileInput.files?.[0];
    if (!file) return;
    selectedFile = file;
    ui.uploadPreview.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = `Selected: ${file.name} (${formatBytes(file.size)})`;
    const send = document.createElement("button");
    send.type = "button"; send.textContent = "Upload & send";
    send.addEventListener("click", () => uploadAndSend(file));
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.textContent = "×"; cancel.setAttribute("aria-label", "Cancel attachment");
    cancel.addEventListener("click", clearSelectedFile);
    ui.uploadPreview.append(label, send, cancel);
    ui.uploadPreview.classList.remove("hidden");
  });
  function clearSelectedFile() {
    selectedFile = null; ui.fileInput.value = ""; ui.uploadPreview.classList.add("hidden"); ui.uploadPreview.innerHTML = "";
  }
  async function uploadAndSend(file) {
    const button = ui.uploadPreview.querySelector("button");
    if (button) { button.disabled = true; button.textContent = "Uploading…"; }
    showError("", "chatError");
    try {
      const body = new FormData(); body.append("file", file);
      const response = await fetch("/api/upload", { method: "POST", body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Upload failed.");
      socket.emit("file:share", { file: result.file }, answer => {
        if (!answer?.ok) return showError(answer?.error || "Could not share file.", "chatError");
        clearSelectedFile();
      });
    } catch (error) {
      showError(error.message || "Upload failed.", "chatError");
      if (button) { button.disabled = false; button.textContent = "Try again"; }
    }
  }
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  socket.on("members:update", renderMembers);
  socket.on("message:new", addMessage);
  socket.on("system:message", data => addSystemMessage(data.text));
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
    showEmptyState();
  });
  socket.on("room:expired", () => {
    leaveRoom();
    showToast("This room expired. Create a new one to continue.");
  });

  function renderMembers(members) {
    ui.memberCount.textContent = members.length;
    ui.headerMembers.textContent = `${members.length} ${members.length === 1 ? "person" : "people"} here`;
    ui.membersList.innerHTML = "";
    members.forEach(member => {
      const row = document.createElement("div"); row.className = "member";
      const avatar = document.createElement("div"); avatar.className = "avatar";
      avatar.style.color = member.color; avatar.style.background = `${member.color}20`;
      avatar.textContent = initials(member.name);
      const info = document.createElement("div"); info.className = "member-info";
      const name = document.createElement("div"); name.className = "member-name"; name.textContent = member.name;
      const status = document.createElement("div"); status.className = "member-status"; status.textContent = "● Online";
      info.append(name, status); row.append(avatar, info);
      if (member.id === socket.id) {
        const you = document.createElement("span"); you.className = "you-tag"; you.textContent = "YOU"; row.append(you);
      }
      ui.membersList.append(row);
    });
  }
  function initials(name) { return (name || "G").trim().split(/\s+/).slice(0, 2).map(p => p[0] || "").join("").toUpperCase(); }
  function showEmptyState() {
    if (ui.messages.querySelector(".empty-state")) return;
    const empty = document.createElement("div"); empty.className = "empty-state";
    empty.innerHTML = '<div class="empty-orbit"><span>✧</span></div><h3>Your conversation starts here</h3><p>Say hello. Share a thought. This space is yours.</p>';
    ui.messages.append(empty);
  }
  function addSystemMessage(text) {
    if (ui.messages.querySelector(".empty-state")) ui.messages.innerHTML = "";
    const node = document.createElement("div"); node.className = "system-message"; node.textContent = text;
    ui.messages.append(node); scrollToBottom();
  }
  function addMessage(message) {
    const existing = document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
    if (existing) return;
    if (ui.messages.querySelector(".empty-state")) ui.messages.innerHTML = "";
    const mine = message.senderId === socket.id;
    const row = document.createElement("article"); row.className = `message-row${mine ? " mine" : ""}`;
    row.dataset.messageId = message.id;
    const avatar = document.createElement("div"); avatar.className = "message-avatar";
    avatar.textContent = initials(message.senderName || "Guest");
    avatar.style.color = message.senderColor || "#c8b6ff"; avatar.style.background = `${message.senderColor || "#a78bfa"}20`;
    const content = document.createElement("div"); content.className = "message-content";
    const meta = document.createElement("div"); meta.className = "message-meta";
    const name = document.createElement("strong"); name.textContent = message.senderName || "Guest";
    const time = document.createElement("time"); time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    meta.append(name, time); content.append(meta);
    if (message.text) {
      const bubble = document.createElement("div"); bubble.className = "bubble"; bubble.textContent = message.text; content.append(bubble);
    }
    if (message.file) content.append(renderFile(message.file));
    const reactionBar = document.createElement("div"); reactionBar.className = "reaction-bar";
    renderReactionCounts(reactionBar, message.id, message.reactions || {}); content.append(reactionBar);
    const picker = document.createElement("div"); picker.className = "reaction-picker";
    reactions.forEach(emoji => {
      const btn = document.createElement("button"); btn.type = "button"; btn.textContent = emoji;
      btn.title = `React ${emoji}`; btn.setAttribute("aria-label", `React ${emoji}`);
      btn.addEventListener("click", () => socket.emit("reaction:toggle", { messageId: message.id, emoji }));
      picker.append(btn);
    });
    content.append(picker); row.append(avatar, content); ui.messages.append(row); scrollToBottom();
  }
  function renderFile(file) {
    const wrap = document.createElement("div");
    if ((file.mime || "").startsWith("image/")) {
      const img = document.createElement("img"); img.className = "attachment"; img.src = file.url; img.alt = file.name; img.loading = "lazy";
      img.addEventListener("error", () => { img.replaceWith(fileLink(file)); });
      wrap.append(img);
    } else wrap.append(fileLink(file));
    const caption = document.createElement("div"); caption.style.cssText = "font-size:9px;color:#9993b7;margin-top:5px";
    caption.textContent = `${file.name} · ${formatBytes(file.size || 0)}`; wrap.append(caption);
    return wrap;
  }
  function fileLink(file) {
    const a = document.createElement("a"); a.className = "attachment-link"; a.href = file.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.download = file.name;
    const icon = document.createElement("span"); icon.textContent = "↧";
    const name = document.createElement("strong"); name.textContent = file.name;
    a.append(icon, name); return a;
  }
  function renderReactionCounts(container, messageId, data) {
    container.innerHTML = "";
    Object.entries(data || {}).forEach(([emoji, ids]) => {
      if (!ids || !ids.length) return;
      const btn = document.createElement("button"); btn.className = "reaction-btn"; btn.type = "button";
      btn.textContent = `${emoji} ${ids.length}`; btn.title = "Click to toggle your reaction";
      btn.addEventListener("click", () => socket.emit("reaction:toggle", { messageId, emoji }));
      container.append(btn);
    });
  }
  function scrollToBottom() { ui.messages.scrollTop = ui.messages.scrollHeight; }

  // Live public room browser and host approval controls.
  const pendingRequests = new Map();
  let requestingRoomCode = null;
  function renderPublicRooms(rooms = []) {
    if (!ui.publicRoomsList) return;
    ui.publicRoomsList.replaceChildren();

    // Keep the lobby clean: show this section only while at least one public
    // room is actually online. The server broadcasts again when rooms change.
    const onlineRooms = Array.isArray(rooms) ? rooms.filter(room => room && room.code && Number(room.members) > 0) : [];
    ui.onlineRoomsSection?.classList.toggle("hidden", onlineRooms.length === 0);
    if (!onlineRooms.length) return;

    onlineRooms.forEach(room => {
      const button=document.createElement("button"); button.type="button"; button.className="public-room-card"; button.disabled=Boolean(currentCode)||requestingRoomCode===room.code;
      const icon=document.createElement("span"); icon.className="room-live-icon"; icon.textContent="✧";
      const info=document.createElement("span"); info.className="public-room-info";
      const name=document.createElement("strong"); name.textContent=`Room ${room.code}`;
      const count=document.createElement("small"); count.textContent=`${room.members} ${room.members===1?"person":"people"} online · approval required`;
      info.append(name,count); const arrow=document.createElement("span"); arrow.className="room-join-arrow"; arrow.textContent="→"; button.append(icon,info,arrow);
      button.addEventListener("click",()=>requestPublicRoom(room.code,button)); ui.publicRoomsList.append(button);
    });
  }
  function requestPublicRoom(code,button) {
    if(currentCode||!socket.connected){showError("Connect to the server first.");return;}
    currentName=nameValue("joinName"); requestingRoomCode=code; button.disabled=true;
    const small=button.querySelector("small"),old=small?.textContent;if(small)small.textContent="Sending join request…";
    socket.timeout(8000).emit("room:request",{code,name:currentName},(error,result)=>{
      requestingRoomCode=null;
      if(error||!result?.ok){showError(error?"Server did not respond. Try again.":(result?.error||"Could not request to join."));socket.emit("rooms:public:list");return;}
      if(result.status==="joined"&&result.code&&result.snapshot){setRoom(result.code,result.snapshot);return;}
      showToast("Join request sent. Waiting for host approval.");if(small)small.textContent="Request sent · waiting for host";
      setTimeout(()=>{if(button.isConnected&&!currentCode){button.disabled=false;if(small)small.textContent=old||"Tap to request access";}},10000);
    });
  }
  function renderJoinRequests(){
    if(!ui.roomRequestsPanel||!ui.roomRequestsList)return;
    ui.pendingRequestCount.textContent=String(pendingRequests.size);ui.roomRequestsPanel.classList.toggle("hidden",pendingRequests.size===0);ui.roomRequestsList.replaceChildren();
    if(!pendingRequests.size){const empty=document.createElement("div");empty.className="rooms-empty";empty.textContent="No pending requests.";ui.roomRequestsList.append(empty);return;}
    for(const [id,r] of pendingRequests){const item=document.createElement("div");item.className="room-request-item";const name=document.createElement("div");name.className="room-request-name";name.textContent=`${r.name} wants to join ${r.code}`;const actions=document.createElement("div");actions.className="room-request-actions";const allow=document.createElement("button");allow.type="button";allow.className="room-request-btn allow";allow.textContent="✓ Allow";const reject=document.createElement("button");reject.type="button";reject.className="room-request-btn reject";reject.textContent="✕ Reject";allow.addEventListener("click",()=>answerJoinRequest(id,true,allow,reject));reject.addEventListener("click",()=>answerJoinRequest(id,false,allow,reject));actions.append(allow,reject);item.append(name,actions);ui.roomRequestsList.append(item);}
  }
  function answerJoinRequest(id,allow,allowButton,rejectButton){allowButton.disabled=rejectButton.disabled=true;socket.timeout(8000).emit("room:request:answer",{requestId:id,allow},(error,result)=>{if(error||!result?.ok){allowButton.disabled=rejectButton.disabled=false;showToast(error?"Server did not respond.":(result?.error||"Could not process request."));return;}pendingRequests.delete(id);renderJoinRequests();showToast(allow?"Join request approved.":"Join request rejected.");});}
  socket.on("rooms:public:update",renderPublicRooms);
  socket.on("room:join-request",request=>{if(!request?.requestId||!request.code)return;pendingRequests.set(request.requestId,request);renderJoinRequests();showToast(`${request.name||"Someone"} wants to join your room.`);});
  socket.on("room:request:result",data=>{if(data?.status==="rejected")showToast("The host rejected your join request.");if(data?.status==="expired")showToast("Join request expired. Try again.");if(data?.status==="approved"&&data.code&&data.snapshot)setRoom(data.code,data.snapshot);});
  ui.refreshRoomsBtn?.addEventListener("click",()=>socket.emit("rooms:public:list"));
  socket.on("connect",()=>socket.emit("rooms:public:list"));
  document.querySelectorAll("#tcCallBar,#tcCallModal,[id^='tcCall']").forEach(node=>node.remove());

  // Theme picker: apply instantly and persist each visitor's choice locally.
  const themeModal = document.getElementById("themeModal");
  const openThemes = document.getElementById("openThemes");
  const floatingTheme = document.getElementById("floatingTheme");
  const closeThemes = document.getElementById("closeThemes");
  const themeOptions = [...document.querySelectorAll("[data-theme-choice]")];
  const allowedThemes = new Set(["midnight", "aurora", "ocean", "sakura", "desert", "dark", "mono", "graphite", "ice", "ember", "light"]);
  const themeColors = {midnight:"#0d1023",aurora:"#071d2a",ocean:"#071827",sakura:"#210d27",desert:"#251407",dark:"#050505",mono:"#181818",graphite:"#10111e",ice:"#071e2a",ember:"#1e0c08",light:"#f4f6fb"};

  function applyTheme(theme) {
    const safeTheme = allowedThemes.has(theme) ? theme : "midnight";
    document.body.dataset.theme = safeTheme;
    themeOptions.forEach(option => {
      const selected = option.dataset.themeChoice === safeTheme;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", themeColors[safeTheme]);
  }
  function openThemePicker() {
    themeModal.hidden = false;
    themeModal.classList.add("open");
    document.body.classList.add("theme-picker-open");
    closeThemes.focus();
  }
  function closeThemePicker() {
    themeModal.classList.remove("open");
    themeModal.hidden = true;
    document.body.classList.remove("theme-picker-open");
    openThemes.focus();
  }
  let savedTheme = "midnight";
  try { savedTheme = localStorage.getItem("tempchat-theme") || "midnight"; } catch (_) {}
  applyTheme(savedTheme);
  openThemes.addEventListener("click", openThemePicker);
  floatingTheme.addEventListener("click", openThemePicker);
  closeThemes.addEventListener("click", closeThemePicker);
  themeModal.addEventListener("click", event => { if (event.target === themeModal || event.target.classList.contains("theme-backdrop")) closeThemePicker(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !themeModal.hidden) closeThemePicker(); });
  themeOptions.forEach(option => option.addEventListener("click", () => {
    const theme = option.dataset.themeChoice;
    applyTheme(theme);
    try { localStorage.setItem("tempchat-theme", theme); } catch (_) {}
    showToast(`${option.querySelector("strong").textContent} theme applied`);
  }));

  const params = new URLSearchParams(location.search);
  const inviteCode = (params.get("room") || "").toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(inviteCode)) {
    ui.roomCode.value = inviteCode;
    ui.joinName.value = "";
    setTimeout(() => ui.joinName.focus(), 100);
  }
})();
