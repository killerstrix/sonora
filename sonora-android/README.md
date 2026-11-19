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

## Compilar

```bash
./build-apk.sh        # deja ./Sonora.apk
```

Requiere Node, el SDK de Android (`~/Android/Sdk`) y Java 17–21 (usa el JBR de Android Studio en `~/.jdks` si existe). La APK es para celulares de 64 bits (arm64-v8a).

## Instalar en el celular

Solo hace falta la APK: yt-dlp, FFmpeg, Python y QuickJS van incluidos, sin Termux, otras apps ni cuentas. Requiere Android 7 o superior de 64 bits. Internet solo se usa para convertir y para el streaming; lo descargado suena sin conexión. La primera conversión tarda algo más porque la app prepara su motor.

1. Pasa `Sonora.apk` al teléfono y ábrelo. Android pedirá permitir «instalar apps desconocidas», como con cualquier APK fuera de Play Store; Play Protect puede mostrar un aviso por el mismo motivo.
2. Con depuración USB también sirve: `adb install -r Sonora.apk`.
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
