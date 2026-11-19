#!/usr/bin/env bash
# Instala Sonora como programa de escritorio según el sistema operativo.
#   ./install.sh               instalar o actualizar
#   ./install.sh --uninstall   desinstalar (no toca tu música)
set -euo pipefail
cd "$(dirname "$0")"
case "$(uname -s)" in
  Linux)  exec bash install/linux.sh "$@" ;;
  Darwin) exec bash install/macos.sh "$@" ;;
  *)      echo "Sistema no soportado: $(uname -s). Sonora funciona en Linux y macOS."; exit 1 ;;
esac
