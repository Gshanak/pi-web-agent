// ===== Pi Web Agent - Frontend Application =====

// --- State ---
let ws = null;
let currentProject = null;
let currentModel = "";
let isAgentRunning = false;
let openTabs = [];
let activeTab = null;
let chatHistory = [];

// --- DOM refs ---
const $ = (id) => document.getElementById(id);
const modelSelect = $("modelSelect");
const projectSelect = $("projectSelect");
const newProjectBtn = $("newProjectBtn");
const previewBtn = $("previewBtn");
const terminalBtn = $("terminalBtn");
const clearBtn = $("clearBtn");
const statusDot = $("statusDot");
const fileTree = $("fileTree");
const refreshFilesBtn = $("refreshFilesBtn");
const chatMessages = $("chatMessages");
const chatInput = $("chatInput");
const sendBtn = $("sendBtn");
const stopBtn = $("stopBtn");
const editorTabs = $("editorTabs");
const editorPlaceholder = $("editorPlaceholder");
const codeView = $("codeView");
const codeContent = $("codeContent");
const previewFrame = $("previewFrame");
const refreshPreviewBtn = $("refreshPreviewBtn");
const terminalOutput = $("terminalOutput");
const clearTerminalBtn = $("clearTerminalBtn");
const newProjectModal = $("newProjectModal");
const newProjectName = $("newProjectName");
const cancelNewProject = $("cancelNewProject");
const confirmNewProject = $("confirmNewProject");
const welcomeOverlay = $("welcomeOverlay");
const getStartedBtn = $("getStartedBtn");

// ===== WebSocket =====
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => { statusDot.className = "status-dot connected"; };
  ws.onclose = () => { statusDot.className = "status-dot disconnected"; setTimeout(connectWS, 2000); };
  ws.onerror = () => { statusDot.className = "status-dot disconnected"; };
  ws.onmessage = (event) => { handleMessage(JSON.parse(event.data)); };
}

// ===== Message Handler =====
function handleMessage(msg) {
  switch (msg.type) {
    case "connected":
      currentModel = msg.defaultModel;
      loadModels();
      loadProjects();
      break;
    case "init_ack":
      currentModel = msg.model;
      modelSelect.value = currentModel;
      chatHistory = msg.history || [];
      renderChatHistory();
      loadFileTree();
      refreshPreview();
      break;
    case "user_message":
      addMessage("user", msg.content);
      break;
    case "text_stream":
      if (!isAgentRunning) setRunning(true);
      appendAssistantText(msg.text);
      break;
    case "text_done":
      finalizeAssistantText(msg.text);
      break;
    case "tool_call":
      renderToolCard(msg.callId, msg.tool, msg.args);
      break;
    case "tool_start":
      const card = document.querySelector(`[data-call-id="${msg.callId}"]`);
      if (card) card.classList.add("running");
      if (msg.command) appendTerminal("cmd", `$ ${msg.command}\n`);
      break;
    case "tool_stream":
      appendToToolStream(msg.callId, msg.data, msg.stderr);
      if (msg.data) appendTerminal(msg.stderr ? "err" : "out", msg.data);
      break;
    case "tool_result":
      updateToolResult(msg.callId, msg.result, msg.tool);
      const card2 = document.querySelector(`[data-call-id="${msg.callId}"]`);
      if (card2) card2.classList.remove("running");
      if (["write_file", "edit_file", "delete_file", "create_directory"].includes(msg.tool)) {
        loadFileTree();
        refreshPreview();
        if (msg.path) openFile(msg.path);
      }
      break;
    case "turn_start":
      statusDot.className = "status-dot busy";
      break;
    case "agent_done":
      setRunning(false);
      if (msg.maxed) addMessage("error", "Agent reached maximum turns (20). Stopping to prevent loop.");
      break;
    case "agent_stopped":
      setRunning(false);
      break;
    case "error":
      addMessage("error", msg.message);
      setRunning(false);
      break;
    case "model_changed":
      currentModel = msg.model;
      break;
    case "session_cleared":
      chatHistory = [];
      chatMessages.innerHTML = "";
      break;
  }
}

// ===== Chat =====
function addMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = formatMessage(content);
  chatMessages.appendChild(div);
  scrollChat();
}

