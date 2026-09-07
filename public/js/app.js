// ===== Pi Web Agent - Mobile Frontend =====

// --- State ---
let ws = null;
let currentProject = null;
let currentModel = "";
let isAgentRunning = false;
let chatHistory = [];
let currentScreen = "onboarding";
let recognition = null;
let isListening = false;

// --- DOM helpers ---
const $ = (id) => document.getElementById(id);

// --- Screen Navigation ---
function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const screen = $(name);
  if (screen) screen.classList.add("active");
  currentScreen = name;

  // Update bottom nav
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === name);
  });

  // Load data when entering certain screens
  if (name === "home") { loadProjects(); loadModels(); }
  if (name === "files" && currentProject) loadFileTree();
  if (name === "preview" && currentProject) refreshPreview();
}

// --- WebSocket ---
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => { updateStatus("connected"); };
  ws.onclose = () => { updateStatus("disconnected"); setTimeout(connectWS, 2000); };
  ws.onerror = () => { updateStatus("disconnected"); };
  ws.onmessage = (event) => { handleMessage(JSON.parse(event.data)); };
}

function updateStatus(status) {
  const dot = $("statusDot");
  if (dot) dot.className = `status-dot ${status}`;
}

// --- Message Handler ---
function handleMessage(msg) {
  switch (msg.type) {
    case "connected":
      currentModel = msg.defaultModel;
      loadModels();
      loadProjects();
      break;
    case "init_ack":
      currentModel = msg.model;
      chatHistory = msg.history || [];
      renderChatHistory();
      loadFileTree();
      refreshPreview();
      break;
    case "user_message":
      addMessage("user", msg.content);
      break;
    case "text_stream":
      addMessage("agent", msg.text, true);
      break;
    case "text_done":
      // Final text — no action needed, streaming already displayed it
      break;
    case "tool_call":
      addMessage("tool", `${msg.tool}${msg.args ? ": " + JSON.stringify(msg.args).slice(0, 200) : ""}`);
      break;
    case "tool_result":
      if (msg.result) addMessage("tool_result", msg.result);
      break;
    case "tool_start":
      addMessage("tool", `▶ ${msg.tool}${msg.command ? ": " + msg.command : ""}`);
      break;
    case "tool_stream":
      const termOut = $("terminalOutput");
      if (termOut) {
        termOut.innerHTML += msg.data;
        termOut.scrollTop = termOut.scrollHeight;
      }
      break;
    case "file_changed":
      loadFileTree();
      refreshPreview();
      break;
    case "agent_done":
      isAgentRunning = false;
      $("sendBtn").style.display = "";
      $("stopBtn").style.display = "none";
      break;
    case "agent_stopped":
      isAgentRunning = false;
      $("sendBtn").style.display = "";
      $("stopBtn").style.display = "none";
      break;
    case "error":
      addMessage("error", msg.message);
      break;
    case "model_changed":
      currentModel = msg.model;
      updateModelDisplay();
      break;
    case "session_cleared":
      chatHistory = [];
      const cm = $("chatMessages");
      if (cm) {
        cm.innerHTML = '<div class="chat-welcome"><div class="chat-welcome-logo">π</div><p>Session cleared. Start a new conversation.</p></div>';
      }
      break;
    default:
      console.log("Unknown message:", msg);
  }
}

// --- Chat ---
function addMessage(role, content, isStreaming) {
  const cm = $("chatMessages");
  if (!cm) return;

  // Remove welcome message
  const welcome = cm.querySelector(".chat-welcome");
  if (welcome) welcome.remove();

  if (role === "agent" && isStreaming) {
    const last = cm.lastElementChild;
    if (last && last.classList.contains("agent") && last.dataset.streaming === "true") {
      last.textContent += content;
      cm.scrollTop = cm.scrollHeight;
      return;
    }
  }

  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = content;
  if (isStreaming) div.dataset.streaming = "true";
  cm.appendChild(div);
  cm.scrollTop = cm.scrollHeight;
}

function renderChatHistory() {
  const cm = $("chatMessages");
  if (!cm) return;
  cm.innerHTML = "";
  if (!chatHistory.length) {
    cm.innerHTML = '<div class="chat-welcome"><div class="chat-welcome-logo">π</div><p>Start a conversation to build something amazing</p></div>';
    return;
  }
  chatHistory.forEach((msg) => {
    const div = document.createElement("div");
    div.className = `message ${msg.role}`;
    div.textContent = msg.content;
    cm.appendChild(div);
  });
  cm.scrollTop = cm.scrollHeight;
}

function sendMessage() {
  const input = $("chatInput");
  if (!input) return;
  const content = input.value.trim();
  if (!content || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (!currentProject) {
    addMessage("error", "Select or create a project first");
    return;
  }
  if (isAgentRunning) {
    addMessage("error", "Agent is running. Use Stop to cancel.");
    return;
  }
  ws.send(JSON.stringify({ type: "chat", content }));
  input.value = "";
  isAgentRunning = true;
  $("sendBtn").style.display = "none";
  $("stopBtn").style.display = "flex";
}

function stopAgent() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
  }
}

