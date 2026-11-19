'use strict';
/*
 * Adaptador para la APK (Capacitor). En el navegador o en la app de escritorio no hace nada.
 * Atiende las mismas rutas que el servidor de escritorio, pero todo ocurre en el teléfono
 * (la app es independiente: no se comunica con ningún PC):
 *   - Biblioteca y conversión: plugin nativo «Sonora» (yt-dlp + ffmpeg + QuickJS dentro de la APK).
 *   - Playlists, historial y canciones en línea: archivos JSON en el almacenamiento de la app.
 *   - Streaming: el enlace directo del audio se obtiene al reproducir (caduca y se renueva solo).
 */
(function () {
  const core = window.capacitorExports;
  const Cap = window.Capacitor;
  if (!core || !Cap?.isNativePlatform?.()) return;

  const Sonora = core.registerPlugin('Sonora');

  // Id estable a partir del nombre de archivo (FNV-1a de 64 bits en dos mitades).
  function trackId(file) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < file.length; i++) {
      const c = file.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  /* ---------- Biblioteca local ---------- */

  let tracks = [];
  let byId = new Map();

  const loadSources = async () => JSON.parse((await Sonora.readData({ name: 'sources' })).data || '{}');
  async function rememberSource(file, url) {
    if (!file || !url) return;
    const src = await loadSources();
    src[file] = url;
    await Sonora.writeData({ name: 'sources', data: JSON.stringify(src) });
  }

  async function listTracks() {
    const [{ tracks: raw }, online, sources] = await Promise.all([Sonora.listTracks(), loadOnline(), loadSources()]);
    const local = raw.map(t => ({
      id: trackId(t.file),
      file: t.file,
      title: t.title || t.file.replace(/\.mp3$/i, ''),
      artist: t.artist || '',
      album: t.album || '',
      duration: t.duration || 0,
      hasCover: !!t.coverPath,
      addedAt: t.addedAt,
      audioSrc: Cap.convertFileSrc(t.path),
      coverSrc: t.coverPath ? Cap.convertFileSrc(t.coverPath) : null,
      art: t.coverPath || null, // ruta real, para la notificación y la pantalla de bloqueo
      url: sources[t.file] || null,
    }));
    tracks = [...local, ...online.map(o => onlineTrack(o, o.id, o.addedAt))].sort((a, b) => b.addedAt - a.addedAt);
    byId = new Map(tracks.map(t => [t.id, t]));
    return tracks;
  }

  async function deleteTrack(id) {
    const t = byId.get(id);
    if (!t) throw new Error('Canción no encontrada');
    if (t.online) await saveOnline((await loadOnline()).filter(o => o.id !== id));
    else await Sonora.deleteTrack({ file: t.file });
    await listTracks();
    await savePlaylists(await loadPlaylists()); // limpia referencias
  }

  /* ---------- Streaming ---------- */

  const loadOnline = async () => JSON.parse((await Sonora.readData({ name: 'online' })).data || '[]');
  const saveOnline = items => Sonora.writeData({ name: 'online', data: JSON.stringify(items) });
  const onlineId = url => 'o' + trackId(url).slice(0, 15);

  // Las carátulas pueden venir de un link de playlist ajeno o de la página de un sitio cualquiera.
  const safeThumb = u => typeof u === 'string' && /^https:\/\/[^\s"'()<>\\]+$/.test(u) ? u : null;
  // Destinos de la red local o del propio teléfono: un link de playlist ajeno no debe hacer que la app los pida.
  function privateHost(url) {
    let h;
    try { h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return true; }
    return !h || h === 'localhost' || /\.(localhost|local|internal|lan)$/.test(h)
      || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h)
      || /^(::1?|f[cd][0-9a-f]{2}:|fe80:)/.test(h);
  }

  function onlineTrack(meta, id, addedAt) {
    const thumb = safeThumb(meta.thumbnail);
    return {
      id, online: true, url: meta.url,
      title: meta.title, artist: meta.artist || '', album: meta.album || '',
      duration: meta.duration || 0, quality: meta.quality || '',
      hasCover: !!thumb, coverSrc: thumb, art: thumb, addedAt,
    };
  }

  // Enlaces directos obtenidos en el propio celular (caducan: se renuevan antes de usarlos).
  // YouTube responde 403 a las primeras peticiones de un enlace recién emitido y lo acepta segundos
  // después: por eso cada enlace se «calienta» (warm) en el plugin antes de dárselo al reproductor.
  const valid = r => r && r.expires * 1000 > Date.now() + 120000;
  // Se guardan en el teléfono (valen unas horas): si Android reinicia la interfaz, no hay que prepararlas otra vez.
  const direct = new Map((() => {
    try { return JSON.parse(localStorage.getItem('sonora.direct') || '[]').filter(([, r]) => valid(r)); } catch { return []; }
  })());
  let saveTimer = null;
  const saveDirect = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem('sonora.direct', JSON.stringify([...direct].filter(([, r]) => valid(r) && r.warm))); } catch {}
    }, 500);
  };
  const setDirect = (url, r) => { direct.set(url, r); saveDirect(); };

  async function resolveLocal(url) {
    const r = await Sonora.resolveStream({ url });
    setDirect(url, r);
    return r;
  }

  // Resuelve y calienta en una sola llamada; si ya hay un enlace vigente, solo lo calienta.
  async function prepareLocal(url) {
    if (privateHost(url)) throw new Error('No se aceptan enlaces de la red local ni de este teléfono');
    const cur = direct.get(url);
    if (valid(cur) && cur.warm) return cur;
    let r;
    if (valid(cur)) {
      const { warm, error } = await Sonora.warmStream({ url: cur.url, headers: cur.headers || {} });
      if (!warm) throw new Error(error || 'La fuente del audio no respondió');
      r = { ...cur, warm: true };
    } else {
      r = await Sonora.prepareStream({ url });
    }
    setDirect(url, r);
    return r;
  }

  /* ---------- Preparar por adelantado (2 a la vez, por orden de llegada) ---------- */

  const PREPARE_WORKERS = 2;
  // Las que ya tenían enlace caliente guardado aparecen listas desde el principio.
  const prepState = new Map([...direct].filter(([, r]) => r.warm).map(([url]) => [url, { state: 'ready', error: null }])); // url -> { state: queued|preparing|ready|error, error }
  const prepQueue = [];
  const inFlight = new Map(); // url -> promesa de prepareLocal (la comparten preparación y reproducción)
  const prepRetried = new Set();
  let prepBusy = 0;

  function prepareShared(url) {
    if (!inFlight.has(url)) {
      inFlight.set(url, prepareLocal(url).finally(() => inFlight.delete(url)));
    }
    return inFlight.get(url);
  }

  function pumpPrepare() {
    while (prepBusy < PREPARE_WORKERS && prepQueue.length) {
      const url = prepQueue.shift();
      prepBusy++;
      prepState.set(url, { state: 'preparing', error: null });
      prepareShared(url)
        .then(() => prepState.set(url, { state: 'ready', error: null }))
        .catch(e => {
          // Un fallo puntual (red, la fuente rechazando un momento) se reintenta una vez, al final de la cola.
          if (!prepRetried.has(url)) {
            prepRetried.add(url);
            prepState.set(url, { state: 'queued', error: null });
            prepQueue.push(url);
          } else {
            prepState.set(url, { state: 'error', error: String(e.message || e).slice(0, 300) });
          }
        })
        .finally(() => { prepBusy--; pumpPrepare(); });
    }
  }

  function queuePrepare(urls) {
    let queued = 0;
    for (const url of new Set(urls || [])) {
      if (!/^https?:\/\//i.test(url || '')) continue;
      if (privateHost(url)) { prepState.set(url, { state: 'error', error: 'No se preparan enlaces de la red local' }); continue; }
      const st = prepState.get(url)?.state;
      if (st === 'queued' || st === 'preparing' || (st === 'ready' && valid(direct.get(url)))) continue;
      prepRetried.delete(url); // una petición nueva vuelve a tener su reintento
      prepState.set(url, { state: 'queued', error: null });
      prepQueue.push(url);
      queued++;
    }
    pumpPrepare();
    return { queued };
  }

  function prepareStatus() {
    const states = {};
    let pending = 0;
    for (const [url, st] of prepState) {
      if (st.state === 'ready' && !valid(direct.get(url))) continue; // caducó: vuelve a estar sin preparar
      states[url] = { ...st };
      if (st.state === 'queued' || st.state === 'preparing') pending++;
    }
    return { states, pending, workers: PREPARE_WORKERS };
  }

  async function getMeta(url) {
    url = (url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Introduce una URL válida (http/https)');
    if (privateHost(url)) throw new Error('No se aceptan enlaces de la red local ni de este teléfono');
    const r = await resolveLocal(url);
    return { url, title: r.title, artist: r.artist, album: r.album, duration: r.duration, thumbnail: r.thumbnail, quality: r.quality };
  }

  // Enlace listo para el reproductor. { fresh: true } (tras un error de reproducción) vuelve a calentar
  // el mismo enlace y solo pide uno nuevo si sigue fallando: pedirlo enseguida daba otro «recién emitido».
  async function streamSrc(t, { fresh = false } = {}) {
    const url = t.url;
    let r;
    if (fresh) {
      const cur = direct.get(url);
      if (cur) setDirect(url, { ...cur, warm: false });
      try { r = await prepareShared(url); } catch { r = null; }
      if (!r) { direct.delete(url); saveDirect(); r = await prepareShared(url); }
    } else {
      r = await prepareShared(url);
    }
    prepState.set(url, { state: 'ready', error: null });
    return r.url;
  }

  async function addOnline(url) {
    const meta = await getMeta(url);
    const id = onlineId(meta.url);
    const items = (await loadOnline()).filter(o => o.id !== id);
    items.unshift({ ...meta, id, addedAt: Date.now() / 1000 });
    await saveOnline(items);
    await listTracks();
    return byId.get(id);
  }

  async function addOnlineBulk(list) {
    const items = await loadOnline();
    const known = new Set(items.map(o => o.id));
    const ids = [];
    const now = Date.now() / 1000;
    list.slice(0, 1000).forEach((it, i) => {
      if (!/^https?:\/\//i.test(it.url || '') || privateHost(it.url)) { ids.push(null); return; }
      const id = onlineId(it.url);
      if (!known.has(id)) {
        items.unshift({ url: it.url, title: (it.title || it.url).slice(0, 300), artist: (it.artist || '').slice(0, 200),
                        album: '', duration: Math.max(0, +it.duration || 0), quality: '',
                        thumbnail: safeThumb(it.thumbnail),
                        id, addedAt: now - i / 1000 });
        known.add(id);
      }
      ids.push(id);
    });
    await saveOnline(items);
    await listTracks();
    return { ids };
  }

  async function replaceOnline(oldId, newId) {
    // Se leen sin filtrar: loadPlaylists() descartaría oldId antes de poder sustituirlo.
    const { data } = await Sonora.readData({ name: 'playlists' });
    const pls = data ? JSON.parse(data) : [];
    pls.forEach(p => { p.tracks = [...new Set(p.tracks.map(id => id === oldId ? newId : id))]; });
    await savePlaylists(pls);
    await saveOnline((await loadOnline()).filter(o => o.id !== oldId));
    await listTracks();
  }

  /* ---------- Playlists ---------- */

  async function loadPlaylists() {
    const { data } = await Sonora.readData({ name: 'playlists' });
    const pls = data ? JSON.parse(data) : [];
    if (!tracks.length) await listTracks();
    pls.forEach(p => { p.tracks = p.tracks.filter(id => byId.has(id)); });
    return pls;
  }

  const savePlaylists = pls => Sonora.writeData({ name: 'playlists', data: JSON.stringify(pls) });
  const uniqueValid = ids => [...new Set(ids)].filter(id => byId.has(id));

  async function playlistsRoute(method, id, body) {
    const pls = await loadPlaylists();
    if (method === 'GET') return pls;
    if (method === 'POST') {
      const name = (body.name || '').trim();
      if (!name) throw new Error('El nombre no puede estar vacío');
      const pl = { id: Math.random().toString(16).slice(2, 14), name, tracks: uniqueValid(body.tracks || []), createdAt: Date.now() / 1000 };
      if (body.shareId) pl.shareId = String(body.shareId).slice(0, 64);
      pls.push(pl);
      await savePlaylists(pls);
      return pl;
    }
    const pl = pls.find(p => p.id === id);
    if (!pl) throw new Error('Playlist no encontrada');
    if (method === 'PATCH') {
      if (body.name?.trim()) pl.name = body.name.trim();
      if (body.tracks) pl.tracks = uniqueValid(body.tracks);
      await savePlaylists(pls);
      return pl;
    }
    if (method === 'DELETE') {
      await savePlaylists(pls.filter(p => p.id !== id));
      return { ok: true };
    }
  }

  /* ---------- Conversiones ---------- */

  const jobs = [];
  const progressHandlers = new Map(); // jobId/transferId -> fn(evento)
  Sonora.addListener('progress', e => progressHandlers.get(e.id)?.(e));

  async function runOnDevice(job) {
    Object.assign(job, { status: 'queued', progress: 0 });
    progressHandlers.set(job.id, e => Object.assign(job, { status: e.status, progress: e.progress ?? job.progress, title: e.title || job.title }));
    try {
      const { file } = await Sonora.convert({ id: job.id, url: job.url });
      await rememberSource(file, job.url);
      return file;
    } finally {
      progressHandlers.delete(job.id);
    }
  }

  async function runJob(job) {
    try {
      const file = await runOnDevice(job);
      await listTracks();
      await addHistory(job.url, byId.get(trackId(file)), file);
      if (job.replaceId) await replaceOnline(job.replaceId, trackId(file));
      Object.assign(job, { status: 'done', progress: 100, trackId: trackId(file) });
    } catch (e) {
      Object.assign(job, { status: 'error', error: String(e.message || e).slice(0, 400) });
    }
  }

  function startJob(url, replaceId = null) {
    url = (url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Introduce una URL válida (http/https)');
    const job = { id: Math.random().toString(16).slice(2, 14), url, title: url, status: 'queued', progress: 0,
                  error: null, trackId: null, replaceId, createdAt: Date.now() / 1000 };
    jobs.unshift(job);
    runJob(job);
    return { ...job };
  }

  /* ---------- Historial de conversiones (de este teléfono) ---------- */

  const loadHistory = async () => JSON.parse((await Sonora.readData({ name: 'history' })).data || '[]');
  const saveHistory = items => Sonora.writeData({ name: 'history', data: JSON.stringify(items) });

  async function addHistory(url, t, file) {
    const items = (await loadHistory()).filter(h => h.file !== file);
    items.unshift({ id: Math.random().toString(16).slice(2, 14), url, title: t?.title || file, artist: t?.artist || '',
                    file, convertedAt: Date.now() / 1000 });
    await saveHistory(items.slice(0, 2000));
  }

  async function history() {
    if (!tracks.length) await listTracks();
    return (await loadHistory()).map(h => {
      const t = byId.get(trackId(h.file));
      return { ...h, trackId: trackId(h.file), available: !!t, hasCover: !!t?.hasCover,
               coverSrc: t?.coverSrc || null, duration: t?.duration || 0 };
    });
  }

  /* ---------- Enrutador con la misma API que el servidor ---------- */

  async function api(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body || {};
    const [, res, id, sub] = path.split('?')[0].split('/');

    if (res === 'tracks' && !id) return listTracks();
    if (res === 'stream' && id === 'info') {
      const meta = await getMeta(body.url);
      return onlineTrack(meta, 't' + trackId(meta.url).slice(0, 15), Date.now() / 1000);
    }
    if (res === 'stream' && id === 'prepare') return method === 'POST' ? queuePrepare(body.urls) : prepareStatus();
    if (res === 'online' && !id) return addOnline(body.url);
    if (res === 'online' && id === 'bulk') return addOnlineBulk(body.items || []);
    if (res === 'online' && sub === 'save') {
      const o = (await loadOnline()).find(x => x.id === id);
      if (!o) throw new Error('Canción no encontrada');
      return startJob(o.url, id);
    }
    if (res === 'tracks' && method === 'DELETE' && !sub) { await deleteTrack(id); return { ok: true }; }
    if (res === 'playlists') return playlistsRoute(method, id, body);
    if (res === 'downloads' && method === 'POST') return startJob(body.url);
    if (res === 'downloads' && method === 'GET') return jobs.map(j => ({ ...j }));
    if (res === 'downloads' && method === 'DELETE') {
      const i = jobs.findIndex(j => j.id === id && ['done', 'error'].includes(j.status));
      if (i >= 0) jobs.splice(i, 1);
      return { ok: true };
    }
    if (res === 'history' && method === 'GET') return history();
    if (res === 'history' && method === 'DELETE') {
      await saveHistory((await loadHistory()).filter(h => h.id !== id));
      return { ok: true };
    }
    if (res === 'info') return { native: true, musicDir: 'Almacenamiento de Sonora en el teléfono' };
    throw new Error(`Ruta no disponible en el celular: ${path}`);
  }

  window.SonoraNative = {
    api,
    // Menú «Compartir» de Android (WhatsApp, Telegram, correo…).
    share: (text, title) => Sonora.shareText({ text, title }),
    // Links de Sonora abiertos desde otras apps (enlace sonora:// o «Compartir → Sonora»).
    onIncomingText: fn => {
      Sonora.addListener('incomingText', e => fn(e.text));
      Sonora.takeIncomingText().then(r => { if (r?.text) fn(r.text); }).catch(() => {});
    },
    streamSrc,
    // Mantiene la app activa (también con la pantalla apagada) y muestra los controles fuera de ella.
    setPlayback: (playing, t, position = 0, duration = 0) => Sonora.setPlayback({
      playing, title: t?.title || 'Sonora', artist: t?.artist || '', art: t?.art || null,
      position: isFinite(position) ? position : 0, duration: isFinite(duration) ? duration : (t?.duration || 0),
    }).catch(() => {}),
    stopPlayback: () => Sonora.stopPlayback().catch(() => {}),
    // Botones de la notificación, pantalla de bloqueo, auriculares y Bluetooth.
    onMediaAction: fn => Sonora.addListener('mediaAction', fn),
  };
})();
