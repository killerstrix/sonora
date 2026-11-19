# Sonora

**Reproductor de música offline-first, de código abierto, para Linux, macOS y Android.**
Convierte enlaces de audio y vídeo a MP3, permite escucharlos por streaming sin descargarlos y los organiza en playlists que se comparten con un simple link. Sin cuentas, sin servidores propios, sin anuncios y sin rastreo.

---

## Índice

1. [Qué es](#qué-es)
2. [Funcionalidades](#funcionalidades)
3. [Cómo funciona](#cómo-funciona)
4. [Cómo se conecta](#cómo-se-conecta)
5. [Privacidad](#privacidad)
6. [Instalación](#instalación)
7. [Preguntas frecuentes](#preguntas-frecuentes)
8. [Estructura del repositorio](#estructura-del-repositorio)
9. [Componentes y su origen](#componentes-y-su-origen)
10. [Licencia](#licencia)
11. [Aviso legal](#aviso-legal)

---

## Qué es

Sonora es una aplicación de escritorio y una app de Android que comparten la misma interfaz oscura y minimalista. Cada instalación es **independiente**: empieza vacía, guarda todo en el propio dispositivo y no necesita registrarse ni vincularse con otro equipo.

| Plataforma | Formato | Estado |
|---|---|---|
| Linux | Programa de escritorio (Qt WebEngine) | Probado |
| macOS 14+ (Intel y Apple Silicon) | `Sonora.app` | Preparado, pendiente de pruebas en equipos reales |
| Android 7+ (arm64) | APK | Compila; pendiente de pruebas en más dispositivos |

## Funcionalidades

### Añadir música desde una URL

- **Convertir y descargar**: extrae el audio, lo convierte a **MP3 de 320 kbps** e incrusta título, artista y carátula. Queda disponible sin conexión.
- **▶ Reproducir ahora**: suena en un par de segundos por streaming, sin guardar nada.
- **☁ Añadir sin descargar**: la canción queda en la biblioteca y en playlists, y se escucha por streaming.
- El streaming reproduce el **audio original de la fuente sin recodificar** (por ejemplo, Opus en YouTube), que es la máxima calidad disponible.
- Una canción ☁ se puede pasar a MP3 en cualquier momento («Guardar sin conexión») y la versión descargada la sustituye en las playlists.

### Biblioteca y playlists

- Biblioteca con búsqueda y filtros: todas, descargadas o en línea.
- Playlists: crear, renombrar, reordenar arrastrando y mezclar canciones descargadas y en línea.
- Lista de **escuchadas sin guardar** (lo reproducido con «Reproducir ahora»), con la que se puede crear una playlist directamente.
- **Playlists por link**: «Compartir» genera un enlace `sonora://playlist/…` que contiene la playlist completa. Al abrirlo o pegarlo en otro Sonora:
  - las canciones que ese dispositivo ya tenga se reutilizan;
  - las que falten se añaden como ☁ (streaming);
  - si la misma playlist se vuelve a importar, se **actualiza** en lugar de duplicarse.
- **Historial** de conversiones de cada dispositivo.

### Reproductor

- Reproductor fijo con cola, aleatorio, bucle (cola o canción), barra de progreso, volumen y carátula.
- Recuerda la canción y la posición al volver a abrir.
- Atajos de teclado en escritorio.
- En Android: reproducción con la **pantalla apagada** o usando otras apps, controles en la notificación y en la pantalla de bloqueo, botones de auriculares y Bluetooth, y pausa automática con llamadas o al desconectar los auriculares.

### Sin conexión

Las canciones descargadas suenan sin internet y la interfaz abre sin red. Las canciones ☁ necesitan conexión; sin ella se saltan con un aviso.

## Cómo funciona

### Escritorio (Linux y macOS)

```
┌──────────────────────────── Sonora (un solo proceso) ────────────────────────────┐
│                                                                                    │
│   Ventana Qt WebEngine  ──HTTP 127.0.0.1──▶  Servidor FastAPI                      │
│   (interfaz HTML/JS)                          ├─ Biblioteca: lee los MP3 y sus      │
│                                               │  etiquetas ID3 (Mutagen)            │
│                                               ├─ Conversión: yt-dlp + FFmpeg        │
│                                               ├─ Streaming: yt-dlp obtiene el       │
│                                               │  enlace del audio y el servidor     │
│                                               │  lo reenvía al reproductor          │
│                                               └─ Playlists, historial y canciones   │
│                                                  en línea: archivos JSON locales    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

1. Al abrir Sonora se inicia, dentro del mismo programa, un pequeño servidor que solo atiende a ese equipo.
2. La ventana muestra la interfaz y le pide al servidor la biblioteca, las playlists y el audio.
3. Al convertir, **yt-dlp** descarga el mejor audio disponible y **FFmpeg** lo convierte a MP3 e incrusta los metadatos y la carátula. yt-dlp usa **Deno** para resolver las protecciones de JavaScript de algunos sitios.
4. Al escuchar por streaming, el servidor obtiene el enlace directo del audio (que caduca a las pocas horas) y lo reenvía al reproductor respetando los saltos dentro de la canción.
5. Al cerrar la ventana se detiene todo.

### Android

```
┌──────────────────────────── App Sonora (APK) ────────────────────────────┐
│                                                                            │
│   WebView (misma interfaz)  ──puente Capacitor──▶  Plugin nativo (Java)   │
│                                                    ├─ yt-dlp + Python +    │
│                                                    │  FFmpeg + QuickJS      │
│                                                    │  (youtubedl-android)   │
│                                                    ├─ Biblioteca y datos   │
│                                                    └─ Servicio de          │
│                                                       reproducción         │
└────────────────────────────────────────────────────────────────────────────┘
```

La interfaz es la misma que en escritorio. Un adaptador (`native.js`) atiende las mismas peticiones que el servidor de escritorio, pero usando el plugin nativo: la conversión y el streaming se ejecutan en el propio teléfono con yt-dlp, FFmpeg y QuickJS incluidos en la APK. Un servicio en primer plano mantiene la música sonando con la pantalla apagada.

## Cómo se conecta

Sonora **no tiene servidores propios** y **no se comunica entre dispositivos**. Las únicas conexiones que hace son:

| Conexión | Cuándo | Para qué |
|---|---|---|
| Al sitio de la URL que pegas | Al convertir o escuchar en streaming | Obtener el audio y sus datos (lo hace yt-dlp) |
| A la imagen de la carátula | Al mostrar canciones en línea | Mostrar la carátula |
| A GitHub (`api.github.com`) | Solo Android, como máximo una vez al día | Actualizar yt-dlp, porque los sitios cambian a menudo |
| `127.0.0.1` | Solo escritorio, siempre | Comunicación interna entre la ventana y su servidor |

- `127.0.0.1` significa «este mismo equipo» en cualquier ordenador; no es una IP de red. El servidor no escucha en la red local y rechaza peticiones cuyo `Host` no sea local, para que ninguna página web pueda usarlo desde el navegador. Si el puerto 8765 está ocupado, se usa otro libre.
- Internet se usa a través de la conexión que tenga el dispositivo (wifi o datos), como cualquier app.
- En Android solo se permiten conexiones cifradas (HTTPS).
- **Entre dispositivos solo viajan los links de playlist**: el enlace `sonora://playlist/…` contiene los datos de la playlist comprimidos (nombre y enlace de origen de cada canción). No se sube a ningún sitio; lo envías tú por el medio que quieras.

## Privacidad

- Sin cuentas, registros, analíticas, anuncios ni telemetría.
- Toda la información (música, playlists, historial) se guarda en el dispositivo:
  - Linux: `~/Música/Sonora` (o la carpeta «Música» del sistema) y `~/.local/share/sonora`
  - macOS: `~/Music/Sonora` y `~/Library/Application Support/Sonora`
  - Android: almacenamiento privado de la app (se borra al desinstalarla)
- El repositorio no contiene música, claves ni datos personales; el `.gitignore` impide subirlos por error.

## Instalación

### Linux y macOS

```bash
git clone https://github.com/killerstrix/sonora.git
cd sonora/sonora
./install.sh
```

- **Linux**: necesita `uv`, `ffmpeg`, `deno` y PySide6 con Qt WebEngine del sistema (Arch: `sudo pacman -S ffmpeg deno pyside6 qt6-webengine`). Queda en el menú de aplicaciones y como comando `sonora`.
- **macOS**: necesita [Homebrew](https://brew.sh); el instalador añade lo demás y crea `Sonora.app` en Aplicaciones.

Desinstalar: `./install.sh --uninstall` (no borra la música).

### Android

Descarga `Sonora.apk` desde la sección **Releases** e instálala. **No hace falta descargar nada más**: yt-dlp, FFmpeg, Python y QuickJS van incluidos en la APK, sin Termux, otras apps ni cuentas.

Requisitos y primeros pasos:

- Android 7 o superior, de 64 bits (arm64; casi todos los celulares de los últimos años).
- Al abrir el APK, Android pedirá permitir «instalar apps desconocidas» para la app desde la que lo abras (Archivos, Drive, Telegram…). Es normal con cualquier APK fuera de Play Store; Play Protect puede mostrar un aviso por el mismo motivo.
- La primera vez que reproduzcas, acepta el permiso de **notificaciones** para tener los controles con la pantalla apagada.
- Internet solo hace falta para convertir y para el streaming; las canciones descargadas suenan sin conexión.

Para compilarla tú mismo (del código a `Sonora.apk`):

```bash
cd sonora-android
./build-apk.sh        # requiere Node 22+, el SDK de Android y Java 17–21
```

La guía paso a paso (requisitos, instalación del SDK, qué hace el script y soluciones a errores comunes) está en [`sonora-android/README.md`](sonora-android/README.md#compilar-la-apk-del-código-a-sonoraapk).

Más detalles en [`sonora/README.md`](sonora/README.md) y [`sonora-android/README.md`](sonora-android/README.md).

## Preguntas frecuentes

**¿Necesito instalar algo más en el celular?**
No. Basta con la APK; todo lo necesario para convertir y reproducir va dentro.

**¿El celular se conecta a mi PC, o el PC a algún servidor?**
No. Cada instalación es independiente y no hay servidores propios. Para tener la misma playlist en otro dispositivo, compártela con su link `sonora://playlist/…`.

**¿Funciona sin internet?**
Sí, para todo lo descargado. Convertir y escuchar canciones ☁ (streaming) necesita conexión.

**¿Por qué la primera conversión en Android tarda más?**
La app prepara su motor de conversión la primera vez. Después es más rápida. yt-dlp se actualiza solo una vez al día cuando hay internet.

**La música se corta con la pantalla apagada en mi celular.**
Algunas marcas (Xiaomi, Samsung, Huawei, Oppo, Realme) cierran apps en segundo plano para ahorrar batería. Ve a Ajustes → Aplicaciones → Sonora → Batería → «Sin restricciones» (en Xiaomi, activa también «Inicio automático»).

**Una URL no funciona en streaming.**
Algunos enlaces (listas, transmisiones en vivo o sitios que solo ofrecen el audio por HLS) no se pueden escuchar directamente; usa **Convertir y descargar**. Si un sitio que antes funcionaba deja de hacerlo, suele resolverse cuando yt-dlp se actualiza.

**¿Dónde están mis canciones?**
Linux: `~/Música/Sonora` (carpeta «Música» del sistema) · macOS: `~/Music/Sonora` · Android: almacenamiento privado de la app (se borra al desinstalarla).

## Estructura del repositorio

```
sonora/                     Aplicación de escritorio
├── backend/main.py         Servidor: biblioteca, conversión, streaming, playlists, historial
├── desktop/                Ventana Qt WebEngine con el servidor integrado
├── frontend/               Interfaz compartida (HTML, CSS y JavaScript sin frameworks)
├── install.sh, install/    Instaladores para Linux y macOS
└── sonora.sh               Modo navegador (sin instalar)

sonora-android/             App de Android (Capacitor)
├── android/…/player/       Plugin nativo y servicio de reproducción (Java)
├── scripts/sync-web.sh     Copia la interfaz compartida desde sonora/frontend
└── build-apk.sh            Compila la APK
```

## Componentes y su origen

Sonora se apoya únicamente en software de código abierto, obtenido de sus repositorios oficiales (PyPI, npm, Maven Central, Google Maven y los gestores de paquetes de cada sistema).

### Escritorio

| Componente | Uso en Sonora | Licencia | Origen |
|---|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Extraer el audio de las URL | Unlicense | PyPI |
| [yt-dlp-ejs](https://github.com/yt-dlp/ejs) | Scripts de yt-dlp para resolver desafíos JavaScript | Unlicense / MIT / ISC | PyPI |
| [FFmpeg](https://ffmpeg.org) | Convertir a MP3 e incrustar carátula y metadatos | LGPL-2.1+ / GPL (según compilación) | Gestor de paquetes del sistema / Homebrew |
| [Deno](https://deno.com) | Motor JavaScript que usa yt-dlp | MIT | Gestor de paquetes del sistema / Homebrew |
| [FastAPI](https://fastapi.tiangolo.com) | Servidor interno | MIT | PyPI |
| [Starlette](https://www.starlette.io) | Base de FastAPI, archivos y streaming | BSD-3-Clause | PyPI |
| [Uvicorn](https://www.uvicorn.org) | Ejecuta el servidor | BSD-3-Clause | PyPI |
| [Pydantic](https://docs.pydantic.dev) | Validación de datos | MIT | PyPI |
| [Mutagen](https://github.com/quodlibet/mutagen) | Leer etiquetas ID3 y carátulas de los MP3 | GPL-2.0-or-later | PyPI |
| [Requests](https://requests.readthedocs.io) | Reenviar el audio en streaming | Apache-2.0 | PyPI |
| [PySide6 / Qt WebEngine](https://doc.qt.io/qtforpython-6/) | Ventana de la aplicación | LGPL-3.0 / GPL | Sistema (Linux) · PyPI (macOS) |
| [uv](https://docs.astral.sh/uv/) | Instalar las dependencias de Python | MIT / Apache-2.0 | Herramienta de instalación |

### Android

| Componente | Uso en Sonora | Licencia | Origen |
|---|---|---|---|
| [Capacitor](https://capacitorjs.com) | Envoltorio de la interfaz web como app nativa | MIT | npm |
| [youtubedl-android](https://github.com/yausername/youtubedl-android) (fork [JunkFood02](https://github.com/JunkFood02/youtubedl-android)) | yt-dlp, Python, FFmpeg y QuickJS dentro de la APK | GPL-3.0 | Maven Central |
| [QuickJS](https://bellard.org/quickjs/) | Motor JavaScript para yt-dlp (incluido en youtubedl-android) | MIT | Maven Central (vía youtubedl-android) |
| [AndroidX Media](https://developer.android.com/jetpack/androidx/releases/media) | Controles de reproducción y pantalla de bloqueo | Apache-2.0 | Google Maven |
| AndroidX AppCompat / Core | Base de la app | Apache-2.0 | Google Maven |

### Propio del proyecto

La interfaz (HTML, CSS y JavaScript sin frameworks), el servidor, la ventana de escritorio, el plugin y el servicio de Android, los instaladores y el icono están escritos para Sonora.

## Licencia

Sonora se distribuye bajo la **GNU General Public License v3.0 (GPL-3.0)**. La app de Android incluye youtubedl-android, que es GPL-3.0, por lo que la APK debe distribuirse con esta licencia; se usa la misma en todo el proyecto por coherencia. Cada componente de terceros mantiene su propia licencia (ver la tabla anterior).

## Aviso legal

- **Uso responsable.** Sonora es una herramienta para uso personal. Úsala únicamente con contenido que tengas derecho a descargar o reproducir: material propio, de dominio público, con licencias que lo permitan (por ejemplo, Creative Commons) o para el que tengas autorización del titular.
- **Derechos de autor y condiciones de uso.** Descargar contenido protegido sin autorización, o de una forma que incumpla las condiciones de servicio de una plataforma, puede estar prohibido según la ley de tu país y las condiciones de esa plataforma. La persona usuaria es la única responsable del uso que haga de la aplicación.
- **Sin contenido alojado.** Sonora no aloja, distribuye ni indexa contenido. No incluye catálogos ni buscadores: solo procesa las URL que la persona usuaria introduce, en su propio dispositivo.
- **Sin afiliación.** Sonora no está afiliada, patrocinada ni respaldada por YouTube, Google ni ninguna otra plataforma. Los nombres y marcas mencionados pertenecen a sus respectivos titulares y se citan solo con fines descriptivos.
- **Sin garantía.** El software se proporciona «tal cual», sin garantía de ningún tipo, en los términos de la licencia GPL-3.0. Los autores no se hacen responsables de daños, pérdidas de datos ni consecuencias derivadas de su uso.
- **Servicios de terceros.** El funcionamiento depende de sitios externos que pueden cambiar en cualquier momento; algunas funciones pueden dejar de funcionar hasta que yt-dlp se actualice.
