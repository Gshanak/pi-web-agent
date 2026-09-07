import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { exec } from "child_process";
import os from "os";
import { fileURLToPath } from "url";

// Global error handlers to prevent server crashes
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err?.message || err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
let DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
const PROJECTS_DIR = path.join(__dirname, "..", "projects");

// F17/P8: Server-side allow-list of known free model IDs (updated Sep 2026)
// All old models (deepseek, old qwen, old llama, old gemma, mistral, etc.) have been
// retired from OpenRouter's free tier. Replaced with current active free models.
let ALLOWED_FREE_MODELS = new Set([
  // NVIDIA Nemotron 3 family
  "nvidia/nemotron-3-ultra-550b-a55b:free",       // 1M context, 55B active, coding/agents
  "nvidia/nemotron-3.5-lightning:free",            // 1M context, 3B active, high-throughput
  "nvidia/nemotron-3-super-120b-a12b:free",        // 262K context, 12B active, reasoning
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", // 256K context, multimodal
  // MiniMax
  "minimax/minimax-m3:free",                       // 1M context, multimodal, agentic
  "minimax/minimax-m2.7:free",                     // 197K context, general purpose
  // Thinking Machines
  "thinkingmachines/inkling:free",                 // 1M context, multimodal+audio, reasoning
  "thinkingmachines/inkling-small:free",            // 1M context, multimodal+audio
  // Poolside (coding-focused)
  "poolside/laguna-s-2.1:free",                    // 262K context, 118B/8B, coding agent
  "poolside/laguna-xs-2.1:free",                   // 262K context, 33B/3B, coding agent
  // Google Gemma 4
  "google/gemma-4-31b-it:free",                   // 262K context, multimodal
  "google/gemma-4-26b-a4b-it:free",                // 262K context, MoE multimodal
  // Cohere
  "cohere/north-mini-code:free",                  // 256K context, code-focused
  // Dots Studio
  "dots-studio/dots-3-note-preview:free",          // 512K context, reasoning/coding
  // InclusionAI
  "inclusionai/ling-3.0-flash-fin:free",           // 262K context, general purpose
  "inclusionai/ling-3.0-flash-sante:free",         // 262K context, general purpose
]);
function isModelAllowed(model) {
  if (!model) return true; // fall back to default
  return ALLOWED_FREE_MODELS.has(model);
}

// F2: Command allow-list — block dangerous commands
const BLOCKED_COMMANDS = [
  /\brm\s+-rf\s+\//i, /sudo/i, /\bsu\s+/i, /\bchmod\s+777/i,
  /\bcurl\s+.*\|\s*sh/i, /\bwget\s+.*\|\s*sh/i,
  /\bmkfs/i, /\bdd\s+if=/i, /\b:(){.*:\|:&};:/i,
  /\bkillall/i, /\bpkill\b/i, /\bshutdown/i, /\breboot/i,
  /\bcrontab/i, /\biptables/i,
];
const ALLOWED_COMMAND_PREFIXES = [
  "npm", "npx", "node", "git", "ls", "cat", "echo", "mkdir",
  "cp", "mv", "touch", "head", "tail", "wc", "grep", "find",
  "sort", "diff", "pwd", "which", "tsc", "vite", "parcel",
  "webpack", "rollup", "esbuild", "sass", "less", "postcss",
  "jest", "vitest", "mocha", "eslint", "prettier",
  "python", "python3", "pip", "ruby", "go", "cargo", "rustc",
  "make", "cmake", "gcc", "g++", "cc",
];
function isCommandAllowed(command) {
  const cmd = command.trim();
  // Check blocked patterns
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(cmd)) return false;
  }
  // Check allowed prefixes
  const firstWord = cmd.split(/\s+/)[0];
  return ALLOWED_COMMAND_PREFIXES.some((p) => firstWord === p || firstWord.startsWith(p));
}

// Ensure projects directory exists
if (!fs.existsSync(PROJECTS_DIR)) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

// --- Express app ---
const app = express();

// F12: Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), interest-cohort=()");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  // P7: CSP — removed 'unsafe-inline' from script-src (all JS is from local files)
  res.setHeader(
    "Content-security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:;"
  );
  next();
});

// F7: Reduced JSON limit from 50mb to 1mb
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// F3: Path traversal contaimment — resolve and verify it stays within project dir
function safeJoin(base, relPath) {
  if (!relPath) return base;
  const resolved = path.resolve(base, relPath);
  const normalizedBase = path.resolve(base);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    return null; // path traversal attempt
  }
  return resolved;
}

