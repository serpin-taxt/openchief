#!/usr/bin/env bash
set -euo pipefail

# OpenChief installer
# Usage: curl -fsSL https://raw.githubusercontent.com/serpin-taxt/openchief/main/install.sh | bash

REPO="https://github.com/serpin-taxt/openchief.git"
DIR="openchief"
MIN_NODE=20
MIN_PNPM=10

# Colors (disable if not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' DIM='' RESET=''
fi

info()  { echo -e "${CYAN}▸${RESET} $1"; }
ok()    { echo -e "${GREEN}✓${RESET} $1"; }
warn()  { echo -e "${YELLOW}!${RESET} $1"; }
fail()  { echo -e "${RED}✗${RESET} $1"; }

echo ""
echo -e "${BOLD}  OpenChief Installer${RESET}"
echo -e "${DIM}  AI agents that watch your business tools${RESET}"
echo ""

# ── Check dependencies ──────────────────────────────────────────────

missing=0

# git
if command -v git &>/dev/null; then
  ok "git $(git --version | awk '{print $3}')"
else
  fail "git is not installed"
  echo -e "    Install: ${DIM}https://git-scm.com/downloads${RESET}"
  missing=1
fi

# node
if command -v node &>/dev/null; then
  node_version=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$node_version" -ge "$MIN_NODE" ]; then
    ok "Node.js $(node -v)"
  else
    fail "Node.js $(node -v) — version $MIN_NODE+ required"
    echo -e "    Install: ${DIM}https://nodejs.org/${RESET}"
    missing=1
  fi
else
  fail "Node.js is not installed — version $MIN_NODE+ required"
  echo -e "    Install: ${DIM}https://nodejs.org/${RESET}"
  missing=1
fi

# pnpm
if command -v pnpm &>/dev/null; then
  pnpm_version=$(pnpm -v | cut -d. -f1)
  if [ "$pnpm_version" -ge "$MIN_PNPM" ]; then
    ok "pnpm $(pnpm -v)"
  else
    fail "pnpm $(pnpm -v) — version $MIN_PNPM+ required"
    echo -e "    Install: ${DIM}npm install -g pnpm${RESET}"
    missing=1
  fi
else
  fail "pnpm is not installed — version $MIN_PNPM+ required"
  echo -e "    Install: ${DIM}npm install -g pnpm${RESET}"
  missing=1
fi

echo ""

if [ "$missing" -ne 0 ]; then
  fail "Install the missing dependencies above and try again."
  echo ""
  exit 1
fi

# ── Clone & install ─────────────────────────────────────────────────

if [ -d "$DIR" ]; then
  warn "${BOLD}$DIR/${RESET} already exists — skipping clone"
  cd "$DIR"
else
  info "Cloning OpenChief..."
  git clone --depth 1 "$REPO" "$DIR"
  cd "$DIR"
fi

info "Installing dependencies..."
pnpm install

echo ""
echo -e "${GREEN}  ┌─────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}  │${RESET}  ${BOLD}Ready to set up OpenChief${RESET}              ${GREEN}│${RESET}"
echo -e "${GREEN}  └─────────────────────────────────────────┘${RESET}"
echo ""
echo -e "  Run the setup wizard:"
echo ""
echo -e "    ${CYAN}cd $DIR && pnpm run setup${RESET}"
echo ""
