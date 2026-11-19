'use strict';

/* ================= Utilidades ================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtTotal(sec) {
  const h = Math.floor(sec / 3600), m = Math.round(sec % 3600 / 60);
  if (!h && !m) return sec > 0 ? '< 1 min' : '0 min';
  return h ? `${h} h ${m} min` : `${m} min`;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('sonora.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sonora.' + k, JSON.stringify(v)); } catch {} },
};

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

const ICON = {
  note: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  play: '<svg viewBox="0 0 24 24" class="fill"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" class="fill"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  more: '<svg viewBox="0 0 24 24" class="fill"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M3 6h13M3 12h13M3 18h8M18 14v7M21 17.5h-6"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M4 6h10M4 12h10M4 18h6M17 10l4 4-4 4"/></svg>',
  queue: '<svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h12"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  grip: '<svg viewBox="0 0 24 24" class="fill"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z"/></svg>',
  spin: '<svg viewBox="0 0 24 24" class="spin"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  share: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>',
};

/* ================= API ================= */

// En la APK, native.js define window.SonoraNative y atiende las mismas rutas con datos del teléfono.
const NATIVE = window.SonoraNative || null;

async function api(path, opts = {}) {
  if (NATIVE) return NATIVE.api(path, opts);
  const res = await fetch('/api' + path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/* ================= Estado ================= */

const state = {
  tracks: [],
  byId: new Map(),
  playlists: [],
  jobs: [],
};

// Canciones de «Reproducir ahora»: no están en la biblioteca, pero pueden estar en la cola.
const tempTracks = new Map(store.get('temp', []).map(t => [t.id, t]));
function rememberTemp(t) {
  tempTracks.delete(t.id); // al final = la más reciente
  tempTracks.set(t.id, { ...t, playedAt: Date.now() });
  saveTemps();
  state.byId.set(t.id, tempTracks.get(t.id));
}
function forgetTemp(id) {
  tempTracks.delete(id);
  saveTemps();
}
function saveTemps() {
  const keep = [...tempTracks.values()].slice(-50);
  store.set('temp', keep);
}
let refreshRecent = () => {}; // la vista Añadir la reemplaza para refrescar «Escuchadas sin guardar»
const inLibrary = id => state.tracks.some(t => t.id === id);
const isTemp = id => tempTracks.has(id) && !inLibrary(id);
// Escuchadas con «Reproducir ahora» que aún no están en la biblioteca, de la más reciente a la más antigua.
const recentTemps = () => [...tempTracks.values()].filter(t => !inLibrary(t.id) && !inLibrary('o' + t.id.slice(1))).reverse();

// Para meter una escuchada en una playlist, primero se guarda como canción en línea (☁, sin descargar).
// Los ids temporales y en línea comparten el mismo hash de la URL: «t…» y «o…».
async function ensureLibraryIds(ids) {
  const swaps = [];
  const out = [];
  for (const id of ids) {
    if (!isTemp(id)) { out.push(id); continue; }
    let newId = 'o' + id.slice(1);
    if (!inLibrary(newId)) newId = (await api('/online', { method: 'POST', body: { url: tempTracks.get(id).url } })).id;
    swaps.push([id, newId]);
    out.push(newId);
  }
  if (swaps.length) {
    swaps.forEach(([oldId]) => forgetTemp(oldId));
    await loadLibrary();
    swaps.forEach(([oldId, newId]) => player.replaceId(oldId, newId));
    renderQueue();
    refreshRecent();
  }
  return out;
}

async function loadLibrary() {
  try {
    const [tracks, playlists] = await Promise.all([api('/tracks'), api('/playlists')]);
    state.tracks = tracks;
    state.byId = new Map([...tempTracks, ...tracks.map(t => [t.id, t])]);
    state.playlists = playlists;
  } catch (e) {
    toast('No se pudo cargar la biblioteca');
  }
  renderSidebarPlaylists();
}

// Las carátulas pueden venir de un link de playlist ajeno: solo se aceptan URL sin comillas, paréntesis,
// espacios ni < >, porque se insertan dentro de style="background-image:url('…')".
const safeUrl = u => typeof u === 'string' && !/["'()\\\s<>]/.test(u) ? u : null;
const coverUrl = t => t && t.hasCover ? safeUrl(t.coverSrc || `/api/tracks/${encodeURIComponent(t.id)}/cover`) : null;
// Si el motor web no reproduce AAC (Qt WebEngine de PyPI, en macOS), el servidor elige otro códec para el streaming.
const NO_AAC = !document.createElement('audio').canPlayType('audio/mp4; codecs="mp4a.40.2"');
const audioUrl = t => t.audioSrc ? t.audioSrc + (t.online && NO_AAC && t.audioSrc.startsWith('/api/stream') ? '&noaac=1' : '')
                                 : `/api/tracks/${t.id}/audio`;
const coverStyle = t => coverUrl(t) ? `style="background-image:url('${esc(coverUrl(t))}')"` : '';
const coverInner = t => coverUrl(t) ? '' : ICON.note;
// ☁ en línea (streaming) · ⤓ descargada (MP3 en el dispositivo, suena sin conexión).
const cloudBadge = t => !t ? '' : t.online
  ? `<span class="cloud" title="En línea: se escucha por streaming">${ICON.cloud}</span>${prepBadge(t)}`
  : `<span class="saved" title="Descargada: se escucha sin conexión">${ICON.download}</span>`;

/* ================= Preparar canciones en línea ================= */
// El servidor (o el teléfono) obtiene y «calienta» el enlace de cada canción ☁ por adelantado,
// de 2 en 2, para que al pulsar Reproducir suene al instante. Cada fila muestra en qué punto está.

const prep = { states: {}, pending: 0, timer: null };

function prepView(st) {
  if (!st) return { cls: '', title: '', inner: '' };
  return {
    queued: { cls: 'queued', title: 'En cola para preparar', inner: '' },
    preparing: { cls: 'preparing', title: 'Preparando…', inner: ICON.spin },
    ready: { cls: 'ready', title: 'Lista: suena al instante', inner: ICON.check },
    error: { cls: 'error', title: `No se pudo preparar: ${st.error || 'error desconocido'}. Al reproducirla se reintenta.`, inner: ICON.alert },
  }[st.state] || { cls: '', title: '', inner: '' };
}

function prepBadge(t) {
  if (!t.url) return '';
  const v = prepView(prep.states[t.url]);
  return `<span class="prep ${v.cls}" data-prep="${esc(t.id)}" title="${esc(v.title)}">${v.inner}</span>`;
}

// Actualiza solo los indicadores visibles, sin volver a pintar la vista (no se pierde el scroll ni el arrastre).
function paintPrep() {
  for (const el of $$('.prep[data-prep]')) {
    const v = prepView(prep.states[state.byId.get(el.dataset.prep)?.url]);
    if (el.className === `prep ${v.cls}`) continue;
    el.className = `prep ${v.cls}`;
    el.title = v.title;
    el.innerHTML = v.inner;
  }
  const sum = $('#plPrep');
  if (sum) {
    const online = (state.playlists.find(p => p.id === sum.dataset.pl)?.tracks || [])
      .map(id => state.byId.get(id)).filter(t => t?.online && t.url);
    const st = online.map(t => prep.states[t.url]?.state);
    const ready = st.filter(s => s === 'ready').length;
    const busy = st.some(s => s === 'queued' || s === 'preparing');
    sum.classList.toggle('done', !busy && online.length > 0 && ready === online.length);
    sum.textContent = busy ? `· Preparando ${ready} de ${online.length}…`
      : online.length && ready === online.length ? `· ${ready} listas ✓` : '';
  }
}

// En el celular no hay «pasar el ratón»: al tocar el ⚠ se muestra el motivo (sin activar la fila).
document.addEventListener('click', e => {
  const badge = e.target.closest('.prep.error');
  if (!badge) return;
  e.stopPropagation();
  e.preventDefault();
  toast(badge.title);
}, true);

async function refreshPrep() {
  clearTimeout(prep.timer);
  try {
    const r = await api('/stream/prepare' + (NO_AAC ? '?noaac=1' : ''));
    prep.states = r.states || {};
    prep.pending = r.pending || 0;
  } catch {
    prep.pending = 0;
  }
  paintPrep();
  if (prep.pending > 0) prep.timer = setTimeout(refreshPrep, 1500);
}

// Pide preparar las canciones ☁ en el orden dado (primero las que se escucharán antes). No bloquea la interfaz.
async function prepareTracks(tracks) {
  const urls = [...new Set(tracks.filter(t => t?.online && t.url).map(t => t.url))]
    .filter(u => !['queued', 'preparing'].includes(prep.states[u]?.state));
  if (!urls.length) return;
  try { await api('/stream/prepare', { method: 'POST', body: { urls, noaac: NO_AAC } }); } catch { return; }
  refreshPrep();
}

/* ================= Reproductor ================= */

const audio = $('#audio');

let loadToken = 0;
let failStreak = 0;

// Si una canción no se puede reproducir, se avisa y se pasa a la siguiente (sin entrar en bucle).
function trackFailed(msg, advance) {
  if (!advance) return; // al restaurar la sesión no hace falta avisar
  toast(msg);
  if (player.queue.length > 1 && ++failStreak < player.queue.length) player.next();
}

const player = {
  queue: store.get('queue', []),
  original: store.get('original', null), // orden previo al aleatorio
  index: store.get('index', -1),
  shuffle: store.get('shuffle', false),
  repeat: store.get('repeat', 'off'), // off | all | one

  get current() { return state.byId.get(this.queue[this.index]); },

  save() {
    store.set('queue', this.queue);
    store.set('original', this.original);
    store.set('index', this.index);
    store.set('shuffle', this.shuffle);
    store.set('repeat', this.repeat);
  },

  playList(ids, start = 0) {
    if (!ids.length) return;
    this.original = null;
    this.queue = ids.slice();
    this.index = start;
    if (this.shuffle) this.applyShuffle();
    this.load(true);
  },

  applyShuffle() {
    this.original = this.queue.slice();
    const cur = this.queue[this.index];
    const rest = this.queue.filter((_, i) => i !== this.index);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    this.queue = cur ? [cur, ...rest] : rest;
    this.index = cur ? 0 : -1;
  },

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.shuffle) {
      this.applyShuffle();
    } else if (this.original) {
      const cur = this.queue[this.index];
      // Conserva canciones añadidas a la cola durante el aleatorio.
      const extra = this.queue.filter(id => !this.original.includes(id));
      this.queue = [...this.original, ...extra];
      this.index = Math.max(0, this.queue.indexOf(cur));
      this.original = null;
    }
    this.save();
    updateModes();
    renderQueue();
    toast(this.shuffle ? 'Aleatorio activado' : 'Aleatorio desactivado');
  },

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.save();
    updateModes();
    toast({ off: 'Bucle desactivado', all: 'Repetir cola', one: 'Repetir canción' }[this.repeat]);
  },

  async load(autoplay, resumeAt = 0) {
    const t = this.current;
    if (!t) { this.stop(); return; }
    const token = ++loadToken;
    this.save();
    updateNowPlaying();
    renderQueue();
    markPlaying();
    if (t.online && !navigator.onLine) { trackFailed('Sin conexión: las canciones en línea necesitan internet', autoplay); return; }
    let src;
    try {
      if (t.online && NATIVE) $('#pArtist').textContent = 'Conectando…';
      src = t.online && NATIVE ? await NATIVE.streamSrc(t) : audioUrl(t);
    } catch (e) {
      if (token === loadToken) { updateNowPlaying(); trackFailed(e.message, autoplay); }
      return;
    }
    if (token !== loadToken) return; // el usuario ya cambió de canción
    updateNowPlaying();
    audio.dataset.retried = '';
    audio.src = src;
    if (resumeAt) audio.addEventListener('loadedmetadata', () => { audio.currentTime = resumeAt; }, { once: true });
    if (autoplay) audio.play().catch(() => {});
  },

  // «Reproducir ahora»: suena enseguida sin perder la cola actual.
  playNow(id) {
    if (!this.current) { this.playList([id]); return; }
    this.queue.splice(this.index + 1, 0, id);
    this.original?.push(id);
    this.index++;
    this.load(true);
  },

  // Al guardar sin conexión una canción en línea, su id cambia por el del MP3.
  replaceId(oldId, newId) {
    const swap = ids => ids.map(id => id === oldId ? newId : id);
    this.queue = swap(this.queue);
    if (this.original) this.original = swap(this.original);
    this.save();
  },

  stop() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    this.index = -1;
    this.save();
    updateNowPlaying();
    markPlaying();
  },

  toggle() {
    if (!this.current) {
      if (state.tracks.length) this.playList(state.tracks.map(t => t.id));
      return;
    }
    if (!audio.src) this.load(true);
    else if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  },

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
    if (this.index < this.queue.length - 1) this.index++;
    else if (this.repeat !== 'off' || !auto) this.index = 0;
    else { audio.pause(); audio.currentTime = 0; NATIVE?.setPlayback(false, this.current, 0, audio.duration); return; }
    this.load(true);
  },

  prev() {
    if (!this.queue.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    this.index = this.index > 0 ? this.index - 1 : (this.repeat === 'all' ? this.queue.length - 1 : 0);
    this.load(true);
  },

  jump(i) { this.index = i; this.load(true); },

  playNext(id) {
    if (!this.current) { this.playList([id]); return; }
    this.queue.splice(this.index + 1, 0, id);
    this.original?.push(id);
    this.save(); renderQueue();
    toast('Se reproducirá a continuación');
  },

  enqueue(ids) {
    if (!this.current) { this.playList(ids); return; }
    this.queue.push(...ids);
    this.original?.push(...ids);
    this.save(); renderQueue();
    toast(ids.length > 1 ? `${ids.length} canciones añadidas a la cola` : 'Añadida a la cola');
  },

  removeAt(i) {
    const [id] = this.queue.splice(i, 1);
    if (this.original) { const k = this.original.indexOf(id); if (k >= 0) this.original.splice(k, 1); }
    if (i < this.index) this.index--;
    else if (i === this.index) { this.index = Math.min(this.index, this.queue.length - 1); this.load(!audio.paused); return; }
    this.save(); renderQueue();
  },

  // Elimina de la cola pistas cuyo archivo ya no existe.
  prune() {
    const cur = this.queue[this.index];
    this.queue = this.queue.filter(id => state.byId.has(id));
    if (this.original) this.original = this.original.filter(id => state.byId.has(id));
    this.index = this.queue.indexOf(cur);
    if (this.index === -1 && cur) this.stop();
    this.save();
  },
};

