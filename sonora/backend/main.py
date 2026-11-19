"""Sonora: servidor local que convierte URLs a MP3, indexa la biblioteca y gestiona playlists."""

import hashlib
import json
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

import requests
import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask
from fastapi.staticfiles import StaticFiles
from mutagen.id3 import ID3, ID3NoHeaderError
from mutagen.mp3 import MP3
from pydantic import BaseModel

def _default_music_dir() -> Path:
    """Carpeta «Música» del sistema: ~/Music en macOS; en Linux la de XDG (p. ej. ~/Música en español)."""
    if sys.platform.startswith("linux"):
        try:
            out = subprocess.run(["xdg-user-dir", "MUSIC"], capture_output=True, text=True, timeout=3).stdout.strip()
            if out and Path(out) != Path.home():
                return Path(out) / "Sonora"
        except (OSError, subprocess.SubprocessError):
            pass
        legacy = Path.home() / "Música"
        if legacy.is_dir():
            return legacy / "Sonora"
    return Path.home() / "Music" / "Sonora"


MUSIC_DIR = Path(os.environ.get("SONORA_MUSIC_DIR") or _default_music_dir()).expanduser()
DATA_DIR = MUSIC_DIR / ".sonora"
PLAYLISTS_FILE = DATA_DIR / "playlists.json"
HISTORY_FILE = DATA_DIR / "history.json"
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

MUSIC_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Sonora")
log = logging.getLogger("sonora")


# ---------- Solo este equipo ----------
# Sonora no se comunica con otros dispositivos: el servidor solo atiende a este mismo equipo.
# Se comprueba también la cabecera Host para que una página web cualquiera no pueda usarlo
# a través del navegador (ataque de «DNS rebinding»).

LOCAL_HOSTS = {"127.0.0.1", "::1"}
LOCAL_NAMES = {"127.0.0.1", "localhost", "[::1]"}


def _host_name(header: str) -> str:
    """«127.0.0.1:8765» → «127.0.0.1»; «[::1]:8765» → «[::1]»."""
    return header.split("]")[0] + "]" if header.startswith("[") else header.rsplit(":", 1)[0]


@app.middleware("http")
async def local_only(request: Request, call_next):
    client = request.client.host if request.client else ""
    if client not in LOCAL_HOSTS or _host_name(request.headers.get("host", "")) not in LOCAL_NAMES:
        return JSONResponse({"detail": "Sonora solo acepta conexiones de este mismo equipo"}, status_code=403)
    return await call_next(request)


# ---------- Biblioteca ----------

_index_lock = threading.Lock()
_index_cache: dict[str, tuple[float, dict]] = {}  # relpath -> (mtime, track)


def _track_id(relpath: str) -> str:
    return hashlib.sha1(relpath.encode()).hexdigest()[:16]


def _read_track(path: Path, relpath: str) -> dict:
    title, artist, album, has_cover, duration, source = path.stem, "", "", False, 0.0, None
    try:
        duration = MP3(path).info.length
    except Exception:
        pass
    try:
        tags = ID3(path)
        if "TIT2" in tags:
            title = str(tags["TIT2"])
        if "TPE1" in tags:
            artist = str(tags["TPE1"])
        if "TALB" in tags:
            album = str(tags["TALB"])
        has_cover = bool(tags.getall("APIC"))
        # yt-dlp guarda el enlace original en TXXX:purl: permite compartir la canción en playlists.
        for frame in tags.getall("TXXX"):
            if frame.desc.lower() in ("purl", "comment") and str(frame.text[0]).startswith("http"):
                source = str(frame.text[0])
                break
    except ID3NoHeaderError:
        pass
    except Exception:
        pass
    return {
        "id": _track_id(relpath),
        "file": relpath,
        "title": title,
        "artist": artist,
        "album": album,
        "duration": round(duration, 2),
        "hasCover": has_cover,
        "url": source,
        "addedAt": path.stat().st_mtime,
    }


