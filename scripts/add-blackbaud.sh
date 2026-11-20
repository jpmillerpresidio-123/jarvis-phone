#!/bin/bash
# Saves your Blackbaud assignment feed link into .env.railway (hidden input; the
# link works like a password), then copies the full settings for Railway.
set -euo pipefail
cd "$(dirname "$0")/.."
F=.env.railway
[ -f "$F" ] || { echo "Missing $F"; exit 1; }
while true; do
  read -r -s -p "Blackbaud assignment feed link (hidden, starts with webcal:// or https://): " v; echo
  v="$(echo -n "$v" | tr -d '[:space:]')"
  h=$(( ${#v} / 2 )); [[ ${#v} -gt 0 && $(( ${#v} % 2 )) == 0 && "${v:0:h}" == "${v:h}" ]] && v="${v:0:h}"
  if [[ "$v" =~ ^(webcal|https):// ]]; then break; fi
  echo "  That doesn't look like a feed link. Try again."
done
python3 - "$F" "$v" <<'PY'
import sys
path, value = sys.argv[1:]
lines = open(path).read().splitlines()
lines = [l for l in lines if not l.startswith("BLACKBAUD_ICAL=")] + [f"BLACKBAUD_ICAL={value}"]
open(path, "w").write("\n".join(lines) + "\n")
PY
echo "  ✓ saved"
if curl -fsS -m 15 "${v/webcal:\/\//https://}" | grep -q "BEGIN:VCALENDAR"; then echo "  ✓ the link returns a calendar"; else echo "  ! that link didn't return a calendar; double-check it"; fi
grep -v REPLACE "$F" | pbcopy
echo
echo "Done. The full settings are on your clipboard."
echo "In Railway: backend → Variables → Raw Editor → Cmd+A → Cmd+V → Update Variables."