function updateNowPlaying() {
  const t = player.current;
  const cover = $('#pCover');
  cover.style.backgroundImage = coverUrl(t) ? `url('${coverUrl(t)}')` : '';
  cover.innerHTML = coverInner(t);
  $('#pTitle').textContent = t ? t.title : 'Nada sonando';
  $('#pArtist').textContent = t ? (t.artist || 'Artista desconocido') + (t.online ? ` · streaming${t.quality ? ' ' + t.quality : ''}` : '') : 'Elige una canción';
  document.title = t ? `${t.title} · Sonora` : 'Sonora';
  if (!t) { $('#tCur').textContent = '0:00'; $('#tDur').textContent = '0:00'; setRange($('#seek'), 0); }
  else $('#tDur').textContent = fmtTime(t.duration);

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = t ? new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: coverUrl(t) ? [{ src: coverUrl(t), sizes: '512x512', type: 'image/jpeg' }] : [],
    }) : null;
  }
}

function updateModes() {
  $('#btnShuffle').classList.toggle('on', player.shuffle);
  const r = $('#btnRepeat');
  r.classList.toggle('on', player.repeat !== 'off');
  r.classList.toggle('one', player.repeat === 'one');
  r.title = { off: 'Bucle', all: 'Repetir cola', one: 'Repetir canción' }[player.repeat];
}

function setRange(el, frac) {
  el.style.setProperty('--p', (frac * 100).toFixed(2) + '%');
  if (el.id === 'seek') el.value = Math.round(frac * 1000);
}