// --- File Tree ---
async function loadFileTree() {
  if (!currentProject) return;
  try {
    const resp = await fetch(`/api/files?project=${encodeURIComponent(currentProject)}`);
    const data = await resp.json();
    const tree = $("fileTree");
    if (!tree) return;
    tree.innerHTML = "";
    if (data.tree && data.tree.length) {
      renderFileTree(data.tree, tree, "");
    } else {
      tree.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No files yet. Ask the AI to build something.</div>';
    }
  } catch (err) {
    console.error("Failed to load file tree:", err);
  }
}

function renderFileTree(items, container, basePath) {
  items.forEach((item) => {
    const fullPath = basePath ? `${basePath}/${item.name}` : item.name;
    const div = document.createElement("div");
    div.className = item.type === "dir" ? "tree-item dir" : "tree-item file";
    div.textContent = (item.type === "dir" ? "📁 " : "📄 ") + item.name;
    if (item.type === "dir" && item.children) {
      const childContainer = document.createElement("div");
      childContainer.className = "tree-children";
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
    const viewer = $("fileViewer");
    const tree = $("fileTree");
    if (viewer && tree) {
      viewer.style.display = "flex";
      tree.style.display = "none";
    }
    $("fileViewerName").textContent = filePath;
    $("codeContent").textContent = data.content;
  } catch (err) {
    console.error("Failed to open file:", err);
  }
}

// --- Preview ---
function refreshPreview() {
  if (!currentProject) return;
  const frame = $("previewFrame");
  const empty = $("previewEmpty");
  if (frame) {
    frame.src = `/preview/${encodeURIComponent(currentProject)}/`;
    frame.style.display = "block";
    if (empty) empty.style.display = "none";
  }
}

// --- Projects ---
async function loadProjects() {
  try {
    const resp = await fetch("/api/projects");
    const data = await resp.json();
    const list = $("recentProjects");
    if (!list) return;
    list.innerHTML = "";
    if (data.projects && data.projects.length) {
      data.projects.forEach((p) => {
        const item = document.createElement("div");
        item.className = "recent-item";
        item.innerHTML = `
          <div class="recent-item-icon">📁</div>
          <div class="recent-item-text">${p}</div>
          <svg class="recent-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        `;
        item.addEventListener("click", () => {
          selectProject(p);
          showScreen("chat");
        });
        list.appendChild(item);
      });
    } else {
      list.innerHTML = '<div class="recent-empty">No projects yet. Create one to get started.</div>';
    }
  } catch {}
}

function selectProject(name) {
  currentProject = name;
  const bar = $("chatProjectName");
  if (bar) bar.textContent = name;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "init", project: name, model: currentModel }));
  }
}

async function createProject(name) {
  try {
    const resp = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (resp.ok) {
      await loadProjects();
      selectProject(name);
      showScreen("chat");
    } else {
      addMessage("error", "Failed to create project: " + (await resp.text()));
    }
  } catch (err) {
    addMessage("error", "Failed to create project: " + err.message);
  }
}

// --- Models ---
async function loadModels() {
  try {
    const resp = await fetch("/api/models");
    const data = await resp.json();
    const select = $("modelSelect");
    if (!select) return;
    select.innerHTML = "";
    if (data.models && data.models.length) {
      const group = document.createElement("optgroup");
      group.label = "Free Models";
      data.models.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name;
        group.appendChild(opt);
      });
      select.appendChild(group);
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
      select.appendChild(group);
    }
    select.value = currentModel;
    updateModelDisplay();
  } catch {}
}

function updateModelDisplay() {
  const select = $("modelSelect");
  const badge = $("chatModelName");
  if (badge) {
    if (select && select.selectedOptions[0]) {
      badge.textContent = select.selectedOptions[0].textContent;
    } else {
      badge.textContent = currentModel || "AI";
    }
  }
}

// --- Refresh Models Modal ---
async function openRefreshModelsModal() {
  $("refreshModelsModal").style.display = "flex";
  $("scrapeLoading").style.display = "block";
  $("scrapeResults").style.display = "none";
  $("confirmRefreshModels").style.display = "none";

  try {
    const resp = await fetch("/api/scrape-free-models");
    if (!resp.ok) { $("scrapeLoading").textContent = "Failed to fetch models: " + resp.status; return; }
    const data = await resp.json();
    $("scrapeLoading").style.display = "none";
    $("scrapeResults").style.display = "block";
    $("confirmRefreshModels").style.display = "";
    $("scrapeModelList").innerHTML = "";

    if (data.models && data.models.length) {
      $("scrapeModelCount").textContent = `${data.models.length} free models found`;
      data.models.forEach((m) => {
        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = m.id;
        cb.checked = m.currentlyAllowed || false;
        const text = document.createElement("span");
        text.textContent = `${m.name || m.id} (${m.context || "unknown"} ctx)`;
        label.appendChild(cb);
        label.appendChild(text);
        $("scrapeModelList").appendChild(label);
      });
    } else {
      $("scrapeModelList").innerHTML = "<p>No free models found.</p>";
    }
  } catch (err) {
    $("scrapeLoading").textContent = "Error: " + err.message;
  }
}

