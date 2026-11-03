#!/usr/bin/env bash
# Genererar en Neon-env-fil för en Kubernetes-miljö.
#
#   environments/neon-env.sh environments/dev/neon
#   environments/neon-env.sh environments/pr/neon pr.neon.env
#
# Läser src/neon/.env.local - repots ENDA källa för Neon-anslutningen
# (db-skripten och webappen läser den) - och skriver neon.env i målkat.
#
# Målfilen gitignoras. Kustomize läser den via secretGenerator.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src/neon/.env.local"
TARGET="${1:?Ange målkatlogg, t.ex. environments/dev/neon}"
NAME="${2:-neon.env}"
OUT="$TARGET/$NAME"

if [[ ! -f "$SRC" ]]; then
  echo "hittar inte $SRC - kör 'npm run neon:env' i repo-roten för att hämta den" >&2
  exit 1
fi

mkdir -p "$TARGET"
umask 077
: > "$OUT"

for key in DATABASE_URL DATABASE_URL_UNPOOLED; do
  line="$(grep -m1 "^${key}=" "$SRC" || true)"
  if [[ -z "$line" ]]; then
    echo "saknar $key i $SRC" >&2
    exit 1
  fi
  value="${line#*=}"
  # Trimma whitespace och ta bort citattecken
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s=%s\n' "$key" "$value" >> "$OUT"
done

chmod 600 "$OUT"
echo "skrev $OUT (2 anslutningssträngar)"
