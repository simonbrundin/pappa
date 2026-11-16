#!/usr/bin/env bash
# =============================================================================
# Admin-lösenord för pappa
#
# Lösenordet krävs för att slå ihop dubbletter och för att spara kravprofiler
# (POST /api/profiles). Utan inloggning är skrivning avstängd (503).
#
# I webbläsaren loggar man in på /admin med lösenordet - det skickas till
# servern och byts mot en httpOnly-cookie. Lösenordet lagras aldrig i
# webbläsaren. CLI:er kan fortfarande skicka det i headern x-admin-token.
#
# Hemligheten får aldrig committas. Den lever i:
#   - src/nuxt/.env            (lokal utveckling, gitignorad)
#   - Kubernetes Secret pappa-admin (i klustret)
#
# Kommandon:
#   ./scripts/admin-token.sh init            skapa lösenord om det saknas
#   ./scripts/admin-token.sh login [url]     öppna adminsidan i webbläsaren
#   ./scripts/admin-token.sh show            visa lösenordet (för CLI/header)
#   ./scripts/admin-token.sh apply [ns]      skapa/uppdatera Secret i klustret
#   ./scripts/admin-token.sh apply-all       ... i dev, pr och prod
#   ./scripts/admin-token.sh status          visa var lösenordet finns
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/src/nuxt/.env"
SECRET_NAME="pappa-admin"
SECRET_KEY="NUXT_ADMIN_TOKEN"

# Namespaces per miljö. Dev och prod delar namespace i dag - se README.
DEV_NS="${PAPPA_DEV_NAMESPACE:-repo-template}"
PR_NS="${PAPPA_PR_NAMESPACE:-repo-template-pr}"
PROD_NS="${PAPPA_PROD_NAMESPACE:-repo-template}"

# -----------------------------------------------------------------------------
# Hjälpare
# -----------------------------------------------------------------------------

# Läs token ur den lokala env-filen.
read_local_token() {
  if [[ ! -f "$ENV_FILE" ]]; then
    return 1
  fi
  sed -n "s/^${SECRET_KEY}=\(.*\)$/\1/p" "$ENV_FILE" | head -1 | tr -d '"'"'"''
}

# Skriv token till den lokala env-filen och se till att filen inte är läsbar
# för andra användare.
write_local_token() {
  local token="$1"
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  if grep -q "^${SECRET_KEY}=" "$ENV_FILE"; then
    # macOS sed kräver -i ''
    sed -i.bak "s|^${SECRET_KEY}=.*|${SECRET_KEY}=${token}|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$SECRET_KEY" "$token" >> "$ENV_FILE"
  fi
}

generate_token() {
  openssl rand -hex 24
}

# -----------------------------------------------------------------------------
# Kommandon
# -----------------------------------------------------------------------------

cmd_init() {
  local token
  token="$(read_local_token || true)"
  if [[ -n "$token" ]]; then
    echo "Token finns redan i $ENV_FILE (använd 'show' för att se den)."
    return 0
  fi
  token="$(generate_token)"
  write_local_token "$token"
  echo "Ny admin-token skapad och sparad i $ENV_FILE"
  echo "Kör './scripts/admin-token.sh show' för att se den."
}

cmd_show() {
  local token
  token="$(read_local_token || true)"
  if [[ -z "$token" ]]; then
    echo "Ingen token i $ENV_FILE - kör 'init' först." >&2
    exit 1
  fi
  echo "$token"
}

# Skapa eller uppdatera Secretet i ett namespace.
apply_secret() {
  local namespace="$1"
  local token
  token="$(read_local_token || true)"
  if [[ -z "$token" ]]; then
    echo "Ingen token i $ENV_FILE - kör 'init' först." >&2
    exit 1
  fi
  if ! kubectl get namespace "$namespace" >/dev/null 2>&1; then
    echo "Namespace '$namespace' finns inte i klustret - hoppar över." >&2
    return 1
  fi
  kubectl -n "$namespace" create secret generic "$SECRET_NAME" \
    --from-literal="$SECRET_KEY=$token" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  echo "Secret '$SECRET_NAME' uppdaterad i namespace '$namespace'"
}

cmd_apply() {
  apply_secret "${1:-$DEV_NS}"
}

cmd_apply_all() {
  local failed=0
  apply_secret "$DEV_NS" || failed=1
  apply_secret "$PR_NS" || failed=1
  apply_secret "$PROD_NS" || failed=1
  return $failed
}

# Öppna adminsidan. Lösenordet matas in i webbläsaren - det skickas till
# servern i requestkroppen och byts mot en httpOnly-cookie. Det hamnar
# alltså inte i URL:en och inte i webbläsarens historik.
cmd_login() {
  local token url
  token="$(read_local_token || true)"
  if [[ -z "$token" ]]; then
    echo "Ingen token i $ENV_FILE - kör 'init' först." >&2
    exit 1
  fi
  url="${1:-${PAPPA_URL:-http://localhost:3000}}"
  url="${url%/}/admin"
  echo "$url"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  fi
}

cmd_status() {
  local token
  token="$(read_local_token || true)"
  if [[ -n "$token" ]]; then
    echo "Lokal token: finns i $ENV_FILE"
  else
    echo "Lokal token: saknas (kör 'init')"
  fi

  for ns in "$DEV_NS" "$PR_NS" "$PROD_NS"; do
    if kubectl get namespace "$ns" >/dev/null 2>&1; then
      if kubectl -n "$ns" get secret "$SECRET_NAME" >/dev/null 2>&1; then
        echo "Secret i '$ns': finns"
      else
        echo "Secret i '$ns': saknas"
      fi
    else
      echo "Secret i '$ns': namespace saknas"
    fi
  done
}

case "${1:-}" in
  init) cmd_init ;;
  login) cmd_login "${2:-}" ;;
  show) cmd_show ;;
  apply) cmd_apply "${2:-}" ;;
  apply-all) cmd_apply_all ;;
  status) cmd_status ;;
  *)
    sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
