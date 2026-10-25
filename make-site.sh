#!/bin/bash
# Build a clean folder for static hosting: site/ is deployed by wrangler (see wrangler.jsonc, README).
# Copies the pages and their js/css, skips git, editor settings, notes for Claude (CLAUDE.md),
# console tools, macOS junk and the source video (26 MB - over Cloudflare's 25 MB per-file
# limit; the page links to YouTube).
#
# Usage: ./make-site.sh [cloudflare-web-analytics-token]
# The Cloudflare Web Analytics beacon is added to every page in site/ (only there - the
# source pages opened from disk send nothing anywhere). The token of genetic.tdhster.workers.dev
# is the default; it is not a secret (it is visible in the code of every page with the beacon).
# Pass "none" to build without analytics.
set -euo pipefail
cd "$(dirname "$0")"
DEFAULT_TOKEN="21c4a4f0a7134e119227f422d85e9a82"
TOKEN="${1:-$DEFAULT_TOKEN}"
[ "$TOKEN" = "none" ] && TOKEN=""

rm -rf site
mkdir site
# tar instead of rsync: rsync is not in the Cloudflare build image (Workers Builds runs this script).
tar -cf - \
  --exclude '.git' --exclude '.gitignore' --exclude '.claude' --exclude '.DS_Store' \
  --exclude '*.mp4' --exclude 'CLAUDE.md' --exclude 'tools' --exclude 'site' --exclude 'make-site.sh' \
  --exclude 'wrangler.jsonc' --exclude '.wrangler' --exclude 'node_modules' \
  . | tar -xf - -C site

if [ -n "$TOKEN" ]; then
  if ! [[ "$TOKEN" =~ ^[A-Za-z0-9]+$ ]]; then
    echo "ERROR: the token should be letters and digits only, got: $TOKEN" >&2
    exit 1
  fi
  # Exactly the snippet Cloudflare gives in Web Analytics -> Installation.
  BEACON="<!-- Cloudflare Web Analytics --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{\"token\": \"$TOKEN\"}'></script><!-- End Cloudflare Web Analytics -->"
  find site -name '*.html' | while read -r page; do
    BEACON="$BEACON" perl -0pi -e 's|</body>|$ENV{BEACON}\n</body>|' "$page"
    echo "analytics: $page"
  done
fi

echo "Ready: $(find site -type f | wc -l | tr -d ' ') files, $(du -sh site | cut -f1) in site/"
find site -type f -size +25M -exec echo "WARNING: over 25 MB: {}" \;
