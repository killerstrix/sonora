#!/usr/bin/env bash
# Instala Sonora como programa de escritorio: icono en el menú de aplicaciones y comando «sonora».
# Requiere: uv, ffmpeg, pyside6 (paquete del sistema con Qt WebEngine). Desinstalar: ./install.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN="$HOME/.local/bin"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$BIN/sonora" "$DATA/applications/sonora.desktop"
  rm -f "$DATA/icons/hicolor/scalable/apps/sonora.svg" "$DATA/icons/hicolor/"{192x192,512x512}/apps/sonora.png
  # Reglas de firewall que pudo dejar una versión anterior (con conexión al celular).
  if command -v ufw >/dev/null && sudo -n true 2>/dev/null; then
    for net in 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12; do
      sudo ufw delete allow from "$net" to any port 8765 proto tcp >/dev/null 2>&1 || true
      sudo ufw delete allow from "$net" to any port 8766 proto udp >/dev/null 2>&1 || true
    done
  fi
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$DATA/applications" || true
  echo "Sonora desinstalada (tu música en ~/Música/Sonora no se ha tocado)."
  exit 0
fi

command -v ffmpeg >/dev/null || { echo "Falta ffmpeg: instálalo con tu gestor de paquetes (p. ej. sudo pacman -S ffmpeg o sudo apt install ffmpeg)"; exit 1; }
python3 -c "import PySide6.QtWebEngineWidgets" 2>/dev/null || { echo "Falta PySide6 con WebEngine (p. ej. sudo pacman -S pyside6 qt6-webengine o sudo apt install python3-pyside6.qtwebenginewidgets)"; exit 1; }

# Entorno de Python con las dependencias y acceso al PySide6 del sistema.
[[ -d .venv ]] || uv venv -q --python /usr/bin/python3 --system-site-packages
sed -i 's/include-system-site-packages = false/include-system-site-packages = true/' .venv/pyvenv.cfg
uv sync -q

mkdir -p "$BIN" "$DATA/applications" "$DATA/icons/hicolor/scalable/apps" "$DATA/icons/hicolor/192x192/apps" "$DATA/icons/hicolor/512x512/apps"
cp frontend/icons/icon.svg "$DATA/icons/hicolor/scalable/apps/sonora.svg"
cp frontend/icons/icon-192.png "$DATA/icons/hicolor/192x192/apps/sonora.png"
cp frontend/icons/icon-512.png "$DATA/icons/hicolor/512x512/apps/sonora.png"

cat > "$BIN/sonora" <<EOF
#!/usr/bin/env bash
exec "$ROOT/.venv/bin/python" "$ROOT/desktop/sonora_desktop.py" "\$@"
EOF
chmod +x "$BIN/sonora"

cat > "$DATA/applications/sonora.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Sonora
GenericName=Reproductor de música
Comment=Convierte enlaces a MP3 y escucha tu música sin conexión
Exec=$BIN/sonora
Icon=sonora
Terminal=false
Categories=AudioVideo;Audio;Player;
Keywords=música;mp3;reproductor;playlist;
StartupWMClass=sonora
EOF

command -v update-desktop-database >/dev/null && update-desktop-database -q "$DATA/applications" || true

command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$DATA/icons/hicolor" || true
echo "Sonora instalada. Búscala en el menú de aplicaciones o ejecuta: sonora"