async function confirmUpdateModels() {
  const checkboxes = $("scrapeModelList").querySelectorAll("input[type=checkbox]:checked");
  const modelIds = Array.from(checkboxes).map((cb) => cb.value);

  try {
    const resp = await fetch("/api/update-free-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: modelIds }),
    });
    if (resp.ok) {
      $("refreshModelsModal").style.display = "none";
      await loadModels();
    } else {
      addMessage("error", "Failed to update models: " + (await resp.text()));
    }
  } catch (err) {
    addMessage("error", "Failed to update models: " + err.message);
  }
}

// --- Voice Input ---
function initVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    const input = $("chatInput");
    if (input) {
      input.value = transcript;
      input.focus();
    }
  };
  recognition.onerror = () => { stopVoiceInput(); };
  recognition.onend = () => { stopVoiceInput(); };
}

function toggleVoiceInput() {
  if (!recognition) {
    addMessage("error", "Voice input not supported on this browser");
    return;
  }
  if (isListening) {
    recognition.stop();
    stopVoiceInput();
  } else {
    recognition.start();
    isListening = true;
    const btn = $("voiceInputBtn");
    if (btn) btn.style.color = "var(--accent-light)";
  }
}

function stopVoiceInput() {
  isListening = false;
  const btn = $("voiceInputBtn");
  if (btn) btn.style.color = "";
}

// --- Event Listeners ---
document.addEventListener("DOMContentLoaded", () => {
  initVoice();

  // Onboarding
  $("startBtn").addEventListener("click", () => showScreen("home"));

  // Bottom nav
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.screen;
      if (target === "new") {
        $("newProjectModal").style.display = "flex";
        $("newProjectName").value = "";
        $("newProjectName").focus();
      } else {
        showScreen(target);
      }
    });
  });

  // Home cards
  $("newChatCard").addEventListener("click", () => {
    $("newProjectModal").style.display = "flex";
    $("newProjectName").value = "";
    $("newProjectName").focus();
  });
  $("browseFilesCard").addEventListener("click", () => showScreen("files"));
  $("voiceChatBtn").addEventListener("click", () => {
    if (!currentProject) {
      $("newProjectModal").style.display = "flex";
      $("newProjectName").value = "";
      $("newProjectName").focus();
    } else {
      showScreen("chat");
      setTimeout(() => toggleVoiceInput(), 300);
    }
  });
  $("refreshModelsHomeBtn").addEventListener("click", openRefreshModelsModal);

  // Chat
  $("sendBtn").addEventListener("click", sendMessage);
  $("stopBtn").addEventListener("click", stopAgent);
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendMessage(); }
  });
  $("voiceInputBtn").addEventListener("click", toggleVoiceInput);
  $("chatBackBtn").addEventListener("click", () => showScreen("home"));
  $("chatFileBtn").addEventListener("click", () => showScreen("files"));
  $("chatMenuBtn").addEventListener("click", () => showScreen("preview"));

  // Model select
  $("modelSelect").addEventListener("change", () => {
    currentModel = $("modelSelect").value;
    updateModelDisplay();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_model", model: currentModel }));
    }
  });

  // Files
  $("filesBackBtn").addEventListener("click", () => showScreen("home"));
  $("refreshFilesBtn").addEventListener("click", loadFileTree);
  $("closeFileBtn").addEventListener("click", () => {
    $("fileViewer").style.display = "none";
    $("fileTree").style.display = "block";
  });

  // Preview
  $("previewBackBtn").addEventListener("click", () => showScreen("home"));
  $("refreshPreviewBtn").addEventListener("click", refreshPreview);
  $("clearTerminalBtn").addEventListener("click", () => { $("terminalOutput").innerHTML = ""; });
  document.querySelectorAll(".preview-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".preview-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const isPreview = tab.dataset.tab === "preview";
      $("previewFrameWrap").style.display = isPreview ? "block" : "none";
      $("terminalWrap").style.display = isPreview ? "none" : "flex";
    });
  });

  // New Project Modal
  $("cancelNewProject").addEventListener("click", () => { $("newProjectModal").style.display = "none"; });
  $("confirmNewProject").addEventListener("click", () => {
    const name = $("newProjectName").value.trim();
    if (name) { createProject(name); $("newProjectModal").style.display = "none"; }
  });
  $("newProjectName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("confirmNewProject").click();
  });

  // Refresh Models Modal
  $("cancelRefreshModels").addEventListener("click", () => { $("refreshModelsModal").style.display = "none"; });
  $("confirmRefreshModels").addEventListener("click", confirmUpdateModels);
  $("selectAllModels").addEventListener("click", () => {
    $("scrapeModelList").querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = true; });
  });
  $("deselectAllModels").addEventListener("click", () => {
    $("scrapeModelList").querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = false; });
  });

  // Init
  connectWS();
});