def scan_library() -> dict[str, dict]:
    """Indexa todos los MP3 de MUSIC_DIR, releyendo solo los archivos modificados."""
    tracks: dict[str, dict] = {}
    with _index_lock:
        seen = set()
        for path in MUSIC_DIR.rglob("*.mp3"):
            if DATA_DIR in path.parents:
                continue
            relpath = path.relative_to(MUSIC_DIR).as_posix()
            seen.add(relpath)
            mtime = path.stat().st_mtime
            cached = _index_cache.get(relpath)
            if not cached or cached[0] != mtime:
                cached = (mtime, _read_track(path, relpath))
                _index_cache[relpath] = cached
            tracks[cached[1]["id"]] = cached[1]
        for gone in set(_index_cache) - seen:
            del _index_cache[gone]
    return tracks


def _get_track_path(track_id: str) -> Path:
    track = scan_library().get(track_id)
    if not track:
        raise HTTPException(404, "Canción no encontrada")
    return MUSIC_DIR / track["file"]


def all_tracks() -> dict[str, dict]:
    """Canciones descargadas + canciones en línea (las que se escuchan por streaming)."""
    return {**scan_library(), **{t["id"]: t for t in _online_tracks()}}


@app.get("/api/tracks")
def list_tracks():
    return sorted(all_tracks().values(), key=lambda t: t["addedAt"], reverse=True)


@app.get("/api/tracks/{track_id}/audio")
def track_audio(track_id: str):
    return FileResponse(_get_track_path(track_id), media_type="audio/mpeg")


@app.get("/api/tracks/{track_id}/cover")
def track_cover(track_id: str):
    try:
        pics = ID3(_get_track_path(track_id)).getall("APIC")
    except Exception:
        pics = []
    if not pics:
        raise HTTPException(404, "Sin carátula")
    return Response(pics[0].data, media_type=pics[0].mime or "image/jpeg",
                    headers={"Cache-Control": "public, max-age=604800"})


@app.delete("/api/tracks/{track_id}")
def delete_track(track_id: str):
    if track_id.startswith(ONLINE_PREFIX):
        _remove_online(track_id)
    else:
        _get_track_path(track_id).unlink()
    _sync_playlists(all_tracks())
    return {"ok": True}


# ---------- Streaming (escuchar sin descargar) ----------
# Se reproduce el audio original de la fuente, sin recodificar: es la máxima calidad disponible.
# Solo formatos servidos por HTTP directo (no listas HLS), que el reproductor puede pedir por rangos.

ONLINE_FILE = DATA_DIR / "online.json"
ONLINE_PREFIX = "o"  # los ids locales son hexadecimales, así que nunca empiezan por «o» ni por «t»
TEMP_PREFIX = "t"
STREAM_FORMAT = "bestaudio[protocol^=http]/best[protocol^=http]"
# Algunos motores web (p. ej. Qt WebEngine de PyPI, en macOS) no traen AAC: se elige el mejor audio en otro códec.
STREAM_FORMAT_NO_AAC = ("bestaudio[protocol^=http][acodec!^=mp4a]/best[protocol^=http][acodec!^=mp4a]/"
                        "bestaudio[protocol^=http]/best[protocol^=http]")

_stream_cache: dict[str, dict] = {}  # url de origen -> enlace directo, cabeceras, caducidad y metadatos
_stream_lock = threading.Lock()
_online_lock = threading.Lock()


def _ydl_error(e: Exception) -> str:
    return str(e).replace("\x1b[0;31mERROR:\x1b[0m ", "").replace("ERROR: ", "").strip()[:400]


