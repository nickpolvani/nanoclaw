# NanoClaw control Makefile (headless Mac: Colima + tmux)
# Usage: make <target>   —   `make` or `make help` lists targets.

SHELL       := /bin/bash
PROJECT_DIR := /Users/nicco/Documents/projects/nanoclaw
TMUX        := /opt/homebrew/bin/tmux -L nanoclaw
COLIMA      := /opt/homebrew/bin/colima
DOCKER      := /usr/local/bin/docker
SESSION     := nanoclaw
LOG         := $(PROJECT_DIR)/logs/nanoclaw.log
NODE_PROC   := nanoclaw/dist/index.js

.DEFAULT_GOAL := help
.PHONY: help start stop restart status logs attach build colima-up truncate-logs

help: ## Show this help
	@echo "NanoClaw — available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

colima-up: ## Ensure the Colima Docker runtime is running
	@$(DOCKER) info >/dev/null 2>&1 && echo "Colima: already running" || { \
	  echo "Starting Colima..."; \
	  $(COLIMA) start --cpu 4 --memory 8 --disk 60 --vm-type vz; }

start: colima-up ## Start NanoClaw (Colima + tmux session)
	@if $(TMUX) has-session -t $(SESSION) 2>/dev/null; then \
	  echo "NanoClaw already running (tmux session '$(SESSION)'). Use 'make restart'."; \
	else \
	  cd $(PROJECT_DIR) && $(TMUX) new-session -d -s $(SESSION) \
	    "exec $(PROJECT_DIR)/run-nanoclaw-loop.sh >> $(LOG) 2>&1" && \
	  sleep 4 && echo "Started. " && $(MAKE) -s status; \
	fi

stop: ## Stop NanoClaw (kill tmux session + node)
	@$(TMUX) kill-session -t $(SESSION) 2>/dev/null && echo "tmux session killed" || echo "no tmux session"
	@pkill -f "$(NODE_PROC)" 2>/dev/null && echo "node stopped" || echo "node not running"

restart: ## Restart NanoClaw
	@$(MAKE) -s stop; sleep 3; $(MAKE) -s start

status: ## Show NanoClaw / Colima / Telegram status
	@echo "── NanoClaw status ──"
	@$(DOCKER) info >/dev/null 2>&1 && echo "Colima      : UP" || echo "Colima      : DOWN"
	@$(TMUX) has-session -t $(SESSION) 2>/dev/null && echo "tmux session: ALIVE ($(SESSION))" || echo "tmux session: GONE"
	@P=$$(pgrep -f "$(NODE_PROC)" | head -1); \
	  if [ -n "$$P" ]; then \
	    echo "node        : pid $$P, uptime $$(ps -p $$P -o etime= | tr -d ' ')"; \
	    echo "telegram    : $$(lsof -nP -p $$P 2>/dev/null | grep -c ESTABLISHED) live connection(s)"; \
	  else echo "node        : NOT running"; fi
	@echo "last agent  : $$(grep -aE 'Telegram message sent|Agent output:' $(LOG) 2>/dev/null | tail -1 | sed 's/\[[0-9;]*m//g')"

logs: ## Tail the NanoClaw log (Ctrl-C to stop)
	@tail -n 40 -f $(LOG)

attach: ## Attach to the live tmux session (Ctrl-b d to detach)
	@$(TMUX) attach -t $(SESSION)

build: colima-up ## Rebuild dist + the agent container image
	@cd $(PROJECT_DIR) && npm run build && ./container/build.sh

truncate-logs: ## Truncate the (unrotated) NanoClaw logs
	@: > $(LOG); : > $(PROJECT_DIR)/logs/nanoclaw.error.log; echo "logs truncated"

reset-container: ## Wipe one group's persistent container (GROUP=<folder>)
	@test -n "$(GROUP)" || (echo "Usage: make reset-container GROUP=<folder>" && exit 1)
	@name="nanoclaw-grp-$$(echo '$(GROUP)' | tr -c 'a-zA-Z0-9-' '-' | sed 's/-*$$//')"; \
		echo "Removing $$name"; docker rm -f "$$name" 2>/dev/null || true

reset-all-containers: ## Wipe ALL persistent per-group containers
	@names="$$(docker ps -a --filter name=nanoclaw-grp- --format '{{.Names}}')"; \
		if [ -n "$$names" ]; then echo "$$names" | xargs -r docker rm -f; \
		else echo "No persistent containers"; fi
