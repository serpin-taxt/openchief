#!/bin/bash
# Run deep Slack backfill until all channels are done.
#
# Usage: bash scripts/run-backfill.sh <connector-url>
# Example: bash scripts/run-backfill.sh https://your-connector-slack.workers.dev/backfill

URL="${1:-http://localhost:8787/backfill}"
PASS=0
TOTAL_EVENTS=0

echo "Starting Slack backfill against: $URL"
echo ""

while true; do
  PASS=$((PASS + 1))
  RESULT=$(curl -s -X POST "$URL")

  DONE=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('done',False))" 2>/dev/null)
  EVENTS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('events',0))" 2>/dev/null)
  CH_IDX=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('channelIndex',0))" 2>/dev/null)
  CH_TOTAL=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('totalChannels',0))" 2>/dev/null)
  CH_DONE=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('channels',0))" 2>/dev/null)

  TOTAL_EVENTS=$((TOTAL_EVENTS + EVENTS))

  echo "Pass $PASS: +$EVENTS events ($TOTAL_EVENTS total) | channel $CH_IDX/$CH_TOTAL | $CH_DONE completed this pass | done=$DONE"

  if [ "$DONE" = "True" ]; then
    echo ""
    echo "=== BACKFILL COMPLETE ==="
    echo "Total events synced: $TOTAL_EVENTS across $CH_TOTAL channels"
    break
  fi

  # Small delay between passes to be kind to Slack rate limits
  sleep 2
done