function markPlaying() {
  const id = player.current?.id;
  $$('tr.t').forEach(tr => {
    const on = tr.dataset.id === id;
    tr.classList.toggle('playing', on);
    const b = $('.pbtn', tr);
    if (b) b.innerHTML = on && !audio.paused ? ICON.pause : ICON.play;
  });
}

function initPlayer() {
  let seeking = false;
  const seek = $('#seek');
  const vol = $('#volume');

  $('#btnPlay').onclick = () => player.toggle();
  $('#btnNext').onclick = () => player.next();
  $('#btnPrev').onclick = () => player.prev();
  $('#btnShuffle').onclick = () => player.toggleShuffle();
  $('#btnRepeat').onclick = () => player.cycleRepeat();

  // En el celular: estado para la notificación / pantalla de bloqueo, que mantiene la música con la pantalla apagada.
  const syncNative = () => NATIVE?.setPlayback(!audio.paused, player.current, audio.currentTime, audio.duration);
  audio.addEventListener('play', () => { $('#btnPlay').innerHTML = ICON.pause; markPlaying(); syncNative(); });
  audio.addEventListener('pause', () => {
    $('#btnPlay').innerHTML = ICON.play; markPlaying(); store.set('time', audio.currentTime);
    // Al terminar una canción se encadena la siguiente: no se suelta el servicio (con la pantalla apagada se dormiría).
    if (!audio.ended) syncNative();
  });
  audio.addEventListener('loadedmetadata', syncNative);
  audio.addEventListener('seeked', syncNative);
  NATIVE?.onMediaAction(({ action, position }) => {
    if (action === 'play') { if (audio.paused) player.toggle(); }
    else if (action === 'pause') audio.pause();
    else if (action === 'next') player.next();
    else if (action === 'prev') player.prev();
    else if (action === 'seek' && isFinite(position)) audio.currentTime = position;
  });
  audio.addEventListener('ended', () => player.next(true));
  audio.addEventListener('playing', () => {
    failStreak = 0;
    // La que suena ya quedó lista; se prepara la siguiente de la cola para que no haya pausa al cambiar.
    const cur = player.current, nxt = state.byId.get(player.queue[player.index + 1]);
    if (nxt?.online) prepareTracks([nxt]);
    else if (cur?.online) refreshPrep();
  });
  audio.addEventListener('error', async () => {
    if (!audio.getAttribute('src')) return;
    const t = player.current;
    // Streaming: un fallo puntual no salta la canción; se reintenta una vez desde el mismo punto con un enlace nuevo.
    if (t?.online && navigator.onLine && !audio.dataset.retried) {
      audio.dataset.retried = '1';
      try {
        const at = audio.currentTime;
        const src = NATIVE ? await NATIVE.streamSrc(t, { fresh: true })
                           : audioUrl(t) + '&retry=' + Date.now();
        if (player.current === t) {
          audio.src = src;
          if (at) audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; }, { once: true });
          audio.play().catch(() => {});
        }
        return;
      } catch {}
    }
    trackFailed(t?.online ? (navigator.onLine ? 'No se pudo reproducir en streaming' : 'Sin conexión: las canciones en línea necesitan internet')
                          : 'No se pudo reproducir el archivo', true);
  });
  audio.addEventListener('loadedmetadata', () => { $('#tDur').textContent = fmtTime(audio.duration); });
  audio.addEventListener('timeupdate', () => {
    if (seeking || !audio.duration) return;
    $('#tCur').textContent = fmtTime(audio.currentTime);
    setRange(seek, audio.currentTime / audio.duration);
  });
  setInterval(() => { if (!audio.paused) store.set('time', audio.currentTime); }, 5000);

  seek.addEventListener('input', () => {
    seeking = true;
    const f = seek.value / 1000;
    setRange(seek, f);
    $('#tCur').textContent = fmtTime(f * (audio.duration || 0));
  });
  seek.addEventListener('change', () => {
    if (audio.duration) audio.currentTime = seek.value / 1000 * audio.duration;
    seeking = false;
  });

  const setVol = v => {
    audio.volume = v; vol.value = v; setRange(vol, v);
    store.set('volume', v);
    $('#volIcon').innerHTML = v === 0 || audio.muted
      ? '<path d="M11 5 6 9H3v6h3l5 4z" class="fill"/><path d="M22 9l-6 6M16 9l6 6"/>'
      : '<path d="M11 5 6 9H3v6h3l5 4z" class="fill"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>' + (v > .5 ? '<path d="M18.5 5.5a9 9 0 0 1 0 13"/>' : '');
  };
  vol.addEventListener('input', () => { audio.muted = false; setVol(+vol.value); });
  let lastVol = store.get('volume', 1);
  $('#btnMute').onclick = () => {
    if (audio.volume > 0) { lastVol = audio.volume; setVol(0); }
    else setVol(lastVol || 1);
  };
  setVol(store.get('volume', 1));

  $('#btnQueue').onclick = () => { $('#queuePanel').hidden = !$('#queuePanel').hidden; renderQueue(); };
  $('#queueClose').onclick = () => { $('#queuePanel').hidden = true; };

  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, [contenteditable="true"]')) return;
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    else if (e.code === 'ArrowRight' && e.shiftKey) player.next();
    else if (e.code === 'ArrowLeft' && e.shiftKey) player.prev();
    else if (e.code === 'ArrowRight' && audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    else if (e.code === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  });

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => audio.play());
    ms.setActionHandler('pause', () => audio.pause());
    ms.setActionHandler('previoustrack', () => player.prev());
    ms.setActionHandler('nexttrack', () => player.next());
    ms.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; });
  }

  updateModes();
}

function renderQueue() {
  if ($('#queuePanel').hidden) return;
  const list = $('#queueList');
  if (!player.queue.length) { list.innerHTML = '<li class="sep">La cola está vacía</li>'; return; }
  const item = (id, i) => {
    const t = state.byId.get(id);
    if (!t) return '';
    const cls = i === player.index ? 'current' : (i < player.index ? 'past' : '');
    return `<li class="${cls}" data-i="${i}">
      <div class="titlecell"><div class="cover" ${coverStyle(t)}>${coverInner(t)}</div>
      <div><div class="tt">${cloudBadge(t)}${esc(t.title)}</div><div class="ta">${esc(t.artist)}</div></div></div>
      <button class="icon-btn" data-rm="${i}" title="Quitar de la cola">${ICON.x}</button></li>`;
  };
  const cur = player.index;
  list.innerHTML =
    (cur >= 0 ? '<li class="sep">Sonando</li>' + item(player.queue[cur], cur) : '') +
    (cur < player.queue.length - 1 ? '<li class="sep">A continuación</li>' + player.queue.slice(cur + 1).map((id, k) => item(id, cur + 1 + k)).join('') : '') +
    (cur > 0 ? '<li class="sep">Reproducidas</li>' + player.queue.slice(0, cur).map(item).join('') : '');
  list.onclick = e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { player.removeAt(+rm.dataset.rm); return; }
    const li = e.target.closest('li[data-i]');
    if (li) player.jump(+li.dataset.i);
  };
}

/* ================= Menú contextual ================= */

const menu = $('#menu');

function openMenu(anchor, items) {
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') { menu.appendChild(document.createElement('hr')); continue; }
    if (it.label && !it.action) { const d = document.createElement('div'); d.className = 'label'; d.textContent = it.label; menu.appendChild(d); continue; }
    const b = document.createElement('button');
    b.innerHTML = (it.icon || '') + `<span>${esc(it.text)}</span>`;
    if (it.danger) b.style.color = 'var(--danger)';
    b.onclick = e => { e.stopPropagation(); const keep = it.action(b); if (!keep) closeMenu(); };
    menu.appendChild(b);
  }
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
  menu.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
}
function closeMenu() { menu.hidden = true; }
document.addEventListener('click', e => { if (!menu.contains(e.target)) closeMenu(); });
window.addEventListener('resize', closeMenu);
$('#view').addEventListener('scroll', closeMenu);

