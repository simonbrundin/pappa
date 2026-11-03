#!/usr/bin/env bash
# Laddar pappa:s env-variabler.
#
#   source src/neon/env.sh
#
# Prioritet: variabler som redan är satta i miljön vinner. Annars läses
# .env.local (fallback .env) från den här katalogen - dit Neon CLI:er skriver
# DATABASE_URL (poolad) och DATABASE_URL_UNPOOLED (direkt).
#
# Sätter också PPA_DIRECT_DATABASE_URL: den omedelbara (icke-poolade) URL:en.
# Migrations, pg_dump/pg_restore och annan sessionsbunden SQL ska använda den -
# PgBouncer i transaktionsläge klarar inte sessionstillstånd (SET search_path,
# prepared statements, advisory locks).

_pappa_neon_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_pappa_repo_root="$(cd "$_pappa_neon_dir/../.." && pwd)"

# Läs en KEY=VALUE-fil. Värden kan vara citrade; citaten tas bort.
_pappa_load_envfile() {
  local file="$1" line key value first last
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" != *=* ]] && continue
    key="$(printf '%s' "${line%%=*}" | tr -d '[:space:]')"
    value="${line#*=}"
    value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    first="${value:0:1}"
    last="${value: -1}"
    if [[ ${#value} -ge 2 && "$first" == "$last" && ( "$first" == '"' || "$first" == "'" ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -n "${!key+x}" ]] && continue          # miljön vinner över filen
    export "$key=$value"
  done < "$file"
}

if [[ -z "${DATABASE_URL:-}" ]]; then
  for _pappa_envfile in "$_pappa_neon_dir/.env.local" "$_pappa_neon_dir/.env" \
                        "$_pappa_repo_root/.env"; do
    if [[ -f "$_pappa_envfile" ]]; then
      _pappa_load_envfile "$_pappa_envfile"
      break
    fi
  done
fi

export PPA_DIRECT_DATABASE_URL="${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}"

# ---------------------------------------------------------------------------
# Certifikatkontroll för psql/pg_dump
#
# Neons URL har sslmode=require, som i libpq bara betyder "kryptera utan att
# kontrollera certifikatet". Databasen innehåller personuppgifter, så vi
# skärper till verify-full (kontrollerar certifikat och värdnamn) när vi kan
# peka ut en CA-fil. libpq:hittar inte systemets CA-rotar på egen, så filen
# pekas ut explicit.
# ---------------------------------------------------------------------------
_pappa_ca=""
for _pappa_candidate in "${PGSSLROOTCERT:-}" \
                        /etc/ssl/certs/ca-certificates.crt \
                        /etc/ssl/cert.pem \
                        /etc/pki/tls/certs/ca-bundle.crt; do
  if [[ -n "$_pappa_candidate" && -f "$_pappa_candidate" ]]; then
    _pappa_ca="$_pappa_candidate"
    break
  fi
done

if [[ -n "$_pappa_ca" && "$PPA_DIRECT_DATABASE_URL" == *"sslmode=require"* ]]; then
  export PPA_DIRECT_DATABASE_URL="${PPA_DIRECT_DATABASE_URL/sslmode=require/sslmode=verify-full}"
  export PGSSLROOTCERT="$_pappa_ca"
  unset _pappa_candidate _pappa_ca
else
  unset _pappa_candidate _pappa_ca
fi