def _resolve(url: str, force: bool = False, no_aac: bool = False) -> dict:
    """Obtiene el enlace directo del mejor audio. Se guarda en caché hasta poco antes de que caduque."""
    key = (url, no_aac)
    with _stream_lock:
        cached = _stream_cache.get(key)
    if cached and not force and cached["expires"] > time.time() + 120:
        return cached
    opts = {"format": STREAM_FORMAT_NO_AAC if no_aac else STREAM_FORMAT,
            "noplaylist": True, "quiet": True, "noprogress": True,
            "js_runtimes": {"deno": {}, "node": {}}}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        raise HTTPException(400, _ydl_error(e) or "No se pudo leer ese enlace")
    if info.get("_type") == "playlist" or not info.get("url"):
        raise HTTPException(400, "Ese enlace no tiene un audio que se pueda escuchar directamente")
    expires = time.time() + 1800
    for part in info["url"].split("?", 1)[-1].split("&"):  # p. ej. YouTube: …&expire=1700000000&…
        if part.startswith("expire=") and part[7:].isdigit():
            expires = int(part[7:])
    entry = {
        "direct": info["url"],
        "headers": info.get("http_headers") or {},
        "expires": expires,
        "meta": {
            "url": url,
            "title": info.get("track") or info.get("title") or url,
            "artist": info.get("artist") or info.get("uploader") or info.get("channel") or "",
            "album": info.get("album") or "",
            "duration": info.get("duration") or 0,
            "thumbnail": info.get("thumbnail"),
            "quality": " ".join(str(x) for x in (
                (info.get("acodec") or "").split(".")[0] or None,
                f"{round(info['abr'])} kbps" if info.get("abr") else None) if x),
        },
    }
    with _stream_lock:
        _stream_cache[key] = entry
    return entry


def _track_from_meta(meta: dict, track_id: str, added_at: float) -> dict:
    return {
        "id": track_id, "online": True, "url": meta["url"],
        "title": meta["title"], "artist": meta["artist"], "album": meta.get("album", ""),
        "duration": meta.get("duration") or 0, "quality": meta.get("quality", ""),
        "hasCover": bool(meta.get("thumbnail")), "coverSrc": meta.get("thumbnail"),
        "audioSrc": "/api/stream?url=" + quote(meta["url"], safe=""),
        "addedAt": added_at,
    }


def _load_online() -> list[dict]:
    return json.loads(ONLINE_FILE.read_text(encoding="utf-8")) if ONLINE_FILE.exists() else []


def _save_online(items: list[dict]) -> None:
    tmp = ONLINE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(ONLINE_FILE)


def _online_id(url: str) -> str:
    return ONLINE_PREFIX + hashlib.sha1(url.encode()).hexdigest()[:15]


def _online_tracks() -> list[dict]:
    with _online_lock:
        return [_track_from_meta(o, o["id"], o["addedAt"]) for o in _load_online()]


def _remove_online(track_id: str) -> None:
    with _online_lock:
        items = _load_online()
        remaining = [o for o in items if o["id"] != track_id]
        if len(remaining) == len(items):
            raise HTTPException(404, "Canción no encontrada")
        _save_online(remaining)


class UrlIn(BaseModel):
    url: str


def _check_url(url: str) -> str:
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "Introduce una URL válida (http/https)")
    return url


@app.post("/api/stream/info")
def stream_info(body: UrlIn):
    """Datos para «Reproducir ahora»: una canción temporal que no se guarda en la biblioteca."""
    url = _check_url(body.url)
    meta = _resolve(url)["meta"]
    return _track_from_meta(meta, TEMP_PREFIX + hashlib.sha1(url.encode()).hexdigest()[:15], time.time())


@app.post("/api/online")
def add_online(body: UrlIn):
    """«Añadir sin descargar»: queda en la biblioteca y se escucha por streaming."""
    url = _check_url(body.url)
    meta = _resolve(url)["meta"]
    track_id = _online_id(url)
    with _online_lock:
        items = [o for o in _load_online() if o["id"] != track_id]
        items.insert(0, {**meta, "id": track_id, "addedAt": time.time()})
        _save_online(items)
    return _track_from_meta(meta, track_id, items[0]["addedAt"])


