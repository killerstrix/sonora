package app.sonora.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Servicio de reproducción en primer plano. El audio lo produce la interfaz web; este servicio:
 *  - mantiene la app viva y el procesador y la wifi despiertos mientras suena (pantalla apagada, otra app abierta);
 *  - muestra la notificación y los controles de la pantalla de bloqueo, auriculares y Bluetooth (MediaSession);
 *  - pausa al desconectar los auriculares (las llamadas y otras apps de audio las gestiona el WebView).
 * Las órdenes del usuario (play, pausa, siguiente…) se envían a la interfaz con {@link ActionListener}.
 */
public class PlaybackService extends Service {

    public interface ActionListener { void onAction(String action, long positionMs); }

    public static final String ACTION_PLAY = "app.sonora.player.PLAY";
    public static final String ACTION_PAUSE = "app.sonora.player.PAUSE";
    public static final String ACTION_NEXT = "app.sonora.player.NEXT";
    public static final String ACTION_PREV = "app.sonora.player.PREV";
    public static final String ACTION_STOP = "app.sonora.player.STOP";

    private static final String CHANNEL = "playback";
    private static final int NOTIFICATION_ID = 1;
    private static final long PAUSED_TIMEOUT_MS = 15 * 60 * 1000; // en pausa tanto tiempo, se cierra la notificación

    static volatile PlaybackService instance;
    static volatile ActionListener listener;
    /** Último estado conocido, para arrancar el servicio con él. */
    static volatile State pending;

    public static class State {
        boolean playing;
        String title = "Sonora", artist = "", art;
        long positionMs, durationMs;
    }

    private MediaSessionCompat session;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService artLoader = Executors.newSingleThreadExecutor();
    private State state = new State();
    private String artKey;
    private Bitmap artBitmap;

    private final Runnable stopWhenIdle = this::stopSelf;

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            // Auriculares desconectados: pausa para que no suene por el altavoz.
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) send(ACTION_PAUSE, -1);
        }
    };

    // El foco de audio lo pide y lo gestiona el propio reproductor del WebView (pausa con llamadas o si
    // suena otra app de música). Pedirlo también aquí hacía que se lo quitaran uno al otro: el WebView lo
    // tomaba al empezar a sonar, el servicio lo perdía y mandaba pausa (sonaba menos de 1 s y se paraba).

    // ---------- API para el plugin ----------

    /** Aplica el estado: si el servicio ya corre lo actualiza (permitido en segundo plano); si no, lo inicia. */
    public static void update(Context ctx, State s) {
        pending = s;
        PlaybackService svc = instance;
        if (svc != null) {
            svc.apply(s);
        } else if (s.playing) {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, PlaybackService.class));
        }
    }

    public static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, PlaybackService.class));
    }

    private static void send(String action, long positionMs) {
        ActionListener l = listener;
        if (l != null) l.onAction(action, positionMs);
    }

    // ---------- Ciclo de vida ----------

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sonora:playback");
        wakeLock.setReferenceCounted(false);
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "sonora:streaming");
        wifiLock.setReferenceCounted(false);

        session = new MediaSessionCompat(this, "Sonora");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { send(ACTION_PLAY, -1); }
            @Override public void onPause() { send(ACTION_PAUSE, -1); }
            @Override public void onSkipToNext() { send(ACTION_NEXT, -1); }
            @Override public void onSkipToPrevious() { send(ACTION_PREV, -1); }
            @Override public void onSeekTo(long pos) { send("seek", pos); }
            @Override public void onStop() { send(ACTION_PAUSE, -1); stopSelf(); }
        });
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        session.setSessionActivity(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        session.setActive(true);

        ContextCompat.registerReceiver(this, noisyReceiver, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                ContextCompat.RECEIVER_NOT_EXPORTED);

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Reproducción", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action != null) {
            // Botones de la notificación.
            if (ACTION_STOP.equals(action)) { send(ACTION_PAUSE, -1); stopSelf(); return START_NOT_STICKY; }
            send(action, -1);
        }
        State s = pending != null ? pending : state;
        state = s;
        startInForeground(buildNotification());
        apply(s);
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Si se cierra la app desde «recientes», la interfaz (y su audio) desaparece: se cierra todo.
        stopSelf();
    }

    @Override
    public void onDestroy() {
        instance = null;
        handler.removeCallbacksAndMessages(null);
        try { unregisterReceiver(noisyReceiver); } catch (Exception ignored) { }
        releaseLocks();
        session.setActive(false);
        session.release();
        artLoader.shutdownNow();
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ---------- Estado ----------

    private void apply(State s) {
        state = s;
        handler.removeCallbacks(stopWhenIdle);
        if (s.playing) {
            if (!wakeLock.isHeld()) wakeLock.acquire();
            if (!wifiLock.isHeld()) wifiLock.acquire();
        } else {
            releaseLocks();
            handler.postDelayed(stopWhenIdle, PAUSED_TIMEOUT_MS);
        }

        MediaMetadataCompat.Builder meta = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, s.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, s.artist)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, s.durationMs);
        String key = s.art == null ? "" : s.art;
        if (!key.equals(artKey)) { artKey = key; artBitmap = null; loadArt(key); }
        if (artBitmap != null) meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artBitmap);
        session.setMetadata(meta.build());

        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                        | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                        | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS | PlaybackStateCompat.ACTION_SEEK_TO
                        | PlaybackStateCompat.ACTION_STOP)
                .setState(s.playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                        s.positionMs, s.playing ? 1f : 0f)
                .build());

        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(NOTIFICATION_ID, buildNotification());
    }

    private void loadArt(String art) {
        if (art.isEmpty()) return;
        artLoader.submit(() -> {
            Bitmap bmp = null;
            try {
                if (art.startsWith("http")) {
                    HttpURLConnection c = (HttpURLConnection) new URL(art).openConnection();
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(8000);
                    try (InputStream in = c.getInputStream()) { bmp = BitmapFactory.decodeStream(in); }
                } else {
                    bmp = BitmapFactory.decodeFile(art);
                }
            } catch (Exception ignored) { }
            if (bmp == null) return;
            Bitmap result = Bitmap.createScaledBitmap(bmp, 512, 512 * bmp.getHeight() / Math.max(1, bmp.getWidth()), true);
            handler.post(() -> {
                if (!art.equals(artKey) || instance == null) return;
                artBitmap = result;
                apply(state);
            });
        });
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_sonora)
                .setContentTitle(state.title)
                .setContentText(state.artist == null || state.artist.isEmpty() ? "Sonora" : state.artist)
                .setLargeIcon(artBitmap)
                .setContentIntent(content)
                .setDeleteIntent(actionIntent(ACTION_STOP, 5))
                .setOngoing(state.playing)
                .setSilent(true)
                .setShowWhen(false)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .addAction(R.drawable.ic_media_prev, "Anterior", actionIntent(ACTION_PREV, 1))
                .addAction(state.playing ? R.drawable.ic_media_pause : R.drawable.ic_media_play,
                        state.playing ? "Pausa" : "Reproducir", actionIntent(state.playing ? ACTION_PAUSE : ACTION_PLAY, 2))
                .addAction(R.drawable.ic_media_next, "Siguiente", actionIntent(ACTION_NEXT, 3))
                .addAction(R.drawable.ic_media_close, "Cerrar", actionIntent(ACTION_STOP, 4))
                .setStyle(new MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private PendingIntent actionIntent(String action, int requestCode) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        return PendingIntent.getService(this, requestCode, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void startInForeground(Notification n) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    // ---------- Recursos ----------

    private void releaseLocks() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
    }
}
