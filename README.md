# Team Massimo Marzeglia — Analytics Hub

A dark space-themed analytics dashboard for the financial analytics team. Built with FastAPI (backend) and React + Vite + TypeScript + Tailwind CSS (frontend).

---

## Project Structure

```
dashboard_config.yaml   # Edit this to add/remove categories and tools
backend/
  main.py               # FastAPI app
  auth.py               # JWT + bcrypt auth
  requirements.txt
  create_user.py        # Script to add/update users
  users.json            # User store (gitignored — create with create_user.py)
frontend/
  src/
    App.tsx
    components/
      Login.tsx
      Dashboard.tsx
      CategoryCard.tsx
      ToolTile.tsx
    types.ts
```

---

## Setup

### 1. Backend

```bash
# Create and activate a virtual environment (recommended)
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r backend/requirements.txt

# Create the initial admin user
python backend/create_user.py admin admin123 "Admin User"

# Start the API server
uvicorn backend.main:app --reload --port 8000
# or
python backend/main.py
```

> **Production**: Set the `SECRET_KEY` environment variable to a long random string before running.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev        # Dev server at http://localhost:5173 (proxies /api to :8000)
npm run build      # Build to frontend/dist/ (served by FastAPI in production)
```

### 3. Production (serving everything from FastAPI)

```bash
cd frontend && npm run build
cd ..
python backend/main.py   # Serves API + built frontend at http://localhost:8000
```

---

## Customisation

Edit `dashboard_config.yaml` to add, remove, or reorganise categories and tools. The dashboard reads this file on every request, so changes take effect immediately without restarting.

---

## Auth

- Default credentials: `admin` / `admin123` (change immediately in production)
- To add more users: `python backend/create_user.py <username> <password> "<Full Name>"`
- Tokens expire after 8 hours
- `users.json` is gitignored — never commit it
