#!/usr/bin/env bash
# Säkerhetskopiering av pappa-databasen.
#
#   ./db/backup.sh                    # dump till db/backups/
#   BACKUP_DIR=/mnt/nas ./db/backup.sh
#
# Ska köras via cron (dagligen). Retain: 30 dagar.
#
# Formatval: PLAIN SQL + gzip (inte custom-format).
#   Anledning: custom-formatets versionsheader skrivs av klientens pg_dump.
#   En backup tagen med klient v18 kan inte läsas av leverantörens pg_restore v16.
#   Plain SQL är versionsagnostiskt och kan återställas var som helst.
#
# Anslutning: använder den DIREKTA (icke-poolade) URL:en. pg_dump mot en
#   PgBouncer-poolad URL misslyckas - dumpen är sessionsbunden.
#   Laddar .env.local/.env automatiskt om DATABASE_URL inte redan är satt.
#
# OBS: dumpen innehåller personuppgifter - kryptera om den läggs på delad lagring.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NEON_DIR="$HERE/../src/neon"
# shellcheck source=src/neon/env.sh
source "$NEON_DIR/env.sh"

: "${PPA_DIRECT_DATABASE_URL:?Sätt DATABASE_URL (eller DATABASE_URL_UNPOOLED)}"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$0")/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/pappa-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

pg_dump --dbname="$PPA_DIRECT_DATABASE_URL" \
        --format=plain --no-owner --no-privileges --clean --if-exists \
  | sed '/^SET transaction_timeout = /d' \
  | gzip -9 > "$FILE"
chmod 600 "$FILE"

# Verifiera: (1) arkivet är helt, (2) dumpen innehåller faktiskt våra tabeller
#      (zgrep, inte "gunzip | grep -q" - pipefail + SIGPIPE ger falskt larm)
gunzip -t "$FILE"
if ! zgrep -q "CREATE TABLE public.person" "$FILE"; then
  echo "VARNING: dumpen saknar tabellen 'person' - kontrollera!" >&2
  exit 1
fi
if ! zgrep -q "CREATE TABLE public.watchlist_entry" "$FILE"; then
  echo "WARNING: dumpen saknar 'watchlist_entry' - kontrollera!" >&2
  exit 1
fi

echo "backup: $FILE ($(du -h "$FILE" | cut -f1)) - verifierad"

# Rotera
find "$BACKUP_DIR" -name 'pappa-*.sql.gz' -type f -mtime "+$KEEP_DAYS" -delete
