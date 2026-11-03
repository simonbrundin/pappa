#!/usr/bin/env bash
# Applicera db/schema.sql mot pappa-databasen.
#
#   ./db/migrate.sh
#
# Kör mot den DIREKTA (icke-poolade) anslutningen. Schemamigreringar behöver
# sessionstillstånd (SET search_path, extensions), vilket PgBouncer i
# transaktionsläge inte klarar - via poolad URL kan migrationen tappa bort
# sessionen mitt i och ge "relation ... does not exist".
#
# Laddar .env.local/.env automatiskt om DATABASE_URL inte redan är satt.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NEON_DIR="$HERE/../src/neon"
# shellcheck source=src/neon/env.sh
source "$NEON_DIR/env.sh"

: "${PPA_DIRECT_DATABASE_URL:?Sätt DATABASE_URL (eller DATABASE_URL_UNPOOLED)}"

echo "migrerar schema -> $PPA_DIRECT_DATABASE_URL"
psql "$PPA_DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$HERE/schema.sql"
echo "schema OK"
