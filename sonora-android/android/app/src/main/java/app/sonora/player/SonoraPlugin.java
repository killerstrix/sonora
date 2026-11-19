package app.sonora.player;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.MediaMetadataRetriever;
import android.os.Build;
import android.os.Environment;
import android.util.Log;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;

import java.io.File;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.locks.ReentrantReadWriteLock;

import org.json.JSONObject;

import kotlin.Unit;

/**
 * Puente entre la interfaz web y el teléfono:
 * conversión URL → MP3 y streaming (yt-dlp + ffmpeg + QuickJS incluidos en la APK), biblioteca local,
 * datos de la app, links de playlist y servicio de reproducción. No se comunica con ningún PC.
 */
@CapacitorPlugin(name = "Sonora")
public class SonoraPlugin extends Plugin {

    private static final long UPDATE_INTERVAL_MS = 24L * 60 * 60 * 1000;

    private final ExecutorService convertExec = Executors.newSingleThreadExecutor();
    private final ExecutorService ioExec = Executors.newFixedThreadPool(2);
    private final Object engineLock = new Object();
    private volatile boolean engineReady = false;
    /**
     * La actualización de yt-dlp borra y vuelve a copiar su archivo: si coincide con una ejecución, esta falla.
     * Cada ejecución toma el cerrojo de lectura y la actualización el de escritura (solo cuando no hay ninguna).
     */
    private final ReentrantReadWriteLock engineRw = new ReentrantReadWriteLock();

    /** Caché de metadatos: nombre de archivo → (fecha de modificación, datos). */
    private final Map<String, Object[]> metaCache = new ConcurrentHashMap<>();

    // ---------- Rutas ----------

