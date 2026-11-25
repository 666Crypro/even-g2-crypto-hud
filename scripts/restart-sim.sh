#!/usr/bin/env bash
# Restart the Even Hub simulator headless (Xvfb) with the automation control plane on :9898.
pkill -f sim-linux-x64 2>/dev/null; pkill -f evenhub-simulator 2>/dev/null; sleep 1
URL="${1:-http://localhost:5173}"
nohup xvfb-run -a -s "-screen 0 1400x1000x24" evenhub-simulator "$URL" --automation-port 9898 > /tmp/sim.log 2>&1 &
for i in $(seq 1 30); do
  sleep 1
  curl -s http://127.0.0.1:9898/api/console 2>/dev/null | grep -q '\[heads-up\] ready' && { echo "simulator ready"; exit 0; }
done
echo "simulator not ready"; exit 1
