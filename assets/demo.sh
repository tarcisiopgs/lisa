#!/usr/bin/env bash

# ANSI colors matching Lisa's picocolors output
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
DIM='\033[2m'
BOLD='\033[1m'
WHITE='\033[37m'
RESET='\033[0m'

log()  { echo -e "${CYAN}[lisa]${RESET} ${DIM}${T}${RESET} $1"; }
ok()   { echo -e "${GREEN}[lisa]${RESET} ${DIM}${T}${RESET} $1"; }

banner() {
  local title=" lisa ♪  autonomous issue resolver "
  local border="──────────────────────────────────────"
  echo -e "${YELLOW}"
  echo "  ┌${border}┐"
  echo -e "  │${RESET}${BOLD}${WHITE}${title}${RESET}${YELLOW}│"
  echo "  └${border}┘"
  echo -e "${RESET}"
}

banner
sleep 0.6

T="14:32:01"; log "━━━ Session 1 ━━━"
sleep 0.4

T="14:32:01"; log "Fetching next issue from linear (Engineering)..."
sleep 1.0

T="14:32:02"; ok "Picked up: INT-512 — Add rate limiting middleware to REST API"
sleep 0.25

T="14:32:02"; ok "Moved INT-512 to \"In Progress\""
sleep 0.25

T="14:32:02"; log "Implementing with native worktree... (log: .lisa/logs/session_1.log)"
sleep 3.5

T="14:34:41"; log "Agent finished. Reading .lisa-manifest.json..."
sleep 0.4

T="14:34:41"; log "Pushing branch int-512-add-rate-limiting-middleware..."
sleep 0.8

T="14:34:42"; ok "PR created by provider: https://github.com/acme/webapp/pull/89"
sleep 0.2

T="14:34:42"; ok "Session 1 complete for INT-512"
sleep 0.3

T="14:34:42"; log "Cooling down 30s before next issue..."
sleep 0.8
