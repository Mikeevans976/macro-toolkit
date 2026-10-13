# Analytics Hub

A dark space-themed analytics dashboard for the financial analytics team. Built with FastAPI (backend) and React + Vite + TypeScript + Tailwind CSS (frontend).

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Python | 3.12+ | `python3 --version` |
| Node.js | 20+ | `node --version` |
| npm | 10+ | `npm --version` |

---

## Quick Start (local)

These steps clone the repo, install all dependencies, create your login, and launch the app.

```bash
# 1. Clone and enter the repo
git clone <repo-url>
cd Team-Massimo-Marzeglia-Analytics

# 2. Create a Python virtual environment and install backend dependencies
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt

# 3. Create your login (replace the placeholder values)
python backend/create_user.py yourname yourpassword "Your Full Name"

# 4. Build the frontend
cd frontend && npm install && npm run build && cd ..

# 5. Start the app
python backend/main.py
```

Open **http://localhost:8000** in your browser and log in with the credentials you set in step 3.

---

## Data source

By default the app runs in **simulation mode** — all charts render with realistic synthetic data, no Bloomberg or Haver connection required.

To switch to live data, set the environment variable before starting:

```bash
ANALYTICS_DATA_SOURCE=bloomberg python backend/main.py
# or
ANALYTICS_DATA_SOURCE=haver python backend/main.py
```

---

## Project structure

```
dashboard_config.yaml      # Edit to add/remove/reorder tool tiles (no restart needed)
backend/
  main.py                  # FastAPI app: middleware, auth routes, router mounting, static files
  routers/                 # One APIRouter per tool (+ agents.py for the Global Macro Pod)
  auth.py                  # JWT + bcrypt auth
  runtime_paths.py         # Where runtime state lives (var/ or $MACROKIT_STATE_DIR)
  requirements.in          # Direct dependencies (edit this)
  requirements.txt         # Pinned lock generated from requirements.in (install this)
  create_user.py           # Script to add/update users
var/                       # Runtime state, gitignored: users.json, SQLite DBs, pod sandbox
frontend/
  src/
    App.tsx
    pages/                 # One file per tool page
    components/
```

---

## Adding users

```bash
source .venv/bin/activate
python backend/create_user.py <username> <password> "<Full Name>"
```

Tokens expire after 8 hours. Users are stored in `var/users.json` (gitignored — never commit it). An older install's `backend/users.json` keeps working until you move it into `var/`.

---

## Developer workflow

```bash
# Backend dev server (auto-reload)
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000

# Frontend dev server (hot-reload, proxies /api → :8000)
cd frontend && npm run dev   # http://localhost:5173

# After editing any .tsx file, always verify it builds cleanly
cd frontend && npm run build
```

> **Production note**: set `SECRET_KEY` to a long random string via environment variable before deploying.
