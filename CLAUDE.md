# CLAUDE.md — macro-toolkit monorepo

This is a monorepo. Each project lives under `projects/<project-name>/`.

## Current projects

| Folder | Description |
|--------|-------------|
| `projects/macro-kit/` | Fixed income macro analytics dashboard (FastAPI + React) |

## Git workflow — how Gerardo and Massimo collaborate

### Golden rules
- **Never push directly to `main`**
- Always work on a personal feature branch
- Open a PR when your work is ready for review
- The other person reviews and merges

### Day-to-day workflow

```bash
# 1. Start from a fresh main
git checkout main
git pull origin main

# 2. Create your feature branch
git checkout -b <your-name>/<feature-description>
# e.g. git checkout -b massimo/us-heatmap
# e.g. git checkout -b gerardo/hicp-fixings

# 3. Do your work, commit as you go
git add <files>
git commit -m "Description of what and why"

# 4. Push your branch
git push origin <your-name>/<feature-description>

# 5. Open a PR on GitHub — other person reviews and merges
```

### Staying up to date with main

If `main` has moved on while you were working on your branch:

```bash
git fetch origin
git rebase origin/main
# resolve any conflicts, then:
git push --force-with-lease origin <your-branch>
```

### Repo structure reminder

All application code lives inside `projects/macro-kit/`. When Claude Code or any tool refers to `backend/` or `frontend/`, it means `projects/macro-kit/backend/` and `projects/macro-kit/frontend/`.

---

## Adding a new project

Create a new folder under `projects/` and add a `CLAUDE.md` inside it following the same pattern as `projects/macro-kit/CLAUDE.md`.
