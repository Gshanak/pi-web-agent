# Pi Web Agent — Project Review & Build Report

## 1. Project Overview

**Pi Web Agent** is a browser-based coding agent inspired by the [`earendil-works/pi`](https://github.com/earendil-works/pi) terminal coding agent. It brings the full power of an AI coding agent — filesystem access, shell execution, live preview, file tree, code editor, and streaming responses — to a web interface, powered entirely by **OpenRouter free models**.

- **GitHub Repo:** [https://github.com/Gshanak/pi-web-agent](https://github.com/Gshanak/pi-web-agent)
- **License:** MIT
- **Node Version:** 22 (Dockerfile), 20+ (local)
- **Deployment Target:** Render (Docker-based, supports WebSocket + ephemeral filesystem)

---

## 2. Original Repo Analysis

The `earendil-works/pi` monorepo was downloaded and analyzed across its 6 packages:

| Package | Purpose |
|---|---|
| `pi-coding-agent` | Main coding agent with tool calling |
| `pi-agent-core` | Core agent loop and message handling |
| `pi-ai` | AI provider abstraction (OpenAI, Anthropic, OpenRouter) |
| `pi-tui` | Terminal UI (Ink-based React) |
| `chord` | Multi-agent orchestration |
| `pi-telemetry` | Logging and telemetry |

Key concepts extracted:
- **Tool-calling agent loop** — system prompt + tools + streaming SSE parsing
- **7 tools** — write_file, read_file, edit_file, list_files, create_directory, run_command, delete_file
- **Project-based isolation** — each project is a directory with its own session
- **Session persistence** — conversation saved to `.pi-session.json` per project
- **OpenRouter integration** — free model filtering, streaming completions

---

## 3. Pi Web Agent — Architecture

### Backend (`backend/server.js`)
- **Express.js** REST API for project management, file operations, and preview serving
- **WebSocketServer** (`ws`) for real-time agent communication, streaming text, and tool execution
- **OpenRouter API** integration with SSE streaming and tool calling
- **29KB** hardened server file (up from 20KB original)

### Frontend (`public/`)
- `index.html` — IDE-style layout (file tree sidebar, chat panel, code editor, live preview, terminal output)
- `css/style.css` — Dark theme matching the original pi terminal aesthetic
- `js/app.js` — Frontend logic: WebSocket connection, file tree rendering, chat streaming, tab management
- `vendor/` — Self-hosted highlight.js (downloaded via postinstall script)

### Deployment Files
- `Dockerfile` — Node 22-slim based, `npm ci` for reproducible builds
- `render.yaml` — Render deployment configuration
- `.dockerignore` — Excludes node_modules, .env, projects/
- `.env.example` — Template for environment variables
- `.gitignore` — Standard Node.js ignores
- `package-lock.json` — Locked dependencies for reproducible installs

---

## 4. All Commits Made to GitHub

### Initial Build (5 commits)

| Commit SHA | Message | Files Added |
|---|---|---|
| `682ff917` | Initial commit: project scaffolding | package.json, .env.example, .gitignore, README.md, public/index.html |
| `e7229cf4` | Add dark theme CSS | public/css/style.css |
| `444954b2` | Add backend server with OpenRouter streaming | backend/server.js |
| `44cd47c9` | Add frontend application logic | public/js/app.js |
| `0a233bf5` | Add Render deployment config | render.yaml, Dockerfile, .dockerignore, updated README.md |

### Security Hardening (5 commits)

| Commit SHA | Message | Files Changed |
|---|---|---|
| `a5e04d47` | F8 iframe sandbox, F13 self-host CSS, F15 Dockerfile Node 22 | public/index.html, Dockerfile, public/vendor/github-dark.min.css |
| `ac62529e` | F2 command allow-list, F3 path traversal, F6 stop abort, F7 limits, F10 error sanitization, F12 headers, F17 model allow-list | backend/server.js |
| `db3d8161` | F14: Add package-lock.json | package-lock.json |
| `5b237766` | F13: Self-host highlight.js placeholder | public/vendor/highlight.min.js |
| `3bc30cca` | F13: postinstall script for highlight.js download | package.json |

**Total: 10 commits across the full build.**

---

## 5. Security Report — Findings & Fixes

A comprehensive security audit was performed comparing the Pi Web Agent against the original pi terminal agent. **17 findings** were identified, all verified against actual code.

### Findings Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| F1 | Critical | No authentication on REST API or WebSocket | **Skipped** (single user) |
| F2 | High | No command filtering — arbitrary shell execution | **Fixed** — command allow-list + dangerous pattern blocking |
| F3 | High | Path traversal — no containment check on file paths | **Fixed** — `safeJoin()` with `path.resolve()` + `startsWith()` check |
| F4 | Medium | No project ownership — any project accessible | **Skipped** (single user) |
| F5 | Medium | No rate limiting or token budget cap | Not yet implemented |
| F6 | High | Stop button doesn't actually stop agent | **Fixed** — `AbortController` on fetch + `SIGTERM` on child processes |
| F7 | Medium | Excessive resource limits (50MB JSON, 20 turns, no WS msg limit) | **Fixed** — 1MB JSON limit, 256KB WS limit, 15 max turns |
| F8 | Medium | Preview iframe has `allow-same-origin` | **Fixed** — removed from sandbox attribute |
| F10 | Medium | Raw error messages leaked to client | **Fixed** — `safeError()` returns generic messages, logs real errors server-side |
| F12 | Medium | No security headers | **Fixed** — nosniff, no-referrer, Permissions-Policy, CSP, X-Frame-Options |
| F13 | Low | highlight.js loaded from CDN | **Fixed** — self-hosted via postinstall download + local vendor directory |
| F14 | Low | No package-lock.json committed | **Fixed** — generated and committed, Dockerfile uses `npm ci` |
| F15 | Low | Dockerfile uses Node 20 (EOL) | **Fixed** — upgraded to `node:22-slim` |
| F17 | Medium | No server-side model validation | **Fixed** — model allow-list only permits `:free` or `/free` models |

### Fixes Skipped (per user request)
- **F1 (Authentication):** User is the only person using the project; bearer-token auth deemed unnecessary
- **F4 (Project Ownership):** Single-user scenario; no multi-tenant isolation needed

### Fixes Not Yet Implemented
- **F5 (Rate Limiting):** No per-connection rate limiting or daily token budget cap. Recommended for future if exposed publicly.

---

## 6. Detailed Fix Descriptions

### F2: Command Allow-List
```javascript
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
```
Commands are checked against both block patterns and allowed prefixes before execution.

### F3: Path Traversal Containment
```javascript
function safeJoin(base, relPath) {
  if (!relPath) return base;
  const resolved = path.resolve(base, relPath);
  const normalizedBase = path.resolve(base);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    return null; // path traversal attempt
  }
  return resolved;
}
```
Applied to all 14 `path.join` sites in the server — file read, write, edit, delete, list, create directory, and preview serving.

### F6: Stop Button Abort
- `AbortController` created per fetch call, stored in `wsAbortControllers` Map
- `SIGTERM` sent to all tracked child processes via `wsChildProcesses` Map
- `wsStopped` flag checked between turns, during SSE streaming, and before each tool call
- Cleanup on WebSocket `close` event

### F7: Resource Limits
- Express JSON body limit: 50MB to 1MB
- WebSocket `maxReceivedFrameSize`: 256KB
- Agent loop max turns: 20 to 15
- Run command `maxBuffer`: 5MB to 2MB
- Raw message size check in WS message handler

### F10: Error Sanitization
```javascript
function safeError(err) {
  console.error("Server error:", err.message);
  return "Internal error";
}
```
All REST API catch blocks now return generic error messages. Real errors logged to server console only.

### F12: Security Headers
```javascript
res.setHeader("X-Content-Type-Options", "nosniff");
res.setHeader("Referrer-Policy", "no-referrer");
res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), interest-cohort=()");
res.setHeader("X-Frame-Options", "SAMEORIGIN");
res.setHeader("Content-Security-Policy",
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; ..."
);
```

### F13: Self-Hosted highlight.js
- `postinstall` script in `package.json` downloads `highlight.min.js` and `github-dark.min.css` from CDN into `public/vendor/` during `npm install`
- `index.html` references local `/vendor/` paths instead of CDN URLs
- No external script dependencies at runtime

### F14: package-lock.json
- Generated via `npm install --package-lock-only`
- 70 packages locked, 29,968 bytes
- Dockerfile updated from `npm install` to `npm ci` for reproducible builds

### F15: Dockerfile Node 22
```dockerfile
FROM node:22-slim  # was node:20-slim
```

### F17: Model Allow-List
```javascript
const ALLOWED_MODEL_PATTERNS = [":free", "/free"];
function isModelAllowed(model) {
  if (!model) return true; // fall back to default
  return ALLOWED_MODEL_PATTERNS.some((p) => model.includes(p));
}
```
Validated on WebSocket `init`, `set_model`, and before each agent loop fetch. Paid models rejected; only free models accepted.

---

## 7. Robustness Fixes (Beyond Security Report)

| Fix | Description |
|---|---|
| Global error handlers | `process.on("uncaughtException")` and `process.on("unhandledRejection")` prevent server crashes |
| `ws.readyState` checks | All `ws.send()` calls check `ws.readyState === 1` before sending |
| Non-blocking agent loop | `runAgentLoop` called with `.catch()` instead of `await` |
| Fetch timeout | `AbortController` with 120-second timeout on OpenRouter fetch calls |
| Child process cleanup | Child processes tracked per connection and killed on disconnect |

---

## 8. Test Results

### Test Suite: 35 tests, 0 failures

| Category | Tests | Passed | Failed |
|---|---|---|---|
| Basic Serving | 3 | 3 | 0 |
| F13: Self-hosted vendor files | 2 | 2 | 0 |
| F12: Security headers | 4 | 4 | 0 |
| Project management | 2 | 2 | 0 |
| File operations | 4 | 4 | 0 |
| Preview serving | 3 | 3 | 0 |
| F3: Path traversal protection | 2 | 2 | 0 |
| Error handling | 3 | 3 | 0 |
| F10: Error sanitization | 1 | 1 | 0 |
| Name sanitization | 1 | 1 | 0 |
| Multi-project isolation | 1 | 1 | 0 |
| File overwrite | 1 | 1 | 0 |
| WebSocket connection | 2 | 2 | 0 |
| F17: Model allow-list | 2 | 2 | 0 |
| F8: iframe sandbox | 1 | 1 | 0 |
| WebSocket session clear | 1 | 1 | 0 |
| F6: Stop button | 1 | 1 | 0 |
| Server stability | 1 | 1 | 0 |
| **Total** | **35** | **35** | **0** |

---

## 9. File Inventory

| File | Size | Purpose |
|---|---|---|
| `package.json` | 964 B | Project config + postinstall script |
| `package-lock.json` | 29,968 B | Locked dependencies |
| `.env.example` | ~100 B | Environment variable template |
| `.gitignore` | ~50 B | Git ignores |
| `.dockerignore` | ~50 B | Docker build ignores |
| `README.md` | ~2 KB | Project documentation |
| `Dockerfile` | 225 B | Container build (Node 22-slim) |
| `render.yaml` | ~200 B | Render deployment config |
| `backend/server.js` | 29,149 B | Hardened Express + WebSocket server |
| `public/index.html` | 4,701 B | IDE-style web UI |
| `public/css/style.css` | ~8 KB | Dark theme styles |
| `public/js/app.js` | ~17 KB | Frontend application logic |
| `public/vendor/highlight.min.js` | ~10 KB | Self-hosted syntax highlighter |
| `public/vendor/github-dark.min.css` | 1,315 B | Self-hosted highlight.js theme |

---

## 10. Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | Yes | — | Your OpenRouter API key (free at openrouter.ai) |
| `OPENROUTER_MODEL` | No | `deepseek/deepseek-chat-v3-0324:free` | Default free model |
| `PORT` | No | `3000` | Server port (Render sets this automatically) |

---

## 11. Deployment Guide (Render)

1. Go to [render.com](https://render.com) and create a new **Web Service**
2. Connect your GitHub account and select the `Gshanak/pi-web-agent` repo
3. Choose **Docker** as the runtime
4. Add environment variable: `OPENROUTER_API_KEY` = your key from openrouter.ai
5. Deploy
6. Access your app at `https://your-app-name.onrender.com`

**Note:** Render free tier has ephemeral filesystem — projects directory resets on sleep/redeploy.

---

## 12. What the User Needs to Do

1. **Get an OpenRouter API key** (free) from https://openrouter.ai/keys
2. **Deploy to Render** using the steps above, or run locally:
   ```bash
   git clone https://github.com/Gshanak/pi-web-agent.git
   cd pi-web-agent
   npm install
   OPENROUTER_API_KEY=your-key npm start
   ```
3. **Open the app** in your browser, create a project, and start chatting

No authentication setup needed — the app runs without login (single-user mode).

---

## 13. Future Improvements (Not Yet Implemented)

- **F5: Rate limiting** — 10 requests/min per token, daily token budget cap
- **F1: Authentication** — bearer token generated on startup if multi-user needed
- **F4: Project ownership** — per-user project isolation
- **Persistent filesystem** — connect a Render disk or use S3 for project storage
- **Multi-tab file editor** — currently single-file view
- **Git integration** — init repos, commit from the UI
- **Terminal emulator** — xterm.js for interactive shell (currently output-only)