function trackMenu(anchor, id, ctx = {}) {
  const temp = isTemp(id);
  const items = [
    { icon: ICON.next, text: 'Reproducir a continuación', action: () => player.playNext(id) },
    { icon: ICON.queue, text: 'Añadir a la cola', action: () => player.enqueue([id]) },
    ...(temp ? [
      { icon: ICON.cloud, text: 'Guardar en la biblioteca (sin descargar)', action: () => ensureLibraryIds([id]).then(() => toast('Guardada en tu biblioteca')).catch(e => toast(e.message)) },
      { icon: ICON.download, text: 'Descargar MP3', action: () => api('/downloads', { method: 'POST', body: { url: state.byId.get(id).url } }).then(() => { toast('Descargando en MP3…'); pollJobs(); }).catch(e => toast(e.message)) },
    ] : state.byId.get(id)?.online ? [{ icon: ICON.download, text: 'Guardar sin conexión (MP3)', action: () => saveOffline(id) }] : []),
    '-',
    { label: 'Añadir a playlist' },
    ...state.playlists.filter(p => p.id !== ctx.playlistId).map(p => ({
      icon: ICON.list, text: p.name, action: () => addToPlaylist(p.id, [id]),
    })),
    { icon: ICON.plus, text: 'Nueva playlist…', action: () => createPlaylist([id]) },
  ];
  if (ctx.playlistId) {
    items.push('-', { icon: ICON.x, text: 'Quitar de esta playlist', action: () => removeFromPlaylist(ctx.playlistId, id) });
  }
  if (temp) {
    items.push('-', { icon: ICON.x, text: 'Quitar de escuchadas', action: () => { forgetTemp(id); refreshRecent(); } });
    openMenu(anchor, items);
    return;
  }
  items.push('-', {
    icon: ICON.trash, text: state.byId.get(id)?.online ? 'Quitar de la biblioteca' : 'Eliminar archivo', danger: true,
    action: btn => {
      if (btn.dataset.confirm) { deleteTrack(id); return false; }
      btn.dataset.confirm = '1';
      btn.querySelector('span').textContent = '¿Seguro? Pulsa otra vez';
      return true;
    },
  });
  openMenu(anchor, items);
}

/* ================= Acciones de biblioteca ================= */

async function deleteTrack(id) {
  try {
    await api(`/tracks/${id}`, { method: 'DELETE' });
    await loadLibrary();
    player.prune();
    renderQueue();
    route();
    toast('Archivo eliminado');
  } catch (e) { toast(e.message); }
}

async function saveOffline(id) {
  try {
    await api(`/online/${id}/save`, { method: 'POST' });
    toast('Guardando sin conexión… (puedes ver el avance en Añadir URL)');
    pollJobs();
  } catch (e) { toast(e.message); }
}

async function createPlaylist(trackIds = []) {
  const n = state.playlists.length + 1;
  try {
    trackIds = await ensureLibraryIds(trackIds);
    const pl = await api('/playlists', { method: 'POST', body: { name: `Mi playlist n.º ${n}`, tracks: trackIds } });
    await loadLibrary();
    location.hash = `#/playlist/${pl.id}?edit=1`;
  } catch (e) { toast(e.message); }
}

async function patchPlaylist(id, body) {
  const pl = await api(`/playlists/${id}`, { method: 'PATCH', body });
  const i = state.playlists.findIndex(p => p.id === id);
  if (i >= 0) state.playlists[i] = pl;
  renderSidebarPlaylists();
  return pl;
}

async function addToPlaylist(plId, ids) {
  let pl = state.playlists.find(p => p.id === plId);
  if (!pl) return;
  try {
    ids = await ensureLibraryIds(ids);
    pl = state.playlists.find(p => p.id === plId);
    const fresh = ids.filter(id => !pl.tracks.includes(id));
    if (!fresh.length) { toast(`Ya está en «${pl.name}»`); return; }
    await patchPlaylist(plId, { tracks: [...pl.tracks, ...fresh] });
    toast(`Añadida a «${pl.name}»`);
    if (currentRoute().name === 'playlist') route();
  } catch (e) { toast(e.message); }
}

async function removeFromPlaylist(plId, id) {
  const pl = state.playlists.find(p => p.id === plId);
  try {
    await patchPlaylist(plId, { tracks: pl.tracks.filter(t => t !== id) });
    route();
  } catch (e) { toast(e.message); }
}

/* ================= Playlists compartidas por link ================= */
// El link lleva la playlist completa (nombre y enlace de origen de cada canción), comprimida.
// No pasa por ningún servidor ni cuenta: se pega o se abre en Sonora de otro dispositivo.

const SHARE_PREFIX = 'sonora://playlist/';

const ytId = url => (String(url).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)([\w-]{11})/) || [])[1];
const ytThumb = url => ytId(url) ? `https://i.ytimg.com/vi/${ytId(url)}/hqdefault.jpg` : null;
const sameSource = url => ytId(url) ? 'yt:' + ytId(url) : String(url).trim();