function formatMessage(text) {
  if (!text) return "";
  let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => `<pre><code class="language-${lang}">${code.trim()}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.split("\n\n").map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  return html;
}

let currentAssistantDiv = null;
let currentAssistantText = "";

function appendAssistantText(text) {
  if (!currentAssistantDiv) {
    currentAssistantDiv = document.createElement("div");
    currentAssistantDiv.className = "message assistant";
    chatMessages.appendChild(currentAssistantDiv);
    currentAssistantText = "";
  }
  currentAssistantText += text;
  currentAssistantDiv.innerHTML = formatMessage(currentAssistantText);
  scrollChat();
}

function finalizeAssistantText(fullText) {
  if (currentAssistantDiv && fullText) {
    currentAssistantText = fullText;
    currentAssistantDiv.innerHTML = formatMessage(fullText);
    currentAssistantDiv.querySelectorAll("pre code").forEach((block) => {
      try { hljs.highlightElement(block); } catch {}
    });
  }
  currentAssistantDiv = null;
  currentAssistantText = "";
}

function renderChatHistory() {
  chatMessages.innerHTML = "";
  for (const msg of chatHistory) {
    if (msg.role === "user") addMessage("user", msg.content);
    else if (msg.role === "assistant" && msg.content) addMessage("assistant", msg.content);
  }
}

function renderToolCard(callId, tool, args) {
  const card = document.createElement("div");
  card.className = "tool-card running";
  card.dataset.callId = callId;
  const icons = { write_file: "📝", read_file: "📖", edit_file: "✏️", list_files: "📂", create_directory: "📁", run_command: "⚡", delete_file: "🗑️" };
  let argsStr = "";
  if (tool === "run_command") argsStr = args.command || "";
  else if (tool === "write_file") argsStr = args.path || "";
  else if (tool === "read_file") argsStr = args.path || "";
  else if (tool === "edit_file") argsStr = args.path || "";
  else if (tool === "list_files") argsStr = args.dir_path || "/";
  else if (tool === "create_directory") argsStr = args.path || "";
  else if (tool === "delete_file") argsStr = args.path || "";
  card.innerHTML = `<div class="tool-header"><span class="tool-icon">${icons[tool] || "🔧"}</span><span class="tool-name">${tool}</span><span class="tool-args">${escapeHtml(argsStr)}</span></div><div class="tool-result" style="display:none;"></div><div class="tool-stream" style="display:none;"></div>`;
  chatMessages.appendChild(card);
  scrollChat();
}

function updateToolResult(callId, result, tool) {
  const card = document.querySelector(`[data-call-id="${callId}"]`);
  if (!card) return;
  const resultDiv = card.querySelector(".tool-result");
  resultDiv.textContent = result || "(no output)";
  resultDiv.style.display = "block";
  const streamDiv = card.querySelector(".tool-stream");
  if (streamDiv && !streamDiv.textContent.trim()) streamDiv.style.display = "none";
}

function appendToToolStream(callId, data, stderr) {
  const card = document.querySelector(`[data-call-id="${callId}"]`);
  if (!card) return;
  const streamDiv = card.querySelector(".tool-stream");
  streamDiv.style.display = "block";
  streamDiv.textContent += data || "";
  scrollChat();
}

function setRunning(running) {
  isAgentRunning = running;
  if (running) {
    sendBtn.style.display = "none";
    stopBtn.style.display = "block";
    statusDot.className = "status-dot busy";
  } else {
    sendBtn.style.display = "block";
    stopBtn.style.display = "none";
    statusDot.className = "status-dot connected";
  }
}

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (!currentProject) { addMessage("error", "Please select or create a project first."); return; }
  ws.send(JSON.stringify({ type: "chat", content: text }));
  chatInput.value = "";
  chatInput.style.height = "auto";
}

function scrollChat() { chatMessages.scrollTop = chatMessages.scrollHeight; }

// ===== Terminal =====
function appendTerminal(cls, text) {
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text;
  terminalOutput.appendChild(span);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

// ===== File Tree =====
async function loadFileTree() {
  if (!currentProject) return;
  try {
    const resp = await fetch(`/api/files?project=${encodeURIComponent(currentProject)}`);
    const data = await resp.json();
    fileTree.innerHTML = "";
    renderTreeNodes(data.tree, fileTree, 0);
  } catch (err) {
    fileTree.innerHTML = `<div style="padding:8px;color:var(--text-dim);">Error loading files</div>`;
  }
}

function renderTreeNodes(nodes, parent, depth) {
  for (const node of nodes) {
    const div = document.createElement("div");
    div.className = `tree-item ${node.type}`;
    div.style.paddingLeft = `${12 + depth * 16}px`;
    const icon = node.type === "dir" ? "📁" : "📄";
    div.innerHTML = `<span>${icon}</span> <span>${escapeHtml(node.name)}</span>`;
    if (node.type === "file") {
      div.addEventListener("click", () => openFile(node.path));
    } else {
      div.addEventListener("click", () => {
        const children = div.nextElementSibling;
        if (children && children.tagName === "DIV") {
          children.style.display = children.style.display === "none" ? "block" : "none";
        }
      });
    }
    parent.appendChild(div);
    if (node.children) {
      const childContainer = document.createElement("div");
      parent.appendChild(childContainer);
      renderTreeNodes(node.children, childContainer, depth + 1);
    }
  }
}

// ===== Editor =====
async function openFile(filePath) {
  if (!currentProject) return;
  try {
    const resp = await fetch(`/api/file?project=${encodeURIComponent(currentProject)}&path=${encodeURIComponent(filePath)}`);
    const data = await resp.json();
    if (!openTabs.includes(filePath)) { openTabs.push(filePath); renderTabs(); }
    activeTab = filePath;
    renderTabs();
    editorPlaceholder.style.display = "none";
    codeView.style.display = "block";
    codeContent.textContent = data.content;
    codeContent.className = `language-${getLang(filePath)}`;
    try { hljs.highlightElement(codeContent); } catch {}
  } catch (err) { console.error("Failed to open file:", err); }
}

function renderTabs() {
  editorTabs.innerHTML = "";
  for (const tab of openTabs) {
    const t = document.createElement("div");
    t.className = `editor-tab ${tab === activeTab ? "active" : ""}`;
    t.textContent = tab.split("/").pop();
    t.addEventListener("click", () => openFile(tab));
    editorTabs.appendChild(t);
  }
}

function getLang(path) {
  const ext = path.split(".").pop().toLowerCase();
  const map = { js: "javascript", ts: "typescript", html: "html", css: "css", json: "json", py: "python", md: "markdown", sh: "bash", xml: "xml", svg: "xml" };
  return map[ext] || "plaintext";
}

// ===== Preview =====
function refreshPreview() {
  if (!currentProject) return;
  previewFrame.src = `/preview/${encodeURIComponent(currentProject)}/index.html`;
}

// ===== Projects =====
async function loadProjects() {
  try {
    const resp = await fetch("/api/projects");
    const data = await resp.json();
    projectSelect.innerHTML = '<option value="">— Select Project —</option>';
    for (const p of data.projects) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      projectSelect.appendChild(opt);
    }
  } catch {}
}

async function createProject(name) {
  try {
    const resp = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    const data = await resp.json();
    await loadProjects();
    projectSelect.value = data.name;
    selectProject(data.name);
  } catch (err) { addMessage("error", "Failed to create project: " + err.message); }
}

function selectProject(name) {
  currentProject = name;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "init", project: name, model: currentModel }));
}

// ===== Models =====
async function loadModels() {
  try {
    const resp = await fetch("/api/models");
    const data = await resp.json();
    modelSelect.innerHTML = "";
    const freeGroup = document.createElement("optgroup");
    freeGroup.label = "Free Models";
    for (const m of (data.models || [])) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.name} (${m.context ? (m.context/1000)+"k" : "?"})`;
      freeGroup.appendChild(opt);
    }
    modelSelect.appendChild(freeGroup);
    const allGroup = document.createElement("optgroup");
    allGroup.label = "All Models";
    for (const m of (data.all || []).slice(0, 50)) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.name} (${m.context ? (m.context/1000)+"k" : "?"})`;
      allGroup.appendChild(opt);
    }
    modelSelect.appendChild(allGroup);
    modelSelect.value = currentModel;
  } catch {}
}

// ===== Utility =====
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ===== Event Listeners =====
sendBtn.addEventListener("click", sendMessage);
stopBtn.addEventListener("click", () => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" })); });
chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
chatInput.addEventListener("input", () => { chatInput.style.height = "auto"; chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px"; });
projectSelect.addEventListener("change", () => { const val = projectSelect.value; if (val) selectProject(val); });
modelSelect.addEventListener("change", () => { currentModel = modelSelect.value; if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "set_model", model: currentModel })); });
newProjectBtn.addEventListener("click", () => { newProjectModal.style.display = "flex"; newProjectName.value = ""; newProjectName.focus(); });
cancelNewProject.addEventListener("click", () => { newProjectModal.style.display = "none"; });
confirmNewProject.addEventListener("click", () => { const name = newProjectName.value.trim(); if (name) { createProject(name); newProjectModal.style.display = "none"; } });
newProjectName.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmNewProject.click(); });
refreshFilesBtn.addEventListener("click", loadFileTree);
refreshPreviewBtn.addEventListener("click", refreshPreview);
clearTerminalBtn.addEventListener("click", () => { terminalOutput.innerHTML = ""; });
clearBtn.addEventListener("click", () => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "clear_session" })); });
previewBtn.addEventListener("click", () => { const container = $("previewContainer"); container.style.display = container.style.display === "none" ? "flex" : "none"; previewBtn.classList.toggle("active"); });
terminalBtn.addEventListener("click", () => { const container = $("terminalContainer"); container.style.display = container.style.display === "none" ? "flex" : "none"; terminalBtn.classList.toggle("active"); });
getStartedBtn.addEventListener("click", () => { welcomeOverlay.style.display = "none"; });

// ===== Init =====
connectWS();