// P4: Symlink hardening — resolve real path and verify it stays within base
async function safeJoinReal(base, relPath) {
  const resolved = safeJoin(base, relPath);
  if (!resolved) return null;
  try {
    const real = await fsp.realpath(resolved);
    const realBase = await fsp.realpath(base);
    if (!real.startsWith(realBase + path.sep) && real !== realBase) {
      return null; // symlink points outside project
    }
    return real;
  } catch {
    // Path doesn't exist yet (e.g., write_file creating new file) — use safeJoin result
    return resolved;
  }
}

// F10: Sanitize error messages — don't leak internal details
function safeError(err) {
  console.error("Server error:", err.message);
  return "Internal error";
}

// REST: list models from OpenRouter
app.get("/api/models", async (req, res) => {
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `bearer ${OPENROUTER_API_KEY}` },
    });
    const data = await resp.json();
    const models = (data.data || [])
      .filter((m) => (m.id.includes(":free") || m.pricing?.prompt === "0") && (m.supported_parameters || []).includes("tools"))
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context: m.context_length,
      }));
    res.json({ models, all: (data.data || []).map((m) => ({ id: m.id, name: m.name || m.id, context: m.context_length }) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch models" });
  }
});

// Scrape current free models from OpenRouter's public API
// Returns models with :free suffix or $0 pricing that also support tool calling
app.get("/api/scrape-free-models", async (req, res) => {
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `bearer ${OPENROUTER_API_KEY}` },
    });
    const data = await resp.json();
    const allModels = data.data || [];

    // Filter for free models: :free suffix or $0 pricing
    const freeModels = allModels
      .filter((m) => {
        const isFreePricing = m.pricing?.prompt === "0" && m.pricing?.completion === "0";
        const hasFreeSuffix = m.id.includes(":free");
        const supportsTools = (m.supported_parameters || []).includes("tools");
        return (isFreePricing || hasFreeSuffix) && supportsTools;
      })
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context: m.context_length || 0,
        modality: m.architecture?.modality || "text",
        currentlyAllowed: ALLOWED_FREE_MODELS.has(m.id),
      }))
      .sort((a, b) => b.context - a.context);

    res.json({
      models: freeModels,
      currentAllowed: [...ALLOWED_FREE_MODELS],
      defaultModel: DEFAULT_MODEL,
    });
  } catch (err) {
    console.error("Scrape free models error:", err.message);
    res.status(500).json({ error: "Failed to scrape free models from OpenRouter" });
  }
});

