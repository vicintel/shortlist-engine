#!/bin/bash
# Daily run. Invoked by cron; safe to run by hand.
#
# Local delivery is the primary path: the run writes data/digest-latest.html and
# posts a notification. That needs no account and no sending domain, so nothing
# here depends on a third party being configured.
#
# Email is attempted only when RESEND_API_KEY is set — use a separate account of
# your own, never a business's sending domain.
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

LOG="data/cron.log"
mkdir -p data
{
  echo "───────── $(date '+%Y-%m-%d %H:%M:%S') ─────────"
  node bin/shortlist.js run --html --email 2>&1
} >> "$LOG"

COUNT=$(node -e "
  try {
    const db = require('./data/jobs.json');
    const today = new Date().toISOString().slice(0,10);
    console.log(Object.values(db.jobs).filter(j => j.status==='new' && j.scoreSource==='llm' && j.score>=65).length);
  } catch { console.log(0); }
")

if [ "$COUNT" -gt 0 ]; then
  osascript -e "display notification \"$COUNT role(s) worth a look\" with title \"Shortlist\" subtitle \"$(date '+%A %-d %B')\" sound name \"Glass\"" 2>/dev/null
else
  osascript -e "display notification \"Nothing cleared the bar today\" with title \"Shortlist\"" 2>/dev/null
fi
