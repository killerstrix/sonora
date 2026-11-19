# Sonora · Android

Versión APK de Sonora. Usa la misma interfaz que la app de escritorio (se copia desde `../sonora/frontend` al compilar) y es **independiente**: todo ocurre en el teléfono, sin cuentas y sin conectarse a ningún PC.

> Para la explicación general del proyecto (funcionamiento, componentes y aviso legal) consulta [`README.md`](../README.md).

## Funciones

- **Convertir y descargar**: el teléfono convierte a MP3 (320 kbps, con título, artista y carátula) usando yt-dlp, ffmpeg y QuickJS incluidos en la APK. yt-dlp se actualiza solo una vez al día cuando hay internet.
- **Reproducir ahora / Añadir sin descargar**: streaming del audio original de la fuente; el enlace se obtiene al reproducir.
- **Biblioteca, playlists e historial**: guardados en el teléfono. Las playlists se comparten con un link `sonora://playlist/…`.
- **Segundo plano**: la música sigue con la pantalla apagada o usando otras apps. Notificación y pantalla de bloqueo con ⏮ ⏯ ⏭, botones de auriculares y Bluetooth, pausa con llamadas y al desconectar los auriculares.
- **Links de playlist**: se pueden abrir directamente o enviar a Sonora desde «Compartir» de WhatsApp, Telegram, etc.

Los MP3 se guardan en el almacenamiento de la app (`Android/data/app.sonora.player/files/Music/Sonora`) y se borran si se desinstala.

## Compilar la APK (del código a `Sonora.apk`)

La APK se genera con un solo script, `./build-apk.sh`, que hace todo el proceso:

1. **Copia la interfaz** compartida desde `../sonora/frontend` a `www/` (`scripts/sync-web.sh`). Por eso se necesita el repositorio completo, con las carpetas `sonora/` y `sonora-android/` una al lado de la otra.
2. **Prepara ffmpeg para teléfonos con páginas de 16 KB** (`scripts/patch-ffmpeg-16k.sh`, solo la primera vez). La librería trae unas librerías de WebP que no cargan en esos teléfonos y hacían fallar toda conversión a MP3 con «ffmpeg not found». El script descarga el paquete oficial y libwebp de Termux, comprueba sus hashes SHA-256 y genera `android/app/src/main/jniLibs/arm64-v8a/libffmpeg.zip.so`.
3. **Sincroniza Capacitor** (`npx cap sync android`) y **compila con Gradle** (`assembleDebug`).
4. Deja el resultado en **`./Sonora.apk`**.

### 1. Requisitos (una sola vez)

| Herramienta | Versión | Para qué |
|---|---|---|
| [Node.js](https://nodejs.org) | 22 o superior | Capacitor (puente entre la interfaz y Android) |
| [Android Studio](https://developer.android.com/studio) | reciente | Trae el SDK de Android y Java (JBR 21) |
| SDK de Android | Platform 36 y Build-Tools 36 | Compilar la app |
| Java | 17 a 21 | Gradle 8.14 |
| `git`, `curl`, `unzip`, `ar` (binutils), `xz`, `python3` | — | Descargar y preparar ffmpeg |

En **Arch Linux**:

```bash
sudo pacman -S nodejs npm git curl unzip binutils xz python jdk21-openjdk
```

En **Debian/Ubuntu**:

```bash
sudo apt install nodejs npm git curl unzip binutils xz-utils python3 openjdk-21-jdk
```

(Si la versión de Node de tu sistema es menor que 22, instálala desde [nodejs.org](https://nodejs.org) o con `nvm`).

Después abre **Android Studio** una vez y, en *More Actions → SDK Manager*, instala **Android SDK Platform 36** y **Android SDK Build-Tools 36**. Por defecto quedan en `~/Android/Sdk`; si los pusiste en otra carpeta, indícalo con `export ANDROID_HOME=/ruta/al/sdk`.

### 2. Compilar

```bash
git clone https://github.com/killerstrix/sonora.git
cd sonora/sonora-android
./build-apk.sh
```

La primera vez tarda varios minutos: instala las dependencias de Node (`npm install`), descarga Gradle y las librerías de Android, y prepara ffmpeg. Las siguientes compilaciones son mucho más rápidas. Al terminar verás:

```
Lista: /…/sonora-android/Sonora.apk (62M)
```

El script busca Java solo (el JBR de Android Studio en `~/.jdks`, o `/usr/lib/jvm/java-21-openjdk`). Si no lo encuentra, indícalo: `export JAVA_HOME=/ruta/a/java21`.

### 3. Si algo falla

- **La APK sale mucho más grande de lo normal (más de 100 MB)**: Gradle deja espacio vacío al reempaquetar. Haz una compilación limpia: `(cd android && ./gradlew clean) && ./build-apk.sh`.
- **«No encontré Java 17 o 21»**: instala `jdk21-openjdk` o define `JAVA_HOME`.
- **«SDK location not found»**: define `ANDROID_HOME` o crea `android/local.properties` con `sdk.dir=/ruta/al/sdk`.
- **«Descarga no válida»** al preparar ffmpeg: falló la descarga o cambió el archivo en el servidor; revisa la conexión y vuelve a ejecutar el script.
- **Cambiaste la interfaz** (`../sonora/frontend`): basta con volver a ejecutar `./build-apk.sh`; siempre copia la versión actual.

La APK resultante está firmada con la clave de depuración: sirve para instalarla en tu teléfono, pero no para publicarla en Play Store. Es para celulares de 64 bits (arm64-v8a).

## Instalar en el celular

Solo hace falta la APK: yt-dlp, FFmpeg, Python y QuickJS van incluidos, sin Termux, otras apps ni cuentas. Requiere Android 7 o superior de 64 bits. Internet solo se usa para convertir y para el streaming; lo descargado suena sin conexión. La primera conversión tarda algo más porque la app prepara su motor.

1. Pasa `Sonora.apk` al teléfono y ábrelo. Android pedirá permitir «instalar apps desconocidas», como con cualquier APK fuera de Play Store; Play Protect puede mostrar un aviso por el mismo motivo.
2. Con depuración USB también sirve: `adb install -r Sonora.apk` (`adb` viene en `~/Android/Sdk/platform-tools`). Si ya tenías Sonora instalada, la nueva APK se instala encima sin perder tu música ni tus playlists.
3. La primera vez que reproduzcas, acepta el permiso de notificaciones para tener los controles fuera de la app.

Si en algunas marcas (Xiaomi, Samsung, Huawei…) la música se corta en segundo plano: Ajustes → Aplicaciones → Sonora → Batería → «Sin restricciones».

## Cómo está hecho

```
scripts/sync-web.sh                 Copia la interfaz compartida a www/ y añade el runtime de Capacitor
build-apk.sh                        Sincroniza y compila la APK
android/app/src/main/java/app/sonora/player/
  SonoraPlugin.java                 Conversión, streaming, biblioteca, datos, compartir y recibir links
  PlaybackService.java              Reproducción en segundo plano, notificación y controles (MediaSession)
  MainActivity.java                 Registra el plugin
```

Permisos: internet (solo conexiones HTTPS), servicio de reproducción en primer plano, notificaciones y mantener el teléfono despierto mientras suena.
