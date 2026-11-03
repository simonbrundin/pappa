#!/usr/bin/env bash
# Återställ pappa-databasen från en backup.
#
#   ./db/restore.sh db/backups/pappa-20261027-182201.sql.gz
#
# VARNING: tömmer mål-databasen (--clean --if-exists i dumpen).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NEON_DIR="$HERE/../src/neon"
# shellcheck source=src/neon/env.sh
source "$NEON_DIR/env.sh"

FILE="${1:?Ange backupfil}"
: "${PPA_DIRECT_DATABASE_URL:?Sätt DATABASE_URL (eller DATABASE_URL_UNPOOLED)}"

if [[ ! -f "$FILE" ]]; then
  echo "filen finns inte: $FILE" >&2
  exit 1
fi

echo "återställer $FILE -> $PPA_DIRECT_DATABASE_URL"
gunzip -c "$FILE" | psql "$PPA_DIRECT_DATABASE_URL" -q -v ON_ERROR_STOP=1
echo "klar - verifierar:"
psql "$PPA_DIRECT_DATABASE_URL" -c "select * from v_coverage;"
