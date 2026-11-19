#!/usr/bin/env bash
# Compila la APK de Sonora con la interfaz actual de ../sonora/frontend y la deja en ./Sonora.apk
set -euo pipefail
cd "$(dirname "$0")"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
# Gradle 8.14 necesita Java 17–24: se usa el JBR 21 de Android Studio si existe.
if [[ -z "${JAVA_HOME:-}" ]]; then
  for j in "$HOME"/.jdks/jbr-21* /usr/lib/jvm/java-21-openjdk /usr/lib/jvm/java-17-openjdk; do
    [[ -x "$j/bin/java" ]] && { export JAVA_HOME="$j"; break; }
  done
fi
[[ -n "${JAVA_HOME:-}" ]] || { echo "No encontré Java 17 o 21 (instala jdk21-openjdk)"; exit 1; }
[[ -d node_modules ]] || npm install --silent
./scripts/sync-web.sh
./scripts/patch-ffmpeg-16k.sh
npx cap sync android >/dev/null
(cd android && ./gradlew assembleDebug --console=plain -q)
cp android/app/build/outputs/apk/debug/app-debug.apk Sonora.apk
echo "Lista: $PWD/Sonora.apk ($(du -h Sonora.apk | cut -f1))"