async function compress(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decompress(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

async function playlistLink(pl) {
  const tracks = pl.tracks.map(id => state.byId.get(id)).filter(Boolean);
  const shareable = tracks.filter(t => t.url);
  const data = {
    v: 1, i: pl.shareId || pl.id, n: pl.name,
    // [enlace, título, artista, duración, carátula] — la carátula de YouTube se deduce del enlace.
    t: shareable.map(t => [t.url, t.title, t.artist || '', Math.round(t.duration || 0),
                           t.online && !ytId(t.url) && /^https:/.test(t.coverSrc || '') ? t.coverSrc : '']),
  };
  return { link: SHARE_PREFIX + await compress(JSON.stringify(data)), count: shareable.length, skipped: tracks.length - shareable.length };
}

async function parsePlaylistLink(text) {
  const m = String(text).match(/sonora:\/\/playlist\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(await decompress(m[1])); } catch { data = null; }
  if (!data || data.v !== 1 || !Array.isArray(data.t) || typeof data.n !== 'string') {
    throw new Error('El link de playlist está incompleto o dañado. Cópialo entero e inténtalo de nuevo.');
  }
  return data;
}

// Las canciones que ya están en este dispositivo (descargadas o ☁) se reutilizan; el resto entra como ☁.
async function importPlaylist(data) {
  const known = new Map(state.tracks.filter(t => t.url).map(t => [sameSource(t.url), t.id]));
  const ids = [];
  const missing = [];
  data.t.forEach(([url, title, artist, duration, thumb], i) => {
    if (!/^https?:\/\//i.test(url || '')) return;
    const have = known.get(sameSource(url));
    if (have) ids[i] = have;
    else missing.push({ i, item: { url, title, artist, duration, thumbnail: safeUrl(thumb) || ytThumb(url) } });
  });
  if (missing.length) {
    const { ids: added } = await api('/online/bulk', { method: 'POST', body: { items: missing.map(m => m.item) } });
    missing.forEach((m, k) => { ids[m.i] = added[k]; });
  }
  await loadLibrary();
  const trackIds = ids.filter(Boolean);
  const existing = state.playlists.find(p => p.shareId === data.i || p.id === data.i);
  const pl = existing
    ? await patchPlaylist(existing.id, { name: data.n, tracks: trackIds })
    : await api('/playlists', { method: 'POST', body: { name: data.n, tracks: trackIds, shareId: data.i } });
  await loadLibrary();
  prepareTracks(trackIds.map(id => state.byId.get(id)));
  const local = trackIds.length - missing.length;
  toast(`«${pl.name}» ${existing ? 'actualizada' : 'importada'}: ${trackIds.length} canciones`
        + (missing.length ? ` (${local} ya estaban, ${missing.length} en streaming)` : ''));
  location.hash = `#/playlist/${pl.id}`;
  return pl;
}

// Acepta el link solo o dentro de un texto (p. ej. un mensaje de WhatsApp). Devuelve false si no hay link.
async function importFromText(text) {
  const data = await parsePlaylistLink(text);
  if (!data) return false;
  await importPlaylist(data);
  return true;
}

function showShareDialog(pl, link, skipped) {
  const box = document.createElement('div');
  box.className = 'modal';
  box.innerHTML = `<div class="modal-card">
    <h3>Compartir «${esc(pl.name)}»</h3>
    <p class="muted">Pega este link en Sonora de otro dispositivo (en <b>Añadir URL</b> o <b>Playlists → Importar</b>).
      Las canciones que no tenga se escucharán por streaming.</p>
    <textarea readonly rows="4">${esc(link)}</textarea>
    ${skipped ? `<p class="muted">${skipped} canción(es) no tienen enlace de origen (MP3 copiados a mano) y no se incluyeron.</p>` : ''}
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cerrar</button><button class="btn primary" data-copy>${ICON.check}Copiar link</button></div>
  </div>`;
  document.body.appendChild(box);
  const area = $('textarea', box);
  area.focus();
  area.select();
  box.onclick = async e => {
    if (e.target === box || e.target.closest('[data-close]')) { box.remove(); return; }
    if (e.target.closest('[data-copy]')) {
      try { await navigator.clipboard.writeText(link); } catch { area.select(); document.execCommand('copy'); }
      toast('Link copiado');
      box.remove();
    }
  };
}

async function sharePlaylist(pl) {
  const { link, count, skipped } = await playlistLink(pl);
  if (!count) { toast('Ninguna canción de esta playlist tiene enlace de origen para compartir'); return; }
  if (NATIVE) {
    await NATIVE.share(`🎵 «${pl.name}» (${count} canciones) en Sonora. Ábrelo o pégalo en Sonora:\n${link}`, pl.name);
    if (skipped) toast(`${skipped} canción(es) sin enlace de origen no se incluyeron`);
  } else {
    showShareDialog(pl, link, skipped);
  }
}

/* ================= Componentes ================= */

function trackTable(tracks, { playlistId = null, numbered = true, draggable = false } = {}) {
  if (!tracks.length) return '';
  const rows = tracks.map((t, i) => `
    <tr class="t" data-id="${t.id}" data-i="${i}" ${draggable ? 'draggable="true"' : ''}>
      <td class="num">${draggable ? `<span class="n drag">${ICON.grip}</span>` : `<span class="n">${numbered ? i + 1 : ''}</span>`}<button class="icon-btn pbtn" data-play="${i}">${ICON.play}</button></td>
      <td class="tc"><div class="titlecell"><div class="cover" ${coverStyle(t)}>${coverInner(t)}</div>
        <div><div class="tt">${cloudBadge(t)}${esc(t.title)}</div><div class="ta">${esc(t.artist || 'Artista desconocido')}</div></div></div></td>
      <td class="dur hide-sm">${fmtTime(t.duration)}</td>
      <td class="act"><button class="icon-btn" data-menu="${t.id}" title="Más opciones">${ICON.more}</button></td>
    </tr>`).join('');
  return `<table class="tracks" data-pl="${playlistId || ''}"><thead><tr><th>#</th><th>Título</th><th class="hide-sm" style="text-align:right">Duración</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

// Enlaza clics/doble clic/menú de una tabla de pistas. `ids` define la cola al reproducir.
function bindTrackTable(root, ids, ctx = {}) {
  const table = $('table.tracks', root);
  if (!table) return;
  table.addEventListener('click', e => {
    const m = e.target.closest('[data-menu]');
    if (m) { e.stopPropagation(); trackMenu(m, m.dataset.menu, ctx); return; }
    const p = e.target.closest('[data-play]');
    if (p) {
      const i = +p.dataset.play;
      if (player.current?.id === ids[i] && audio.src) player.toggle();
      else player.playList(ids, i);
    }
  });
  table.addEventListener('dblclick', e => {
    const tr = e.target.closest('tr.t');
    if (tr && !e.target.closest('button')) player.playList(ids, +tr.dataset.i);
  });
  markPlaying();
}

function playlistArt(pl, cls = 'art') {
  const covers = pl.tracks.map(id => state.byId.get(id)).filter(t => t?.hasCover).slice(0, 4);
  if (covers.length >= 4) return `<div class="${cls} mosaic">${covers.map(t => `<div ${coverStyle(t)}></div>`).join('')}</div>`;
  if (covers.length) return `<div class="${cls}" ${coverStyle(covers[0])}></div>`;
  return `<div class="${cls}">${ICON.list}</div>`;
}

function playlistCard(pl) {
  return `<div class="card" data-pl="${pl.id}">
    ${playlistArt(pl)}
    <div class="name">${esc(pl.name)}</div>
    <div class="info">${pl.tracks.length} canciones</div>
    ${pl.tracks.length ? `<button class="fab" data-plplay="${pl.id}" title="Reproducir">${ICON.play}</button>` : ''}
  </div>`;
}

function bindPlaylistCards(root) {
  root.addEventListener('click', e => {
    const play = e.target.closest('[data-plplay]');
    if (play) { e.stopPropagation(); const pl = state.playlists.find(p => p.id === play.dataset.plplay); player.playList(pl.tracks); return; }
    if (e.target.closest('[data-newpl]')) { createPlaylist(); return; }
    const card = e.target.closest('[data-pl]');
    if (card && card.classList.contains('card')) location.hash = `#/playlist/${card.dataset.pl}`;
  });
}

function renderSidebarPlaylists() {
  const cur = currentRoute();
  $('#sidebarPlaylists').innerHTML = state.playlists.map(p =>
    `<a href="#/playlist/${p.id}" class="${cur.name === 'playlist' && cur.id === p.id ? 'active' : ''}">${esc(p.name)}</a>`).join('');
}

/* ================= Vistas ================= */

const views = {};

views.home = el => {
  const h = new Date().getHours();
  const greet = h < 6 ? 'Buenas noches' : h < 13 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
  const total = state.tracks.reduce((s, t) => s + t.duration, 0);
  const onlineCount = state.tracks.filter(t => t.online).length;
  const recent = state.tracks.slice(0, 10);
  el.innerHTML = `
    <h1>${greet}</h1>
    <p class="sub">Tu música: descargada para escucharla sin conexión o en línea por streaming.</p>
    <div class="stats">
      <div class="stat"><b>${state.tracks.length - onlineCount}</b><span>canciones descargadas</span></div>
      <div class="stat"><b>${onlineCount}</b><span>en línea</span></div>
      <div class="stat"><b>${state.playlists.length}</b><span>playlists</span></div>
      <div class="stat"><b>${fmtTotal(total)}</b><span>de música</span></div>
    </div>
    ${state.tracks.length ? `
      <div class="row" style="margin-top:28px"><h2 style="margin:0">Añadidas recientemente</h2><span class="spacer"></span><a class="btn" href="#/library">Ver todo</a></div>
      <div class="grid" id="recent" style="margin-top:14px">${recent.map((t, i) => `
        <div class="card" data-i="${i}">
          <div class="art" ${coverStyle(t)}>${coverInner(t)}</div>
          <div class="name">${cloudBadge(t)}${esc(t.title)}</div>
          <div class="info">${esc(t.artist || 'Artista desconocido')}</div>
          <button class="fab" title="Reproducir">${ICON.play}</button>
        </div>`).join('')}</div>`
      : `<div class="empty">${ICON.download}Aún no tienes canciones.<br><br><a class="btn primary" href="#/add">${ICON.plus}Añadir desde una URL</a></div>`}
    ${state.playlists.length ? `<h2>Tus playlists</h2><div class="grid" id="homePl">${state.playlists.slice(0, 6).map(playlistCard).join('')}</div>` : ''}
  `;
  const ids = recent.map(t => t.id);
  $('#recent', el)?.addEventListener('click', e => {
    const c = e.target.closest('.card');
    if (c) player.playList(ids, +c.dataset.i);
  });
  const hp = $('#homePl', el);
  if (hp) bindPlaylistCards(hp);
};

views.add = el => {
  el.innerHTML = `
    <h1>Añadir desde URL</h1>
    <p class="sub">Pega el enlace de un vídeo o pista y elige qué hacer con él.</p>
    <form class="add-form" id="addForm">
      <input class="input" id="urlInput" type="url" placeholder="https://… o un link sonora://playlist/…" required autocomplete="off">
      <div class="add-actions">
        <button class="btn primary" type="submit" data-act="download">${ICON.download}Convertir y descargar</button>
        <button class="btn" type="button" data-act="play">${ICON.play}Reproducir ahora</button>
        <button class="btn" type="button" data-act="online">${ICON.cloud}Añadir sin descargar</button>
      </div>
    </form>
    <ul class="modes">
      <li><b>Convertir y descargar:</b> MP3 a 320 kbps con título, artista y carátula. Se escucha sin conexión.</li>
      <li><b>Reproducir ahora:</b> suena al instante por streaming, sin guardar nada.</li>
      <li><b>Añadir sin descargar:</b> queda en tu biblioteca con ☁ y se escucha por streaming. Puedes descargarla cuando quieras.</li>
      <li>El streaming usa el audio original de la fuente en su mejor calidad y necesita internet.</li>
      <li>¿Te pasaron un link <b>sonora://playlist/…</b>? Pégalo aquí y pulsa cualquier botón para importar la playlist.</li>
    </ul>
    <div id="preview"></div>
    <div id="recentBox"></div>
    <p class="hint" id="dirHint"></p>
    <div class="jobs" id="jobs"></div>
  `;
  api('/info').then(i => {
    $('#dirHint', el).innerHTML = NATIVE
      ? 'La conversión se hace en el teléfono y los MP3 se guardan en él.'
      : `Los archivos se guardan en <code>${esc(i.musicDir)}</code>`;
  }).catch(() => {});
  const input = $('#urlInput', el);
  input.focus();

  const startDownload = async url => {
    await api('/downloads', { method: 'POST', body: { url } });
    pollJobs();
  };
  const addOnline = async url => {
    const t = await api('/online', { method: 'POST', body: { url } });
    await loadLibrary();
    prepareTracks([state.byId.get(t.id)]);
    toast(`«${t.title}» añadida a tu biblioteca`);
  };

  // Tarjeta de lo que suena con «Reproducir ahora», para guardarlo si gusta.
  const showPreview = t => {
    $('#preview', el).innerHTML = `<div class="job preview">
      <div class="cover" ${coverStyle(t)}>${coverInner(t)}</div>
      <div class="body"><div class="jt">${esc(t.title)}</div>
        <div class="js">${esc(t.artist || 'Artista desconocido')} · streaming${t.quality ? ' ' + esc(t.quality) : ''}</div></div>
      <button class="btn" data-pv="playlist">${ICON.list}<span class="hide-sm">A playlist</span></button>
      <button class="btn" data-pv="online">${ICON.cloud}<span class="hide-sm">Añadir</span></button>
      <button class="btn" data-pv="download">${ICON.download}<span class="hide-sm">Descargar</span></button>
    </div>`;
    $('#preview', el).onclick = async e => {
      const b = e.target.closest('[data-pv]');
      if (!b) return;
      if (b.dataset.pv === 'playlist') { e.stopPropagation(); trackMenu(b, t.id); return; }
      b.disabled = true;
      try {
        if (b.dataset.pv === 'online') await addOnline(t.url);
        else { await startDownload(t.url); toast('Descargando en MP3…'); }
      } catch (err) { toast(err.message); b.disabled = false; }
    };
  };

  const run = async (act, btn) => {
    const url = input.value.trim();
    if (/^sonora:/i.test(url)) {  // link de playlist compartida
      try { await importFromText(url); input.value = ''; } catch (err) { toast(err.message); }
      return;
    }
    if (!input.reportValidity()) return;
    const label = btn.innerHTML;
    btn.disabled = true;
    if (act !== 'download') btn.innerHTML = `${ICON.spin}${act === 'play' ? 'Cargando…' : 'Añadiendo…'}`;
    try {
      if (act === 'download') await startDownload(url);
      else if (act === 'online') await addOnline(url);
      else {
        const t = await api('/stream/info', { method: 'POST', body: { url } });
        rememberTemp(t);
        player.playNow(t.id);
        showPreview(t);
        renderRecent();
      }
      input.value = '';
    } catch (err) { toast(err.message); }
    btn.disabled = false;
    btn.innerHTML = label;
  };
  // Escuchadas sin guardar: se pueden reproducir otra vez o juntar en una playlist (siguen por streaming).
  const renderRecent = () => {
    const box = $('#recentBox', el);
    const temps = recentTemps();
    if (!temps.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="row" style="margin:32px 0 6px"><h2 style="margin:0">Escuchadas sin guardar</h2><span class="spacer"></span>
        <button class="btn" id="recentPl">${ICON.list}Crear playlist con estas</button>
        <button class="btn" id="recentClear">${ICON.x}Limpiar</button></div>
      <p class="hint" style="margin:0 0 10px">Lo que escuchaste con «Reproducir ahora». En una playlist se siguen escuchando por streaming, sin descargar.</p>
      <div id="recentList">${trackTable(temps, { numbered: false })}</div>`;
    bindTrackTable($('#recentList', box), temps.map(t => t.id));
    $('#recentPl', box).onclick = e => { e.target.disabled = true; createPlaylist(temps.map(t => t.id)).finally(() => { e.target.disabled = false; }); };
    $('#recentClear', box).onclick = () => { temps.forEach(t => forgetTemp(t.id)); renderRecent(); };
  };
  renderRecent();
  refreshRecent = () => { if ($('#recentBox', el)?.isConnected) renderRecent(); };

  $('#addForm', el).onsubmit = e => { e.preventDefault(); run('download', e.submitter || $('[data-act=download]', el)); };
  $$('[data-act]', el).forEach(b => { if (b.type === 'button') b.onclick = () => run(b.dataset.act, b); });

  $('#jobs', el).addEventListener('click', async e => {
    const d = e.target.closest('[data-dismiss]');
    if (d) { await api(`/downloads/${d.dataset.dismiss}`, { method: 'DELETE' }); pollJobs(); return; }
    const p = e.target.closest('[data-playtrack]');
    if (p && state.byId.has(p.dataset.playtrack)) player.playList([p.dataset.playtrack]);
  });
  renderJobs();
};

function renderJobs() {
  const box = $('#jobs');
  if (!box) return;
  const label = { queued: 'En cola…', downloading: 'Descargando audio', converting: 'Convirtiendo a MP3 e incrustando metadatos', done: 'Guardada en la biblioteca', error: 'Error' };
  box.innerHTML = state.jobs.map(j => {
    const active = !['done', 'error'].includes(j.status);
    const icon = j.status === 'done' ? ICON.check : j.status === 'error' ? ICON.alert : ICON.download;
    const color = j.status === 'done' ? 'var(--ok)' : j.status === 'error' ? 'var(--danger)' : 'var(--accent)';
    const indet = j.status === 'queued' || j.status === 'converting' || (j.status === 'downloading' && !j.progress);
    const pct = j.status === 'downloading' && j.progress ? ` · ${Math.round(j.progress / 0.9)}%` : '';
    return `<div class="job">
      <span style="color:${color}">${icon}</span>
      <div class="body">
        <div class="jt">${esc(j.title)}</div>
        <div class="js ${j.status === 'error' ? 'err' : ''}">${esc(j.status === 'error' ? j.error : label[j.status])}${pct}</div>
        ${active ? `<div class="bar ${indet ? 'indet' : ''}"><i style="width:${indet ? '' : j.progress + '%'}"></i></div>` : ''}
      </div>
      ${j.status === 'done' && j.trackId ? `<button class="icon-btn" data-playtrack="${j.trackId}" title="Reproducir">${ICON.play}</button>` : ''}
      ${active ? '' : `<button class="icon-btn" data-dismiss="${j.id}" title="Descartar">${ICON.x}</button>`}
    </div>`;
  }).join('');
}

let pollTimer = null;
async function pollJobs() {
  clearTimeout(pollTimer);
  try {
    const prev = new Map(state.jobs.map(j => [j.id, j.status]));
    state.jobs = await api('/downloads');
    const finished = state.jobs.filter(j => j.status === 'done' && prev.has(j.id) && prev.get(j.id) !== 'done');
    if (finished.length) {
      finished.forEach(j => { if (j.replaceId && j.trackId) player.replaceId(j.replaceId, j.trackId); });
      await loadLibrary();
      toast(finished.length > 1 ? `${finished.length} canciones listas` : `«${finished[0].title}» lista`);
      if (['home', 'library', 'history'].includes(currentRoute().name)) route();
    }
    for (const j of state.jobs) if (j.status === 'error' && prev.has(j.id) && prev.get(j.id) !== 'error') toast('Falló una descarga');
    renderJobs();
    if (state.jobs.some(j => !['done', 'error'].includes(j.status))) pollTimer = setTimeout(pollJobs, 1000);
  } catch {
    pollTimer = setTimeout(pollJobs, 4000);
  }
}

views.library = el => {
  const q = store.get('libQuery', '');
  const onlineCount = state.tracks.filter(t => t.online).length;
  let kind = store.get('libKind', 'all');
  el.innerHTML = `
    <h1>Biblioteca</h1>
    <p class="sub">${state.tracks.length - onlineCount} descargadas (sin conexión) · ${onlineCount} en línea · ${fmtTotal(state.tracks.reduce((s, t) => s + t.duration, 0))}</p>
    <div class="chips" id="kind" style="margin-bottom:14px">
      <button data-k="all">Todas <span class="count">${state.tracks.length}</span></button>
      <button data-k="local">${ICON.download}Descargadas <span class="count">${state.tracks.length - onlineCount}</span></button>
      <button data-k="online">${ICON.cloud}En línea <span class="count">${onlineCount}</span></button>
    </div>
    <div class="row" style="margin-bottom:18px">
      <button class="btn primary" id="playAll" ${state.tracks.length ? '' : 'disabled'}>${ICON.play}Reproducir</button>
      <button class="btn" id="shuffleAll" ${state.tracks.length ? '' : 'disabled'}>${ICON.shuffle}Aleatorio</button>
      <span class="spacer"></span>
      <input class="input" id="search" placeholder="Buscar por título, artista o álbum" style="max-width:320px" value="${esc(q)}">
    </div>
    <div id="list"></div>
  `;
  const list = $('#list', el);
  let shown = [];
  const draw = () => {
    const term = $('#search', el).value.trim().toLowerCase();
    store.set('libQuery', term);
    $$('#kind button', el).forEach(b => b.classList.toggle('on', b.dataset.k === kind));
    shown = state.tracks.filter(t => (kind === 'all' || (kind === 'online') === !!t.online)
      && (!term || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(term)));
    if (!shown.length) {
      list.innerHTML = `<div class="empty">${ICON.note}${state.tracks.length ? 'Sin resultados' : 'Aún no hay canciones en tu biblioteca.'}</div>`;
      return;
    }
    const local = shown.filter(t => !t.online), online = shown.filter(t => t.online);
    if (kind !== 'all' || !local.length || !online.length) {
      list.innerHTML = trackTable(shown);
      bindTrackTable(list, shown.map(t => t.id));
      return;
    }
    // «Todas»: primero las descargadas y después las en línea, cada grupo con su título.
    shown = [...local, ...online];
    list.innerHTML = `
      <h2 class="lib-group">${ICON.download}Descargadas <span class="hint">· sin conexión · ${local.length}</span></h2>
      <div id="libLocal">${trackTable(local)}</div>
      <h2 class="lib-group">${ICON.cloud}En línea <span class="hint">· streaming · ${online.length}</span></h2>
      <div id="libOnline">${trackTable(online)}</div>`;
    bindTrackTable($('#libLocal', list), local.map(t => t.id));
    bindTrackTable($('#libOnline', list), online.map(t => t.id));
  };
  $('#search', el).addEventListener('input', draw);
  $('#kind', el).onclick = e => { const b = e.target.closest('[data-k]'); if (b) { kind = b.dataset.k; store.set('libKind', kind); draw(); } };
  $('#playAll', el).onclick = () => { if (player.shuffle) player.toggleShuffle(); player.playList(shown.map(t => t.id)); };
  $('#shuffleAll', el).onclick = () => { if (!player.shuffle) { player.shuffle = true; updateModes(); } player.playList(shown.map(t => t.id), Math.floor(Math.random() * shown.length)); };
  draw();
};

function dayLabel(ts) {
  const d = new Date(ts * 1000), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return 'Hoy';
  if (days === 1) return 'Ayer';
  return d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

views.history = async el => {
  el.innerHTML = `
    <div class="row"><h1>Historial de conversiones</h1><span class="spacer"></span>
      ${NATIVE ? '' : `<button class="btn" id="openDir">${ICON.folder}Abrir carpeta de música</button>`}</div>
    <p class="sub">Todo lo que has convertido a MP3 en este ${NATIVE ? 'teléfono' : 'equipo'}.</p>
    <div id="hist"><div class="empty">Cargando…</div></div>
  `;
  $('#openDir', el)?.addEventListener('click', () => api('/open-folder', { method: 'POST' }).catch(e => toast(e.message)));

  const list = $('#hist', el);
  let history;
  try { history = await api('/history'); }
  catch { if (list.isConnected) list.innerHTML = `<div class="empty">${ICON.alert}No se pudo cargar el historial.</div>`; return; }
  if (!list.isConnected) return; // el usuario cambió de vista mientras cargaba

  const draw = () => {
    if (!history.length) {
      list.innerHTML = `<div class="empty">${ICON.download}Aún no has convertido canciones.<br><br><a class="btn primary" href="#/add">${ICON.plus}Añadir desde una URL</a></div>`;
      return;
    }
    let lastDay = '';
    list.innerHTML = history.map(h => {
      const day = dayLabel(h.convertedAt);
      const head = day !== lastDay ? `<div class="hist-day">${esc(day)}</div>` : '';
      lastDay = day;
      const cover = { id: h.trackId, hasCover: h.hasCover, coverSrc: h.coverSrc };
      const time = new Date(h.convertedAt * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
      return head + `<div class="hist-row ${h.available ? '' : 'gone'}">
        <div class="titlecell"><div class="cover" ${coverStyle(cover)}>${coverInner(cover)}</div>
          <div><div class="tt">${esc(h.title)}</div>
          <div class="ta">${esc(h.artist || 'Artista desconocido')} · ${time}${h.available ? (h.duration ? ' · ' + fmtTime(h.duration) : '') : ' · archivo eliminado'}</div></div></div>
        ${h.available ? `<button class="icon-btn" data-play="${h.trackId}" title="Reproducir">${ICON.play}</button>` : ''}
        <button class="icon-btn" data-forget="${h.id}" title="Quitar del historial">${ICON.x}</button>
      </div>`;
    }).join('');
  };

  list.addEventListener('click', async e => {
    const p = e.target.closest('[data-play]');
    if (p) { player.playList([p.dataset.play]); return; }
    const f = e.target.closest('[data-forget]');
    if (f) {
      await api(`/history/${f.dataset.forget}`, { method: 'DELETE' });
      history = history.filter(h => h.id !== f.dataset.forget);
      draw();
    }
  });

  draw();
};

views.playlists = el => {
  el.innerHTML = `
    <div class="row"><h1>Tus playlists</h1><span class="spacer"></span><button class="btn primary" data-newpl>${ICON.plus}Nueva playlist</button></div>
    <p class="sub">Agrupa y ordena tus canciones. Compártelas con un link para tenerlas en tu otro dispositivo.</p>
    <form class="import-form" id="importForm">
      <input class="input" id="importInput" placeholder="Pega un link sonora://playlist/… para importarla" autocomplete="off">
      <button class="btn" type="submit">${ICON.download}Importar</button>
    </form>
    ${state.playlists.length ? `<div class="grid">${state.playlists.map(playlistCard).join('')}</div>`
      : `<div class="empty">${ICON.list}Todavía no has creado ninguna playlist.</div>`}
  `;
  bindPlaylistCards(el);
  $('#importForm', el).onsubmit = async e => {
    e.preventDefault();
    const btn = $('button', e.target);
    btn.disabled = true;
    try {
      if (!await importFromText($('#importInput', el).value)) toast('Eso no es un link de playlist de Sonora');
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  };
};

views.playlist = (el, { id, params }) => {
  const pl = state.playlists.find(p => p.id === id);
  if (!pl) { el.innerHTML = `<div class="empty">Playlist no encontrada.<br><br><a class="btn" href="#/playlists">Volver</a></div>`; return; }
  const tracks = pl.tracks.map(i => state.byId.get(i)).filter(Boolean);
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  el.innerHTML = `
    <div class="hero">
      ${playlistArt(pl)}
      <div style="min-width:0">
        <small>Playlist</small>
        <h1 id="plName" spellcheck="false">${esc(pl.name)}</h1>
        <div class="sub" style="margin:0">${tracks.length} canciones · ${fmtTotal(total)}<span class="prep-sum" id="plPrep" data-pl="${esc(id)}"></span></div>
      </div>
    </div>
    <div class="row" style="margin-bottom:18px">
      <button class="btn primary" id="plPlay" ${tracks.length ? '' : 'disabled'}>${ICON.play}Reproducir</button>
      <button class="btn" id="plShuffle" ${tracks.length ? '' : 'disabled'}>${ICON.shuffle}Aleatorio</button>
      <button class="btn" id="plQueue" ${tracks.length ? '' : 'disabled'}>${ICON.queue}A la cola</button>
      <span class="spacer"></span>
      <button class="btn" id="plShare" ${tracks.length ? '' : 'disabled'}>${ICON.share}Compartir</button>
      <button class="btn" id="plRename">${ICON.edit}Renombrar</button>
      <button class="btn danger" id="plDelete">${ICON.trash}Eliminar</button>
    </div>
    <div id="plTracks">${trackTable(tracks, { playlistId: id, draggable: true }) || `<div class="empty" style="padding:24px 0">Esta playlist está vacía. Añade canciones desde abajo.</div>`}</div>
    <h2>Añadir canciones</h2>
    <input class="input" id="plSearch" placeholder="Buscar en tus canciones descargadas" style="max-width:420px;margin-bottom:12px">
    <div id="plAdd"></div>
  `;
  const ids = tracks.map(t => t.id);
  bindTrackTable($('#plTracks', el), ids, { playlistId: id });
  paintPrep();
  prepareTracks(tracks); // las ☁ que aún no estén listas
  $('#plPlay', el).onclick = () => { if (player.shuffle) player.toggleShuffle(); player.playList(ids); };
  $('#plShuffle', el).onclick = () => { if (!player.shuffle) { player.shuffle = true; updateModes(); } player.playList(ids, Math.floor(Math.random() * ids.length)); };
  $('#plQueue', el).onclick = () => player.enqueue(ids);

  // Renombrar en línea
  const name = $('#plName', el);
  const startEdit = () => {
    name.contentEditable = 'true'; name.focus();
    getSelection().selectAllChildren(name);
  };
  name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } if (e.key === 'Escape') { name.textContent = pl.name; name.blur(); } });
  name.addEventListener('blur', async () => {
    name.contentEditable = 'false';
    const v = name.textContent.trim();
    if (!v) { name.textContent = pl.name; return; }
    if (v !== pl.name) { await patchPlaylist(id, { name: v }); toast('Playlist renombrada'); }
  });
  name.addEventListener('dblclick', startEdit);
  $('#plRename', el).onclick = startEdit;
  $('#plShare', el).onclick = () => sharePlaylist(state.playlists.find(p => p.id === id) || pl).catch(e => toast(e.message));
  if (params.get('edit')) { history.replaceState(null, '', `#/playlist/${id}`); startEdit(); }

  // Eliminar con confirmación en dos pasos
  const del = $('#plDelete', el);
  del.onclick = async () => {
    if (!del.dataset.confirm) { del.dataset.confirm = '1'; del.lastChild.textContent = '¿Seguro?'; setTimeout(() => { if (del.isConnected) { delete del.dataset.confirm; del.lastChild.textContent = 'Eliminar'; } }, 3000); return; }
    await api(`/playlists/${id}`, { method: 'DELETE' });
    await loadLibrary();
    toast('Playlist eliminada');
    location.hash = '#/playlists';
  };

  // Reordenar arrastrando
  const tbody = $('#plTracks tbody', el);
  if (tbody) {
    let dragId = null;
    tbody.addEventListener('dragstart', e => { const tr = e.target.closest('tr.t'); dragId = tr.dataset.id; tr.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    tbody.addEventListener('dragend', e => { e.target.closest('tr.t')?.classList.remove('dragging'); $$('.drop-above,.drop-below', tbody).forEach(r => r.classList.remove('drop-above', 'drop-below')); });
    tbody.addEventListener('dragover', e => {
      const tr = e.target.closest('tr.t'); if (!tr || !dragId) return;
      e.preventDefault();
      $$('.drop-above,.drop-below', tbody).forEach(r => r.classList.remove('drop-above', 'drop-below'));
      const r = tr.getBoundingClientRect();
      tr.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
    });
    tbody.addEventListener('drop', async e => {
      e.preventDefault();
      const tr = e.target.closest('tr.t'); if (!tr || !dragId || tr.dataset.id === dragId) return;
      const below = tr.classList.contains('drop-below');
      const order = pl.tracks.filter(t => t !== dragId);
      order.splice(order.indexOf(tr.dataset.id) + (below ? 1 : 0), 0, dragId);
      dragId = null;
      await patchPlaylist(id, { tracks: order });
      route();
    });
  }

  // Buscador para añadir
  const addBox = $('#plAdd', el);
  const drawAdd = () => {
    const term = $('#plSearch', el).value.trim().toLowerCase();
    const cands = [...state.tracks, ...recentTemps()]
      .filter(t => !pl.tracks.includes(t.id) && (!term || `${t.title} ${t.artist}`.toLowerCase().includes(term))).slice(0, 30);
    addBox.innerHTML = cands.length ? `<table class="tracks"><tbody>${cands.map(t => `
      <tr class="t" data-id="${t.id}"><td class="tc"><div class="titlecell"><div class="cover" ${coverStyle(t)}>${coverInner(t)}</div>
      <div><div class="tt">${cloudBadge(t)}${esc(t.title)}</div><div class="ta">${esc(t.artist || 'Artista desconocido')}${isTemp(t.id) ? ' · escuchada, sin guardar' : ''}</div></div></div></td>
      <td class="dur hide-sm">${fmtTime(t.duration)}</td>
      <td class="act"><button class="btn" data-add="${t.id}">${ICON.plus}Añadir</button></td></tr>`).join('')}</tbody></table>`
      : `<div class="empty" style="padding:16px 0">${state.tracks.length ? 'No hay más canciones que añadir.' : 'Descarga canciones primero.'}</div>`;
  };
  $('#plSearch', el).addEventListener('input', drawAdd);
  addBox.addEventListener('click', async e => {
    const b = e.target.closest('[data-add]');
    if (b) { b.disabled = true; await addToPlaylist(id, [b.dataset.add]); }
  });
  drawAdd();
};

/* ================= Router ================= */

function currentRoute() {
  const [path, query = ''] = (location.hash.slice(2) || 'home').split('?');
  const [name, id] = path.split('/');
  return { name: views[name] ? name : 'home', id, params: new URLSearchParams(query) };
}

function route() {
  const r = currentRoute();
  const view = $('#view');
  const keepScroll = view.dataset.route === `${r.name}/${r.id || ''}`;
  const scroll = view.scrollTop;
  views[r.name](view, r);
  view.dataset.route = `${r.name}/${r.id || ''}`;
  view.scrollTop = keepScroll ? scroll : 0;
  const navName = r.name === 'playlist' ? 'playlists' : r.name;
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === navName));
  renderSidebarPlaylists();
  closeMenu();
}

window.addEventListener('hashchange', route);

/* ================= Arranque ================= */

function updateNet() {
  const el = $('#netStatus');
  el.classList.toggle('offline', !navigator.onLine);
  el.textContent = navigator.onLine ? 'En línea' : 'Sin conexión · modo offline';
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

(async function init() {
  initPlayer();
  updateNet();
  await loadLibrary();
  player.prune();
  if (player.current) player.load(false, store.get('time', 0));
  else updateNowPlaying();
  route();
  pollJobs();
  refreshPrep();
  NATIVE?.onIncomingText(text => importFromText(text).then(ok => { if (!ok) toast('Eso no es un link de playlist de Sonora'); })
                                                   .catch(e => toast(e.message)));
  if (!NATIVE && 'serviceWorker' in navigator) {
    // Si se instala una versión nueva de la app mientras está abierta, se recarga para mostrarla.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
