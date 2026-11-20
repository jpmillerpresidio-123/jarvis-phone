#!/bin/bash
# Fills .env.railway by asking for each key with hidden input, then copies
# the finished file to the clipboard for pasting into Railway's Raw Editor.
# Keys are typed here only; they never appear on screen or in chat.
set -euo pipefail
cd "$(dirname "$0")/.."
F=.env.railway
[ -f "$F" ] || { cp .env.example "$F"; chmod 600 "$F"; echo "Created $F from .env.example"; }

setval() { # name value
  python3 - "$F" "$1" "$2" <<'PY'
import sys
path, name, value = sys.argv[1:]
lines = open(path).read().splitlines()
lines = [f"{name}={value}" if l.split("=", 1)[0] == name else l for l in lines]
open(path, "w").write("\n".join(lines) + "\n")
PY
}

ask_secret() { # name prompt prefix
  local v
  while true; do
    read -r -s -p "$2: " v; echo
    v="$(echo -n "$v" | tr -d '[:space:]')"
    if [[ "$v" == $3* ]]; then setval "$1" "$v"; echo "  ✓ saved"; return; fi
    echo "  That doesn't start with $3. Try again."
  done
}

if grep -q "^ENCRYPTION_KEY=REPLACE_ME" "$F"; then setval ENCRYPTION_KEY "$(openssl rand -base64 32)"; echo "Generated ENCRYPTION_KEY (keep a backup of $F: changing this key later makes saved sign-ins unreadable)."; fi
echo "Paste each key and press Return (input is hidden)."
ask_secret ANTHROPIC_API_KEY "Claude API key (sk-ant-...)" "sk-ant-"
while true; do
  read -r -s -p "Supabase secret key (sb_secret_... or the legacy service_role key): " v; echo
  v="$(echo -n "$v" | tr -d '[:space:]')"
  if [[ "$v" == sb_secret_* || "$v" == eyJ* ]]; then setval SUPABASE_SERVICE_ROLE_KEY "$v"; echo "  ✓ saved"; break; fi
  echo "  That doesn't look like a Supabase secret key. Try again."
done
while true; do
  read -r -p "Your mobile number (10 digits, US): " n
  d="$(echo "$n" | tr -cd '0-9')"
  [[ ${#d} == 11 && $d == 1* ]] && d="${d:1}"
  if [[ ${#d} == 10 ]]; then setval ALLOWED_CALLERS "+1$d"; echo "  ✓ saved +1$d"; break; fi
  echo "  Please enter a 10-digit number."
done

pbcopy < "$F"
echo
echo "Done. The full settings are now on your clipboard."
echo "In Railway: service → Variables → Raw Editor → select all → paste → Update Variables."
