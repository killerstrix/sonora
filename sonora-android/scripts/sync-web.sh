#!/usr/bin/env bash
# Copia la interfaz compartida desde ../sonora/frontend a www/ y la adapta para la APK.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${SONORA_DESKTOP_DIR:-../sonora}/frontend"
rm -rf www && mkdir www
cp -r "$SRC"/. www/
# En la APK no hacen falta el service worker ni el manifest de PWA.
rm -f www/sw.js www/manifest.webmanifest
sed -i '/rel="manifest"/d' www/index.html
# Runtime de Capacitor (puente JS <-> plugins nativos), cargado antes que native.js.
cp node_modules/@capacitor/core/dist/capacitor.js www/capacitor.js
sed -i 's#  <script src="native.js"></script>#  <script src="capacitor.js"></script>\n  <script src="native.js"></script>#' www/index.html
grep -q 'capacitor.js' www/index.html || { echo "No se pudo insertar capacitor.js en index.html"; exit 1; }
echo "Interfaz copiada a www/"