    private File musicDir() {
        File base = getContext().getExternalFilesDir(Environment.DIRECTORY_MUSIC);
        if (base == null) base = new File(getContext().getFilesDir(), "music");
        File dir = new File(base, "Sonora");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private File coversDir() {
        File dir = new File(getContext().getCacheDir(), "covers");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /** Solo nombres simples: evita escribir o borrar fuera de la carpeta de música. */
    private static String safeName(String name) {
        if (name == null) return null;
        name = name.trim();
        if (name.isEmpty() || name.contains("/") || name.contains("\\") || name.startsWith(".")) return null;
        return name;
    }

    // ---------- Motor de conversión ----------

    private void ensureEngine() throws Exception {
        synchronized (engineLock) {
            if (engineReady) return;
            Context ctx = getContext().getApplicationContext();
            YoutubeDL.getInstance().init(ctx);
            FFmpeg.getInstance().init(ctx);
            engineReady = true;
        }
        maybeUpdateEngine();
    }

    /** Actualiza yt-dlp como mucho una vez al día: los sitios cambian a menudo y una versión vieja deja de funcionar. */
    private void maybeUpdateEngine() {
        SharedPreferences prefs = getContext().getSharedPreferences("sonora", Context.MODE_PRIVATE);
        long last = prefs.getLong("ytdlpUpdatedAt", 0);
        if (System.currentTimeMillis() - last < UPDATE_INTERVAL_MS) return;
        prefs.edit().putLong("ytdlpUpdatedAt", System.currentTimeMillis()).apply(); // una sola actualización en curso
        ioExec.submit(() -> {
            // tryLock no hace cola: no frena las ejecuciones nuevas mientras espera a que terminen las actuales.
            try {
                while (!engineRw.writeLock().tryLock()) Thread.sleep(2000);
            } catch (InterruptedException e) {
                return;
            }
            try {
                YoutubeDL.getInstance().updateYoutubeDL(getContext().getApplicationContext(), YoutubeDL.UpdateChannel._STABLE);
            } catch (Exception e) {
                // Sin internet o GitHub no disponible: se reintenta en la próxima conversión.
                Log.w(TAG, "No se pudo actualizar yt-dlp", e);
                prefs.edit().putLong("ytdlpUpdatedAt", 0).apply();
            } finally {
                engineRw.writeLock().unlock();
            }
        });
    }

    private void emit(String id, String status, Float progress, String title) {
        JSObject ev = new JSObject();
        ev.put("id", id);
        ev.put("status", status);
        if (progress != null) ev.put("progress", progress);
        if (title != null) ev.put("title", title);
        notifyListeners("progress", ev);
    }

    private static String cleanError(Throwable e) {
        String msg = e.getMessage() == null ? e.toString() : e.getMessage();
        for (String line : msg.split("\n")) {
            if (line.startsWith("ERROR:")) return line.substring(6).trim();
        }
        return msg.length() > 400 ? msg.substring(0, 400) : msg;
    }

    @PluginMethod
    public void convert(PluginCall call) {
        String id = call.getString("id", "job");
        String url = call.getString("url");
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            call.reject("Introduce una URL válida (http/https)");
            return;
        }
        emit(id, "queued", 0f, null);
        convertExec.submit(() -> {
            try {
                ensureEngine();
                emit(id, "downloading", 0f, null);
                long startedAt = System.currentTimeMillis();
                YoutubeDLRequest req = new YoutubeDLRequest(url);
                req.addOption("--no-playlist");
                req.addOption("-f", "bestaudio/best");
                req.addOption("-x");
                req.addOption("--audio-format", "mp3");
                req.addOption("--audio-quality", "320K");
                req.addOption("--embed-thumbnail");
                req.addOption("--convert-thumbnails", "jpg");
                req.addOption("--embed-metadata");
                req.addOption("-o", new File(musicDir(), "%(title).150B [%(id)s].%(ext)s").getAbsolutePath());
                req.addOption("--print", "before_dl:SONORA_TITLE:%(title)s");
                req.addOption("--print", "after_move:SONORA_FILE:%(filepath)s");
                req.addOption("--progress");  // --print activa el modo silencioso; esto mantiene el progreso

                final boolean[] converting = {false};
                YoutubeDLResponse resp;
                engineRw.readLock().lock();
                try {
                    resp = YoutubeDL.getInstance().execute(req, id, (Float progress, Long eta, String line) -> {
                        int t = line == null ? -1 : line.indexOf("SONORA_TITLE:");
                        if (t >= 0) {
                            emit(id, "downloading", 0f, line.substring(t + 13).trim());
                        } else if (progress != null && progress >= 0 && !converting[0]) {
                            if (progress >= 100f) {
                                converting[0] = true;
                                emit(id, "converting", 90f, null);
                            } else {
                                emit(id, "downloading", progress * 0.9f, null);
                            }
                        }
                        return Unit.INSTANCE;
                    });
                } finally {
                    engineRw.readLock().unlock();
                }

                // La barra de progreso usa «\r» sin salto de línea: la ruta puede llegar pegada detrás de ella.
                String path = null;
                for (String line : resp.getOut().split("[\r\n]+")) {
                    int f = line.indexOf("SONORA_FILE:");
                    if (f >= 0) path = line.substring(f + 12).trim();
                }
                if (path == null || !new File(path).exists()) path = newestMp3Since(startedAt);
                if (path == null) {
                    Log.e(TAG, "convert sin ruta del MP3. Salida: " + resp.getOut());
                    throw new Exception("No se generó el MP3");
                }
                JSObject ret = new JSObject();
                ret.put("file", new File(path).getName());
                call.resolve(ret);
            } catch (Throwable e) {
                Log.e(TAG, "convert " + url, e);
                String msg = cleanError(e);
                // yt-dlp dice «ffmpeg not found» cuando ffmpeg no arranca: se muestra el motivo real.
                if (msg.contains("ffmpeg not found") || msg.contains("ffprobe and ffmpeg not found")) {
                    String why = ffmpegDiagnosis();
                    msg = "ffmpeg no pudo arrancar en este teléfono" + (why == null ? "" : ": " + why) + " (" + msg + ")";
                }
                call.reject(msg);
            }
        });
    }

    /** Respaldo: el MP3 más reciente creado en la carpeta de música desde que empezó la conversión. */
    private String newestMp3Since(long startedAt) {
        File[] files = musicDir().listFiles((d, n) -> n.toLowerCase().endsWith(".mp3"));
        File best = null;
        if (files != null) for (File f : files) {
            if (f.lastModified() >= startedAt - 2000 && (best == null || f.lastModified() > best.lastModified())) best = f;
        }
        return best == null ? null : best.getAbsolutePath();
    }

    /** Ejecuta ffmpeg como lo hace yt-dlp y devuelve el error (p. ej. del enlazador), o null si arranca bien. */
    private String ffmpegDiagnosis() {
        try {
            Context ctx = getContext().getApplicationContext();
            File ffmpeg = new File(ctx.getApplicationInfo().nativeLibraryDir, "libffmpeg.so");
            if (!ffmpeg.exists()) return "falta " + ffmpeg.getName() + " en la APK";
            File pkgs = new File(ctx.getNoBackupFilesDir(), "youtubedl-android/packages");
            ProcessBuilder pb = new ProcessBuilder(ffmpeg.getAbsolutePath(), "-version").redirectErrorStream(true);
            pb.environment().put("LD_LIBRARY_PATH",
                    new File(pkgs, "python/usr/lib").getAbsolutePath() + ":" + new File(pkgs, "ffmpeg/usr/lib").getAbsolutePath());
            Process p = pb.start();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (InputStream in = p.getInputStream()) {
                byte[] buf = new byte[4096];
                for (int n; (n = in.read(buf)) > 0 && out.size() < 4000; ) out.write(buf, 0, n);
            }
            int code = p.waitFor();
            String text = out.toString("UTF-8").trim();
            Log.i(TAG, "ffmpeg -version → " + code + ": " + text);
            if (code == 0) return null;
            String first = text.isEmpty() ? "código " + code : text.split("\n")[0];
            return first.length() > 300 ? first.substring(0, 300) : first;
        } catch (Exception e) {
            Log.e(TAG, "ffmpegDiagnosis", e);
            return e.toString();
        }
    }

    // ---------- Streaming ----------

    // Sin límite propio: la interfaz ya prepara como mucho 2 canciones a la vez y la que se va a escuchar
    // no debe esperar detrás de ellas.
    private final ExecutorService streamExec = Executors.newCachedThreadPool();
    private static final String TAG = "Sonora";

    private static boolean isHttp(String url) {
        return url != null && (url.startsWith("http://") || url.startsWith("https://"));
    }

    /**
     * Obtiene el enlace directo del mejor audio (formato original, sin recodificar) y sus metadatos.
     * Solo formatos HTTP directos: las listas HLS no se pueden reproducir en el reproductor de la app.
     */
    @PluginMethod
    public void resolveStream(PluginCall call) {
        String url = call.getString("url");
        if (!isHttp(url)) {
            call.reject("Introduce una URL válida (http/https)");
            return;
        }
        streamExec.submit(() -> {
            try {
                call.resolve(resolveInfo(url));
            } catch (Throwable e) {
                Log.w(TAG, "resolveStream " + url, e);
                call.reject(cleanError(e));
            }
        });
    }

    /** resolveStream + calentar el enlace: el resultado suena al instante (warm: true). */
    @PluginMethod
    public void prepareStream(PluginCall call) {
        String url = call.getString("url");
        if (!isHttp(url)) {
            call.reject("Introduce una URL válida (http/https)");
            return;
        }
        streamExec.submit(() -> {
            try {
                JSObject ret = resolveInfo(url);
                String problem = warm(ret.getString("url"), ret.getJSObject("headers"));
                if (problem != null) throw new Exception("La fuente del audio no respondió (" + problem + ")");
                ret.put("warm", true);
                call.resolve(ret);
            } catch (Throwable e) {
                Log.w(TAG, "prepareStream " + url, e);
                call.reject(cleanError(e));
            }
        });
    }

    /** Vuelve a calentar un enlace ya obtenido (tras un error de reproducción), sin pedir uno nuevo. */
    @PluginMethod
    public void warmStream(PluginCall call) {
        String direct = call.getString("url");
        JSObject headers = call.getObject("headers", new JSObject());
        if (!isHttp(direct)) {
            call.reject("Enlace no válido");
            return;
        }
        streamExec.submit(() -> {
            String problem = warm(direct, headers);
            JSObject ret = new JSObject();
            ret.put("warm", problem == null);
            if (problem != null) ret.put("error", "La fuente del audio no respondió (" + problem + ")");
            call.resolve(ret);
        });
    }

    /**
     * YouTube responde 403 a las primeras peticiones de un enlace recién emitido y lo acepta segundos después.
     * Se pide el primer byte (con las cabeceras de yt-dlp) hasta recibir 2xx. Devuelve el problema o null.
     */
    private static String warm(String direct, JSObject headers) {
        String problem = "";
        for (int retry = 0; retry < 8; retry++) {
            HttpURLConnection con = null;
            try {
                con = (HttpURLConnection) new URL(direct).openConnection();
                con.setConnectTimeout(10000);
                con.setReadTimeout(15000);
                if (headers != null) {
                    for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                        String k = it.next();
                        con.setRequestProperty(k, headers.getString(k));
                    }
                }
                con.setRequestProperty("Range", "bytes=0-0");
                int code = con.getResponseCode();
                if (code >= 200 && code < 400) {
                    try (InputStream in = con.getInputStream()) { in.read(); }
                    return null;
                }
                problem = "HTTP " + code;
            } catch (Exception e) {
                problem = "conexión: " + e.getClass().getSimpleName();
            } finally {
                if (con != null) con.disconnect();
            }
            Log.i(TAG, "Calentando enlace: intento " + (retry + 1) + " sin respuesta (" + problem + ")");
            try {
                Thread.sleep(Math.min(1500, 500 + 150L * retry));
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return problem;
            }
        }
        return problem;
    }

