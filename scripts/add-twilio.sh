#!/bin/bash
# Saves the Twilio settings into .env.railway (hidden input for the token),
# then copies the full settings to the clipboard for Railway's Raw Editor.
set -euo pipefail
cd "$(dirname "$0")/.."
F=.env.railway
[ -f "$F" ] || { echo "Missing $F"; exit 1; }

setval() { # name value
  python3 - "$F" "$1" "$2" <<'PY'
import sys
path, name, value = sys.argv[1:]
lines = open(path).read().splitlines()
if any(l.split("=", 1)[0] == name for l in lines):
    lines = [f"{name}={value}" if l.split("=", 1)[0] == name else l for l in lines]
else:
    lines.append(f"{name}={value}")
open(path, "w").write("\n".join(lines) + "\n")
PY
}

while true; do
  read -r -p "Twilio Account SID (starts with AC): " v
  v="$(echo -n "$v" | tr -d '[:space:]')"
  if [[ "$v" =~ ^AC[0-9a-fA-F]{32}$ ]]; then setval TWILIO_ACCOUNT_SID "$v"; echo "  ✓ saved"; break; fi
  echo "  That doesn't look right (AC + 32 letters/numbers). Try again."
done
while true; do
  read -r -s -p "Twilio Auth Token (hidden, 32 letters/numbers): " v; echo
  v="$(echo -n "$v" | tr -d '[:space:]')"
  if [[ "$v" =~ ^[0-9a-fA-F]{32}$ ]]; then setval TWILIO_AUTH_TOKEN "$v"; echo "  ✓ saved"; break; fi
  echo "  That doesn't look like an Auth Token. Try again."
done
while true; do
  read -r -p "Your new Twilio phone number (10 digits): " n
  d="$(echo "$n" | tr -cd '0-9')"
  [[ ${#d} == 11 && $d == 1* ]] && d="${d:1}"
  if [[ ${#d} == 10 ]]; then setval TWILIO_PHONE_NUMBER "+1$d"; echo "  ✓ saved +1$d"; break; fi
  echo "  Please enter a 10-digit number."
done

grep -v REPLACE "$F" | pbcopy
echo
echo "Done. The full settings are on your clipboard."
echo "In Railway: backend → Variables → Raw Editor → Cmd+A → Cmd+V → Update Variables."