class OnlineItem(BaseModel):
    url: str
    title: str = ""
    artist: str = ""
    duration: float = 0
    thumbnail: str | None = None


class OnlineBulkIn(BaseModel):
    items: list[OnlineItem]


@app.post("/api/online/bulk")
def add_online_bulk(body: OnlineBulkIn):
    """Importar una playlist compartida: añade sus canciones en línea con los datos del link,
    sin consultar cada una (el audio se obtiene al reproducirlas)."""
    ids, now = [], time.time()
    with _online_lock:
        items = _load_online()
        known = {o["id"] for o in items}
        for i, it in enumerate(body.items[:1000]):
            url = _check_url(it.url)
            track_id = _online_id(url)
            if track_id not in known:
                thumb = it.thumbnail if (it.thumbnail or "").startswith("https://") else None
                items.insert(0, {"url": url, "title": it.title[:300] or url, "artist": it.artist[:200], "album": "",
                                 "duration": max(0.0, it.duration or 0), "thumbnail": thumb, "quality": "",
                                 "id": track_id, "addedAt": now - i / 1000})
                known.add(track_id)
            ids.append(track_id)
        _save_online(items)
    return {"ids": ids}


@app.get("/api/stream")
def stream(url: str, request: Request, noaac: bool = False):
    """Reenvía el audio de la fuente al reproductor, respetando los saltos (cabecera Range)."""
    url = _check_url(url)
    # Las fuentes a veces rechazan una petición suelta: YouTube, en concreto, responde 403 a las
    # primeras peticiones de un enlace recién emitido y lo acepta segundos después. Por eso se insiste
    # con el mismo enlace y solo se pide uno nuevo si sigue fallando (pedirlo en cada intento hacía
    # que todos los intentos dieran con un enlace «recién emitido» y fallaran).
    client_range = request.headers.get("range")
    upstream, problem, attempt, entry = None, "", 0, None
    for refresh in range(2):
        entry = _resolve(url, force=refresh > 0, no_aac=noaac)
        headers = dict(entry["headers"])
        if client_range:
            headers["Range"] = client_range
        for retry in range(6):
            attempt += 1
            try:
                upstream = requests.get(entry["direct"], headers=headers, stream=True, timeout=(10, 30))
            except requests.RequestException as e:
                upstream, problem = None, f"conexión: {type(e).__name__}"
            else:
                if upstream.status_code < 400:
                    break
                problem = f"HTTP {upstream.status_code}"
                upstream.close()
                upstream = None
            log.info("Streaming de %s falló (intento %d): %s", url, attempt, problem)
            time.sleep(0.5 + 0.25 * retry)
        if upstream is not None:
            break
    if upstream is None:
        log.warning("Streaming de %s falló tras %d intentos: %s", url, attempt, problem)
        raise HTTPException(502, f"La fuente del audio no respondió ({problem})")
    entry["warm"] = True  # el enlace ya responde: queda lista para sonar al instante
    with _stream_lock:
        _prepare_state[(url, noaac)] = {"state": "ready", "error": None}
    passthrough = {k: upstream.headers[k] for k in ("Content-Length", "Content-Range") if k in upstream.headers}
    passthrough["Accept-Ranges"] = "bytes"
    return StreamingResponse(upstream.iter_content(64 * 1024), status_code=upstream.status_code,
                             media_type=upstream.headers.get("Content-Type", "audio/webm"),
                             headers=passthrough, background=BackgroundTask(upstream.close))


# ---------- Preparar canciones por adelantado ----------
# Resuelve el enlace de las canciones en línea y lo «calienta» (pequeñas peticiones hasta que la
# fuente lo acepta) para que al pulsar Reproducir suenen al instante. Solo 2 a la vez, por orden de
# llegada: pedirlas todas juntas a la fuente podría provocar límites o bloqueos.

