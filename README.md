# VEEos — Multi-Account Google Flow Pool API

**VEEos** (Visual Execution Engine operating system) is a unified API gateway that pools multiple Google accounts with Flow credits, exposing them via **MCP (Model Context Protocol)** and **REST API** for AI agents and applications.

> 🎯 **Goal**: Like `freellmapi` but for Google Flow — route generation requests across multiple accounts, track credits, handle queueing, and provide a single unified interface.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        VEEos API Gateway                        │
│  ┌─────────────────┐    ┌─────────────────┐                    │
│  │   REST API      │    │   MCP Server    │  ← OpenCode, etc.  │
│  │   (Port 3456)   │    │   (stdio)       │                    │
│  └────────┬────────┘    └────────┬────────┘                    │
│           │                      │                             │
│           └──────────┬───────────┘                             │
│                      ▼                                         │
│         ┌───────────────────────┐                              │
│         │   Instance Manager    │                              │
│         │  (Credit-aware sched) │                              │
│         └───────────┬───────────┘                              │
│                     │                                          │
│      ┌──────────────┼──────────────┐                           │
│      ▼              ▼              ▼                           │
│  ┌───────┐      ┌───────┐      ┌───────┐                      │
│  │Acc #1 │      │Acc #2 │      │Acc #N │  ← Chrome + CDP      │
│  │Port9222│     │Port9223│     │Port922X│   (isolated profiles)│
│  │Credits│      │Credits│      │Credits│                      │
│  └───────┘      └───────┘      └───────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **Multi-account pooling** | Route requests to account with most credits / least load |
| **Credit tracking** | Persistent SQLite DB — debits on queue, refunds on failure |
| **Single-job queue per account** | Chrome limitation: 1 generation at a time per profile |
| **Anti-detection** | Launches Chrome direct (not Playwright) → `navigator.webdriver = false` |
| **Profile isolation** | Each account gets copied Chrome profile in `/tmp` |
| **Health monitoring** | Auto-restart on session expiry, captcha, OAuth walls |
| **Dual interface** | MCP (for OpenCode/agents) + REST API (for apps) |
| **OpenAI-compatible** | `/v1/images/generations` drop-in replacement |
| **WebSocket events** | Real-time job status updates |

---

## 🚀 Quick Start (Docker on 10.0.0.126)

### Prerequisites on Host (10.0.0.126)

```bash
# 1. Have Google Chrome profiles with Flow access
# Each account needs its own Chrome profile (Profile 3, Profile 4, etc.)
# Verify: google-chrome --profile-directory="Profile 3" → navigate to labs.google/fx/tools/flow

# 2. Install Docker & Docker Compose
# 3. Generate API token
openssl rand -hex 32
```

### Deploy

```bash
# On 10.0.0.126
cd /opt
git clone <your-repo> VEEos
cd VEEos

# Copy and edit config
cp config/local.yaml.example config/local.yaml
# Edit: accounts[].email, chromeProfile, initialCredits, api.auth.token

# Build and start
docker compose -f docker/docker-compose.yml up -d --build

# Check logs
docker compose -f docker/docker-compose.yml logs -f veeos

# Health check
curl http://10.0.0.126:3456/health
curl -H "Authorization: Bearer YOUR_TOKEN" http://10.0.0.126:3456/v1/accounts
```

---

## 📋 Configuration (`config/local.yaml`)

```yaml
pool:
  cdpPortBase: 9222           # First CDP port (9222, 9223, 9224...)
  headless: true              # Server mode
  locale: "en"

accounts:
  - id: "flow-main"
    email: "main@gmail.com"
    chromeProfile: "Profile 3"          # Must exist on host
    hostUserDataDir: "/host-chrome"     # Mounted read-only
    initialCredits: 150
    priority: "high"
    enabled: true

  - id: "flow-backup"
    email: "backup@gmail.com"
    chromeProfile: "Profile 4"
    hostUserDataDir: "/host-chrome"
    initialCredits: 100
    priority: "normal"
    enabled: true

scheduler:
  strategy: "credit-aware-round-robin"
  modelCosts:
    "Nano Banana Pro": 10
    "Nano Banana 2": 5
    "Imagen 4": 8
    "Omni Flash": 15
    "Veo 3.1 - Quality": 25

api:
  port: 3456
  auth:
    type: "bearer"
    token: "YOUR_SECURE_TOKEN_HERE"
```

