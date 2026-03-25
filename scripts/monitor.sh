#!/bin/bash
# Monitor resource usage of the cleanslice runtime (bun) process
# Usage: ./monitor.sh [interval_seconds]

INTERVAL=${1:-2}

PID=$(pgrep -f "bun.*src/(index|cli)\.ts" | head -1)

if [ -z "$PID" ]; then
  echo "Runtime process not found. Make sure it's running (bun run dev / bun run start)."
  exit 1
fi

PEAK_RSS=0
PEAK_CPU="0.0"

cleanup() {
  echo ""
  echo "==========================================================="
  peak_rss_mb=$(echo "scale=1; $PEAK_RSS / 1024" | bc)
  echo "  PEAK:  RAM ${peak_rss_mb} MB  |  CPU ${PEAK_CPU}%"
  echo "==========================================================="
  echo ""
  echo "  Droplet sizing recommendation:"
  recommended=$(echo "scale=0; ($PEAK_RSS / 1024) * 1.3 / 1" | bc)
  if [ "$recommended" -lt 512 ]; then
    echo "  -> 512 MB RAM droplet should be enough"
  elif [ "$recommended" -lt 1024 ]; then
    echo "  -> 1 GB RAM droplet recommended"
  elif [ "$recommended" -lt 2048 ]; then
    echo "  -> 2 GB RAM droplet recommended"
  else
    echo "  -> 4 GB+ RAM droplet recommended (${recommended} MB needed)"
  fi
  exit 0
}

trap cleanup INT TERM

echo "Monitoring PID $PID (interval: ${INTERVAL}s) — Ctrl+C for summary"
echo "==========================================================="
printf "%-8s  %8s  %8s  %8s\n" "TIME" "RAM(MB)" "CPU(%)" "THREADS"
echo "-----------------------------------------------------------"

while kill -0 "$PID" 2>/dev/null; do
  read -r cpu rss threads <<< $(ps -p "$PID" -o pcpu=,rss=,th= 2>/dev/null)
  if [ -z "$cpu" ]; then
    echo "Process $PID exited."
    cleanup
  fi

  rss_mb=$(echo "scale=1; $rss / 1024" | bc)

  # Track peaks
  if [ "$rss" -gt "$PEAK_RSS" ] 2>/dev/null; then
    PEAK_RSS=$rss
  fi
  peak_cpu_int=$(echo "$cpu * 10 / 1" | bc 2>/dev/null)
  current_peak_int=$(echo "$PEAK_CPU * 10 / 1" | bc 2>/dev/null)
  if [ "${peak_cpu_int:-0}" -gt "${current_peak_int:-0}" ] 2>/dev/null; then
    PEAK_CPU=$cpu
  fi

  printf "%-8s  %7s   %7s   %7s\n" \
    "$(date +%H:%M:%S)" "${rss_mb}" "${cpu}" "${threads}"
  sleep "$INTERVAL"
done

echo "Process $PID exited."
cleanup