PREPARE_WORKERS = 2
_prepare_exec = ThreadPoolExecutor(max_workers=PREPARE_WORKERS)
_prepare_state: dict[tuple[str, bool], dict] = {}  # (url, noaac) -> {"state": queued|preparing|ready|error, "error"}


def _warm(entry: dict) -> str | None:
    """Pide el primer byte hasta que la fuente acepte el enlace. Devuelve el problema si no lo consigue."""
    headers = {**entry["headers"], "Range": "bytes=0-0"}
    problem = ""
    for retry in range(8):
        try:
            with requests.get(entry["direct"], headers=headers, stream=True, timeout=(10, 15)) as r:
                if r.status_code < 400:
                    entry["warm"] = True
                    return None
                problem = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            problem = f"conexión: {type(e).__name__}"
        log.info("Preparando %s: intento %d sin respuesta (%s)", entry["meta"]["url"], retry + 1, problem)
        time.sleep(min(1.5, 0.5 + 0.15 * retry))
    return f"La fuente del audio no respondió ({problem})"


def _set_prepare(key: tuple[str, bool], state: str, error: str | None = None) -> None:
    with _stream_lock:
        _prepare_state[key] = {"state": state, "error": error}


def _prepare(url: str, no_aac: bool) -> None:
    key = (url, no_aac)
    _set_prepare(key, "preparing")
    try:
        entry = _resolve(url, no_aac=no_aac)
        problem = None if entry.get("warm") else _warm(entry)
    except HTTPException as e:
        problem = str(e.detail)
    except Exception as e:  # el trabajador nunca debe morir con una canción a medias
        problem = str(e)[:300] or type(e).__name__
    _set_prepare(key, "error" if problem else "ready", problem)


def _is_ready(key: tuple[str, bool]) -> bool:
    """«ready» deja de valer cuando el enlace caduca (o se renovó y volvió a estar frío)."""
    entry = _stream_cache.get(key)
    return bool(entry and entry.get("warm") and entry["expires"] > time.time() + 120)


class PrepareIn(BaseModel):
    urls: list[str]
    noaac: bool = False


@app.post("/api/stream/prepare")
def prepare_streams(body: PrepareIn):
    """Encola canciones para prepararlas en segundo plano. Responde enseguida."""
    queued = 0
    for url in dict.fromkeys(u.strip() for u in body.urls[:1000]):
        if not url.startswith(("http://", "https://")):
            continue
        key = (url, body.noaac)
        with _stream_lock:
            current = _prepare_state.get(key, {}).get("state")
            if current in ("queued", "preparing") or (current == "ready" and _is_ready(key)):
                continue
            _prepare_state[key] = {"state": "queued", "error": None}
        _prepare_exec.submit(_prepare, url, body.noaac)
        queued += 1
    return {"queued": queued}


@app.get("/api/stream/prepare")
def prepare_status(noaac: bool = False):
    states, pending = {}, 0
    with _stream_lock:
        for (url, no_aac), st in _prepare_state.items():
            if no_aac != noaac or (st["state"] == "ready" and not _is_ready((url, no_aac))):
                continue
            states[url] = dict(st)
            pending += st["state"] in ("queued", "preparing")
    return {"states": states, "pending": pending, "workers": PREPARE_WORKERS}


@app.post("/api/online/{track_id}/save")
def save_online(track_id: str):
    """«Guardar sin conexión»: convierte a MP3 y, al terminar, sustituye la canción en línea en las playlists."""
    entry = next((o for o in _load_online() if o["id"] == track_id), None)
    if not entry:
        raise HTTPException(404, "Canción no encontrada")
    return _start_job(entry["url"], replace_id=track_id)


# ---------- Historial de conversiones ----------

_hist_lock = threading.Lock()


def _load_history() -> list[dict]:
    if HISTORY_FILE.exists():
        return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    # Primera vez: importa lo que ya estaba en la biblioteca.
    seeded = [{"id": uuid.uuid4().hex[:12], "url": None, "title": t["title"], "artist": t["artist"],
               "file": t["file"], "convertedAt": t["addedAt"]}
              for t in sorted(scan_library().values(), key=lambda t: t["addedAt"], reverse=True)]
    _save_history(seeded)
    return seeded