---

## 🔌 API Reference

### Authentication
```bash
# All /v1 endpoints require Bearer token
curl -H "Authorization: Bearer YOUR_TOKEN" http://10.0.0.126:3456/v1/accounts
```

### Accounts
```bash
# List all accounts with credits/status
GET /v1/accounts

# Get specific account
GET /v1/accounts/flow-main

# Start/connect account
POST /v1/accounts/flow-main/start

# Restart account (cleanup + relaunch)
POST /v1/accounts/flow-main/restart

# Credit history
GET /v1/accounts/flow-main/credits/history?limit=50
```

### Jobs (Async — returns 202 with jobId)
```bash
# Generate image
POST /v1/jobs/images
{
  "prompt": "A futuristic city at sunset, cyberpunk style",
  "model": "Nano Banana 2",
  "ratio": "16:9",
  "auto_confirm": true,
  "priority": "normal"
}

# Generate video (configures only, no auto-confirm)
POST /v1/jobs/videos
{
  "prompt": "Camera panning over ocean waves",
  "model": "Omni Flash",
  "ratio": "16:9",
  "duration": 5
}

# Create character
POST /v1/jobs/characters
{
  "name": "Protagonist",
  "description": "Young woman, cyberpunk outfit, neon background"
}

# Create scene
POST /v1/jobs/scenes
{
  "prompt": "Character walking through neon street",
  "characters": ["Protagonist"]
}

# Grid Architect (batch shots)
POST /v1/jobs/grid-architect
{
  "theme_prompt": "Product photography, coffee brand",
  "shot_prompts": ["Macro shot of beans", "Pouring into cup", "Lifestyle flatlay"],
  "engine": "Nano Banana 2",
  "ratio": "1:1"
}

# Check job status
GET /v1/jobs/{jobId}

# List jobs
GET /v1/jobs?account_id=flow-main&status=completed&limit=20
```

### Downloads
```bash
# Get latest generated file from account
GET /v1/downloads/flow-main/latest
```

### Pool Management
```bash
# Overall status
GET /v1/pool/status

# Health check all accounts
POST /v1/pool/health-check
```

### OpenAI-Compatible (Drop-in)
```bash
POST /v1/images/generations
{
  "prompt": "A beautiful sunset over mountains",
  "model": "nano-banana-2",      # nano-banana-pro, nano-banana-2, imagen-4
  "size": "1024x1024",           # 1024x1024, 1792x1024, 1024x1792
  "n": 1,
  "quality": "standard"
}
```

---

## 🤖 MCP Integration (OpenCode)

### Register in OpenCode
```json
// ~/.config/opencode/mcp.json
{
  "mcpServers": {
    "veeos": {
      "command": "docker",
      "args": ["exec", "-i", "veeos", "node", "src/index.js", "--mcp"],
      "env": { "VEEOS_MCP_MODE": "true" }
    }
  }
}
```

Or run MCP directly:
```bash
# Inside container
docker exec -it veeos node src/index.js --mcp
```

### Available MCP Tools
| Tool | Description |
|------|-------------|
| `veeos_status` | Pool status with credits, queues, health |
| `veeos_accounts` | List all accounts |
| `veeos_generate_image` | Generate image (auto-selects best account) |
| `veeos_generate_video` | Configure video generation |
| `veeos_create_character` | Create Flow character |
| `veeos_create_scene` | Create scene with characters |
| `veeos_grid_architect` | Batch shot generation |
| `veeos_use_tool` | Any Flow tool by name |
| `veeos_queue_status` | Job queue status |