// Update the allow-list with user-verified models
// Body: { models: ["model-id-1:free", "model-id-2:free", ...] }
app.post("/api/update-free-models", (req, res) => {
  try {
    const { models } = req.body;
    if (!Array.isArray(models)) {
      return res.status(400).json({ error: "models array required" });
    }

    // Validate all model IDs end with :free or have $0 pricing — never allow paid models
    const validModels = models.filter((m) => {
      if (typeof m !== "string") return false;
      // Must end with :free suffix (security: never allow arbitrary model IDs)
      return m.endsWith(":free") || m.includes("/openrouter/free");
    });

    if (validModels.length === 0) {
      return res.status(400).json({ error: "No valid free model IDs provided" });
    }

    // Replace the allow-list
    ALLOWED_FREE_MODELS = new Set(validModels);

    // If current default is no longer allowed, switch to first allowed model
    if (!ALLOWED_FREE_MODELS.has(DEFAULT_MODEL)) {
      DEFAULT_MODEL = validModels[0];
    }

    console.log(`Allow-list updated: ${validModels.length} models. Default: ${DEFAULT_MODEL}`);
    res.json({
      success: true,
      count: validModels.length,
      allowedModels: [...ALLOWED_FREE_MODELS],
      defaultModel: DEFAULT_MODEL,
    });
  } catch (err) {
    console.error("Update free models error:", err.message);
    res.status(500).json({ error: safeError(err) });
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
    res.status(500).json({ error: safeError(err) });
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
  // P3: Use safeJoin for project root validation instead of startsWith
  const dir = safeJoin(PROJECTS_DIR, project);
  if (!dir) return res.status(400).json({ error: "Invalid project" });
  try {
    const tree = await buildFileTree(dir);
    res.json({ tree });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// REST: read a file
app.get("/api/file", async (req, res) => {
  const { project, path: relPath } = req.query;
  if (!project || !relPath) return res.status(400).json({ error: "Project and path required" });
  // P3: Use safeJoin for project root validation
  const projectDir = safeJoin(PROJECTS_DIR, project);
  if (!projectDir) return res.status(400).json({ error: "Invalid project" });
  const fullPath = safeJoin(projectDir, relPath);
  if (!fullPath) return res.status(400).json({ error: "Invalid file path" });
  try {
    const content = await fsp.readFile(fullPath, "utf-8");
    res.json({ content, path: relPath });
  } catch (err) {
    res.status(500).json({ error: "File not found" });
  }
});

// REST: save a file
app.post("/api/file", async (req, res) => {
  const { project, path: relPath, content } = req.body;
  if (!project || !relPath) return res.status(400).json({ error: "Project and path required" });
  // P3: Use safeJoin for project root validation
  const projectDir = safeJoin(PROJECTS_DIR, project);
  if (!projectDir) return res.status(400).json({ error: "Invalid project" });
  const fullPath = safeJoin(projectDir, relPath);
  if (!fullPath) return res.status(400).json({ error: "Invalid file path" });
  try {
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, content || "");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

// REST: serve preview files from a project
app.use("/preview/:project", async (req, res, next) => {
  const { project } = req.params;
  // P3: Use safeJoin for project root validation
  const projectDir = safeJoin(PROJECTS_DIR, project);
  if (!projectDir) return res.status(400).send("Invalid project");
  // Strip leading slash from req.url so safeJoin treats it as relative
  const relPath = req.url === "/" ? "index.html" : req.url.replace(/^\//, "");
  const fullPath = safeJoin(projectDir, relPath);
  if (!fullPath) return res.status(404).send("File not found");
  if (!fs.existsSync(fullPath)) {
    return res.status(404).send("File not found");
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
// F6: Track active child processes per connection for stop/cancel
const wsChildProcesses = new Map(); // ws -> Set<child>

async function executeTool(toolName, args, projectDir, ws, callId) {
  // F3: Path containment for all file operations
  const fullPath = safeJoin(projectDir, args.path || "");
  const fullDirPath = safeJoin(projectDir, args.dir_path || "");

  try {
    switch (toolName) {
      case "write_file": {
        if (!fullPath) { return "Error: invalid path"; }
        // P4: Symlink check for write operations
        const realPath = await safeJoinReal(projectDir, args.path || "");
        if (!realPath) { return "Error: path resolves outside project (symlink detected)"; }
        await fsp.mkdir(path.dirname(fullPath), { recursive: true });
        await fsp.writeFile(fullPath, args.content || "");
        ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: `File written: ${args.path}`, path: args.path }));
        return `File written successfully: ${args.path}`;
      }
      case "read_file": {
        if (!fullPath) { return "Error: invalid path"; }
        const content = await fsp.readFile(fullPath, "utf-8");
        const truncated = content.length > 8000 ? content.slice(0, 8000) + "\n... [truncated]" : content;
        ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: truncated, path: args.path }));
        return truncated;
      }
      case "edit_file": {
        if (!fullPath) { return "Error: invalid path"; }
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
        if (!targetDir) { return "Error: invalid directory"; }
        const entries = await fsp.readdir(targetDir, { withFileTypes: true });
        const listing = entries
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
          .map((e) => `${e.isDirectory() ? "[DIR] " : "      "}${e.name}`)
          .join("\n");
        ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: listing, path: args.dir_path }));
        return listing || "Empty directory";
      }
      case "create_directory": {
        if (!fullPath) { return "Error: invalid path"; }
        // P4: Symlink check for directory creation
        const realPath = await safeJoinReal(projectDir, args.path || "");
        if (!realPath) { return "Error: path resolves outside project (symlink detected)"; }
        await fsp.mkdir(fullPath, { recursive: true });
        ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: `Directory created: ${args.path}`, path: args.path }));
        return `Directory created: ${args.path}`;
      }
      case "delete_file": {
        if (!fullPath) { return "Error: invalid path"; }
        // P4: Symlink check for delete operations
        const realPath = await safeJoinReal(projectDir, args.path || "");
        if (!realPath) { return "Error: path resolves outside project (symlink detected)"; }
        await fsp.rm(fullPath, { recursive: true, force: true });
        ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: `Deleted: ${args.path}`, path: args.path }));
        return `Deleted: ${args.path}`;
      }
      case "run_command": {
        // F2: Command allow-list check
        if (!isCommandAllowed(args.command)) {
          const msg = `Command blocked by safety policy: ${args.command.slice(0, 100)}`;
          ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: msg, command: args.command }));
          return msg;
        }
        return await new Promise((resolve) => {
          ws.send(JSON.stringify({ type: "tool_start", callId, tool: toolName, command: args.command }));
          const child = exec(args.command, {
            cwd: projectDir,
            timeout: 30000,
            maxBuffer: 1024 * 1024 * 2,
          });
          // F6: Track child process for stop/cancel
          if (!wsChildProcesses.has(ws)) wsChildProcesses.set(ws, new Set());
          wsChildProcesses.get(ws).add(child);
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (data) => {
            stdout += data;
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "tool_stream", callId, data: data.toString() }));
          });
          child.stderr.on("data", (data) => {
            stderr += data;
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "tool_stream", callId, data: data.toString(), stderr: true }));
          });
          child.on("close", (code) => {
            const result = `Exit code: ${code}\n--- stdout ---\n${stdout.slice(0, 4000)}\n${stderr ? `--- stderr ---\n${stderr.slice(0, 4000)}` : ""}`;
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result, command: args.command }));
            wsChildProcesses.get(ws)?.delete(child);
            resolve(result);
          });
          child.on("error", () => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: "Command execution error", command: args.command }));
            wsChildProcesses.get(ws)?.delete(child);
            resolve("Command execution error");
          });
        });
      }
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    console.error("Tool error:", err.message);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "tool_result", callId, tool: toolName, result: "Tool execution error" }));
    return "Tool execution error";
  }
}

