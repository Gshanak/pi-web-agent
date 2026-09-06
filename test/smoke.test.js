import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";

// --- Test harness ---
const PORT = 3099;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

let serverProcess = null;
let serverStarted = false;

function fetchJSON(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const req = http.request(url, { method: options.method || "GET", headers: { "Content-Type": "application/json", ...options.headers } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: body, json: body ? JSON.parse(body) : {} }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: body, json: {} }); }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function fetchRaw(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}

function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function wsSend(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function wsRecv(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS recv timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.toString())); }
      catch { resolve({}); }
    });
  });
}

function wsRecvAll(ws, count, timeoutMs = 5000) {
  const msgs = [];
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(msgs), timeoutMs);
    ws.on("message", (data) => {
      try { msgs.push(JSON.parse(data.toString())); } catch { msgs.push({}); }
      if (msgs.length >= count) { clearTimeout(timer); resolve(msgs); }
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- Start/stop server ---
before(async () => {
  // Clean projects dir
  const projectsDir = path.join(process.cwd(), "projects");
  if (fs.existsSync(projectsDir)) fs.rmSync(projectsDir, { recursive: true, force: true });

  serverProcess = spawn("node", ["backend/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, OPENROUTER_API_KEY: "test-key", PORT: String(PORT) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Wait for server to start
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server startup timeout")), 10000);
    serverProcess.stdout.on("data", (data) => {
      if (data.toString().includes("running at")) {
        clearTimeout(timer);
        serverStarted = true;
        resolve();
      }
    });
    serverProcess.stderr.on("data", (data) => {
      console.error("Server stderr:", data.toString());
    });
    serverProcess.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  // Give it a moment to fully bind
  await sleep(500);
}, { timeout: 15000 });

after(async () => {
  if (serverProcess) {
    try { serverProcess.kill("SIGTERM"); } catch {}
    await sleep(200);
    try { serverProcess.kill("SIGKILL"); } catch {}
  }
});

// =====================
// TESTS
// =====================

describe("Basic serving", () => {
  test("GET / returns homepage with Pi Web", async () => {
    const r = await fetchRaw("/");
    assert.equal(r.status, 200);
    assert.ok(r.body.includes("Pi Web"), "Homepage should contain 'Pi Web'");
  });

  test("GET /css/style.css returns CSS", async () => {
    const r = await fetchRaw("/css/style.css");
    assert.equal(r.status, 200);
  });

  test("GET /js/app.js returns JavaScript", async () => {
    const r = await fetchRaw("/js/app.js");
    assert.equal(r.status, 200);
  });

  test("GET /vendor/highlight.min.js returns local vendor JS", async () => {
    const r = await fetchRaw("/vendor/highlight.min.js");
    assert.equal(r.status, 200);
  });

  test("GET /vendor/github-dark.min.css returns local vendor CSS", async () => {
    const r = await fetchRaw("/vendor/github-dark.min.css");
    assert.equal(r.status, 200);
  });
});

describe("Security headers", () => {
  test("X-Content-Type-Options is nosniff", async () => {
    const r = await fetchRaw("/");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
  });

  test("Content-Security-Policy is present", async () => {
    const r = await fetchRaw("/");
    assert.ok(r.headers["content-security-policy"], "CSP header should be set");
  });

  test("CSP script-src does not contain unsafe-inline", async () => {
    const r = await fetchRaw("/");
    const csp = r.headers["content-security-policy"] || "";
    const scriptPart = csp.split("style-src")[0];
    assert.ok(scriptPart.includes("script-src 'self'"), "script-src should be 'self'");
    assert.od(!scriptPart.includes("unsafe-inline"), "script-src should NOT contain unsafe-inline");
  });

  test("X-Frame-Options is SAMEORIGIN", async () => {
    const r = await fetchRaw("/");
    assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
  });
});

describe("Project CRUD", () => {
  test("POST /api/projects creates a project", async () => {
    const r = await fetchJSON("/api/projects", { method: "POST", body: { name: "testproj" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, "testproj");
  });

  test("GET /api/projects lists created project", async () => {
    const r = await fetchJSON("/api/projects");
    assert.equal(r.status, 200);
    assert.ok(r.json.projects.includes("testproj"));
  });

  test("POST /api/projects without name returns 400", async () => {
    const r = await fetchJSON("/api/projects", { method: "POST", body: {} });
    assert.equal(r.status, 400);
  });

  test("POST /api/projects sanitizes bad characters", async () => {
    const r = await fetchJSON("/api/projects", { method: "POST", body: { name: "bad!@#$%" } });
    assert.equal(r.json.name, "bad_____");
  });
});

describe("File operations", () => {
  test("POST /api/file writes a file", async () => {
    const r = await fetchJSON("/api/file", { method: "POST", body: { project: "testproj", path: "index.html", content: "<h1>Hello</h1>" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.success, true);
  });

  test("POST /api/file writes nested file", async () => {
    const r = await fetchJSON("/api/file", { method: "POST", body: { project: "testproj", path: "css/app.css", content: "body { margin: 0; }" } });
    assert.equal(r.status, 200);
  });

  test("GET /api/file reads file content", async () => {
    const r = await fetchJSON("/api/file?project=testproj&path=index.html");
    assert.equal(r.status, 200);
    assert.ok(r.json.content.includes("Hello"));
  });

  test("GET /api/files returns file tree", async () => {
    const r = await fetchJSON("/api/files?project=testproj");
    assert.equal(r.status, 200);
    const names = r.json.tree.map((n) => n.name);
    assert.ok(names.includes("index.html"));
  });

  test("GET /api/files without project returns 400", async () => {
    const r = await fetchJSON("/api/files");
    assert.equal(r.status, 400);
  });
});

describe("Preview serving", () => {
  test("GET /preview/testproj/index.html serves HTML", async () => {
    const r = await fetchRaw("/preview/testproj/index.html");
    assert.equal(r.status, 200);
    assert.ok(r.body.includes("Hello"));
  });

  test("GET /preview/testproj/css/app.css serves CSS", async () => {
    const r = await fetchRaw("/preview/testproj/css/app.css");
    assert.equal(r.status, 200);
    assert.ok(r.body.includes("margin"));
  });

  test("GET /preview/testproj/missing.html returns 404", async () => {
    const r = await fetchRaw("/preview/testproj/missing.html");
    assert.equal(r.status, 404);
  });
});

describe("Path traversal protection", () => {
  test("GET /api/file with ../../../etc/passwd is blocked", async () => {
    const r = await fetchJSON("/api/file?project=testproj&path=../../../etc/passwd");
    assert.ok(r.status === 400 || (r.json.error && r.json.error.toLowerCase().includes("invalid")));
  });

  test("GET /api/files with project=../etc is blocked", async () => {
    const r = await fetchJSON("/api/files?project=../etc");
    assert.equal(r.status, 400);
  });

  test("GET /preview/../../../etc/passwd is blocked", async () => {
    const r = await fetchRaw("/preview/testproj/../../../etc/passwd");
    assert.od(r.status === 400 || r.status === 404);
  });
});

describe("Error handling", () => {
  test("GET /api/file for nonexistent file returns 'File not found'", async () => {
    const r = await fetchJSON("/api/file?project=testproj&path=nonexistent.txt");
    assert.equal(r.json.error, "File not found");
  });

  test("Errors do not leak internal details", async () => {
    const r = await fetchJSON("/api/file?project=testproj&path=nonexistent.txt");
    assert.ok(!JSON.stringify(r.json).includes("Error:") || r.json.error === "File not found");
  });
});

describe("Multi-project isolation", () => {
  test("Projects are isolated from each other", async () => {
    await fetchJSON("/api/projects", { method: "POST", body: { name: "iso-a" } });
    await fetchJSON("/api/projects", { method: "POST", body: { name: "iso-b" } });
    await fetchJSON("/api/file", { method: "POST", body: { project: "iso-a", path: "index.html", content: "AAA" } });
    await fetchJSON("/api/file", { method: "POST", body: { project: "iso-b", path: "index.html", content: "BBB" } });
    const ra = await fetchRaw("/preview/iso-a/index.html");
    const rb = await fetchRaw("/preview/iso-b/index.html");
    assert.ok(ra.body.includes("AAA"));
    assert.ok(rb.body.includes("BBB"));
    assert.ok(!rb.body.includes("AAA"));
  });
});

describe("Preview iframe sandbox", () => {
  test("Homepage does not include allow-same-origin in iframe", async () => {
    const r = await fetchRaw("/");
    assert.ok(!r.body.includes("allow-same-origin"), "iframe should NOT have allow-same-origin");
  });
});

describe("WebSocket", () => {
  test("WS connection sends connected message", async () => {
    const ws = await wsConnect();
    const msg = await wsRecv(ws);
    assert.equal(msg.type, "connected");
    ws.close();
  });

  test("WS init returns init_ack with project and model", async () => {
    const ws = await wsConnect();
    await wsRecv(ws); // connected
    wsSend(ws, { type: "init", project: "testproj", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    const msg = await wsRecv(ws);
    assert.equal(msg.type, "init_ack");
    assert.equal(msg.project, "testproj");
    ws.close();
  });

  test("WS clear_session returns session_cleared", async () => {
    const ws = await wsConnect();
    await wsRecv(ws); // connected
    wsSend(ws, { type: "init", project: "testproj", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    await wsRecv(ws); // init_ack
    wsSend(ws, { type: "clear_session" });
    const msg = await wsRecv(ws);
    assert.equal(msg.type, "session_cleared");
    ws.close();
  });

  test("WS stop returns agent_stopped", async () => {
    const ws = await wsConnect();
    await wsRecv(ws); // connected
    wsSend(ws, { type: "init", project: "testproj", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    await wsRecv(ws); // init_ack
    wsSend(ws, { type: "stop" });
    const msg = await wsRecv(ws);
    assert.equal(msg.type, "agent_stopped");
    ws.close();
  });
});

describe("Model allow-list (P8)", () => {
  test("Known free model is accepted", async () => {
    const ws = await wsConnect();
    await wsRecv(ws); // connected
    wsSend(ws, { type: "init", project: "testproj", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    await wsRecv(ws); // init_ack
    await sleep(100); // let any queued messages settle
    wsSend(ws, { type: "set_model", model: "minimax/minimax-m3:free" });
    const msg = await wsRecv(ws, 3000);
    assert.equal(msg.type, "model_changed");
    ws.close();
  });

  test("Paid model is rejected", async () => {
    const ws = await wsConnect();
    await wsRecv(ws); // connected
    wsSend(ws, { type: "init", project: "testproj", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    await wsRecv(ws); // init_ack
    wsSend(ws, { type: "set_model", model: "gpt-4" });
    const msg = await wsRecv(ws);
    assert.equal(msg.type, "error");
    ws.close();
  });

  test("Unknown free model is rejected (pattern bypass blocked)", async () => {
    const ws = await wsConnect();
    await wsRecv(ws); // connected
    wsSend(ws, { type: "init", project: "testproj", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    await wsRecv(ws); // init_ack
    wsSend(ws, { type: "set_model", model: "fake/model:free" });
    const msg = await wsRecv(ws);
    assert.equal(msg.type, "error");
    ws.close();
  });
});

describe("Concurrent agent run prevention (P2)", () => {
  test("Second chat while agent is running is rejected", async () => {
    const ws = await wsConnect();
    await wsRecv(ws); // connected
    wsSend(ws, { type: "init", project: "testproj", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    await wsRecv(ws); // init_ack
    wsSend(ws, { type: "chat", content: "test 1" });
    await sleep(500); // let the run start
    wsSend(ws, { type: "chat", content: "test 2" });
    const msgs = await wsRecvAll(ws, 5, 3000);
    const hasConcurrentError = msgs.some((m) => m.type === "error" && m.message && m.message.includes("already in progress"));
    assert.ok(hasConcurrentError, "Should reject concurrent run with 'already in progress' error");
    ws.close();
  });
});

describe("Rate limiting (P1)", () => {
  test("Exceeding rate limit triggers error", async () => {
    const ws = await wsConnect();
    await wsRecv(ws); // connected
    wsSend(ws, { type: "init", project: "testproj", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    await wsRecv(ws); // init_ack

    // Collect all incoming messages
    const allMsgs = [];
    ws.on("message", (data) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch {}
    });

    // Send 15 chat messages rapidly, with stop between each to clear active run
    for (let i = 0; i < 15; i++) {
      wsSend(ws, { type: "chat", content: `msg ${i}` });
      await sleep(200);
      wsSend(ws, { type: "stop" });
      await sleep(100);
    }

    // Wait for all messages to arrive
    await sleep(1000);

    const rateLimited = allMsgs.some((m) => m.type === "error" && m.message && m.message.includes("Rate limit"));
    assert.ok(rateLimited, "Should trigger rate limit error after exceeding 10 requests per minute");
    ws.close();
  });
});

describe("Server stability", () => {
  test("Server stays alive after all tests", async () => {
    assert.ok(serverStarted, "Server should have started");
    const r = await fetchRaw("/");
    assert.equal(r.status, 200);
  });
});