    private JSObject resolveInfo(String url) throws Exception {
        ensureEngine();
        YoutubeDLRequest req = new YoutubeDLRequest(url);
        req.addOption("--no-playlist");
        req.addOption("--no-warnings");
        req.addOption("-f", "bestaudio[protocol^=http]/best[protocol^=http]");
        req.addOption("--dump-single-json");
        YoutubeDLResponse resp;
        engineRw.readLock().lock();
        try {
            resp = YoutubeDL.getInstance().execute(req);
        } finally {
            engineRw.readLock().unlock();
        }
        JSONObject info = new JSONObject(resp.getOut());
        String direct = info.optString("url", "");
        if (direct.isEmpty()) throw new Exception("Ese enlace no tiene un audio que se pueda escuchar directamente");

        long expires = System.currentTimeMillis() / 1000 + 1800;
        for (String part : direct.substring(direct.indexOf('?') + 1).split("&")) {
            if (part.startsWith("expire=")) {
                try { expires = Long.parseLong(part.substring(7)); } catch (NumberFormatException ignored) { }
            }
        }
        String artist = firstNonEmpty(info.optString("artist"), info.optString("uploader"), info.optString("channel"));
        String codec = info.optString("acodec", "").split("\\.")[0];
        double abr = info.optDouble("abr", 0);
        String quality = (codec.isEmpty() || codec.equals("none") ? "" : codec)
                + (abr > 0 ? " " + Math.round(abr) + " kbps" : "");

        JSObject ret = new JSObject();
        ret.put("url", direct);
        ret.put("expires", expires);
        ret.put("title", firstNonEmpty(info.optString("track"), info.optString("title"), url));
        ret.put("artist", artist);
        ret.put("album", info.optString("album", ""));
        ret.put("duration", info.optDouble("duration", 0));
        ret.put("thumbnail", info.optString("thumbnail", null));
        ret.put("quality", quality.trim());
        // Cabeceras con las que yt-dlp pide el audio: se usan al calentar el enlace.
        JSObject headers = new JSObject();
        JSONObject h = info.optJSONObject("http_headers");
        if (h != null) {
            for (Iterator<String> it = h.keys(); it.hasNext(); ) {
                String k = it.next();
                headers.put(k, h.optString(k));
            }
        }
        ret.put("headers", headers);
        return ret;
    }

