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
const refreshModelsBtn = $("refreshModelsBtn");
const refreshModelsModal = $("refreshModelsModal");
const scrapeLoading = $("scrapeLoading");
const scrapeResults = $("scrapeResults");
const scrapeModelList = $("scrapeModelList");
const scrapeModelCount = $("scrapeModelCount");
const selectAllModels = $("selectAllModels");
const deselectAllModels = $("deselectAllModels");
const cancelRefreshModels = $("cancelRefreshModels");
const confirmRefreshModels = $("confirmRefreshModels");

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
    case "agent_text":
      addMessage("agent", msg.content, msg.isStreaming);
      break;
    case "tool_call":
      addMessage("tool", `${msg.tool}${msg.args ? ": " + JSON.stringify(msg.args).slice(0, 200) : ""}`);
      break;
    case "tool_result":
      addMessage("tool_result", msg.result);
      break;
    case "command_output":
      terminalOutput.innerHTML += msg.output;
      terminalOutput.scrollTop = terminalOutput.scrollHeight;
      break;
    case "file_changed":
      loadFileTree();
      refreshPreview();
      break;
    case "agent_done":
      isAgentRunning = false;
      sendBtn.style.display = "";
      stopBtn.style.display = "none";
      break;
    case "agent_stopped":
      isAgentRunning = false;
      sendBtn.style.display = "";
      stopBtn.style.display = "none";
      break;
    case "error":
      addMessage("error", msg.message);
      break;
    case "model_changed":
      currentModel = msg.model;
      modelSelect.value = currentModel;
      break;
    case "session_cleared":
      chatHistory = [];
      chatMessages.innerHTML = "";
      addMessage("system", "Session cleared");
      break;
    default:
      console.log("Unknown message:", msg);
  }
}

// ===== Chat =====
function addMessage(role, content, isStreaming) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  if (role === "agent" && isStreaming) {
    const last = chatMessages.lastElementChild;
    if (last && last.classList.contains("agent") && last.dataset.streaming === "true") {
      last.textContent += content;
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return;
    }
    div.dataset.streaming = "true";
  }
  div.textContent = content;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderChatHistory() {
  chatMessages.innerHTML = "";
  chatHistory.forEach((msg) => {
    const div = document.createElement("div");
    div.className = `message ${msg.role}`;
    div.textContent = msg.content;
    if (msg.role === "agent" || msg.role === "tool_result") {
      try { hljs.highlightElement(div); } catch {}
    }
    chatMessages.appendChild(div);
  });
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendMessage() {
  const content = chatInput.value.trim();
  if (!content || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (!currentProject) { addMessage("error", "Select or create a project first"); return; }
  if (isAgentRunning) { addMessage("error", "Agent is running. Use Stop to cancel."); return; }
  ws.send(JSON.stringify({ type: "chat", content }));
  chatInput.value = "";
  chatInput.style.height = "auto";
  isAgentRunning = true;
  sendBtn.style.display = "none";
  stopBtn.style.display = "";
}

function stopAgent() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
  }
}

// ===== File Tree =====
async function loadFileTree() {
  if (!currentProject) return;
  try {
    const resp = await fetch(`/api/files?project=${encodeURIComponent(currentProject)}`);
    const files = await resp.json();
    fileTree.innerHTML = "";
    renderFileTree(files, fileTree, "");
  } catch (err) {
    console.error("Failed to load file tree:", err);
  }
}

function renderFileTree(items, container, basePath) {
  items.forEach((item) => {
    const fullPath = basePath ? `${basePath}/${item.name}` : item.name;
    const div = document.createElement("div");
    div.className = item.type === "dir" ? "file-item dir" : "file-item file";
    div.textContent = (item.type === "dir" ? "📁 " : "📄 ") + item.name;
    if (item.type === "dir" && item.children) {
      const childContainer = document.createElement("div");
      childContainer.className = "file-children";
      childContainer.style.display = "none";
      div.addEventListener("click", () => {
        childContainer.style.display = childContainer.style.display === "none" ? "block" : "none";
      });
      renderFileTree(item.children, childContainer, fullPath);
      div.appendChild(childContainer);
    } else if (item.type === "file") {
      div.addEventListener("click", () => openFile(fullPath));
    }
    container.appendChild(div);
  });
}