def _save_history(history: list[dict]) -> None:
    tmp = HISTORY_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(HISTORY_FILE)


def _add_history(url: str, title: str, artist: str, relpath: str) -> None:
    with _hist_lock:
        # Si se reconvierte el mismo archivo, la entrada sube arriba en vez de duplicarse.
        history = [h for h in _load_history() if h["file"] != relpath]
        history.insert(0, {"id": uuid.uuid4().hex[:12], "url": url, "title": title, "artist": artist,
                           "file": relpath, "convertedAt": time.time()})
        _save_history(history)


@app.get("/api/history")
def list_history():
    tracks = scan_library()
    with _hist_lock:
        history = _load_history()
    out = []
    for h in history:
        tid = _track_id(h["file"])
        track = tracks.get(tid)
        out.append({**h, "trackId": tid, "available": track is not None,
                    "hasCover": bool(track and track["hasCover"]),
                    "duration": track["duration"] if track else 0})
    return out


@app.delete("/api/history/{entry_id}")
def delete_history(entry_id: str):
    """Quita la entrada del historial (no borra el archivo)."""
    with _hist_lock:
        history = _load_history()
        _save_history([h for h in history if h["id"] != entry_id])
    return {"ok": True}


# ---------- Playlists ----------

_pl_lock = threading.Lock()


def _load_playlists() -> list[dict]:
    if not PLAYLISTS_FILE.exists():
        return []
    return json.loads(PLAYLISTS_FILE.read_text(encoding="utf-8"))


def _save_playlists(playlists: list[dict]) -> None:
    tmp = PLAYLISTS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(playlists, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(PLAYLISTS_FILE)


def _sync_playlists(tracks: dict[str, dict]) -> list[dict]:
    """Quita de las playlists las canciones cuyo archivo ya no existe."""
    with _pl_lock:
        playlists = _load_playlists()
        changed = False
        for pl in playlists:
            kept = [t for t in pl["tracks"] if t in tracks]
            if kept != pl["tracks"]:
                pl["tracks"], changed = kept, True
        if changed:
            _save_playlists(playlists)
        return playlists


class PlaylistIn(BaseModel):
    name: str
    tracks: list[str] = []
    shareId: str | None = None  # id de la playlist original cuando se importa desde un link


class PlaylistPatch(BaseModel):
    name: str | None = None
    tracks: list[str] | None = None


@app.get("/api/playlists")
def list_playlists():
    return _sync_playlists(all_tracks())


@app.post("/api/playlists")
def create_playlist(body: PlaylistIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "El nombre no puede estar vacío")
    tracks = all_tracks()
    pl = {"id": uuid.uuid4().hex[:12], "name": name,
          "tracks": [t for t in dict.fromkeys(body.tracks) if t in tracks],
          "createdAt": time.time()}
    if body.shareId:
        pl["shareId"] = body.shareId[:64]
    with _pl_lock:
        playlists = _load_playlists()
        playlists.append(pl)
        _save_playlists(playlists)
    return pl


@app.patch("/api/playlists/{pl_id}")
def update_playlist(pl_id: str, body: PlaylistPatch):
    tracks = all_tracks()
    with _pl_lock:
        playlists = _load_playlists()
        pl = next((p for p in playlists if p["id"] == pl_id), None)
        if not pl:
            raise HTTPException(404, "Playlist no encontrada")
        if body.name is not None and body.name.strip():
            pl["name"] = body.name.strip()
        if body.tracks is not None:
            pl["tracks"] = [t for t in dict.fromkeys(body.tracks) if t in tracks]
        _save_playlists(playlists)
        return pl


@app.delete("/api/playlists/{pl_id}")
def delete_playlist(pl_id: str):
    with _pl_lock:
        playlists = _load_playlists()
        remaining = [p for p in playlists if p["id"] != pl_id]
        if len(remaining) == len(playlists):
            raise HTTPException(404, "Playlist no encontrada")
        _save_playlists(remaining)
    return {"ok": True}


# ---------- Conversión URL -> MP3 ----------

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=2)