// --- Agent loop ---
// F6: Track AbortControllers per connection for stop/cancel
const wsAbortControllers = new Map(); // ws -> AbortController

async function runAgentLoop(ws, messages, model, projectDir, sessionId) {
  // F17: Validate model
  const useModel = isModelAllowed(model) ? (model || DEFAULT_MODEL) : DEFAULT_MODEL;
  if (!OPENROUTER_API_KEY) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", message: "OPENROUTER_API_KEY not set. Go to Render Dashboard → Environment → add your OpenRouter API key." }));
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "agent_done" }));
    return;
  }

  const conversation = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages,
  ];

  // F7: Reduced max turns from 20 to 15
  let maxTurns = 15;

  for (let turn = 0; turn < maxTurns; turn++) {
    // F6: Check if stop was requested
    if (wsStopped.get(ws)) {
      ws.send(JSON.stringify({ type: "agent_done", stopped: true }));
      return;
    }

    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "turn_start", turn }));

    let response;
    try {
      // F6: Use AbortController for each fetch
      const controller = new AbortController();
      wsAbortControllers.set(ws, controller);
      const timeout = setTimeout(() => controller.abort(), 120000);
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://pi-web-agent.onrender.com",
          "X-Title": "Pi Web Agent",
        },
        body: JSON.stringify({
          model: useModel,
          messages: conversation,
          tools: TOOLS,
          stream: true,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      wsAbortControllers.delete(ws);
    } catch (err) {
      wsAbortControllers.delete(ws);
      if (ws.readyState !== 1) return;
      const msg = err.name === "AbortError" ? "Request cancelled or timed out" : "Failed to connect to OpenRouter";
      ws.send(JSON.stringify({ type: "error", message: msg }));
      ws.send(JSON.stringify({ type: "agent_done" }));
      return;
    }

    if (!response.ok) {
      let errText = "";
      try { errText = await response.text(); } catch {}
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", message: `OpenRouter API error (${response.status}): ${errText.slice(0, 300)}` }));
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "agent_done" }));
      return;
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantContent = "";
    let toolCalls = [];

    while (true) {
      // F6: Check stop during streaming
      if (wsStopped.get(ws)) {
        try { reader.cancel(); } catch {}
        ws.send(JSON.stringify({ type: "agent_done", stopped: true }));
        return;
      }
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
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "text_stream", text: delta.content }));
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

    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "text_done", text: assistantContent }));

    if (!toolCalls.length) {
      conversation.push({ role: "assistant", content: assistantContent });
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "turn_end", turn }));
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "agent_done" }));
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

    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "turn_end", turn }));

    for (const tc of toolCalls) {
      // F6: Check stop before each tool call
      if (wsStopped.get(ws)) {
        ws.send(JSON.stringify({ type: "agent_done", stopped: true }));
        return;
      }
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch (e) { args = {}; }
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "tool_call", callId: tc.id, tool: tc.function.name, args }));
      const result = await executeTool(tc.function.name, args, projectDir, ws, tc.id);
      conversation.push({ role: "tool", tool_call_id: tc.id, content: typeof result === "string" ? result : JSON.stringify(result) });
    }
  }

  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "agent_done", maxed: true }));
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
// F7: WebSocket message size limit (256KB)
const wss = new WebSocketServer({ server, path: "/ws", maxReceivedFrameSize: 256 * 1024 });

// F6: Track stop state per connection
const wsStopped = new Map();
// P1: Rate limiting — track chat request timestamps per connection
const wsChatTimestamps = new Map(); // ws -> array of timestamps
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 10;  // max 10 chat requests per minute
// P2: Track active agent run per connection
const wsActiveRun = new Map(); // ws -> boolean

