# Pi Web Agent

A browser-based coding agent powered by OpenRouter free models. Built by extracting the core agent concepts from the [pi](https://github.com/earendil-works/pi) project and adapting them for the browser.

## Features

- **Chat-based coding agent** — Describe what you want, the agent writes the code
- **Live preview** — See your HTML/CSS/JS rendered instantly in a side panel
- **File tree + code viewer** — Browse and read all files in your project
- **Shell execution** — The agent can run commands (npm install, builds, tests, etc.)
- **OpenRouter integration** — Uses free models from OpenRouter (DeepSeek, Llama, Gemini, etc.)
- **Model switching** — Switch between any OpenRouter model on the fly
- **Session persistence** — Conversation history is saved per project
- **Streaming responses** — See the agent's output in real-time
- **Tool calling** — Agent can read, write, edit, delete files and run shell commands

## Quick Start (Local)

### 1. Get an OpenRouter API key

1. Go to [openrouter.ai](https://openrouter.ai)
2. Sign up and get a free API key
3. Free models are available at no cost

### 2. Configure and run

```bash
git clone https://github.com/Gshanak/pi-web-agent.git
cd pi-web-agent
cp .env.example .env
# Edit .env and add your key:
# OPENROUTER_API_KEY=sk-or-v1-...
npm install
npm start
```

Open http://localhost:3000 in your browser.

## Deploy to Render (Free Tier)

Get a live web URL in 2 minutes:

### Option A: One-click deploy

1. Go to [render.com](https://render.com) and sign up
2. Click **New** → **Web Service**
3. Connect your GitHub account and select the `Gshanak/pi-web-agent` repo
4. Render will auto-detect `render.yaml` — just click **Apply**
5. Add your `OPENROUTER_API_KEY` as an environment variable in the Render dashboard
6. Wait for the build to finish — you'll get a live URL like `https://pi-web-agent.onrender.com`

### Option B: Manual deploy

1. Fork this repo to your GitHub account
2. Go to [render.com](https://render.com) → **New** → **Web Service**
3. Connect your GitHub and select the forked repo
4. Set the following:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Add environment variable:
   - `OPENROUTER_API_KEY` = your API key
   - `OPENROUTER_MODEL` = `deepseek/deepseek-chat-v3-0324:free` (or any free model)
6. Click **Create Web Service**
7. Your app will be live at `https://<your-service-name>.onrender.com`

## Deploy with Docker

```bash
docker build -t pi-web-agent .
docker run -p 3000:3000 -e OPENROUTER_API_KEY=sk-or-v1-... pi-web-agent
```

Open http://localhost:3000.

## Usage

1. Click **+ New** to create a project
2. Select a free model from the dropdown
3. Type a prompt like "Build a todo list app with HTML, CSS, and JavaScript"
4. Watch the agent write files, run commands, and build your project
5. See the live preview update automatically
6. Click files in the sidebar to view them in the editor
7. Continue chatting to iterate and refine

## How it works

- **Backend** (Node.js + Express + WebSocket): Runs the agent loop, handles OpenRouter API calls with streaming and tool calling, executes tools (file I/O, shell commands), and serves preview files
- **Frontend** (HTML + CSS + vanilla JS): Chat interface, file tree, code viewer, live preview iframe, and terminal output panel — all in a dark IDE-like layout
- **Agent loop**: Sends messages to OpenRouter with tool definitions, streams the response, executes any tool calls, feeds results back, and repeats until the agent is done

## Project structure

```
pi-web-agent/
├── backend/
│   └── server.js        # Express + WebSocket server, agent loop, tools
├── public/
│   ├── index.html       # Main UI
│   ├── css/
│   │   └── style.css    # Dark IDE styling
│   └── js/
│       └── app.js       # Frontend logic (chat, file tree, preview, editor)
├── Dockerfile           # Containerized deployment
├── render.yaml          # Render.com deployment config
├── projects/            # User projects (created at runtime)
├── package.json
├── .env.example
└── .gitignore
```

## Tools available to the agent

| Tool | Description |
|------|-------------|
| `write_file` | Create or overwrite a file |
| `read_file` | Read file contents |
| `edit_file` | Find and replace text in a file |
| `list_files` | List directory contents |
| `create_directory` | Create a new directory |
| `run_command` | Execute a shell command |
| `delete_file` | Delete a file or directory |

## Security note

The agent runs shell commands with your user's permissions. For safety, commands timeout after 30 seconds. For untrusted prompts, consider running inside a Docker container.

## License

MIT
