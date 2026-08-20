# Detects whether the app lives at root (local main) or under projects/macro-kit/ (monorepo branches)
APP_DIR := $(if $(wildcard backend/main.py),.,$(if $(wildcard projects/macro-kit/backend/main.py),projects/macro-kit,.))
VENV    := $(CURDIR)/.venv/bin/activate

.PHONY: backend frontend

backend:
	@if [ ! -f $(APP_DIR)/backend/users.json ]; then \
		source $(VENV) && python $(APP_DIR)/backend/create_user.py gerardo gerardo123 "Gerardo"; \
	fi
	cd $(APP_DIR)/backend && source $(VENV) && uvicorn main:app --reload --port 8000

frontend:
	cd $(APP_DIR)/frontend && npm run dev
