#!/bin/bash
# Manage the coach bridge daemon (launchd).
P=~/Library/LaunchAgents/com.coach.bridge.plist
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
L=gui/$(id -u)/com.coach.bridge
BUN="$(command -v bun || echo ~/.bun/bin/bun)"
case "$1" in
  install)
    # launchd gets a bare environment: bake in this shell's PATH so the
    # worker can find bun, claude/codex, and sips.
    mkdir -p "$ROOT/data/logs" \
      && sed -e "s|__ROOT__|$ROOT|g" -e "s|__BUN__|$BUN|g" -e "s|__PATH__|$PATH|g" -e "s|__HOME__|$HOME|g" \
           "$ROOT/daemon/com.coach.bridge.plist" > "$P" \
      && launchctl bootstrap gui/$(id -u) "$P" && echo "installed + started";;
  start)   launchctl kickstart "$L" && echo started;;
  stop)    launchctl bootout "$L" 2>/dev/null; echo stopped;;
  restart)
    cd "$ROOT" && "$(dirname "$BUN")/bunx" tsc --noEmit -p . \
      || { echo "TYPECHECK FAILED — not restarting; daemon keeps running old code"; exit 1; }
    launchctl kickstart -k "$L" && echo "typecheck ok, restarted";;
  status)  launchctl print "$L" 2>/dev/null | grep -E "state|pid|last exit" | head -5 || echo "not installed";;
  logs)    tail -30 "$ROOT/data/logs/bridge.err.log" "$ROOT/data/events.log";;
  uninstall) launchctl bootout "$L" 2>/dev/null; rm -f "$P"; echo uninstalled;;
  *) echo "usage: daemon.sh install|start|stop|restart|status|logs|uninstall";;
esac
