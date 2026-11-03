#!/usr/bin/env bash
# Genererar environments/dev/neon/neon.env ur src/neon/.env.local.
#
#   ./sync-env.sh
#
# Se ../../neon-env.sh för själva logiken.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/neon-env.sh" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
