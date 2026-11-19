# Sonora · escritorio (Linux y macOS)

Reproductor de música con estética oscura que convierte enlaces a MP3, permite escucharlos por streaming sin descargarlos y organiza todo en playlists. Funciona como un programa normal: ventana propia, icono en el menú de aplicaciones y sin cuentas.

> Para la explicación general del proyecto (funcionamiento, componentes y aviso legal) consulta [`README.md`](../README.md). La versión para Android está en [`../sonora-android`](../sonora-android).

## Instalar

```bash
./install.sh              # instala o actualiza (detecta Linux o macOS)
./install.sh --uninstall  # desinstala (no toca tu música)
```

### Linux

- Requisitos: [uv](https://docs.astral.sh/uv/), `ffmpeg`, `deno` (o `node`) y PySide6 con Qt WebEngine del sistema.
  - Arch: `sudo pacman -S ffmpeg deno pyside6 qt6-webengine`
  - Debian/Ubuntu: `sudo apt install ffmpeg python3-pyside6.qtwebenginewidgets` (y [Deno](https://deno.com))
- Queda en el menú de aplicaciones y como comando `sonora`.

### macOS (14 Sonoma o superior, Intel o Apple Silicon)

- Requisito: [Homebrew](https://brew.sh). El instalador añade lo que falte (`ffmpeg`, `deno`, `uv`) y PySide6 desde PyPI.
- Crea **Sonora.app** en Aplicaciones (Launchpad, Dock, Spotlight). Usa su propio entorno `.venv-macos`, así la carpeta puede compartirse con Linux.

### Sin instalar (en el navegador)

```bash
./sonora.sh               # abre http://127.0.0.1:8765
```

## Uso

### Añadir una URL

| Opción | Qué hace | Calidad | Sin internet |
|---|---|---|---|
| **Convertir y descargar** | Guarda un MP3 con título, artista y carátula | MP3 320 kbps | Sí |
| **▶ Reproducir ahora** | Suena al instante por streaming, no se guarda | Audio original de la fuente | No |
| **☁ Añadir sin descargar** | Queda en la biblioteca con ☁ y en playlists | Audio original de la fuente | No |

Lo escuchado con «Reproducir ahora» aparece en **Escuchadas sin guardar**, desde donde se puede crear una playlist. Una canción ☁ se pasa a MP3 con **Guardar sin conexión** (menú ⋯) y la descargada la reemplaza en las playlists.

### Biblioteca, playlists e historial

- **Biblioteca**: canciones descargadas y en línea, con búsqueda y filtros (Todas · Descargadas · En línea).
- **Playlists**: crear, renombrar, reordenar arrastrando, añadir desde el menú ⋯ o desde el buscador de la playlist.
- **Compartir**: genera un link `sonora://playlist/…` con la playlist completa. Se importa pegándolo en **Añadir URL** o **Playlists → Importar** de otro Sonora; si se vuelve a importar, la playlist se actualiza en vez de duplicarse.
- **Historial**: todo lo convertido en este equipo, con acceso a la carpeta de música.

### Reproductor

Cola, aleatorio, bucle (cola o canción), barra de progreso, volumen y recuerdo de la última posición.

| Atajo | Acción |
|---|---|
| Espacio | Reproducir / pausar |
| ← / → | Retroceder / avanzar 5 s |
| Shift + ← / → | Canción anterior / siguiente |
| F5 · Ctrl+R (⌘R) | Recargar la ventana |

## Dónde se guarda cada cosa

| Qué | Linux | macOS |
|---|---|---|
| MP3 | `~/Música/Sonora` (carpeta «Música» del sistema) | `~/Music/Sonora` |
| Playlists, historial, canciones en línea | `.sonora/` dentro de la carpeta de música | igual |
| Datos de la ventana (cola, volumen, caché) | `~/.local/share/sonora` | `~/Library/Application Support/Sonora` |

La carpeta de música se puede cambiar con `SONORA_MUSIC_DIR`. Cualquier MP3 que copies ahí aparece en la biblioteca.

## Cómo está hecho

```
desktop/sonora_desktop.py   Ventana Qt WebEngine + servidor integrado (una sola instancia)
backend/main.py             Servidor FastAPI: biblioteca, conversión, streaming, playlists, historial
frontend/                   Interfaz (HTML, CSS y JS sin frameworks), compartida con la app de Android
  app.js                    Vistas, reproductor y playlists por link
  native.js                 Adaptador que solo se activa dentro de la APK
  sw.js                     Caché para abrir sin conexión
install.sh, install/        Instaladores para Linux y macOS
```

- El servidor escucha **solo en `127.0.0.1`** (si el puerto 8765 está ocupado, elige otro libre) y rechaza peticiones cuyo `Host` no sea local, para que ninguna página web pueda usarlo desde el navegador.
- La conversión usa yt-dlp + ffmpeg (MP3 320 kbps, metadatos y carátula). El streaming obtiene el enlace directo del mejor audio y el servidor lo reenvía al reproductor, permitiendo saltar dentro de la canción; si la fuente rechaza una petición, se reintenta con un enlace nuevo.
- Variables opcionales: `SONORA_MUSIC_DIR` y `SONORA_PORT`.
