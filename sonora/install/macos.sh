#!/usr/bin/env bash
# Instala Sonora en macOS como aplicación (Sonora.app en Aplicaciones: Launchpad, Dock y Spotlight).
# Usa Homebrew para ffmpeg, Deno (necesario para YouTube) y uv. Desinstalar: ./install.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
APP_NAME="Sonora"
# Entorno propio de macOS: no choca con el .venv de Linux si la carpeta se comparte (MEGA, Dropbox…).
export UV_PROJECT_ENVIRONMENT="$ROOT/.venv-macos"

if [[ -w /Applications ]]; then APPS=/Applications; else APPS="$HOME/Applications"; fi
APP="$APPS/$APP_NAME.app"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$APP" "$HOME/Applications/$APP_NAME.app"
  echo "Sonora desinstalada (tu música en ~/Music/Sonora no se ha tocado)."
  exit 0
fi

# --- Dependencias del sistema (Homebrew) ---
if ! command -v brew >/dev/null; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x $b ]] && eval "$($b shellenv)"; done
fi
if ! command -v brew >/dev/null; then
  echo "Falta Homebrew. Instálalo con el comando de https://brew.sh y vuelve a ejecutar ./install.sh"
  exit 1
fi
missing=()
for tool in ffmpeg deno uv; do command -v "$tool" >/dev/null || missing+=("$tool"); done
if (( ${#missing[@]} )); then
  echo "Instalando con Homebrew: ${missing[*]}"
  brew install "${missing[@]}"
fi

# --- Entorno de Python (incluye PySide6 con Qt WebEngine para la ventana) ---
echo "Preparando el entorno de Python (la primera vez descarga ~200 MB)…"
uv sync -q --python 3.12

# --- Icono .icns a partir de los PNG del proyecto ---
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ICONSET="$TMP/Sonora.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s frontend/icons/icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) frontend/icons/icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$TMP/Sonora.icns"

# --- Paquete Sonora.app ---
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$TMP/Sonora.icns" "$APP/Contents/Resources/Sonora.icns"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Sonora</string>
  <key>CFBundleDisplayName</key><string>Sonora</string>
  <key>CFBundleIdentifier</key><string>app.sonora.desktop</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Sonora</string>
  <key>CFBundleIconFile</key><string>Sonora</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.music</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

# Las apps abiertas desde el Finder no heredan el PATH de la terminal: se añade el de Homebrew
# para que yt-dlp encuentre ffmpeg y Deno.
cat > "$APP/Contents/MacOS/Sonora" <<EOF
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec "$ROOT/.venv-macos/bin/python" "$ROOT/desktop/sonora_desktop.py" "\$@"
EOF
chmod +x "$APP/Contents/MacOS/Sonora"

# Registra el icono en el Finder/Launchpad.
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

echo "Sonora instalada en $APP"
echo "Ábrela desde Launchpad o Spotlight."