    private static String firstNonEmpty(String... values) {
        for (String v : values) if (v != null && !v.isEmpty() && !v.equals("null")) return v;
        return "";
    }

    // ---------- Biblioteca ----------

    private JSObject readTrack(File f) {
        String key = f.getName();
        Object[] cached = metaCache.get(key);
        if (cached != null && (Long) cached[0] == f.lastModified()) return (JSObject) cached[1];

        JSObject t = new JSObject();
        t.put("file", f.getName());
        t.put("path", f.getAbsolutePath());
        t.put("addedAt", f.lastModified() / 1000.0);
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            mmr.setDataSource(f.getAbsolutePath());
            t.put("title", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE));
            t.put("artist", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST));
            t.put("album", mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM));
            String dur = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            t.put("duration", dur == null ? 0 : Long.parseLong(dur) / 1000.0);
            byte[] pic = mmr.getEmbeddedPicture();
            if (pic != null) {
                File cover = new File(coversDir(), sha1(f.getName() + f.lastModified()) + ".jpg");
                if (!cover.exists()) {
                    try (OutputStream out = new FileOutputStream(cover)) { out.write(pic); }
                }
                t.put("coverPath", cover.getAbsolutePath());
            }
        } catch (Exception ignored) {
            // Archivo dañado o sin etiquetas: se muestra con el nombre del archivo.
        } finally {
            try { mmr.release(); } catch (Exception ignored) { }
        }
        metaCache.put(key, new Object[]{f.lastModified(), t});
        return t;
    }

    @PluginMethod
    public void listTracks(PluginCall call) {
        ioExec.submit(() -> {
            JSArray arr = new JSArray();
            File[] files = musicDir().listFiles((d, n) -> n.toLowerCase().endsWith(".mp3"));
            if (files != null) for (File f : files) arr.put(readTrack(f));
            JSObject ret = new JSObject();
            ret.put("tracks", arr);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void deleteTrack(PluginCall call) {
        String name = safeName(call.getString("file"));
        File f = name == null ? null : new File(musicDir(), name);
        if (f == null || !f.exists()) { call.reject("Canción no encontrada"); return; }
        if (!f.delete()) { call.reject("No se pudo borrar el archivo"); return; }
        metaCache.remove(name);
        call.resolve();
    }

    // ---------- Datos de la app (playlists) ----------

    private File dataFile(String name) {
        if (name == null || !name.matches("[a-z]+")) return null;
        return new File(getContext().getFilesDir(), name + ".json");
    }

    @PluginMethod
    public void readData(PluginCall call) {
        File f = dataFile(call.getString("name"));
        if (f == null) { call.reject("Nombre no válido"); return; }
        JSObject ret = new JSObject();
        try {
            ret.put("data", f.exists() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8) : null);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("No se pudieron leer los datos");
        }
    }

    @PluginMethod
    public void writeData(PluginCall call) {
        File f = dataFile(call.getString("name"));
        String data = call.getString("data", "");
        if (f == null) { call.reject("Nombre no válido"); return; }
        File tmp = new File(f.getPath() + ".tmp");
        try {
            Files.write(tmp.toPath(), data.getBytes(StandardCharsets.UTF_8));
            if (!tmp.renameTo(f)) throw new Exception();
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudieron guardar los datos");
        }
    }

    // ---------- Reproducción en segundo plano ----------

    // ---------- Compartir y recibir links de playlist ----------

    private String pendingText;

    @PluginMethod
    public void shareText(PluginCall call) {
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, call.getString("text", ""))
                .putExtra(Intent.EXTRA_SUBJECT, call.getString("title", "Sonora"));
        Intent chooser = Intent.createChooser(send, "Compartir playlist");
        if (getActivity() == null) { call.reject("La app no está visible"); return; }
        getActivity().startActivity(chooser);
        call.resolve();
    }

    /** Texto recibido al abrir la app con un link (para cuando la interfaz aún no estaba cargada). */
    @PluginMethod
    public void takeIncomingText(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("text", pendingText);
        pendingText = null;
        call.resolve(ret);
    }

    private static String textFromIntent(Intent intent) {
        if (intent == null) return null;
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null
                && "sonora".equals(intent.getData().getScheme())) {
            return intent.getData().toString();
        }
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            String t = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (t != null && t.contains("sonora://")) return t;
        }
        return null;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String text = textFromIntent(intent);
        if (text == null) return;
        JSObject ev = new JSObject();
        ev.put("text", text);
        notifyListeners("incomingText", ev);
    }

    @Override
    public void load() {
        // La app se abrió desde un link: se guarda hasta que la interfaz lo pida.
        if (getActivity() != null) {
            pendingText = textFromIntent(getActivity().getIntent());
            if (pendingText != null) getActivity().setIntent(new Intent());
        }
        // Controles de la notificación, pantalla de bloqueo, auriculares y Bluetooth → interfaz web.
        PlaybackService.listener = (action, positionMs) -> {
            JSObject ev = new JSObject();
            String a = action.substring(action.lastIndexOf('.') + 1).toLowerCase();
            ev.put("action", a);
            if (positionMs >= 0) ev.put("position", positionMs / 1000.0);
            notifyListeners("mediaAction", ev);
        };
    }

    /** Estado del reproductor: mantiene la notificación, los controles y la app activa con la pantalla apagada. */
    @PluginMethod
    public void setPlayback(PluginCall call) {
        boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        Context ctx = getContext();
        if (playing && Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && getActivity() != null) {
            ActivityCompat.requestPermissions(getActivity(), new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7001);
        }
        PlaybackService.State st = new PlaybackService.State();
        st.playing = playing;
        st.title = call.getString("title", "Sonora");
        st.artist = call.getString("artist", "");
        st.art = call.getString("art", null);
        Double pos = call.getDouble("position", 0.0);
        Double dur = call.getDouble("duration", 0.0);
        st.positionMs = pos == null || pos.isNaN() ? 0 : (long) (pos * 1000);
        st.durationMs = dur == null || dur.isNaN() || dur.isInfinite() ? 0 : (long) (dur * 1000);
        try {
            PlaybackService.update(ctx, st);
        } catch (Exception ignored) {
            // Android puede negar iniciar el servicio con la app en segundo plano; se reintenta en el siguiente «play».
        }
        call.resolve();
    }

    @PluginMethod
    public void stopPlayback(PluginCall call) {
        PlaybackService.stop(getContext());
        call.resolve();
    }

    private static String sha1(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 10; i++) sb.append(String.format("%02x", d[i]));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }
}
