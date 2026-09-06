import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { exec, spawn } from "child_process";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3-0324:free";
const PROJECTS_DIR = path.join(__dirname, "..", "projects");

// Ensure projects directory exists
if (!fs.existsSync(PROJECTS_DIR)) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

// --- Express app ---
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// REST: list models from OpenRouter
app.get("/api/models", async (req, res) => {
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    });
    const data = await resp.json();
    const models = (data.data || [])
      .filter((m) => m.id.includes(":free") || m.pricing?.prompt === "0")
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context: m.context_length,
      }));
    res.json({ models, all: (data.data || []).map((m) => ({ id: m.id, name: m.name || m.id, context: m.context_length })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST: list projects
app.get("/api/projects", (req, res) => {
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    res.json({ projects: dirs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST: create project
app.post("/api/projects", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(PROJECTS_DIR, safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  res.json({ name: safe, path: dir });
});

// REST: get file tree
app.get("/api/files", async (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: "Project required" });
  const dir = path.join(PROJECTS_DIR, project);
  try {
    const tree = await buildFileTree(dir);
    res.json({ tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST: read a file
app.get("/api/file", async (req, res) => {
  const { project, path: relPath } = req.query;
  if (!project || !relPath) return res.status(400).json({ error: "Project and path required" });
  const fullPath = path.join(PROJECTS_DIR, project, relPath);
  try {
    const content = await fsp.readFile(fullPath, "utf-8");
    res.json({ content, path: relPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST: save a file
app.post("/api/file", async (req, res) => {
  const { project, path: relPath, content } = req.body;
  if (!project || !relPath) return res.status(400).json({ error: "Project and path required" });
  const fullPath = path.join(PROJECTS_DIR, project, relPath);
  try {
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, content || "");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST: serve preview files from a project
app.use("/preview/:project", async (req, res, next) => {
  const { project } = req.params;
  const relPath = req.url === "/" ? "/index.html" : req.url;
  const fullPath = path.join(PROJECTS_DIR, project, relPath);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).send("File not found: " + relPath);
  }
  const ext = path.extname(fullPath);
  const types = {
    ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
    ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
    ".svg": "image/svg+xml", ".gif": "image/gif", ".ico": "image/x-icon",
  };
  res.setHeader("Content-Type", types[ext] || "application/octet-stream");
  fs.createReadStream(fullPath).pipe(res);
});

// --- Build file tree ---
async function buildFileTree(dir, base = "") {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const children = await buildFileTree(path.join(dir, entry.name), rel);
      nodes.push({ name: entry.name, path: rel, type: "dir", children });
    } else {
      nodes.push({ name: entry.name, path: rel, type: "file" });
    }
  }
  return nodes;
}

// ============================================================
//  AGENT CORE - OpenRouter integration with tool calling
// ============================================================

const SYSTEM_PROMPT = `You are Pi Web, a powerful coding agent that runs in the browser. You help users build projects by writing code, running commands, and managing files.

You have these tools available:
1. write_file(path, content) - Create or overwrite a file in the project
2. read_file(path) - Read the contents of a file
3. edit_file(path, old_string, new_string) - Replace text in a file
4. list_files(dir_path) - List files and directories
5. create_directory(path) - Create a new directory
6. run_command(command) - Run a shell command in the project directory
7. delete_file(path) - Delete a file or directory

Rules:
- Always use tools to read/write files and run commands. Do NOT just describe what to do - DO IT.
- When creating web projects, always create an index.html as the entry point.
- Keep responses concise. Show the user what you did, not lengthy explanations.
- If a command fails, try to fix it and retry.
- For web projects, use modern HTML5, CSS3, and vanilla JS unless the user asks for a framework.
- Create complete, working files - not placeholders.
`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file in the project directory",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from project root" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file from the project directory",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from project root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace a specific string in a file with a new string",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from project root" },
          old_string: { type: "string", description: "Exact text to find" },
          new_string: { type: "string", description: "Text to replace with" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories in a given path",
      parameters: {
        type: "object",
        properties: {
          dir_path: { type: "string", description: "Directory path relative to project root. Use '' for root." },
        },
        required: ["dir_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description: "Create a new directory in the project",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to project root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the project directory. Use for installing packages, running builds, tests, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file or directory from the project",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to project root" },
        },
        required: ["path"],
      },
    },
  },
];

// --- Tool executor ---
async function executeTool(toolName, args, projectDir, ws, callId) {
  const fullPath = path.join(projectDir, args.path || "");
  const fullDirPath = path.join(projectDir, args.dir_path || "");

  try {
    switch (toolName) {
      case "write_file": {
        await fsp.mkdir(path.dirname(fullPath), { recursive: true });
        await fsp.writeFile(fullPath, args.content || "");
        ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: `File written: ${args.path}`, path: args.path }));
        return `File written successfully: ${args.path}`;
      }
      case "read_file": {
        const content = await fsp.readFile(fullPath, "utf-8");
        const truncated = content.length > 8000 ? content.slice(0, 8000) + "\n... [truncated]" : content;
        ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: truncated, path: args.path }));
        return truncated;
      }
      case "edit_file": {
        const content = await fsp.readFile(fullPath, "utf-8");
        if (!content.includes(args.old_string)) {
          ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: `Error: old_string not found in ${args.path}`, path: args.path }));
          return `Error: old_string not found in ${args.path}`;
        }
        const updated = content.replace(args.old_string, args.new_string);
        await fsp.writeFile(fullPath, updated);
        ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: `File edited: ${args.path}`, path: args.path }));
        return `File edited successfully: ${args.path}`;
      }
      case "list_files": {
        const targetDir = args.dir_path ? fullDirPath : projectDir;
        const entries = await fsp.readdir(targetDir, { withFileTypes: true });
        const listing = entries
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
          .map((e) => `${e.isDirectory() ? "[DIR] " : "      "}${e.name}`)
          .join("\n");
        ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: listing, path: args.dir_path }));
        return listing || "Empty directory";
      }
      case "create_directory": {
        await fsp.mkdir(fullPath, { recursive: true });
        ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: `Directory created: ${args.path}`, path: args.path }));
        return `Directory created: ${args.path}`;
      }
      case "delete_file": {
        await fsp.rm(fullPath, { recursive: true, force: true });
        ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: `Deleted: ${args.path}`, path: args.path }));
        return `Deleted: ${args.path}`;
      }
      case "run_command": {
        return await new Promise((resolve) => {
          ws.send(JSON.stringify({ type: "tool_start", callId, tool: toolName, command: args.command }));
          const child = exec(args.command, {
            cwd: projectDir,
            timeout: 30000,
            maxBuffer: 1024 * 1024 * 5,
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (data) => {
            stdout += data;
            ws.send(JSON.stringify({ type: "tool_stream", callId, data: data.toString() }));
          });
          child.stderr.on("data", (data) => {
            stderr += data;
            ws.send(JSON.stringify({ type: "tool_stream", callId, data: data.toString(), stderr: true }));
          });
          child.on("close", (code) => {
            const result = `Exit code: ${code}\n--- stdout ---\n${stdout.slice(0, 4000)}\n${stderr ? `--- stderr ---\n${stderr.slice(0, 4000)}` : ""}`;
            ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result, command: args.command }));
            resolve(result);
          });
          child.on("error", (err) => {
            ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: `Error: ${err.message}`, command: args.command }));
            resolve(`Error: ${err.message}`);
          });
        });
      }
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: `Error: ${err.message}` }));
    return `Error: ${err.message}`;
  }
}