async function openFile(filePath) {
  try {
    const resp = await fetch(`/api/file?project=${encodeURIComponent(currentProject)}&path=${encodeURIComponent(filePath)}`);
    const data = await resp.json();
    editorPlaceholder.style.display = "none";
    codeView.style.display = "block";
    codeContent.textContent = data.content;
    try { hljs.highlightElement(codeContent); } catch {}
  } catch (err) { console.error("Failed to open file:", err); }
}

// ===== Preview =====
function refreshPreview() {
  if (!currentProject) return;
  previewFrame.src = `/preview/${encodeURIComponent(currentProject)}/`;
}

// ===== Projects =====
async function loadProjects() {
  try {
    const resp = await fetch("/api/projects");
    const projects = await resp.json();
    projectSelect.innerHTML = '<option value="">— Select Project —</option>';
    projects.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      projectSelect.appendChild(opt);
    });
  } catch {}
}

function selectProject(name) {
  currentProject = name;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "init", project: name, model: currentModel }));
  }
}

async function createProject(name) {
  try {
    const resp = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (resp.ok) {
      await loadProjects();
      projectSelect.value = name;
      selectProject(name);
    } else {
      addMessage("error", "Failed to create project: " + (await resp.text()));
    }
  } catch (err) { addMessage("error", "Failed to create project: " + err.message); }
}

// ===== Models =====
async function loadModels() {
  try {
    const resp = await fetch("/api/models");
    const data = await resp.json();
    modelSelect.innerHTML = "";
    if (data.models && data.models.length) {
      const group = document.createElement("optgroup");
      group.label = "Free Models";
      data.models.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name;
        group.appendChild(opt);
      });
      modelSelect.appendChild(group);
    }
    if (data.all && data.all.length) {
      const group = document.createElement("optgroup");
      group.label = "All Models";
      data.all.slice(0, 50).forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name;
        group.appendChild(opt);
      });
      modelSelect.appendChild(group);
    }
    modelSelect.value = currentModel;
  } catch {}
}

// ===== Refresh Models Modal =====
async function openRefreshModelsModal() {
  refreshModelsModal.style.display = "flex";
  scrapeLoading.style.display = "block";
  scrapeResults.style.display = "none";
  confirmRefreshModels.style.display = "none";

  try {
    const resp = await fetch("/api/scrape-free-models");
    if (!resp.ok) { scrapeLoading.textContent = "Failed to fetch models: " + resp.status; return; }
    const data = await resp.json();
    scrapeLoading.style.display = "none";
    scrapeResults.style.display = "block";
    confirmRefreshModels.style.display = "";
    scrapeModelList.innerHTML = "";

    if (data.models && data.models.length) {
      scrapeModelCount.textContent = `${data.models.length} free models found`;
      data.models.forEach((m) => {
        const label = document.createElement("label");
        label.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = m.id;
        cb.checked = m.allowed || false;
        const text = document.createElement("span");
        text.textContent = `${m.name || m.id} (${m.context || "unknown"} ctx)`;
        label.appendChild(cb);
        label.appendChild(text);
        scrapeModelList.appendChild(label);
      });
    } else {
      scrapeModelList.innerHTML = "<p>No free models found.</p>";
    }
  } catch (err) {
    scrapeLoading.textContent = "Error: " + err.message;
  }
}

async function confirmUpdateModels() {
  const checkboxes = scrapeModelList.querySelectorAll("input[type=checkbox]:checked");
  const modelIds = Array.from(checkboxes).map((cb) => cb.value);

  try {
    const resp = await fetch("/api/update-free-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: modelIds }),
    });
    if (resp.ok) {
      refreshModelsModal.style.display = "none";
      await loadModels();
      addMessage("system", `Updated allow-list with ${modelIds.length} free models`);
    } else {
      addMessage("error", "Failed to update models: " + (await resp.text()));
    }
  } catch (err) {
    addMessage("error", "Failed to update models: " + err.message);
  }
}

// ===== Event Listeners =====
sendBtn.addEventListener("click", sendMessage);
stopBtn.addEventListener("click", stopAgent);
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
refreshModelsBtn.addEventListener("click", openRefreshModelsModal);
cancelRefreshModels.addEventListener("click", () => { refreshModelsModal.style.display = "none"; });
confirmRefreshModels.addEventListener("click", confirmUpdateModels);
selectAllModels.addEventListener("click", () => {
  scrapeModelList.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = true; });
});
deselectAllModels.addEventListener("click", () => {
  scrapeModelList.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = false; });
});

// ===== Init =====
connectWS();
