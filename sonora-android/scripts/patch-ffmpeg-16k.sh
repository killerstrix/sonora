#!/usr/bin/env bash
# ffmpeg de youtubedl-android 0.18.1 trae las librerías de WebP alineadas a 4 KB (el resto va a 16 KB).
# En teléfonos con páginas de memoria de 16 KB (muchos con Android 15/16) el enlazador las rechaza,
# ffmpeg no arranca y yt-dlp responde «ffmpeg not found»: falla toda conversión a MP3.
# Este script genera un libffmpeg.zip.so igual al original pero con libwebp 1.6.0 de Termux
# (misma versión y mismos símbolos, alineada a 16 KB). La APK lo incluye en lugar del de la librería.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=android/app/src/main/jniLibs/arm64-v8a/libffmpeg.zip.so
AAR_URL=https://repo1.maven.org/maven2/io/github/junkfood02/youtubedl-android/ffmpeg/0.18.1/ffmpeg-0.18.1.aar
AAR_SHA256=0a87ffa6cf912b0fe76c1a99b9107f543ee2f247935fae2c71f0822eb7bc5f49
DEB_URL=https://packages.termux.dev/apt/termux-main/pool/main/libw/libwebp/libwebp_1.6.0.0.0.1+really1.6.0_aarch64.deb
DEB_SHA256=8ba7fcfadd1a9957a7632c6407d6ef3e41d34dbd96a41769b245592ed4559045

[[ -f "$OUT" ]] && { echo "ffmpeg (16 KB) ya preparado"; exit 0; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch() { curl -sfL "$1" -o "$2" && echo "$3  $2" | sha256sum -c --quiet - || { echo "Descarga no válida: $1"; exit 1; }; }
fetch "$AAR_URL" "$tmp/ffmpeg.aar" "$AAR_SHA256"
fetch "$DEB_URL" "$tmp/libwebp.deb" "$DEB_SHA256"

unzip -q -j "$tmp/ffmpeg.aar" jni/arm64-v8a/libffmpeg.zip.so -d "$tmp"
(cd "$tmp" && ar x libwebp.deb data.tar.xz && mkdir deb && tar -xJf data.tar.xz -C deb)
mkdir "$tmp/libs"
for lib in libwebp.so libwebpmux.so libwebpdemux.so libwebpdecoder.so libsharpyuv.so; do
  cp "$tmp/deb/data/data/com.termux/files/usr/lib/$lib" "$tmp/libs/"
done

mkdir -p "$(dirname "$OUT")"
python3 -I scripts/patch_ffmpeg_zip.py "$tmp/libffmpeg.zip.so" "$tmp/libs" "$OUT"
