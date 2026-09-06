# Pi Web Agent — Complete Render Deployment Guide

This guide walks you through deploying Pi Web Agent to Render.com from start to finish. The app is already configured for Render via `render.yaml` — you just need to connect your repo, set your API key, and deploy.

---

## Prerequisites

Before you begin, make sure you have:

1. **A GitHub account** with the `Gshanak/pi-web-agent` repository available (you already have this).
2. **A Render.com account** — sign up free at [render.com](https://render.com). The free plan is sufficient.
3. **An OpenRouter API key** — get one free at [openrouter.ai/keys](https://openrouter.ai/keys). You need credits or a free-tier model available.
4. **Node.js 22+** installed locally (optional, only if you want to test before deploying).

---

## What You're Deploying

Pi Web Agent is a single-service web app:

- **Backend**: Node.js + Express + WebSocket server (`backend/server.js`)
- **Frontend**: Static HTML/CSS/JS served from `public/`
- **Runtime**: Node.js
- **Dependencies**: `express` and `ws` (only two npm packages)
- **Build**: `npm ci` (clean install from `package-lock.json`)
- **Start command**: `npm start` (runs `node backend/server.js`)
- **Port**: Reads from `PORT` environment variable (Render sets this automatically)
- **Plan**: Free tier (512 MB RAM, 750 hours/month — enough for personal use)

The `render.yaml` file in the repo root already defines all of this, so Render will auto-detect the configuration.

---

## Step 1 — Push Final Code to GitHub

Your repo (`Gshanak/pi-web-agent`, branch `main`) is already up to date with all hardening, tests, and CI. Verify the latest commits are pushed:

```
git log --oneline -5
```

You should see (most recent first):
- `03baeff` — test: Add smoke test suite (38 tests)
- `8b65418` — test: Add npm test script + update CI
- `883c2e5` — P0 fixes (continge typo, stderr template)
- `68e1a4b` — CI workflow + package.json postinstall removal
- `fb0225c` — server.js hardening (P1-P9)
- `9c0714c` — render.yaml npm ci

All code is already on GitHub. No local push needed.

---

## Step 2 — Create a Render Account and Connect GitHub

1. Go to [render.com](https://render.com) and sign up (you can use your GitHub account for one-click sign-in).
2. Once logged in, Render will ask to connect your GitHub account. Authorize it.
3. Render needs access to your repository. You can grant access to:
   - **All repositories** (easier), or
   - **Specific repositories** — select `Gshanak/pi-web-agent`.

---

## Step 3 — Deploy Using render.yaml (Blueprint Deploy)

Render supports "Blueprint" deployments, which read the `render.yaml` file from your repo and automatically configure everything.

1. In the Render dashboard, click **New +** → **Blueprint**.
2. Select your GitHub account/organization.
3. Find and select the `pi-web-agent` repository.
4. Render will detect `render.yaml` and show you the service it will create:
   - **Name**: `pi-web-agent`
   - **Type**: Web Service
   - **Runtime**: Node
   - **Plan**: Free
   - **Build Command**: `npm ci`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/`
5. Before clicking **Apply**, scroll down to **Environment Variables**. You'll see:
   - `OPENROUTER_API_KEY` — marked as `sync: false`, meaning Render will prompt you to enter it.
   - `OPENROUTER_MODEL` — pre-set to `deepseek/deepseek-chat-v3-0324:free`
   - `PORT` — pre-set to `3000`

---

## Step 4 — Set Your OpenRouter API Key

This is the one piece Render cannot auto-fill — your API key is secret.

1. In the Blueprint apply screen, find the `OPENROUTER_API_KEY` field.
2. Paste your OpenRouter API key (starts with `sk-or-v1-...`).
3. If you want to use a different default model, change `OPENROUTER_MODEL` to any of the allowed free models (see list below).
4. Click **Apply**.

Render will now:
1. Clone your repo.
2. Run `npm ci` (installs `express` and `ws`).
3. Run `npm start` (starts the server).
4. Assign a public URL like `https://pi-web-agent.onrender.com`.

---

## Step 5 — Watch the First Deploy

1. In the Render dashboard, click on your new service (`pi-web-agent`).
2. Go to the **Events** or **Logs** tab.
3. You'll see the build process:
   ```
   ==> Cloning repo...
   ==> Running build command 'npm ci'...
   ==> Running start command 'npm start'...
   ```
4. When the server starts, you'll see:
   ```
   Pi Web Agent running at http://localhost:3000
   ```
5. Render detects the health check at `/` (returns 200 OK) and marks the service as **Live**.

If the deploy fails, check the logs for the specific error. Common issues and solutions are in the Troubleshooting section below.

---

## Step 6 — Verify the Deployment

Once the service is live:

1. **Open the URL** — Click the URL Render assigned (e.g., `https://pi-web-agent.onrender.com`). You should see the Pi Web Agent interface.
2. **Create a project** — Type a name in the "New Project" field and click Create.
3. **Send a chat message** — Type a prompt like "Create a simple HTML page with a red button" and watch the agent work.
4. **Check the preview** — After the agent writes files, the preview iframe should render your project.
5. **Check the models endpoint** — Visit `https://pi-web-agent.onrender.com/api/models` — it should return a JSON list of free models from OpenRouter.

If all of these work, your deployment is successful.

---

## Step 7 — (Optional) Set Up a Custom Domain

On the Render free plan, you get a `*.onrender.com` subdomain. If you want a custom domain:

1. Go to your service → **Settings** → **Custom Domains**.
2. Add your domain (e.g., `piweb.yourdomain.com`).
3. Render will give you DNS records to add to your domain registrar.
4. Once DNS propagates, Render issues an SSL certificate automatically.

This is optional — the `*.onrender.com` URL works fine for personal use.

---

## Environment Variables Reference

The `render.yaml` file defines these environment variables:

| Variable | Value | Sync | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | (your key) | `false` | Your OpenRouter API key — Render prompts you to enter this |
| `OPENROUTER_MODEL` | `deepseek/deepseek-chat-v3-0324:free` | — | Default AI model (must be in the allowed free models list) |
| `PORT` | `3000` | — | Port the server listens on (Render sets this automatically) |

### Changing the Default Model

You can change `OPENROUTER_MODEL` to any of these 32 allowed free models:

**DeepSeek:**
- `deepseek/deepseek-chat-v3-0324:free`
- `deepseek/deepseek-r1:free`
- `deepseek/deepseek-r1-distill-llama-70b:free`
- `deepseek/deepseek-r1-distill-qwen-32b:free`
- `deepseek/deepseek-r1-distill-qwen-14b:free`

**Google:**
- `google/gemini-2.0-flash-exp:free`
- `google/gemini-flash-1.5:free`
- `google/gemma-2-9b-it:free`
- `google/gemma-3-27b-it:free`

**Meta LLaMA:**
- `meta-llama/llama-3.3-70b-instruct:free`
- `meta-llama/llama-3.2-3b-instruct:free`
- `meta-llama/llama-3.2-1b-instruct:free`
- `meta-llama/llama-3.1-8b-instruct:free`

**Mistral:**
- `mistralai/mistral-7b-instruct:free`
- `mistralai/mistral-nemo:free`
- `mistralai/pixtral-12b:free`

**Qwen:**
- `qwen/qwen-2.5-72b-instruct:free`
- `qwen/qwen-2.5-coder-32b-instruct:free`
- `qwen/qwen-2.5-7b-instruct:free`
- `qwen/qwen-2.5-1.5b-instruct:free`
- `qwen/qwq-32b:free`
- `qwen/qwq-32b-preview:free`

**Others:**
- `nvidia/nemotron-nano-8b-v2:free`
- `microsoft/phi-3-medium-128k-instruct:free`
- `microsoft/phi-3.5-mini-128k-instruct:free`
- `microsoft/mai-ds-r1:free`
- `huggingfaceh4/zephyr-7b-beta:free`
- `openchat/openchat-7b:free`
- `teknium/openhermes-2.5-mistral-7b:free`
- `nousresearch/nous-hermes-2-mixtral-8x7b-dpo:free`
- `sophosympatheia/rogue-rose-103b-v0.2:free`
- `undi95/topl-models:free`

---

## render.yaml (Reference)

The current `render.yaml` in your repo:

```yaml
services:
  - type: web
    name: pi-web-agent
    runtime: node
    plan: free
    buildCommand: npm ci
    startCommand: npm start
    healthCheckPath: /
    envVars:
      - key: OPENROUTER_API_KEY
        sync: false
      - key: OPENROUTER_MODEL
        value: deepseek/deepseek-chat-v3-0324:free
      - key: PORT
        value: 3000
```

---

## How Render Handles Your App

### Build Phase
1. Render clones your repo from GitHub.
2. Runs `npm ci` — installs exactly what's in `package-lock.json` (express + ws).
3. No build step needed — your code is ready to run as-is.

### Runtime
1. Render runs `npm start` → `node backend/server.js`.
2. The server reads `PORT` from the environment (Render injects this).
3. Express serves the frontend from `public/`.
4. WebSocket server attaches to the same HTTP server at path `/ws`.
5. Render's load balancer routes HTTPS traffic to your container.
6. Health check hits `/` every few minutes — if it returns 200, the service stays alive.

### Free Plan Limitations
- **512 MB RAM** — sufficient for Node.js + Express + a few concurrent WebSocket connections.
- **750 hours/month** — enough for always-on if it's your only service.
- **Spin-down after 15 min idle** — the service goes to sleep when no traffic. First request after idle takes ~30 seconds to cold-start. This is normal on the free plan.
- **No persistent disk** — if Render restarts your container, files in `projects/` are lost. This is expected for the current single-user scope. If you need persistence, upgrade to a paid plan with a disk mount, or connect an external storage service.

---

## Troubleshooting

### Deploy fails with "npm ci" error
**Cause**: `package-lock.json` is missing or out of sync.
**Fix**: The lockfile is committed in your repo. If you've changed `package.json`, run `npm install` locally first to regenerate the lockfile, then commit and push.

### Deploy succeeds but the app shows "OPENROUTER_API_KEY not set"
**Cause**: You didn't enter the API key during the Blueprint apply step.
**Fix**: Go to your service → **Environment** → add `OPENROUTER_API_KEY` with your key value. Render will auto-redeploy.

### The app loads but chat doesn't work
**Cause**: The OpenRouter API key is invalid, or the model is not available on your account.
**Fix**:
1. Check the logs in Render dashboard → your service → **Logs**.
2. Look for error messages from the OpenRouter API.
3. Verify your API key at [openrouter.ai/keys](https://openrouter.ai/keys).
4. Try a different model from the allowed list above.

### WebSocket connection fails (chat hangs)
**Cause**: Render's free plan uses a timeout that can close idle WebSocket connections.
**Fix**: The app handles reconnection automatically. Refresh the page if the connection drops. For more stable WebSocket, consider upgrading to a paid plan.

### The service keeps spinning down
**Cause**: Free plan services sleep after 15 minutes of inactivity.
**Fix**: This is expected behavior. The service wakes up on the next request (takes ~30 seconds). If you need always-on, upgrade to the **Starter** plan ($7/month) which includes always-on service.

### "Port not detected" error
**Cause**: The server isn't reading the `PORT` environment variable.
**Fix**: Your `render.yaml` sets `PORT=3000`, and `server.js` reads `process.env.PORT || 3000`. This should work. If you see this error, verify the `render.yaml` is at the repo root and hasn't been modified.

### Health check failing
**Cause**: The server isn't returning 200 on `/`.
**Fix**: Verify locally:
```bash
PORT=3000 node backend/server.js
# In another terminal:
curl http://localhost:3000/
# Should return the HTML homepage
```

### Files disappear after redeploy
**Cause**: Render free plan has no persistent disk. Each deploy starts fresh.
**Fix**: This is expected. Projects are ephemeral on the free plan. For persistence:
- **Option A**: Upgrade to a paid plan and attach a disk to `/opt/render/project/src/projects`.
- **Option B**: Accept ephemeral projects (fine for testing/demoing).
- **Option C**: Use the agent itself to push projects to GitHub instead of relying on local files.

---

## Post-Deploy: Setting Up Auto-Deploy

By default, Render auto-deploys whenever you push to `main`. To verify:

1. Go to your service → **Settings** → **Auto-Deploy**.
2. Ensure it's set to **Yes** for the `main` branch.
3. Every push to `main` will trigger a new deploy automatically.

You can also manually deploy from a specific commit:
1. Go to your service → **Manual Deploy**.
2. Select a branch or commit SHA.
3. Click **Deploy**.

---

## CI/CD Pipeline

Your repo has a GitHub Actions CI workflow (`.github/workflows/ci.yml`) that runs on every push and pull request to `main`:

1. `npm ci` — install dependencies
2. `node --check backend/server.js` — syntax validation
3. `npm test` — runs the 38-test smoke suite

If CI fails, Render will still deploy (Render doesn't check CI status by default). To enforce CI before deploy:

1. In Render, go to your service → **Settings**.
2. Enable **"Wait for CI to pass before deploying"**.
3. Now Render will only deploy when CI is green.

---

## Security Checklist for Production

Your app already has these protections built in (from the hardening work):

- ✅ **CSP header** — `script-src 'self'` (no `unsafe-inline`)
- ✅ **X-Content-Type-Options: nosniff**
- ✅ **X-Frame-Options: SAMEORIGIN**
- ✅ **Path traversal protection** — `safeJoin()` validates all file paths
- ✅ **Symlink hardening** — `safeJoinReal()` resolves real paths
- ✅ **Command allow-list** — blocks `rm -rf`, `sudo`, `curl|sh`, etc.
- ✅ **Model allow-list** — only 32 known free models accepted
- ✅ **Rate limiting** — 10 chat requests per 60 seconds per connection
- ✅ **Concurrent run prevention** — one agent run per WebSocket
- ✅ **AbortController timeout** — 120s timeout on OpenRouter fetch
- ✅ **JSON body limit** — 1 MB max
- ✅ **WebSocket frame limit** — 256 KB max
- ✅ **Preview iframe sandbox** — no `allow-same-origin`
- ✅ **Child process tracking** — kill/cancel on disconnect or stop

### For public deployment, you'd additionally want:
- **WebSocket Origin validation** — only accept WS connections from your own domain (prevents cross-site WebSocket hijacking). Not needed for personal use.
- **Shell sandbox** — if untrusted users will run commands, consider running the agent in a container or VM. Not needed for single-user personal use.
- **Authentication** — if the app is publicly accessible, add at least a password/token. Your current scope is personal/single-user, so this is optional.

---

## Quick Deploy Summary (TL;DR)

1. Go to [render.com](https://render.com), sign up with GitHub.
2. **New +** → **Blueprint** → select `Gshanak/pi-web-agent`.
3. Enter your `OPENROUTER_API_KEY` when prompted.
4. Click **Apply**.
5. Wait ~2 minutes for the build and deploy.
6. Visit your `*.onrender.com` URL.
7. Create a project, send a chat message, watch the agent build.

That's it. Your app is live on the internet.
