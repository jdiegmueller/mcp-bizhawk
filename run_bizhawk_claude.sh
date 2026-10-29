#!/bin/bash
# Auto-restart BizHawk on crash with 5s cooldown. CTRL+C to exit.
# Usage: run_bizhawk.sh [--socket_ip=IP] [--socket_port=PORT]
trap 'echo "Stopped."; exit 0' INT

IP=127.0.0.1
PORT=8767

for arg in "$@"; do
  case "$arg" in
    --socket_ip=*) IP="${arg#*=}" ;;
    --socket_port=*) PORT="${arg#*=}" ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

while true; do
  clear
  DISPLAY=:1 ~/src/nvnhl94-2/tools/bizhawk/BizHawk-2.11.1-linux-x64/EmuHawkMono.sh \
    --socket_ip="$IP" --socket_port="$PORT" --lua=Lua/bridge_JD.lua \
    /mnt/8tb/jason/nvnhl94-2/rom/nhl94.gen
  echo "BizHawk exited. Restarting in 5s... (CTRL+C to stop)"
  sleep 5
done