wss.on("connection", (ws) => {
  let currentProject = null;
  let currentModel = DEFAULT_MODEL;
  let conversationHistory = [];
  wsStopped.set(ws, false);

  ws.on("message", async (raw) => {
    // F7: Message size check
    if (raw.length > 256 * 1024) {
      ws.send(JSON.stringify({ type: "error", message: "Message too large" }));
      return;
    }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case "init": {
        currentProject = msg.project;
        // F17: Validate model from init
        currentModel = isModelAllowed(msg.model) ? (msg.model || DEFAULT_MODEL) : DEFAULT_MODEL;
        conversationHistory = loadSession(currentProject);
        ws.send(JSON.stringify({ type: "init_ack", project: currentProject, model: currentModel, history: conversationHistory }));
        break;
      }
      case "set_model": {
        // F17: Validate model
        if (isModelAllowed(msg.model)) {
          currentModel = msg.model;
          ws.send(JSON.stringify({ type: "model_changed", model: currentModel }));
        } else {
          ws.send(JSON.stringify({ type: "error", message: "Model not allowed. Only free models are permitted." }));
        }
        break;
      }
      case "chat": {
        if (!currentProject) { ws.send(JSON.stringify({ type: "error", message: "No project selected" })); break; }
        // P2: Prevent concurrent agent runs
        if (wsActiveRun.get(ws)) {
          ws.send(JSON.stringify({ type: "error", message: "An agent run is already in progress. Use Stop to cancel it first." }));
          break;
        }
        // P1: Rate limiting — check request count in window
        const now = Date.now();
        const timestamps = wsChatTimestamps.get(ws) || [];
        const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
          ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded. Please wait before sending more requests." }));
          break;
        }
        recent.push(now);
        wsChatTimestamps.set(ws, recent);
        // P3: Use safeJoin for project root validation
        const projectDir = safeJoin(PROJECTS_DIR, currentProject);
        if (!projectDir) { ws.send(JSON.stringify({ type: "error", message: "Invalid project" })); break; }
        conversationHistory.push({ role: "user", content: msg.content });
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "user_message", content: msg.content }));
        wsStopped.set(ws, false);
        wsActiveRun.set(ws, true);
        runAgentLoop(ws, conversationHistory, currentModel, projectDir, currentProject).catch((err) => {
          console.error("Agent loop error:", err.message);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "error", message: "Agent error occurred" }));
            ws.send(JSON.stringify({ type: "agent_done" }));
          }
        }).finally(() => {
          wsActiveRun.set(ws, false);
        });
        break;
      }
      case "stop": {
        // F6: Actually abort the fetch and kill child processes
        wsStopped.set(ws, true);
        const controller = wsAbortControllers.get(ws);
        if (controller) {
          try { controller.abort(); } catch {}
          wsAbortControllers.delete(ws);
        }
        const children = wsChildProcesses.get(ws);
        if (children) {
          for (const child of children) {
            try { child.kill("SIGTERM"); } catch {}
          }
          children.clear();
        }
        ws.send(JSON.stringify({ type: "agent_stopped" }));
        break;
      }
      case "clear_session": {
        conversationHistory = [];
        if (currentProject) {
          const sessionFile = safeJoin(path.join(PROJECTS_DIR, currentProject), ".pi-session.json");
          if (sessionFile) fsp.unlink(sessionFile).catch(() => {});
        }
        ws.send(JSON.stringify({ type: "session_cleared" }));
        break;
      }
    }
  });

  ws.on("close", () => {
    // F6: Cleanup on disconnect
    wsStopped.set(ws, true);
    wsActiveRun.set(ws, false);
    wsChatTimestamps.delete(ws);
    const controller = wsAbortControllers.get(ws);
    if (controller) { try { controller.abort(); } catch {} }
    wsAbortControllers.delete(ws);
    const children = wsChildProcesses.get(ws);
    if (children) {
      for (const child of children) { try { child.kill("SIGTERM"); } catch {} }
      children.clear();
    }
    wsChildProcesses.delete(ws);
    wsStopped.delete(ws);
    wsActiveRun.delete(ws);
  });

  ws.send(JSON.stringify({ type: "connected", defaultModel: DEFAULT_MODEL }));
});

server.listen(PORT, () => {
  console.log(`\n  Pi Web Agent running at http://localhost:${PORT}\n`);
  if (!OPENROUTER_API_KEY) {
    console.log("  WARNING: OPENROUTER_API_KEY not set. Set it in .env or as env var.\n");
  }
});