// --- Agent loop ---
async function runAgentLoop(ws, messages, model, projectDir, sessionId) {
  const conversation = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages,
  ];

  let maxTurns = 20;

  for (let turn = 0; turn < maxTurns; turn++) {
    ws.send(JSON.stringify({ type: "turn_start", turn }));

    let response;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:" + PORT,
          "X-Title": "Pi Web Agent",
        },
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          messages: conversation,
          tools: TOOLS,
          stream: true,
        }),
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: "Failed to connect to OpenRouter: " + err.message }));
      return;
    }

    if (!response.ok) {
      const errText = await response.text();
      ws.send(JSON.stringify({ type: "error", message: `OpenRouter API error (${response.status}): ${errText}` }));
      return;
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantContent = "";
    let toolCalls = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            assistantContent += delta.content;
            ws.send(JSON.stringify({ type: "text_stream", text: delta.content }));
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || `call_${idx}`, function: { name: "", arguments: "" } };
              }
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch (e) {
          // partial JSON, skip
        }
      }
    }

    ws.send(JSON.stringify({ type: "text_done", text: assistantContent }));

    if (!toolCalls.length) {
      conversation.push({ role: "assistant", content: assistantContent });
      ws.send(JSON.stringify({ type: "turn_end", turn }));
      ws.send(JSON.stringify({ type: "agent_done" }));
      saveSession(sessionId, conversation);
      return;
    }

    conversation.push({
      role: "assistant",
      content: assistantContent || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    ws.send(JSON.stringify({ type: "turn_end", turn }));

    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch (e) { args = {}; }
      ws.send(JSON.stringify({ type: "tool_call", callId: tc.id, tool: tc.function.name, args }));
      const result = await executeTool(tc.function.name, args, projectDir, ws, tc.id);
      conversation.push({ role: "tool", tool_call_id: tc.id, content: typeof result === "string" ? result : JSON.stringify(result) });
    }
  }

  ws.send(JSON.stringify({ type: "agent_done", maxed: true }));
  saveSession(sessionId, conversation);
}