### Example MCP Usage
```
User: "Generate a cyberpunk city image using the best available account"
→ Agent calls veeos_generate_image with auto_confirm=true
→ VEEos selects account with most credits, executes, returns result
```

---

## 📊 WebSocket Events

Connect to `ws://10.0.0.126:3456/ws` for real-time updates:

```javascript
const ws = new WebSocket('ws://10.0.0.126:3456/ws');
ws.onmessage = (event) => {
  const { event: type, data } = JSON.parse(event.data);
  console.log(type, data);
};

// Events: job.queued, job.started, job.completed, job.failed, account.health, account.status
```

---

## 🔧 Operations

### Adding a New Account
1. Create Chrome profile on host: `google-chrome --profile-directory="Profile 5"` → login to Flow
2. Add to `config/local.yaml`
3. Restart: `docker compose -f docker/docker-compose.yml restart veeos`

### Checking Credits
```bash
curl -H "Authorization: Bearer TOKEN" http://10.0.0.126:3456/v1/accounts | jq '.accounts[] | {id, email, credits, status}'
```

### Manual Credit Adjustment
```bash
# Via database (container)
docker exec -it veeos sqlite3 /data/veeos.db "UPDATE accounts SET credits = 200 WHERE id = 'flow-main';"
```

### Debugging an Account
```bash
# Get account page screenshot
curl -H "Authorization: Bearer TOKEN" -X POST http://10.0.0.126:3456/v1/accounts/flow-main/screenshot

# View Chrome logs
docker exec veeos ls -la /tmp/veeos-chrome-*
```

---

## 🛡️ Security Notes

- **Chrome profiles mounted READ-ONLY** — VEEos copies to `/tmp` per instance
- **No credentials stored** — Uses existing Chrome cookies/session
- **API auth required** — Bearer token or API key
- **Rate limiting** — 100 req/min default
- **Network isolation** — CDP ports only exposed if needed

---

## 📁 Project Structure

```
VEEos/
├── src/
│   ├── index.js                 # Entry point
│   ├── api/server.js            # REST API + WebSocket
│   ├── mcp/server.js            # MCP server
│   ├── manager/
│   │   ├── instance-manager.js  # Multi-account orchestration
│   │   └── job-queue.js         # Per-account job queue
│   ├── browser/
│   │   ├── connect.js           # Chrome launch + CDP (anti-detection)
│   │   └── navigation.js        # Flow navigation helpers
│   ├── tools/
│   │   └── flow-tools.js        # All Flow operations
│   └── utils/
│       ├── config.js            # YAML config with env vars
│       ├── logger.js            # Pino structured logging
│       ├── errors.js            # Error codes & types
│       └── database.js          # SQLite persistence
├── config/
│   ├── veeos.yaml               # Default config
│   └── local.yaml.example       # Template for local override
├── docker/
│   ├── Dockerfile               # Multi-stage build
│   └── docker-compose.yml       # Deployment
└── package.json
```

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| `CHROME_NOT_FOUND` | Verify `google-chrome-stable` in container: `docker exec veeos which google-chrome-stable` |
| `PROFILE_NOT_FOUND` | Check host mount: `docker exec veeos ls /host-chrome/` |
| `CDP_CONNECTION_FAILED` | Port conflict — check `netstat -tlnp` on host for 9222+ |
| `OAUTH_REQUIRED` | Account needs manual login — open Chrome profile on host once |
| `INSUFFICIENT_CREDITS` | Add credits or wait for refill |
| `NO_AVAILABLE_INSTANCE` | All accounts busy or out of credits |
| High memory | Reduce `deploy.resources.limits.memory` in compose |

---

## 📝 License

MIT — Built for the OpenCode ecosystem.

---

## 🤝 Contributing

1. Fork
2. Feature branch
3. Tests pass
4. PR with description

---

**VEEos** — Because one Google account is never enough. 🚀