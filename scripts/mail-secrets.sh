#!/usr/bin/env bash
# =============================================================================
# Hemligheter för mailagenten och Kameo-uppsökningen
#
# Hemligheterna lever i:
#   - environments/dev/mail.env          (lokal utveckling, gitignorad)
#   - Kubernetes Secret pappa-mail-secrets (i klustret)
#
# Innehåll:
#   MAIL_PASSWORD_MICHAEL  IMAP-lösenord för michael@brundins.se
#   OPENAI_API_KEY         nyckel till AI-modellen
#   KAMEO_EMAIL            Kameo-inloggning (alternativt 1Password via op-cli)
#   KAMEO_PASSWORD
#   KAMEO_TOTP_SECRET
#
# Kommandon:
#   ./scripts/mail-secrets.sh apply [ns]      skapa/uppdatera Secret i klustret
#   ./scripts/mail-secrets.sh apply-all       ... i dev, pr och prod
#   ./scripts/mail-secrets.sh status          visa var hemligheterna finns
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/environments/dev/mail.env"
SECRET_NAME="pappa-mail-secrets"
SECRET_KEYS=(MAIL_PASSWORD_MICHAEL OPENAI_API_KEY KAMEO_EMAIL KAMEO_PASSWORD KAMEO_TOTP_SECRET)

# Namespaces per miljö. Dev och prod delar namespace i dag - se README.
DEV_NS="${PAPPA_DEV_NAMESPACE:-repo-template}"
PR_NS="${PAPPA_PR_NAMESPACE:-repo-template-pr}"
PROD_NS="${PAPPA_PROD_NAMESPACE:-repo-template}"

# -----------------------------------------------------------------------------
# Hjälpare
# -----------------------------------------------------------------------------

# Läs nyckel ur den lokala env-filen.
read_local_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 1
  sed -n "s/^${key}=\(.*\)$/\1/p" "$ENV_FILE" | head -1 | tr -d '"'"'"''
}

# -----------------------------------------------------------------------------
# Kommandon
# -----------------------------------------------------------------------------

# Skapa eller uppdatera Secretet i ett namespace.
apply_secret() {
  local namespace="$1"
  local args=()
  local key value

  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Filen $ENV_FILE saknas - skapa den med hemligheterna." >&2
    return 1
  fi

  for key in "${SECRET_KEYS[@]}"; do
    value="$(read_local_value "$key" || true)"
    [[ -z "$value" ]] && continue
    args+=(--from-literal="${key}=${value}")
  done

  if [[ ${#args[@]} -eq 0 ]]; then
    echo "Inga värden hittades i $ENV_FILE." >&2
    return 1
  fi

  if ! kubectl get namespace "$namespace" >/dev/null 2>&1; then
    echo "Namespace '$namespace' finns inte i klustret - hoppar över." >&2
    return 1
  fi

  kubectl -n "$namespace" create secret generic "$SECRET_NAME" \
    "${args[@]}" \
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

cmd_status() {
  local key value

  if [[ -f "$ENV_FILE" ]]; then
    echo "Lokal fil: $ENV_FILE"
    for key in "${SECRET_KEYS[@]}"; do
      value="$(read_local_value "$key" || true)"
      if [[ -n "$value" ]]; then
        echo "  $key: finns"
      else
        echo "  $key: saknas"
      fi
    done
  else
    echo "Lokal fil: $ENV_FILE saknas"
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
  apply) cmd_apply "${2:-}" ;;
  apply-all) cmd_apply_all ;;
  status) cmd_status ;;
  *)
    sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