def _update_job(job_id: str, **fields) -> None:
    with _jobs_lock:
        _jobs[job_id].update(fields)


def _replace_in_playlists(old_id: str, new_id: str) -> None:
    with _pl_lock:
        playlists = _load_playlists()
        for pl in playlists:
            pl["tracks"] = list(dict.fromkeys(new_id if t == old_id else t for t in pl["tracks"]))
        _save_playlists(playlists)


def _run_download(job_id: str, url: str, replace_id: str | None = None) -> None:
    def on_progress(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            pct = (d.get("downloaded_bytes", 0) / total * 90) if total else 0
            _update_job(job_id, status="downloading", progress=round(pct, 1),
                        title=d.get("info_dict", {}).get("title") or _jobs[job_id]["title"])
        elif d["status"] == "finished":
            _update_job(job_id, status="converting", progress=90)

    def on_postprocess(d):
        if d["status"] == "started":
            _update_job(job_id, status="converting")

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(MUSIC_DIR / "%(title).150B [%(id)s].%(ext)s"),
        "noplaylist": True,
        "writethumbnail": True,
        "quiet": True,
        "noprogress": True,
        "js_runtimes": {"deno": {}, "node": {}},
        "progress_hooks": [on_progress],
        "postprocessor_hooks": [on_postprocess],
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "320"},
            {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
            {"key": "FFmpegMetadata", "add_metadata": True},
            {"key": "EmbedThumbnail"},
        ],
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
        mp3 = Path(ydl.prepare_filename(info)).with_suffix(".mp3")
        relpath = mp3.relative_to(MUSIC_DIR).as_posix()
        track = _read_track(mp3, relpath)
        _add_history(url, track["title"], track["artist"], relpath)
        if replace_id:
            _replace_in_playlists(replace_id, track["id"])
            try:
                _remove_online(replace_id)
            except HTTPException:
                pass
        _update_job(job_id, status="done", progress=100, title=info.get("title", url),
                    trackId=_track_id(relpath))
    except Exception as e:
        msg = str(e).replace("\x1b[0;31mERROR:\x1b[0m ", "").strip()
        _update_job(job_id, status="error", error=msg[:400])


def _start_job(url: str, replace_id: str | None = None) -> dict:
    job_id = uuid.uuid4().hex[:12]
    with _jobs_lock:
        _jobs[job_id] = {"id": job_id, "url": url, "title": url, "status": "queued",
                         "progress": 0, "error": None, "trackId": None, "replaceId": replace_id,
                         "createdAt": time.time()}
    _executor.submit(_run_download, job_id, url, replace_id)
    return _jobs[job_id]


@app.post("/api/downloads")
def start_download(body: UrlIn):
    return _start_job(_check_url(body.url))


@app.get("/api/downloads")
def list_downloads():
    with _jobs_lock:
        return sorted(_jobs.values(), key=lambda j: j["createdAt"], reverse=True)


@app.delete("/api/downloads/{job_id}")
def dismiss_download(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job and job["status"] in ("done", "error"):
            del _jobs[job_id]
    return {"ok": True}


@app.get("/api/info")
def info():
    return {"musicDir": str(MUSIC_DIR)}


@app.post("/api/open-folder")
def open_folder():
    if sys.platform == "darwin":
        cmd = ["open", str(MUSIC_DIR)]
    elif sys.platform == "win32":
        cmd = ["explorer", str(MUSIC_DIR)]
    else:
        cmd = ["xdg-open", str(MUSIC_DIR)]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": True}


# El frontend (PWA) se sirve desde la raíz; se monta al final para no tapar /api.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
