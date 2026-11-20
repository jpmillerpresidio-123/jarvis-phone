#!/bin/bash
# Saves the Google OAuth client ID and secret into .env.railway (hidden input
# for the secret), then copies the full settings to the clipboard for Railway.
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
  read -r -p "Google Client ID (ends with .apps.googleusercontent.com): " v
  v="$(echo -n "$v" | tr -d '[:space:]')"
  if [[ "$v" == *.apps.googleusercontent.com && "$v" != REPLACE* ]]; then setval GOOGLE_CLIENT_ID "$v"; echo "  ✓ saved"; break; fi
  echo "  That doesn't look like a Client ID. Try again."
done
while true; do
  read -r -s -p "Google Client secret (hidden, starts with GOCSPX-): " v; echo
  v="$(echo -n "$v" | tr -d '[:space:]')"
  # Pasted twice by accident? Keep one copy.
  h=$(( ${#v} / 2 )); [[ ${#v} -gt 0 && $(( ${#v} % 2 )) == 0 && "${v:0:h}" == "${v:h}" ]] && v="${v:0:h}"
  if [[ "$v" =~ ^GOCSPX-[A-Za-z0-9_-]{28}$ ]]; then setval GOOGLE_CLIENT_SECRET "$v"; echo "  ✓ saved"; break; fi
  echo "  That doesn't look like a Client secret. Try again."
done

grep -v REPLACE "$F" | pbcopy
echo
echo "Done. The full settings are on your clipboard."
echo "In Railway: backend → Variables → Raw Editor → Cmd+A → Cmd+V → Update Variables."