// --- Session storage ---
function saveSession(projectName, conversation) {
  const sessionFile = path.join(PROJECTS_DIR, projectName, ".pi-session.json");
  const slim = conversation
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    }));
  fsp.writeFile(sessionFile, JSON.stringify(slim, null, 2)).catch(() => {});
}

function loadSession(projectName) {
  const sessionFile = path.join(PROJECTS_DIR, projectName, ".pi-session.json");
  try {
    const data = fs.readFileSync(sessionFile, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// --- HTTP server + WebSocket ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let currentProject = null;
  let currentModel = DEFAULT_MODEL;
  let conversationHistory = [];

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case "init": {
        currentProject = msg.project;
        currentModel = msg.model || DEFAULT_MODEL;
        conversationHistory = loadSession(currentProject);
        ws.send(JSON.stringify({ type: "init_ack", project: currentProject, model: currentModel, history: conversationHistory }));
        break;
      }
      case "set_model": {
        currentModel = msg.model;
        ws.send(JSON.stringify({ type: "model_changed", model: currentModel }));
        break;
      }
      case "chat": {
        if (!currentProject) { ws.send(JSON.stringify({ type: "error", message: "No project selected" })); break; }
        const projectDir = path.join(PROJECTS_DIR, currentProject);
        conversationHistory.push({ role: "user", content: msg.content });
        ws.send(JSON.stringify({ type: "user_message", content: msg.content }));
        await runAgentLoop(ws, conversationHistory, currentModel, projectDir, currentProject);
        break;
      }
      case "stop": {
        ws.send(JSON.stringify({ type: "agent_stopped" }));
        break;
      }
      case "clear_session": {
        conversationHistory = [];
        if (currentProject) { fsp.unlink(path.join(PROJECTS_DIR, currentProject, ".pi-session.json")).catch(() => {}); }
        ws.send(JSON.stringify({ type: "session_cleared" }));
        break;
      }
    }
  });

  ws.send(JSON.stringify({ type: "connected", defaultModel: DEFAULT_MODEL }));
});

server.listen(PORT, () => {
  console.log(`\n  Pi Web Agent running at http://localhost:${PORT}\n`);
  if (!OPENROUTER_API_KEY) {
    console.log("  WARNING: OPENROUTER_API_KEY not set. Set it in .env or as env var.\n");
  }
});
