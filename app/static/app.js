/* Unraid Monitor frontend */
(() => {
  let REFRESH_MS = 2000;

  const $ = (id) => document.getElementById(id);

  function fmtMs(ms) {
    const s = Math.floor((ms || 0) / 1000);
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0, v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 && i > 0 ? 2 : v < 100 ? 1 : 0) + ' ' + units[i];
  }

  function fmtRate(bps) { return fmtBytes(bps) + '/s'; }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtUptime(secs) {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const parts = [];
    if (d) parts.push(d + 'd');
    if (h || d) parts.push(h + 'h');
    parts.push(m + 'm');
    return parts.join(' ');
  }

  function barClass(pct) {
    return pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '';
  }

  function tempClass(t, high, crit) {
    if (crit && t >= crit) return 'crit';
    if (high && t >= high) return 'warn';
    return t >= 80 ? 'crit' : t >= 65 ? 'warn' : '';
  }

  // ── Temperature graph ────────────────────────────────────────────────────────

  const TEMP_COLORS = ['#e22828', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#ff5722'];
  const TEMP_HISTORY_MAX = 60;
  const tempHistory = []; // array of {label: temp} maps

  function pushTempHistory(sensors) {
    const frame = {};
    sensors.forEach(s => { frame[s.label] = s.current; });
    tempHistory.push(frame);
    if (tempHistory.length > TEMP_HISTORY_MAX) tempHistory.shift();
  }

  function drawTempGraph(canvas, sensors) {
    if (!canvas || !canvas.getContext || sensors.length === 0 || tempHistory.length < 2) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    // Y range across all history
    let minT = Infinity, maxT = -Infinity;
    tempHistory.forEach(f => Object.values(f).forEach(t => {
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }));
    minT = Math.max(0, minT - 5);
    maxT = maxT + 5;
    const range = maxT - minT || 1;

    const offset = TEMP_HISTORY_MAX - tempHistory.length;
    const toX = (fi) => ((offset + fi) / (TEMP_HISTORY_MAX - 1)) * w;
    const toY = (t)  => h - 2 - ((t - minT) / range) * (h - 10);

    // Grid lines
    const step = range > 40 ? 20 : range > 20 ? 10 : 5;
    const firstGrid = Math.ceil(minT / step) * step;
    ctx.strokeStyle = '#2e2e2e';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    for (let t = firstGrid; t <= maxT; t += step) {
      const y = Math.round(toY(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(t + '°', 3, y - 2);
    }

    // One line per sensor
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    sensors.forEach((sensor, si) => {
      ctx.strokeStyle = TEMP_COLORS[si % TEMP_COLORS.length];
      ctx.beginPath();
      let started = false;
      tempHistory.forEach((f, fi) => {
        const t = f[sensor.label];
        if (t === undefined) return;
        const x = toX(fi), y = toY(t);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      });
      if (started) ctx.stroke();
    });
  }

  // ── Minecraft player-count history ──────────────────────────────────────────

  function fmtGameTime(seconds) {
    if (seconds < 60) return '< 1m';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h === 0) return m + 'm';
    return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
  }

  function drawMcGraph(canvas, history, maxPlayers) {
    if (!canvas || !canvas.getContext || history.length < 2) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const peak = Math.max(...history, 1);
    const maxY = Math.max(maxPlayers || 1, peak);
    const toX = (i) => (i / (history.length - 1)) * w;
    const toY = (v) => h - 2 - (v / maxY) * (h - 14);

    // Grid lines (one per player slot, max 10)
    const step = maxY <= 10 ? 1 : Math.ceil(maxY / 10);
    ctx.strokeStyle = '#2e2e2e';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    for (let v = 0; v <= maxY; v += step) {
      const y = Math.round(toY(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(v, 3, y - 2);
    }

    // Time labels
    ctx.fillStyle = '#444';
    ctx.textAlign = 'right';
    const mins = Math.round(history.length * 0.5);
    ctx.fillText('← ' + (mins >= 60 ? Math.round(mins / 60) + 'h' : mins + 'm') + ' ago', w - 4, h - 2);

    // Player count line with fill
    ctx.strokeStyle = '#4caf50';
    ctx.fillStyle = 'rgba(76,175,80,0.12)';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    history.forEach((count, i) => {
      const x = toX(i), y = toY(count);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // Fill below
    ctx.lineTo(toX(history.length - 1), h);
    ctx.lineTo(toX(0), h);
    ctx.closePath();
    ctx.fill();
  }

  // ── Network rate history ─────────────────────────────────────────────────────

  const NET_HISTORY_MAX = 60;
  const netHistory = []; // array of {recv, sent}

  function pushNetHistory(network) {
    netHistory.push({ recv: network.rate_recv_bps, sent: network.rate_sent_bps });
    if (netHistory.length > NET_HISTORY_MAX) netHistory.shift();
  }

  function drawNetGraph(canvas) {
    if (!canvas || !canvas.getContext || netHistory.length < 2) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    let maxRate = 0;
    netHistory.forEach(f => {
      if (f.recv > maxRate) maxRate = f.recv;
      if (f.sent > maxRate) maxRate = f.sent;
    });
    maxRate = (maxRate * 1.1) || 1024;

    const offset = NET_HISTORY_MAX - netHistory.length;
    const toX = (fi) => ((offset + fi) / (NET_HISTORY_MAX - 1)) * w;
    const toY = (v)  => h - 2 - (v / maxRate) * (h - 14);

    // Grid lines
    ctx.strokeStyle = '#2e2e2e';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    for (let i = 0; i <= 2; i++) {
      const v = (maxRate * i) / 2;
      const y = Math.round(toY(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(fmtBytes(v) + '/s', 3, y - 2);
    }

    const drawLine = (color, key) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      netHistory.forEach((f, fi) => {
        const x = toX(fi), y = toY(f[key]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      });
      if (started) ctx.stroke();
    };
    drawLine('#e22828', 'recv');
    drawLine('#4caf50', 'sent');
  }

  function mountCanvas(id, drawFn) {
    setTimeout(() => {
      const canvas = document.getElementById(id);
      if (!canvas) return;
      canvas.width  = canvas.offsetWidth  || canvas.parentElement?.offsetWidth || 600;
      canvas.height = canvas.offsetHeight || 180;
      drawFn(canvas);
    }, 0);
  }

  // ── Historical trend chart (timestamped data) ────────────────────────────────

  function downsampleArr(arr, n) {
    if (arr.length <= n) return arr;
    return Array.from({length: n}, (_, i) => arr[Math.floor(i * arr.length / n)]);
  }

  function drawHistChart(canvas, points, strokeHex, fmtY) {
    // points: [[epoch, value], ...]
    if (!canvas || !canvas.getContext) return;
    const valid = points.filter(p => p[1] !== null && p[1] !== undefined);
    if (valid.length < 2) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const vals = valid.map(p => p[1]);
    let minV = Math.min(...vals);
    let maxV = Math.max(...vals);
    const pad = (maxV - minV) * 0.1 || 1;
    minV = Math.max(0, minV - pad);
    maxV = maxV + pad;
    const range = maxV - minV || 1;

    const t0 = valid[0][0];
    const t1 = valid[valid.length - 1][0];
    const tRange = t1 - t0 || 1;
    const toX = t => ((t - t0) / tRange) * w;
    const toY = v => h - 2 - ((v - minV) / range) * (h - 16);

    // Y grid lines
    ctx.strokeStyle = '#2e2e2e';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    for (let i = 0; i <= 3; i++) {
      const v = minV + range * i / 3;
      const y = Math.round(toY(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(fmtY(v), 3, y - 2);
    }

    // X axis label (time span)
    const spanSecs = tRange;
    let timeLabel;
    if (spanSecs >= 86400 * 2) timeLabel = Math.round(spanSecs / 86400) + 'd';
    else if (spanSecs >= 3600) timeLabel = Math.round(spanSecs / 3600) + 'h';
    else timeLabel = Math.round(spanSecs / 60) + 'm';
    ctx.fillStyle = '#444';
    ctx.textAlign = 'right';
    ctx.fillText('← ' + timeLabel + ' ago', w - 4, h - 2);

    // Parse hex colour to r,g,b for fill alpha
    let r = 128, g = 128, b = 128;
    if (strokeHex && strokeHex.length === 7) {
      r = parseInt(strokeHex.slice(1, 3), 16);
      g = parseInt(strokeHex.slice(3, 5), 16);
      b = parseInt(strokeHex.slice(5, 7), 16);
    }

    ctx.strokeStyle = strokeHex;
    ctx.fillStyle = `rgba(${r},${g},${b},0.12)`;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    valid.forEach((p, i) => {
      const x = toX(p[0]), y = toY(p[1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.lineTo(toX(valid[valid.length - 1][0]), h);
    ctx.lineTo(toX(valid[0][0]), h);
    ctx.closePath();
    ctx.fill();
  }

  // ── Spotify ──────────────────────────────────────────────────────────────────

  // Local progress interpolation — updated on every poll
  let _spLastPoll = 0;
  let _spProgressMs = 0;
  let _spDurationMs = 0;
  let _spPlaying = false;
  let _spProgressTimer = null;

  function _startSpProgressTimer() {
    if (_spProgressTimer) return;
    _spProgressTimer = setInterval(() => {
      if (!_spPlaying || !_spDurationMs) return;
      const elapsed = Date.now() - _spLastPoll;
      const pos = Math.min(_spProgressMs + elapsed, _spDurationMs);
      const pct = (pos / _spDurationMs) * 100;
      const bar = $('spotify-bar');
      const posEl = $('spotify-pos');
      if (bar) bar.style.width = pct.toFixed(1) + '%';
      if (posEl) posEl.textContent = fmtMs(pos);
      const dBar = $('sp-det-bar');
      const dPos = $('sp-det-pos');
      if (dBar) dBar.style.width = pct.toFixed(1) + '%';
      if (dPos) dPos.textContent = fmtMs(pos);
    }, 500);
  }

  async function _spotifyControl(action, params) {
    try {
      const r = await fetch('/api/spotify/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
      });
      if (r.ok) setTimeout(() => { if (currentModule === 'spotify') renderDetail(); else tick(); }, 300);
    } catch (e) {
      console.error('Spotify control failed:', e);
    }
  }

  function renderSpotify(sp) {
    const card = $('card-spotify');
    if (!sp || !sp.configured) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    const chev = $('spotify-chevron');
    if (chev) chev.style.display = sp.authorized ? '' : 'none';

    if (!sp.authorized) {
      $('spotify-meta').textContent = 'not authorised';
      const uriNote = sp.redirect_uri
        ? '<p class="spotify-auth-uri">Add this Redirect URI in your ' +
            '<a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Spotify app settings</a>:' +
            '<br><code>' + esc(sp.redirect_uri) + '</code></p>'
        : '';
      $('spotify-body').innerHTML =
        '<div class="spotify-auth">' +
          '<p>Authorise Brainless-Dash to read and control Spotify playback.</p>' +
          uriNote +
          '<a href="/api/spotify/auth" class="spotify-auth-btn">Connect Spotify</a>' +
        '</div>';
      return;
    }

    if (!sp.active) {
      $('spotify-meta').textContent = sp.device_name || 'idle';
      $('spotify-body').innerHTML = '<div class="spotify-idle">No active playback</div>';
      _spPlaying = false;
      return;
    }

    // Update local progress interpolation
    _spLastPoll    = Date.now();
    _spProgressMs  = sp.progress_ms || 0;
    _spDurationMs  = sp.duration_ms || 0;
    _spPlaying     = sp.is_playing;
    _startSpProgressTimer();

    const pct = _spDurationMs > 0 ? Math.min(100, (_spProgressMs / _spDurationMs) * 100) : 0;

    $('spotify-meta').textContent = sp.device_name || '';

    const artHtml = sp.art_url
      ? '<img class="spotify-art" src="' + esc(sp.art_url) + '" alt="">'
      : '<div class="spotify-art spotify-art-empty"></div>';

    const shuffleCls = sp.shuffle ? ' active' : '';
    const repeatCls  = sp.repeat !== 'off' ? ' active' : '';
    const repeatTitle = sp.repeat === 'track' ? 'Repeat: track' : sp.repeat === 'context' ? 'Repeat: playlist' : 'Repeat: off';

    const volHtml = sp.volume != null
      ? '<label class="spotify-vol">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>' +
          '<input type="range" class="spotify-vol-range" min="0" max="100" value="' + sp.volume + '" aria-label="Volume">' +
        '</label>'
      : '';

    $('spotify-body').innerHTML =
      '<div class="spotify-now-playing">' +
        artHtml +
        '<div class="spotify-info">' +
          '<div class="spotify-track">' + esc(sp.track || '—') + '</div>' +
          '<div class="spotify-artist">' + esc(sp.artist || '—') + '</div>' +
          (sp.album ? '<div class="spotify-album">' + esc(sp.album) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="spotify-progress">' +
        '<span id="spotify-pos" class="spotify-time">' + fmtMs(sp.progress_ms) + '</span>' +
        '<div class="bar spotify-prog-bar"><div class="bar-fill spotify-prog-fill" id="spotify-bar" style="width:' + pct.toFixed(1) + '%"></div></div>' +
        '<span class="spotify-time">' + fmtMs(sp.duration_ms) + '</span>' +
      '</div>' +
      '<div class="spotify-controls">' +
        '<button class="spotify-btn' + shuffleCls + '" id="sp-shuffle" title="' + (sp.shuffle ? 'Shuffle on' : 'Shuffle off') + '" aria-pressed="' + sp.shuffle + '">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>' +
        '</button>' +
        '<button class="spotify-btn" id="sp-prev" title="Previous">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>' +
        '</button>' +
        '<button class="spotify-btn spotify-btn-play" id="sp-toggle" title="' + (sp.is_playing ? 'Pause' : 'Play') + '">' +
          (sp.is_playing
            ? '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>') +
        '</button>' +
        '<button class="spotify-btn" id="sp-next" title="Next">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>' +
        '</button>' +
        '<button class="spotify-btn' + repeatCls + '" id="sp-repeat" title="' + repeatTitle + '" aria-label="' + repeatTitle + '">' +
          (sp.repeat === 'track'
            ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>') +
        '</button>' +
        volHtml +
      '</div>';

    // Wire buttons
    const nextRepeat = { off: 'context', context: 'track', track: 'off' }[sp.repeat] || 'off';

    $('sp-shuffle').addEventListener('click', () => _spotifyControl('shuffle', { state: !sp.shuffle }));
    $('sp-prev').addEventListener('click',    () => _spotifyControl('previous'));
    $('sp-toggle').addEventListener('click',  () => _spotifyControl(sp.is_playing ? 'pause' : 'play'));
    $('sp-next').addEventListener('click',    () => _spotifyControl('next'));
    $('sp-repeat').addEventListener('click',  () => _spotifyControl('repeat', { mode: nextRepeat }));

    // Volume: debounce to avoid flooding the API
    const volRange = document.querySelector('.spotify-vol-range');
    if (volRange) {
      let volTimer = null;
      volRange.addEventListener('input', () => {
        clearTimeout(volTimer);
        volTimer = setTimeout(() => _spotifyControl('volume', { volume_percent: parseInt(volRange.value, 10) }), 400);
      });
    }
  }

  // ── Weather ──────────────────────────────────────────────────────────────────

  let _weatherCoords = null; // {lat, lon} once geolocation is granted

  const _WEATHER_ICONS = {
    'clear': (day) => day
      ? `<svg class="wx-icon" viewBox="0 0 48 48"><circle cx="24" cy="24" r="9" fill="#fbbf24"/><g stroke="#fbbf24" stroke-width="3" stroke-linecap="round"><line x1="24" y1="5" x2="24" y2="11"/><line x1="24" y1="37" x2="24" y2="43"/><line x1="5" y1="24" x2="11" y2="24"/><line x1="37" y1="24" x2="43" y2="24"/><line x1="9.4" y1="9.4" x2="13.7" y2="13.7"/><line x1="34.3" y1="34.3" x2="38.6" y2="38.6"/><line x1="38.6" y1="9.4" x2="34.3" y2="13.7"/><line x1="13.7" y1="34.3" x2="9.4" y2="38.6"/></g></svg>`
      : `<svg class="wx-icon" viewBox="0 0 48 48"><path d="M24 8a16 16 0 000 32 16 16 0 000-32zm0 4a12 12 0 010 24 12 12 0 010-24z" fill="#c7d2fe" opacity=".4"/><path d="M32 24a8 8 0 11-16 0 8 8 0 0116 0z" fill="#e2e8f0"/></svg>`,
    'partly-cloudy': () =>
      `<svg class="wx-icon" viewBox="0 0 48 48"><circle cx="18" cy="20" r="7" fill="#fbbf24"/><path d="M34 22h-.8a9 9 0 00-18 0H14a7 7 0 000 14h20a5 5 0 000-10z" fill="#e2e8f0"/></svg>`,
    'cloudy': () =>
      `<svg class="wx-icon" viewBox="0 0 48 48"><path d="M36 20h-.8a11 11 0 00-22 0H12a9 9 0 000 18h24a6 6 0 000-12z" fill="#94a3b8"/></svg>`,
    'fog': () =>
      `<svg class="wx-icon" viewBox="0 0 48 48" stroke="#94a3b8" stroke-width="3" stroke-linecap="round"><line x1="8" y1="18" x2="40" y2="18"/><line x1="8" y1="24" x2="40" y2="24"/><line x1="8" y1="30" x2="32" y2="30"/><line x1="8" y1="36" x2="26" y2="36"/></svg>`,
    'drizzle': () =>
      `<svg class="wx-icon" viewBox="0 0 48 48"><path d="M34 18h-.8a9 9 0 00-18 0H14a7 7 0 000 14h20a5 5 0 000-10z" fill="#94a3b8"/><g stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="36" x2="16" y2="40"/><line x1="24" y1="36" x2="22" y2="40"/><line x1="30" y1="36" x2="28" y2="40"/></g></svg>`,
    'rain': () =>
      `<svg class="wx-icon" viewBox="0 0 48 48"><path d="M34 16h-.8a9 9 0 00-18 0H14a7 7 0 000 14h20a5 5 0 000-10z" fill="#64748b"/><g stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round"><line x1="17" y1="34" x2="14" y2="42"/><line x1="24" y1="34" x2="21" y2="42"/><line x1="31" y1="34" x2="28" y2="42"/></g></svg>`,
    'showers': () =>
      `<svg class="wx-icon" viewBox="0 0 48 48"><path d="M34 16h-.8a9 9 0 00-18 0H14a7 7 0 000 14h20a5 5 0 000-10z" fill="#64748b"/><g stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round"><line x1="17" y1="34" x2="14" y2="42"/><line x1="24" y1="34" x2="21" y2="42"/><line x1="31" y1="34" x2="28" y2="42"/></g></svg>`,
    'snow': () =>
      `<svg class="wx-icon" viewBox="0 0 48 48"><path d="M34 16h-.8a9 9 0 00-18 0H14a7 7 0 000 14h20a5 5 0 000-10z" fill="#94a3b8"/><g stroke="#bfdbfe" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="35" x2="18" y2="42"/><line x1="24" y1="35" x2="24" y2="42"/><line x1="30" y1="35" x2="30" y2="42"/><line x1="15" y1="38.5" x2="21" y2="38.5"/><line x1="21" y1="38.5" x2="27" y2="38.5"/><line x1="27" y1="38.5" x2="33" y2="38.5"/></g></svg>`,
    'snow-showers': () =>
      `<svg class="wx-icon" viewBox="0 0 48 48"><path d="M34 16h-.8a9 9 0 00-18 0H14a7 7 0 000 14h20a5 5 0 000-10z" fill="#94a3b8"/><g stroke="#bfdbfe" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="35" x2="18" y2="42"/><line x1="24" y1="35" x2="24" y2="42"/><line x1="30" y1="35" x2="30" y2="42"/></g></svg>`,
    'thunderstorm': () =>
      `<svg class="wx-icon" viewBox="0 0 48 48"><path d="M34 14h-.8a9 9 0 00-18 0H14a7 7 0 000 14h20a5 5 0 000-10z" fill="#475569"/><polyline points="26,28 21,36 25,36 20,44" fill="none" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };

  function _wxIcon(icon, isDay) {
    const fn = _WEATHER_ICONS[icon] || _WEATHER_ICONS['cloudy'];
    return fn(isDay);
  }

  function _windDir(deg) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round((deg || 0) / 45) % 8];
  }

  function renderWeather(data) {
    const card = $('card-weather');
    if (!data || !data.available) {
      if (data && data.error) {
        card.style.display = '';
        $('weather-location').textContent = 'unavailable';
        $('weather-body').innerHTML = '<div class="empty">Weather unavailable: ' + esc(data.error) + '</div>';
      }
      return;
    }
    card.style.display = '';
    $('weather-location').textContent = data.location || '';

    const t  = data.temp  != null ? Math.round(data.temp)  : '—';
    const fl = data.feels_like != null ? Math.round(data.feels_like) : null;
    const hi = data.high != null ? Math.round(data.high) : '—';
    const lo = data.low  != null ? Math.round(data.low)  : '—';
    const u  = data.temp_unit || '°C';
    const wu = data.wind_unit || 'km/h';

    const feelsHtml = fl != null && fl !== t
      ? '<div class="wx-feels">Feels like ' + fl + u + '</div>'
      : '';

    const detailItems = [
      '<span class="wx-detail-item"><span class="wx-detail-label">High</span><span class="wx-detail-val">' + hi + u + '</span></span>',
      '<span class="wx-detail-item"><span class="wx-detail-label">Low</span><span class="wx-detail-val">' + lo + u + '</span></span>',
      data.humidity != null ? '<span class="wx-detail-item"><span class="wx-detail-label">Humidity</span><span class="wx-detail-val">' + data.humidity + '%</span></span>' : '',
      data.wind != null ? '<span class="wx-detail-item"><span class="wx-detail-label">Wind</span><span class="wx-detail-val">' + Math.round(data.wind) + ' ' + wu + '</span></span>' : '',
      data.precip_pct != null ? '<span class="wx-detail-item"><span class="wx-detail-label">Rain</span><span class="wx-detail-val">' + data.precip_pct + '%</span></span>' : '',
    ].filter(Boolean).join('');

    $('weather-body').innerHTML =
      '<div class="wx-main">' +
        '<div class="wx-icon-wrap">' + _wxIcon(data.icon, data.is_day) + '</div>' +
        '<div class="wx-current">' +
          '<div class="wx-temp">' + t + u + '</div>' +
          '<div class="wx-condition">' + esc(data.condition) + '</div>' +
          feelsHtml +
        '</div>' +
      '</div>' +
      '<div class="wx-details">' + detailItems + '</div>';
  }

  function _startWeatherPolling() {
    if (!navigator.geolocation) {
      $('card-weather').style.display = '';
      $('weather-location').textContent = 'unavailable';
      $('weather-body').innerHTML = '<div class="empty">Geolocation not supported by this browser</div>';
      return;
    }

    const fetchWeather = () => {
      if (!_weatherCoords) return;
      const { lat, lon } = _weatherCoords;
      fetch('/api/weather?lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon), { cache: 'no-store' })
        .then(r => r.ok ? r.json() : Promise.reject('HTTP ' + r.status))
        .then(data => renderWeather(data))
        .catch(e => console.error('Weather fetch failed:', e));
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        _weatherCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        fetchWeather();
        setInterval(fetchWeather, 10 * 60 * 1000); // re-poll every 10 min
      },
      (err) => {
        // Permission denied or unavailable — keep card hidden
        console.debug('Geolocation denied:', err.message);
      },
      { timeout: 10000, maximumAge: 300000 }
    );
  }

  // ── Weather detail ──────────────────────────────────────────────────────────

  function renderWeatherDetail(data) {
    if (!data || !data.available) {
      $('detail-body').innerHTML = '<div class="detail-section"><div class="empty">Weather unavailable</div></div>';
      $('detail-meta').textContent = '';
      return;
    }

    $('detail-meta').textContent = data.location || '';

    const u  = data.temp_unit || '°C';
    const wu = data.wind_unit || 'km/h';

    // 7-day forecast strip
    let forecastHtml = '';
    if (data.forecast && data.forecast.length) {
      const days = data.forecast.map(day => {
        const dt      = new Date(day.date + 'T12:00:00');
        const dayName = dt.toLocaleDateString('en-AU', { weekday: 'short' });
        const hi      = day.high  != null ? Math.round(day.high)  + esc(u) : '—';
        const lo      = day.low   != null ? Math.round(day.low)   + esc(u) : '—';
        const precip  = day.precip_pct != null ? day.precip_pct + '%' : '';
        const windStr = day.wind_max != null
          ? Math.round(day.wind_max) + ' ' + esc(wu) + (day.wind_dir != null ? ' ' + _windDir(day.wind_dir) : '')
          : '';
        return '<div class="wx-forecast-day">' +
          '<div class="wx-forecast-name">' + esc(dayName) + '</div>' +
          '<div class="wx-forecast-icon">' + _wxIcon(day.icon, true) + '</div>' +
          '<div class="wx-forecast-hi">' + hi + '</div>' +
          '<div class="wx-forecast-lo">' + lo + '</div>' +
          (precip  ? '<div class="wx-forecast-precip">' + esc(precip) + '</div>' : '<div class="wx-forecast-precip"></div>') +
          (windStr ? '<div class="wx-forecast-wind">' + windStr + '</div>' : '') +
          '</div>';
      }).join('');
      forecastHtml = '<div class="detail-section"><h3>7-day Forecast</h3>' +
        '<div class="wx-forecast-grid">' + days + '</div></div>';
    }

    // Marine wave/swell section
    let marineHtml = '';
    if (data.marine && data.marine.length) {
      const byDay = {};
      data.marine.forEach(h => {
        const d = h.time.substring(0, 10);
        if (!byDay[d]) byDay[d] = [];
        byDay[d].push(h);
      });

      const dayBlocks = Object.entries(byDay).map(([date, hours]) => {
        const dt       = new Date(date + 'T12:00:00');
        const dayLabel = dt.toLocaleDateString('en-AU', { weekday: 'long', month: 'short', day: 'numeric' });
        // Sample every 3 hours
        const rows = hours.filter((_, i) => i % 3 === 0).map(h => {
          const time   = h.time.substring(11, 16);
          const wave   = h.wave_height   != null ? h.wave_height.toFixed(1)   + ' m' : '—';
          const swell  = h.swell_height  != null ? h.swell_height.toFixed(1)  + ' m' : '—';
          const dir    = h.swell_dir     != null ? _windDir(h.swell_dir)              : '—';
          const period = h.swell_period  != null ? h.swell_period.toFixed(0)  + ' s' : '—';
          return '<div class="marine-row">' +
            '<span class="marine-time">'   + esc(time)   + '</span>' +
            '<span class="marine-wave">'   + esc(wave)   + '</span>' +
            '<span class="marine-swell">'  + esc(swell)  + '</span>' +
            '<span class="marine-dir">'    + esc(dir)    + '</span>' +
            '<span class="marine-period">' + esc(period) + '</span>' +
            '</div>';
        }).join('');
        return '<div class="marine-day">' +
          '<div class="marine-day-label">' + esc(dayLabel) + '</div>' +
          '<div class="marine-header">' +
            '<span>Time</span><span>Wave</span><span>Swell</span><span>Dir</span><span>Period</span>' +
          '</div>' + rows + '</div>';
      }).join('');

      marineHtml = '<div class="detail-section"><h3>Marine Conditions</h3>' +
        dayBlocks + '</div>';
    }

    $('detail-body').innerHTML = forecastHtml + marineHtml;
  }

  // ── Layout drag-to-reorder ───────────────────────────────────────────────────

  let _layoutUnlocked = false;
  let _dragState      = null;
  let _refreshTimer   = null;

  const _LOCK_SVG   = '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="4" y="10" width="12" height="9" rx="1.5"/><path d="M7 10V7.5a3 3 0 016 0V10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const _UNLOCK_SVG = '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="4" y="10" width="12" height="9" rx="1.5"/><path d="M7 10V7a3 3 0 016 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  function _saveCardOrder() {
    const ids = Array.from(document.querySelectorAll('.content > .card'))
      .map(c => c.id).filter(Boolean);
    try { localStorage.setItem('bd-card-order', JSON.stringify(ids)); } catch (_) {}
  }

  function _applyCardOrder() {
    try {
      const order = JSON.parse(localStorage.getItem('bd-card-order') || '[]');
      if (!order.length) return;
      const content = document.querySelector('.content');
      order.forEach(id => {
        const card = document.getElementById(id);
        if (card && card.parentNode === content) content.appendChild(card);
      });
    } catch (_) {}
  }

  function _onDragPointerDown(e) {
    if (!_layoutUnlocked || _dragState) return;
    if (e.target.closest('a, button, input, label')) return;
    e.preventDefault();

    const card = e.currentTarget;
    card.setPointerCapture(e.pointerId);
    card.addEventListener('pointermove',   _onDragPointerMove);
    card.addEventListener('pointerup',     _onDragPointerUp);
    card.addEventListener('pointercancel', _onDragPointerUp);

    // Store start position; ghost/placeholder are created only after threshold
    _dragState = { card, ghost: null, ph: null, active: false,
                   startX: e.clientX, startY: e.clientY,
                   offsetX: 0, offsetY: 0 };
  }

  function _activateDrag(e) {
    const { card } = _dragState;
    const rect    = card.getBoundingClientRect();
    const content = document.querySelector('.content');

    const ghost = document.createElement('div');
    ghost.className = 'card card-drag-ghost';
    ghost.innerHTML = card.innerHTML;
    ghost.style.width  = rect.width  + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.left   = rect.left   + 'px';
    ghost.style.top    = rect.top    + 'px';
    document.body.appendChild(ghost);

    const ph = document.createElement('div');
    ph.className = 'card-drag-placeholder';
    ph.style.gridColumn = getComputedStyle(card).gridColumn;
    ph.style.height     = rect.height + 'px';
    content.insertBefore(ph, card);
    card.style.display = 'none';

    clearInterval(_refreshTimer);

    _dragState.ghost   = ghost;
    _dragState.ph      = ph;
    _dragState.active  = true;
    _dragState.offsetX = _dragState.startX - rect.left;
    _dragState.offsetY = _dragState.startY - rect.top;
  }

  function _onDragPointerMove(e) {
    if (!_dragState || _dragState.card !== e.currentTarget) return;

    if (!_dragState.active) {
      // Only activate once the pointer has moved far enough to be intentional
      if (Math.hypot(e.clientX - _dragState.startX, e.clientY - _dragState.startY) < 8) return;
      _activateDrag(e);
    }

    const { ghost, ph, offsetX, offsetY } = _dragState;
    ghost.style.left = (e.clientX - offsetX) + 'px';
    ghost.style.top  = (e.clientY - offsetY) + 'px';

    const content  = document.querySelector('.content');
    const ghostCY  = e.clientY - offsetY + ghost.offsetHeight / 2;

    // Find the card whose centre Y is closest to the ghost centre Y.
    // Using Y only (not 2D distance) prevents left/right inversion in multi-column grids.
    const cards = Array.from(content.querySelectorAll('.card'))
      .filter(c => c !== ph && getComputedStyle(c).display !== 'none');
    let best = null, bestDist = Infinity;
    for (const c of cards) {
      const r  = c.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const d  = Math.abs(ghostCY - cy);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    if (!best) return;

    const br  = best.getBoundingClientRect();
    const bcy = br.top + br.height / 2;
    if (ghostCY < bcy) {
      if (ph.nextSibling !== best) content.insertBefore(ph, best);
    } else {
      if (best.nextSibling !== ph) best.after(ph);
    }
  }

  function _onDragPointerUp(e) {
    if (!_dragState || _dragState.card !== e.currentTarget) return;
    const { card, ghost, ph, active } = _dragState;

    card.removeEventListener('pointermove',   _onDragPointerMove);
    card.removeEventListener('pointerup',     _onDragPointerUp);
    card.removeEventListener('pointercancel', _onDragPointerUp);

    if (active) {
      ph.parentNode.insertBefore(card, ph);
      card.style.display = '';
      ghost.remove();
      ph.remove();
      _saveCardOrder();
      _refreshTimer = setInterval(() => { if (currentModule) renderDetail(); else tick(); }, REFRESH_MS);
    }

    _dragState = null;
  }

  function _setLayoutLocked() {
    _layoutUnlocked = false;
    document.querySelector('.content').classList.remove('layout-unlocked');
    const btn = $('layout-lock-btn');
    btn.innerHTML = _LOCK_SVG;
    btn.setAttribute('aria-pressed', 'false');
    btn.title = 'Unlock layout to rearrange cards';
    btn.classList.remove('unlocked');
    document.querySelectorAll('.content > .card').forEach(c => {
      c.removeEventListener('pointerdown', _onDragPointerDown);
    });
    _saveCardOrder();
  }

  function _setLayoutUnlocked() {
    _layoutUnlocked = true;
    document.querySelector('.content').classList.add('layout-unlocked');
    const btn = $('layout-lock-btn');
    btn.innerHTML = _UNLOCK_SVG;
    btn.setAttribute('aria-pressed', 'true');
    btn.title = 'Lock layout';
    btn.classList.add('unlocked');
    document.querySelectorAll('.content > .card').forEach(c => {
      c.removeEventListener('pointerdown', _onDragPointerDown);
      c.addEventListener('pointerdown', _onDragPointerDown);
    });
  }

  // ── Sonarr change detection ──────────────────────────────────────────────────

  let _sonarrHash = '';
  function sonarrKey(episodes) {
    return episodes.map(e => e.air_date + e.show + e.episode + e.downloaded).join('|');
  }

  // ── Main render ──────────────────────────────────────────────────────────────

  function render(d) {
    $('hostname').textContent = d.hostname || 'unknown';
    $('status-dot').className = 'dot dot-on';

    // CPU & Memory (merged with system info)
    $('uptime').textContent = 'up ' + fmtUptime(d.uptime);
    $('load1').textContent  = d.cpu.load_1m.toFixed(2) + ' · ' + d.cpu.load_5m.toFixed(2) + ' · ' + d.cpu.load_15m.toFixed(2);
    $('cores').textContent  = d.cpu.cores + ' / ' + d.cpu.threads + 't';

    const cpuPct = d.cpu.percent;
    $('cpu-percent').textContent = cpuPct.toFixed(0);
    $('cpu-freq').textContent = d.cpu.freq_mhz ? '@ ' + (d.cpu.freq_mhz / 1000).toFixed(2) + ' GHz' : '';
    const cpuBar = $('cpu-bar');
    cpuBar.style.width = cpuPct + '%';
    cpuBar.className = 'bar-fill ' + barClass(cpuPct);

    const m = d.memory;
    $('mem-used').textContent = fmtBytes(m.used);
    $('mem-total').textContent = fmtBytes(m.total);
    const memBar = $('mem-bar');
    memBar.style.width = m.percent + '%';
    memBar.className = 'bar-fill ' + barClass(m.percent);
    $('mem-available').textContent = fmtBytes(m.available);
    $('swap').textContent = m.swap_total > 0
      ? fmtBytes(m.swap_used) + ' / ' + fmtBytes(m.swap_total) + ' (' + m.swap_percent.toFixed(0) + '%)'
      : 'none';

    // Temperatures
    const temps = d.temps || [];
    const fans  = d.fans  || [];
    if (temps.length > 0) pushTempHistory(temps);
    pushNetHistory(d.network);

    if (temps.length === 0) {
      $('temp-count').textContent = '0 sensors';
      $('sensor-list').innerHTML = '<div class="empty">no sensors detected (mount /sys in container)</div>';
    } else {
      const fanLabel = fans.length ? ' · ' + fans.length + (fans.length === 1 ? ' fan' : ' fans') : '';
      $('temp-count').textContent = temps.length + (temps.length === 1 ? ' sensor' : ' sensors') + fanLabel;
      const rows = temps.map((s, si) => {
        const color = TEMP_COLORS[si % TEMP_COLORS.length];
        const cls = tempClass(s.current, s.high, s.critical);
        return '<div class="sensor-row">' +
          '<span class="sensor-row-dot" style="background:' + color + '"></span>' +
          '<span class="sensor-row-label">' + esc(s.label) + '</span>' +
          '<span class="sensor-row-value ' + cls + '">' + s.current.toFixed(1) + '°C</span>' +
          '</div>';
      });
      if (fans.length) {
        rows.push('<div class="sensor-sep"></div>');
        fans.forEach(f => {
          rows.push('<div class="sensor-row">' +
            '<span class="sensor-row-dot" style="background:var(--border)"></span>' +
            '<span class="sensor-row-label">' + esc(f.label) + '</span>' +
            '<span class="sensor-row-value">' + f.rpm.toLocaleString() + ' RPM</span>' +
            '</div>');
        });
      }
      $('sensor-list').innerHTML = rows.join('');
    }

    // Storage
    const dList = $('disk-list');
    let totalUsed = 0, totalSize = 0;
    if (!d.storage.disks.length) {
      dList.innerHTML = '<div class="empty">no mounts found</div>';
      $('storage-summary').textContent = '0 mounts';
    } else {
      dList.innerHTML = d.storage.disks.map(disk => {
        totalUsed += disk.used;
        totalSize += disk.total;
        return '<div class="disk-item">' +
          '<div class="disk-head">' +
            '<span class="disk-name">' + esc(disk.name) + '</span>' +
            '<span class="disk-stats">' + fmtBytes(disk.used) + ' / ' + fmtBytes(disk.total) + ' (' + disk.percent.toFixed(0) + '%)</span>' +
          '</div>' +
          '<div class="bar"><div class="bar-fill ' + barClass(disk.percent) + '" style="width:' + disk.percent + '%"></div></div>' +
          '</div>';
      }).join('');
      const overall = totalSize > 0 ? ((totalUsed / totalSize) * 100).toFixed(0) : 0;
      $('storage-summary').textContent = fmtBytes(totalUsed) + ' / ' + fmtBytes(totalSize) + ' (' + overall + '%)';
    }

    // Network
    $('net-down').textContent = fmtRate(d.network.rate_recv_bps);
    $('net-up').textContent   = fmtRate(d.network.rate_sent_bps);
    const ifaceCount = (d.network.interfaces || []).length;
    $('net-iface-count').textContent = ifaceCount + (ifaceCount === 1 ? ' interface' : ' interfaces');

    // Sonarr — skip DOM rebuild if episodes haven't changed
    const sonarrCard = $('card-sonarr');
    if (d.sonarr) {
      sonarrCard.style.display = '';
      const sonarr = d.sonarr;
      const list = $('sonarr-list');
      if (!sonarr.available) {
        const msg = sonarr.error ? 'sonarr unavailable: ' + esc(sonarr.error) : 'sonarr unavailable';
        list.innerHTML = '<div class="empty">' + msg + '</div>';
        $('sonarr-count').textContent = '';
      } else {
        const hash = sonarrKey(sonarr.episodes);
        if (hash !== _sonarrHash) {
          _sonarrHash = hash;
          if (!sonarr.episodes.length) {
            list.innerHTML = '<div class="empty">no episodes in the next 5 days</div>';
            $('sonarr-count').textContent = 'nothing upcoming';
          } else {
            $('sonarr-count').textContent = sonarr.episodes.length + (sonarr.episodes.length === 1 ? ' episode' : ' episodes');
            const days = [], dayMap = {};
            sonarr.episodes.forEach(ep => {
              if (!dayMap[ep.air_date]) { dayMap[ep.air_date] = []; days.push(ep.air_date); }
              dayMap[ep.air_date].push(ep);
            });
            list.innerHTML = days.map(d2 => {
              const eps = dayMap[d2];
              return '<div class="sonarr-day">' +
                '<div class="sonarr-day-label">' + esc(eps[0].day_label) + '</div>' +
                eps.map(ep => {
                  const epNum = 'S' + String(ep.season).padStart(2, '0') + 'E' + String(ep.episode).padStart(2, '0');
                  const badge = ep.downloaded
                    ? '<span class="sonarr-badge downloaded">Downloaded</span>'
                    : '<span class="sonarr-badge upcoming">Upcoming</span>';
                  return '<div class="sonarr-episode">' +
                    '<div class="sonarr-left">' +
                      '<span class="sonarr-show">' + esc(ep.show) + '</span>' +
                      '<span class="sonarr-ep-title">' + esc(ep.title) + '</span>' +
                    '</div>' +
                    '<div class="sonarr-right"><span class="sonarr-ep-num">' + epNum + '</span>' + badge + '</div>' +
                    '</div>';
                }).join('') +
                '</div>';
            }).join('');
          }
        }
      }
    } else {
      sonarrCard.style.display = 'none';
    }

    // Plex
    const plexCard = $('card-plex');
    if (d.plex) {
      plexCard.style.display = '';
      const plex = d.plex;
      $('plex-count').textContent = plex.stream_count === 1 ? '1 stream' : plex.stream_count + ' streams';
      const streamList = $('plex-streams');
      if (!plex.available) {
        const msg = plex.error ? 'plex unavailable: ' + esc(plex.error) : 'plex unavailable';
        streamList.innerHTML = '<div class="empty">' + msg + '</div>';
      } else if (!plex.sessions.length) {
        streamList.innerHTML = '<div class="empty">no active streams</div>';
      } else {
        streamList.innerHTML = plex.sessions.map(s => {
          const heading = s.show ? esc(s.show) + ' — ' + esc(s.title) : esc(s.title);
          const pausedBadge = s.state === 'paused' ? ' <span class="plex-paused">(paused)</span>' : '';
          const streamBadge = s.transcoding
            ? '<span class="plex-transcode">transcoding</span>'
            : '<span class="plex-direct">direct play</span>';
          return '<div class="plex-session">' +
            '<div class="plex-title">' + heading + pausedBadge + '</div>' +
            '<div class="plex-meta"><span>' + esc(s.user) + ' · ' + esc(s.player) + '</span>' + streamBadge + '</div>' +
            '<div class="bar"><div class="bar-fill" style="width:' + s.progress_pct + '%"></div></div>' +
            '</div>';
        }).join('');
      }
    } else {
      plexCard.style.display = 'none';
    }

    // UniFi
    const unifiCard = $('card-unifi');
    if (d.unifi) {
      unifiCard.style.display = '';
      const uf = d.unifi;
      if (!uf.available) {
        $('unifi-meta').textContent    = uf.error || 'unavailable';
        $('unifi-clients').textContent = '—';
        $('unifi-aps').textContent     = '—';
        $('unifi-wan-row').style.display = 'none';
      } else {
        const hasWan = uf.wan_status != null;
        if (hasWan) {
          const wanDot = uf.wan_status === 'ok' ? '●' : '○';
          $('unifi-meta').textContent      = wanDot + ' WAN';
          $('unifi-down').textContent      = fmtRate(uf.wan_down_bps);
          $('unifi-up').textContent        = fmtRate(uf.wan_up_bps);
          $('unifi-wan-row').style.display = '';
        } else {
          $('unifi-meta').textContent      = 'online';
          $('unifi-wan-row').style.display = 'none';
        }
        $('unifi-clients').textContent = uf.clients;
        $('unifi-aps').textContent     = uf.ap_online + ' / ' + uf.ap_total;
      }
    } else {
      unifiCard.style.display = 'none';
    }

    // Minecraft
    const mcCard = $('card-minecraft');
    if (d.minecraft) {
      mcCard.style.display = '';
      const mc = d.minecraft;
      const fav = $('mc-favicon');
      const mods = $('mc-mods');
      if (!mc.online) {
        $('mc-dot').className = 'dot dot-off';
        $('mc-count').textContent = 'offline';
        $('mc-version').textContent = '—';
        $('mc-latency').textContent = '';
        $('mc-secure').style.display = 'none';
        $('mc-motd').textContent = mc.error || 'server unreachable';
        $('mc-players').innerHTML = '';
        fav.style.display = 'none';
        fav.removeAttribute('src');
        mods.style.display = 'none';
        mods.innerHTML = '';
      } else {
        $('mc-dot').className = 'dot dot-on';
        $('mc-count').textContent = mc.players_online + ' / ' + mc.players_max + ' online';
        const versionParts = [mc.version || 'unknown'];
        if (mc.protocol) versionParts.push('proto ' + mc.protocol);
        $('mc-version').textContent = versionParts.join(' · ');
        $('mc-latency').textContent = mc.latency_ms != null ? mc.latency_ms + ' ms' : '';
        $('mc-secure').style.display = mc.enforces_secure_chat ? '' : 'none';
        const gmEl = $('mc-gamemode');
        if (mc.gamemode) {
          gmEl.textContent = mc.hardcore ? mc.gamemode + ' hc' : mc.gamemode;
          gmEl.className = 'mc-gamemode mc-gm-' + (mc.gamemode || '').toLowerCase() +
            (mc.hardcore ? ' mc-gm-hardcore' : '');
          gmEl.style.display = '';
        } else {
          gmEl.style.display = 'none';
        }
        // MOTD: render multi-line if the server returned newlines.
        const motdEl = $('mc-motd');
        const motd = mc.motd || mc.version || '';
        motdEl.innerHTML = motd
          ? motd.split('\n').map(l => '<div>' + esc(l) + '</div>').join('')
          : '';
        if (mc.favicon) {
          fav.src = mc.favicon;
          fav.style.display = '';
        } else {
          fav.style.display = 'none';
          fav.removeAttribute('src');
        }
        const chips = mc.players.map(p => '<span class="mc-player">' + esc(p) + '</span>');
        if (mc.hidden_players > 0) {
          chips.push('<span class="mc-player mc-player-hidden">+' + mc.hidden_players + ' hidden</span>');
        }
        if (chips.length) {
          $('mc-players').innerHTML = chips.join('');
        } else {
          $('mc-players').innerHTML = '<span class="empty">no players online</span>';
        }
        if (mc.mod_count > 0) {
          const sample = (mc.mods || []).slice(0, 6).map(esc).join(', ');
          const more = mc.mod_count > (mc.mods || []).length ? ', …' : '';
          mods.innerHTML = '<span class="mc-mods-label">' + mc.mod_count + ' mod' +
            (mc.mod_count === 1 ? '' : 's') + ':</span> <span class="mc-mods-list">' +
            sample + more + '</span>';
          mods.style.display = '';
        } else {
          mods.style.display = 'none';
          mods.innerHTML = '';
        }
      }
    } else {
      mcCard.style.display = 'none';
    }

    // SABnzbd
    const sabnzbdCard = $('card-sabnzbd');
    if (d.sabnzbd) {
      sabnzbdCard.style.display = '';
      const sab = d.sabnzbd;
      if (!sab.available) {
        $('sabnzbd-meta').textContent = sab.error ? 'unavailable: ' + sab.error : 'unavailable';
        $('sabnzbd-speed').textContent = '—';
        $('sabnzbd-sizeleft').textContent = '—';
        $('sabnzbd-slots').innerHTML = '';
      } else {
        const statusText = sab.status + (sab.queue_count ? ' · ' + sab.queue_count + (sab.queue_count === 1 ? ' item' : ' items') : '');
        $('sabnzbd-meta').textContent = statusText;
        $('sabnzbd-speed').textContent = sab.speed ? sab.speed + '/s' : '0 B/s';
        $('sabnzbd-sizeleft').textContent = sab.size_left || '0 B';
        $('sabnzbd-slots').innerHTML = sab.slots.map(s => {
          const pct = s.percent.toFixed(0);
          return '<div class="dl-item">' +
            '<div class="dl-head">' +
              '<span class="dl-name">' + esc(s.filename) + '</span>' +
              '<span class="dl-pct">' + pct + '%</span>' +
            '</div>' +
            '<div class="bar"><div class="bar-fill ' + barClass(s.percent) + '" style="width:' + pct + '%"></div></div>' +
            '</div>';
        }).join('');
      }
    } else {
      sabnzbdCard.style.display = 'none';
    }

    // qBittorrent
    const qbCard = $('card-qbittorrent');
    if (d.qbittorrent) {
      qbCard.style.display = '';
      const qb = d.qbittorrent;
      if (!qb.available) {
        $('qb-meta').textContent = qb.error ? 'unavailable: ' + qb.error : 'unavailable';
        $('qb-dl').textContent = '—';
        $('qb-ul').textContent = '—';
        $('qb-downloading').textContent = '—';
        $('qb-seeding').textContent = '—';
        $('qb-paused').textContent = '—';
      } else {
        $('qb-meta').textContent = qb.total + (qb.total === 1 ? ' torrent' : ' torrents');
        $('qb-dl').textContent = fmtRate(qb.dl_speed);
        $('qb-ul').textContent = fmtRate(qb.ul_speed);
        $('qb-downloading').textContent = qb.downloading;
        $('qb-seeding').textContent = qb.seeding;
        $('qb-paused').textContent = qb.paused;
      }
    } else {
      qbCard.style.display = 'none';
    }

    // Spotify
    renderSpotify(d.spotify);

    // Footer
    $('last-update').textContent = new Date().toLocaleTimeString();
    $('refresh-rate').textContent = (REFRESH_MS / 1000) + 's';
  }

  function setError() {
    $('status-dot').className = 'dot dot-off';
    $('hostname').textContent = 'connection lost';
  }

  async function tick() {
    if (currentModule) return; // detail view drives its own refresh
    try {
      const r = await fetch('/api/stats', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      render(await r.json());
    } catch (e) {
      console.error(e);
      setError();
    }
  }

  // ── Detail view router ──────────────────────────────────────────────────────

  const MODULES = {
    resources:   { title: 'CPU & Memory',  endpoint: '/api/resources',      render: renderResourcesDetail },
    minecraft:   { title: 'Minecraft',     endpoint: '/api/minecraft',      render: renderMinecraftDetail },
    qbittorrent: { title: 'qBittorrent',   endpoint: '/api/qbittorrent',    render: renderQbDetail },
    sabnzbd:     { title: 'SABnzbd',       endpoint: '/api/sabnzbd',        render: renderSabDetail },
    sonarr:      { title: 'Sonarr',        endpoint: '/api/sonarr',         render: renderSonarrDetail },
    plex:        { title: 'Plex',          endpoint: '/api/plex',           render: renderPlexDetail },
    unifi:       { title: 'UniFi',         endpoint: '/api/unifi',          render: renderUnifiDetail },
    temps:       { title: 'Temperatures',  endpoint: '/api/temps',          render: renderTempsDetail },
    network:     { title: 'Network',       endpoint: '/api/network',        render: renderNetworkDetail },
    storage:     { title: 'Storage',       endpoint: '/api/storage',        render: renderStorageDetail },
    spotify:     { title: 'Spotify',       endpoint: '/api/spotify/detail', render: renderSpotifyDetail },
    weather:     { title: 'Weather',       endpoint: () => _weatherCoords ? `/api/weather/detail?lat=${encodeURIComponent(_weatherCoords.lat)}&lon=${encodeURIComponent(_weatherCoords.lon)}` : null, render: renderWeatherDetail },
  };

  let currentModule = null;

  function parseHash() {
    const m = (location.hash || '').match(/^#\/([a-z]+)$/);
    return m && MODULES[m[1]] ? m[1] : null;
  }

  async function renderDetail() {
    const mod = MODULES[currentModule];
    if (!mod) return;
    $('detail-title').textContent = mod.title;
    const savedScroll = window.scrollY;
    try {
      const url = typeof mod.endpoint === 'function' ? mod.endpoint() : mod.endpoint;
      if (!url) {
        $('detail-body').innerHTML = '<div class="empty">Location not available yet</div>';
        $('detail-meta').textContent = '';
        return;
      }
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      mod.render(data);
    } catch (e) {
      console.error(e);
      $('detail-body').innerHTML = '<div class="empty">failed to load: ' + esc(e.message) + '</div>';
      $('detail-meta').textContent = '';
    }
    // Restore scroll position after DOM rebuild to prevent mobile jump/glitch
    if (savedScroll > 0) window.scrollTo(0, savedScroll);
  }

  function showDetail() {
    document.querySelector('.content').style.display = 'none';
    $('detail').style.display = '';
    renderDetail();
    window.scrollTo(0, 0);
  }

  function showDashboard() {
    $('detail').style.display = 'none';
    document.querySelector('.content').style.display = '';
    tick();
  }

  function applyRoute() {
    const mod = parseHash();
    if (mod === currentModule) return;
    // Reset transient per-module UI state when changing modules.
    qbSelected = new Set();
    currentModule = mod;
    if (mod) showDetail(); else showDashboard();
  }

  function fmtEta(secs) {
    if (!secs || secs >= 8640000) return '∞';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + s + 's';
    return s + 's';
  }

  function statItem(label, value, cls) {
    return '<div class="detail-stat"><div class="detail-stat-label">' + esc(label) + '</div>' +
      '<div class="detail-stat-value' + (cls ? ' ' + cls : '') + '">' + value + '</div></div>';
  }

  function stateClass(state) {
    const s = (state || '').toLowerCase();
    if (s.includes('paused')) return 'pause';
    if (s.includes('dl') || s.includes('downloading') || s.includes('meta') || s.includes('alloc') || s.includes('check')) return 'dl';
    if (s.includes('up') || s.includes('seed')) return 'up';
    return '';
  }

  // ── Detail renderers ────────────────────────────────────────────────────────

  function gamemodeLabel(mc) {
    const g = (mc.gamemode || '').toLowerCase();
    if (!g) return '—';
    const label = g.charAt(0).toUpperCase() + g.slice(1);
    return mc.hardcore ? label + ' (hardcore)' : label;
  }

  function gamemodeClass(mc) {
    const g = (mc.gamemode || '').toLowerCase();
    if (mc.hardcore) return 'warn';
    if (g === 'creative') return 'accent';
    if (g === 'survival') return 'ok';
    return '';
  }

  function renderMinecraftDetail(mc) {
    if (!mc.online) {
      $('detail-meta').textContent = 'offline';
      $('detail-body').innerHTML = '<div class="detail-section"><div class="empty">' +
        esc(mc.error || 'server unreachable') + '</div></div>';
      return;
    }
    $('detail-meta').textContent = mc.players_online + ' / ' + mc.players_max + ' online';
    const motdLines = (mc.motd || '').split('\n').map(l => '<div>' + esc(l) + '</div>').join('');
    const favHtml = mc.favicon ? '<img class="mc-favicon" src="' + mc.favicon + '" alt="">' : '';
    const stats =
      statItem('Gamemode', esc(gamemodeLabel(mc)), gamemodeClass(mc)) +
      statItem('Difficulty', esc(mc.difficulty || '—')) +
      statItem('Version', esc(mc.version || '—')) +
      statItem('Protocol', mc.protocol != null ? mc.protocol : '—') +
      statItem('Latency', mc.latency_ms != null ? mc.latency_ms + ' ms' : '—') +
      statItem('Players', mc.players_online + ' / ' + mc.players_max, 'accent') +
      statItem('Mods', mc.mod_count || 0) +
      statItem('PvP', mc.pvp ? 'yes' : 'no', mc.pvp ? 'warn' : '');

    const onlineOps = new Set((mc.online_op_names || []).map(n => n.toLowerCase()));
    const rcon = mc.rcon_available;

    const playerChips = (mc.players || []).map(p => {
      const isOp = onlineOps.has(p.toLowerCase());
      const opBadge = isOp ? '<span class="mc-op-badge" title="Operator">OP</span>' : '';
      const action = isOp ? 'deop' : 'op';
      const btnLabel = isOp ? 'Deop' : 'Op';
      const btn = rcon
        ? '<button class="mc-op-btn" data-action="' + action + '" data-player="' + esc(p) +
            '" title="' + (isOp ? 'Remove operator' : 'Make operator') + '">' + btnLabel + '</button>'
        : '';
      return '<span class="mc-player ' + (isOp ? 'mc-player-op' : '') + '">' +
        esc(p) + opBadge + btn + '</span>';
    }).join('');
    const hidden = mc.hidden_players > 0
      ? '<span class="mc-player mc-player-hidden">+' + mc.hidden_players + ' hidden</span>' : '';
    const playersBlock = playerChips + hidden || '<span class="empty">no players online</span>';

    const allOps = mc.ops || [];
    const opsBlock = allOps.length
      ? allOps.map(o => {
          const online = onlineOps.has(o.name.toLowerCase());
          return '<span class="mc-player ' + (online ? 'mc-player-op-online' : '') +
            '" title="level ' + o.level + (online ? ' · online' : '') + '">' +
            esc(o.name) + '<span class="mc-op-level">L' + o.level + '</span></span>';
        }).join('')
      : '<span class="empty">' + (mc.ops ? 'no ops defined' : 'mount MC_DATA_DIR to see ops') + '</span>';

    const mods = (mc.mods || []).map(m => '<div class="mod-chip">' + esc(m) + '</div>').join('') ||
      '<span class="empty">no mods</span>';

    // Build a diagnostic block explaining why ops/mods/gamemode might be
    // empty. Visible whenever MC_DATA_DIR is misconfigured or empty.
    const diag = mc.data_dir_diag || {};
    let diagHtml = '';
    if (!diag.configured) {
      diagHtml = '<div class="mc-diag warn">' +
        '<strong>MC_DATA_DIR is not set.</strong> Without it, the mod count, ' +
        'operator list, and gamemode cannot be read. ' +
        'In the Unraid template, MC_DATA_DIR must be an <em>environment variable</em> ' +
        '(text input), not a Path mount. Set it to a directory inside the container ' +
        '(typically under <code>/mnt/...</code>, which is already mounted read-only).' +
        '</div>';
    } else if (!diag.exists) {
      diagHtml = '<div class="mc-diag warn">' +
        '<strong>MC_DATA_DIR is set to <code>' + esc(diag.path) + '</code> but does not exist inside the container.</strong> ' +
        'The path must be reachable from inside the container (the dashboard mounts the host\'s <code>/mnt</code> read-only).' +
        '</div>';
    } else if (!diag.readable) {
      diagHtml = '<div class="mc-diag warn">' +
        '<strong>MC_DATA_DIR exists but is not readable.</strong> ' +
        'The dashboard runs as UID 1001 — make sure the directory is world-readable.' +
        '</div>';
    } else if (!diag.has_mods_dir && !diag.has_ops_json && !diag.has_properties) {
      diagHtml = '<div class="mc-diag warn">' +
        '<strong>MC_DATA_DIR is readable but contains no <code>mods/</code>, ' +
        '<code>ops.json</code>, or <code>server.properties</code>.</strong> ' +
        'Check the path (<code>' + esc(diag.path) + '</code>) really points at the Minecraft server\'s data dir.' +
        '</div>';
    }

    const playersHeader = '<h3>Online players' +
      (rcon ? '' : ' <span class="mc-rcon-hint">(set MC_RCON_PASSWORD to enable op/deop)</span>') +
      '</h3>';

    // Player count history graph (short-term, from dashboard payload)
    const countHistory = mc.player_count_history || [];
    // History is [[epoch, count], ...]; extract counts for the short-term chart
    const recentCounts = countHistory.map(r => Array.isArray(r) ? r[1] : r);
    const graphSection = recentCounts.length >= 2
      ? '<div class="detail-section"><h3>Player count (recent 2h)</h3>' +
          '<canvas id="mc-count-canvas" style="width:100%;height:140px;display:block;margin-bottom:6px"></canvas>' +
        '</div>'
      : '';

    // Leaderboard
    const leaderboard = mc.player_leaderboard || [];
    const onlineSet = new Set((mc.players || []).map(p => p.toLowerCase()));
    const lbRows = leaderboard.map((entry, i) => {
      const online = onlineSet.has(entry.name.toLowerCase());
      return '<div class="mc-lb-row">' +
        '<span class="mc-lb-rank">#' + (i + 1) + '</span>' +
        '<span class="mc-lb-name">' + esc(entry.name) + '</span>' +
        (online ? '<span class="mc-lb-online">online</span>' : '') +
        '<span class="mc-lb-time">' + fmtGameTime(entry.seconds) + '</span>' +
        '</div>';
    }).join('');
    const lbSection = '<div class="detail-section"><h3>Leaderboard · time online</h3>' +
      (lbRows
        ? '<div class="mc-leaderboard">' + lbRows + '</div>'
        : '<div class="empty">no players tracked yet — accumulates while the server is running</div>') +
      '</div>';

    $('detail-body').innerHTML =
      '<div class="detail-section">' +
        '<div class="mc-detail-banner">' + favHtml +
          '<div><div class="mc-detail-name">' + esc(mc.version || 'Minecraft Server') + '</div>' +
          '<div class="mc-motd">' + motdLines + '</div></div>' +
        '</div>' +
      '</div>' +
      (diagHtml ? '<div class="detail-section">' + diagHtml + '</div>' : '') +
      '<div class="detail-section"><div class="detail-stats">' + stats + '</div></div>' +
      graphSection +
      lbSection +
      '<div class="detail-section">' + playersHeader +
        '<div class="mc-players">' + playersBlock + '</div>' +
      '</div>' +
      '<div class="detail-section"><h3>Operators (' + allOps.length + ')</h3>' +
        '<div class="mc-players">' + opsBlock + '</div>' +
      '</div>' +
      '<div class="detail-section"><h3>Mods (' + (mc.mod_count || 0) + ')' +
        (mc.mod_source && mc.mod_source !== 'none'
          ? ' <span class="mc-rcon-hint">via ' + esc(mc.mod_source) + '</span>'
          : ' <span class="mc-rcon-hint">no source — SLP did not advertise mods and MC_DATA_DIR/mods is empty or missing</span>') +
        '</h3>' +
        (mc.mod_count > 0 ? '<div class="mods-grid">' + mods + '</div>' : '<div class="empty">no mods detected</div>') +
      '</div>';

    if (recentCounts.length >= 2) {
      mountCanvas('mc-count-canvas', (c) => drawMcGraph(c, recentCounts, mc.players_max));
    }

    // Append 14-day history chart asynchronously
    fetch('/api/history/minecraft').then(r => r.ok ? r.json() : null).then(hist => {
      if (!hist || !hist.count_history || hist.count_history.length < 2) return;
      const section = document.createElement('div');
      section.className = 'detail-section';
      section.innerHTML = '<h3>14-day player count</h3>' +
        '<canvas id="mc-hist-canvas" style="width:100%;height:140px;display:block;margin-bottom:6px"></canvas>';
      const detailBody = $('detail-body');
      // Insert before the leaderboard (4th section: banner, diag?, stats, graph, lb)
      const graphEl = $('mc-count-canvas');
      const graphSection2 = graphEl ? graphEl.closest('.detail-section') : null;
      if (graphSection2) {
        graphSection2.after(section);
      } else {
        // Insert before leaderboard section
        const sections = detailBody.querySelectorAll('.detail-section');
        const lb = sections[sections.length - 4]; // leaderboard is 4th from end
        if (lb) lb.before(section); else detailBody.appendChild(section);
      }
      mountCanvas('mc-hist-canvas', c => drawHistChart(c, hist.count_history, '#4caf50', v => v.toFixed(0)));
    }).catch(() => {});

    wireMcOpButtons();
  }

  function wireMcOpButtons() {
    document.querySelectorAll('.mc-op-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        const player = btn.getAttribute('data-player');
        if (!confirm((action === 'op' ? 'Make ' : 'Remove operator from ') + player + '?')) return;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = '…';
        try {
          const r = await fetch('/api/minecraft/' + action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player }),
          });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.ok) {
            flashBtn(btn, '✓', 'ok', original);
            // Force a refresh so the button flips state.
            setTimeout(renderDetail, 800);
          } else {
            const msg = data.error || 'failed';
            flashBtn(btn, msg, 'warn', original);
            alert(action + ' failed: ' + msg);
            console.error('mc op action failed', data);
          }
        } catch (err) {
          flashBtn(btn, 'failed', 'warn', original);
          console.error(err);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  // Track which torrent hashes the user has selected for bulk actions.
  // Cleared on each detail-view (re)entry so it doesn't leak between sessions.
  let qbSelected = new Set();

  function renderQbDetail(qb) {
    if (!qb.available) {
      $('detail-meta').textContent = 'unavailable';
      $('detail-body').innerHTML = '<div class="detail-section"><div class="empty">' +
        esc(qb.error || 'qbittorrent unavailable') + '</div></div>';
      return;
    }
    $('detail-meta').textContent = qb.total + (qb.total === 1 ? ' torrent' : ' torrents');
    const stats =
      statItem('Down', fmtRate(qb.dl_speed), 'accent') +
      statItem('Up', fmtRate(qb.ul_speed), 'ok') +
      statItem('Downloading', qb.downloading) +
      statItem('Seeding', qb.seeding) +
      statItem('Paused', qb.paused) +
      statItem('Total', qb.total) +
      statItem('Session down', fmtBytes(qb.dl_total || 0)) +
      statItem('Session up', fmtBytes(qb.ul_total || 0));

    // Drop selections for hashes that no longer exist (torrent removed upstream)
    const liveHashes = new Set((qb.torrents || []).map(t => t.hash));
    qbSelected = new Set([...qbSelected].filter(h => liveHashes.has(h)));

    const torrents = (qb.torrents || []).map(t => {
      const stCls = stateClass(t.state);
      const right = t.dl_speed > 0 ? '↓ ' + fmtRate(t.dl_speed) :
                    t.ul_speed > 0 ? '↑ ' + fmtRate(t.ul_speed) : '';
      const checked = qbSelected.has(t.hash) ? ' checked' : '';
      return '<div class="tor-item" data-hash="' + esc(t.hash) + '">' +
        '<div class="tor-row-top">' +
          '<label class="tor-select"><input type="checkbox" class="qb-select"' + checked +
            ' data-hash="' + esc(t.hash) + '" aria-label="select torrent"></label>' +
          '<div class="tor-name">' + esc(t.name) + '</div>' +
          '<div class="tor-row-actions">' +
            '<button class="qb-action-btn" data-action="recheck" data-hash="' + esc(t.hash) + '" title="Force recheck this torrent">Recheck</button>' +
            '<button class="qb-action-btn" data-action="reannounce" data-hash="' + esc(t.hash) + '" title="Reannounce this torrent to trackers">Reannounce</button>' +
          '</div>' +
        '</div>' +
        '<div class="tor-meta">' +
          '<span class="tor-state ' + stCls + '">' + esc(t.state) + '</span>' +
          '<span>' + fmtBytes(t.size) + ' · ratio ' + t.ratio + (t.category ? ' · ' + esc(t.category) : '') + '</span>' +
          '<span>' + right + (t.eta && t.eta < 8640000 ? ' · ETA ' + fmtEta(t.eta) : '') + '</span>' +
        '</div>' +
        '<div class="bar"><div class="bar-fill" style="width:' + t.progress + '%"></div></div>' +
      '</div>';
    }).join('') || '<div class="empty">no torrents</div>';

    const actionsBar =
      '<div class="qb-actions-bar">' +
        '<button class="qb-action-btn" data-action="recheck" data-target="all">Recheck all</button>' +
        '<button class="qb-action-btn" data-action="reannounce" data-target="all">Reannounce all</button>' +
        '<button class="qb-action-btn primary" data-action="recheck" data-target="selected">Recheck selected</button>' +
        '<button class="qb-action-btn primary" data-action="reannounce" data-target="selected">Reannounce selected</button>' +
        '<span class="qb-selected-count" id="qb-selected-count"></span>' +
      '</div>';

    $('detail-body').innerHTML =
      '<div class="detail-section"><div class="detail-stats">' + stats + '</div></div>' +
      '<div class="detail-section"><h3>Torrents</h3>' + actionsBar +
        '<div class="tor-list">' + torrents + '</div></div>';

    updateQbSelectedCount();
    wireQbActions();
  }

  function updateQbSelectedCount() {
    const el = $('qb-selected-count');
    if (!el) return;
    el.textContent = qbSelected.size
      ? qbSelected.size + ' selected'
      : 'no selection';
  }

  function wireQbActions() {
    document.querySelectorAll('.qb-select').forEach(cb => {
      cb.addEventListener('change', () => {
        const h = cb.getAttribute('data-hash');
        if (cb.checked) qbSelected.add(h); else qbSelected.delete(h);
        updateQbSelectedCount();
      });
    });
    document.querySelectorAll('.qb-action-btn').forEach(btn => {
      btn.addEventListener('click', () => qbDoAction(btn));
    });
  }

  async function qbDoAction(btn) {
    const action = btn.getAttribute('data-action');
    const target = btn.getAttribute('data-target');
    const hash = btn.getAttribute('data-hash');
    let hashes;
    if (hash) {
      hashes = [hash];
    } else if (target === 'selected') {
      if (qbSelected.size === 0) {
        flashBtn(btn, 'No selection', 'warn');
        return;
      }
      hashes = [...qbSelected];
    } else {
      hashes = 'all';
    }
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '…';
    try {
      const r = await fetch('/api/qbittorrent/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) {
        flashBtn(btn, '✓', 'ok', original);
      } else {
        flashBtn(btn, 'failed', 'warn', original);
        console.error('qb action failed', data);
      }
    } catch (e) {
      flashBtn(btn, 'failed', 'warn', original);
      console.error(e);
    } finally {
      btn.disabled = false;
    }
  }

  function flashBtn(btn, msg, cls, restore) {
    btn.textContent = msg;
    btn.classList.add('flash-' + cls);
    setTimeout(() => {
      btn.classList.remove('flash-' + cls);
      if (restore !== undefined) btn.textContent = restore;
    }, 1200);
  }

  function renderSabDetail(sab) {
    if (!sab.available) {
      $('detail-meta').textContent = 'unavailable';
      $('detail-body').innerHTML = '<div class="detail-section"><div class="empty">' +
        esc(sab.error || 'sabnzbd unavailable') + '</div></div>';
      return;
    }
    $('detail-meta').textContent = sab.status + ' · ' + sab.queue_count + (sab.queue_count === 1 ? ' item' : ' items');
    const stats =
      statItem('Status', esc(sab.status), sab.paused ? 'warn' : 'ok') +
      statItem('Speed', (sab.speed || '0') + '/s', 'accent') +
      statItem('Size left', esc(sab.size_left || '0 B')) +
      statItem('Time left', esc(sab.time_left || '—')) +
      statItem('Queue', sab.queue_count) +
      statItem('Disk free (incomplete)', esc(sab.diskspace1 || '—') + ' GB') +
      statItem('Disk free (complete)', esc(sab.diskspace2 || '—') + ' GB');

    const slots = (sab.slots || []).map(s => {
      const pct = s.percent.toFixed(0);
      return '<div class="slot-item">' +
        '<div class="slot-name">' + esc(s.filename) + '</div>' +
        '<div class="slot-meta">' +
          '<span>' + esc(s.status) + (s.category ? ' · ' + esc(s.category) : '') + '</span>' +
          '<span>' + esc(s.size_left || '') + ' / ' + esc(s.size || '') + '</span>' +
          '<span>ETA ' + esc(s.time_left || '—') + '</span>' +
        '</div>' +
        '<div class="bar"><div class="bar-fill ' + barClass(s.percent) + '" style="width:' + pct + '%"></div></div>' +
      '</div>';
    }).join('') || '<div class="empty">queue empty</div>';

    $('detail-body').innerHTML =
      '<div class="detail-section"><div class="detail-stats">' + stats + '</div></div>' +
      '<div class="detail-section"><h3>Queue</h3><div class="slot-list">' + slots + '</div></div>';
  }

  function renderSonarrDetail(sonarr) {
    if (!sonarr.available) {
      $('detail-meta').textContent = 'unavailable';
      $('detail-body').innerHTML = '<div class="detail-section"><div class="empty">' +
        esc(sonarr.error || 'sonarr unavailable') + '</div></div>';
      return;
    }
    const eps = sonarr.episodes || [];
    const downloaded = eps.filter(e => e.downloaded).length;
    $('detail-meta').textContent = eps.length + (eps.length === 1 ? ' episode' : ' episodes') +
      ' · next 14 days';

    const stats =
      statItem('Total episodes', eps.length) +
      statItem('Downloaded', downloaded, 'ok') +
      statItem('Upcoming', eps.length - downloaded, 'warn') +
      statItem('Unique shows', new Set(eps.map(e => e.show)).size);

    let body = '<div class="detail-section"><div class="detail-stats">' + stats + '</div></div>';
    if (!eps.length) {
      body += '<div class="detail-section"><div class="empty">no episodes in the next 14 days</div></div>';
    } else {
      const days = [], dayMap = {};
      eps.forEach(ep => {
        if (!dayMap[ep.air_date]) { dayMap[ep.air_date] = []; days.push(ep.air_date); }
        dayMap[ep.air_date].push(ep);
      });
      body += days.map(d => {
        const items = dayMap[d].map(ep => {
          const epNum = 'S' + String(ep.season).padStart(2, '0') + 'E' + String(ep.episode).padStart(2, '0');
          const badge = ep.downloaded
            ? '<span class="sonarr-badge downloaded">Downloaded</span>'
            : '<span class="sonarr-badge upcoming">Upcoming</span>';
          const overview = ep.overview
            ? '<div class="sonarr-detail-overview">' + esc(ep.overview) + '</div>' : '';
          return '<div class="sonarr-detail-ep">' +
            '<div class="sonarr-episode">' +
              '<div class="sonarr-left">' +
                '<span class="sonarr-show">' + esc(ep.show) + (ep.network ? ' · ' + esc(ep.network) : '') + '</span>' +
                '<span class="sonarr-ep-title">' + esc(ep.title) + '</span>' +
              '</div>' +
              '<div class="sonarr-right"><span class="sonarr-ep-num">' + epNum + '</span>' + badge + '</div>' +
            '</div>' +
            overview +
          '</div>';
        }).join('');
        return '<div class="detail-section"><h3>' + esc(dayMap[d][0].day_label) + '</h3>' + items + '</div>';
      }).join('');
    }
    $('detail-body').innerHTML = body;
  }

  function renderPlexDetail(plex) {
    if (!plex.available) {
      $('detail-meta').textContent = 'unavailable';
      $('detail-body').innerHTML = '<div class="detail-section"><div class="empty">' +
        esc(plex.error || 'plex unavailable') + '</div></div>';
      return;
    }
    const sessions = plex.sessions || [];
    $('detail-meta').textContent = sessions.length + (sessions.length === 1 ? ' stream' : ' streams');
    const transcoding = sessions.filter(s => s.transcoding).length;

    const stats =
      statItem('Active streams', sessions.length, 'accent') +
      statItem('Direct play', sessions.length - transcoding, 'ok') +
      statItem('Transcoding', transcoding, transcoding ? 'warn' : '') +
      statItem('Paused', sessions.filter(s => s.state === 'paused').length);

    let body = '<div class="detail-section"><div class="detail-stats">' + stats + '</div></div>';
    if (!sessions.length) {
      body += '<div class="detail-section"><div class="empty">no active streams</div></div>';
    } else {
      const items = sessions.map(s => {
        let title = s.title;
        let subtitle = '';
        if (s.show) {
          const epNum = (s.season != null && s.episode != null)
            ? 'S' + String(s.season).padStart(2, '0') + 'E' + String(s.episode).padStart(2, '0') + ' · ' : '';
          title = s.show;
          subtitle = epNum + s.title;
        } else if (s.year) {
          subtitle = String(s.year);
        }
        const dur = s.duration ? Math.floor(s.duration / 60000) + ' min' : '';
        const tags = [
          '<span class="plex-tag">' + esc(s.type || 'media') + '</span>',
          s.library ? '<span class="plex-tag">' + esc(s.library) + '</span>' : '',
          s.transcoding
            ? '<span class="plex-tag warn">transcode: ' + esc(s.video_decision) + '/' + esc(s.audio_decision) + '</span>'
            : '<span class="plex-tag ok">direct play</span>',
          s.state === 'paused' ? '<span class="plex-tag warn">paused</span>' : '',
        ].filter(Boolean).join('');
        return '<div class="plex-detail-session">' +
          '<div class="plex-detail-title">' + esc(title) + '</div>' +
          (subtitle ? '<div class="plex-detail-subtitle">' + esc(subtitle) + '</div>' : '') +
          '<div class="plex-meta"><span>' + esc(s.user) + ' · ' + esc(s.player) +
            (s.platform ? ' (' + esc(s.platform) + ')' : '') + '</span>' +
            '<span>' + s.progress_pct + '%' + (dur ? ' of ' + dur : '') + '</span></div>' +
          '<div class="bar"><div class="bar-fill" style="width:' + s.progress_pct + '%"></div></div>' +
          '<div class="plex-detail-tags">' + tags + '</div>' +
        '</div>';
      }).join('');
      body += '<div class="detail-section"><h3>Sessions</h3>' + items + '</div>';
    }
    $('detail-body').innerHTML = body;
  }

  // ── System drilldown renderers ───────────────────────────────────────────────

  function renderResourcesDetail(data) {
    const cpu = data.cpu || {};
    const mem = data.memory || {};
    $('detail-meta').textContent = 'CPU ' + (cpu.percent || 0).toFixed(0) + '% · MEM ' + (mem.percent || 0).toFixed(0) + '%';

    const statsHtml =
      statItem('CPU', (cpu.percent || 0).toFixed(0) + '%', barClass(cpu.percent || 0)) +
      statItem('Frequency', cpu.freq_mhz ? (cpu.freq_mhz / 1000).toFixed(2) + ' GHz' : '—') +
      statItem('Cores', (cpu.cores || '—') + ' / ' + (cpu.threads || '—') + 't') +
      statItem('Load avg', (cpu.load_1m || 0).toFixed(2) + ' · ' + (cpu.load_5m || 0).toFixed(2) + ' · ' + (cpu.load_15m || 0).toFixed(2)) +
      statItem('Memory', fmtBytes(mem.used) + ' / ' + fmtBytes(mem.total), barClass(mem.percent || 0)) +
      statItem('Available', fmtBytes(mem.available)) +
      (mem.swap_total > 0 ? statItem('Swap', fmtBytes(mem.swap_used) + ' / ' + fmtBytes(mem.swap_total) + ' (' + (mem.swap_percent || 0).toFixed(0) + '%)') : '');

    $('detail-body').innerHTML =
      '<div class="detail-section"><div class="detail-stats">' + statsHtml + '</div></div>';

    // Fetch 14-day history and append charts
    fetch('/api/history/system').then(r => r.ok ? r.json() : null).then(hist => {
      if (!hist) return;
      const db = $('detail-body');
      if (hist.cpu && hist.cpu.length >= 2) {
        const s = document.createElement('div');
        s.className = 'detail-section';
        s.innerHTML = '<h3>14-day CPU trend</h3><canvas id="cpu-hist-canvas" style="width:100%;height:140px;display:block"></canvas>';
        db.appendChild(s);
        mountCanvas('cpu-hist-canvas', c => drawHistChart(c, hist.cpu, '#e22828', v => v.toFixed(0) + '%'));
      }
      if (hist.mem && hist.mem.length >= 2) {
        const s = document.createElement('div');
        s.className = 'detail-section';
        s.innerHTML = '<h3>14-day memory trend</h3><canvas id="mem-hist-canvas" style="width:100%;height:140px;display:block"></canvas>';
        db.appendChild(s);
        mountCanvas('mem-hist-canvas', c => drawHistChart(c, hist.mem, '#2196f3', v => v.toFixed(0) + '%'));
      }
    }).catch(() => {});
  }

  function renderUnifiDetail(data) {
    if (!data.available) {
      $('detail-meta').textContent = 'unavailable';
      $('detail-body').innerHTML = '<div class="detail-section"><div class="empty">' +
        esc(data.error || 'UniFi unavailable') + '</div></div>';
      return;
    }

    $('detail-meta').textContent = data.clients + ' clients';

    const hasWan = data.wan_status != null;
    let statsHtml =
      statItem('Clients', data.clients) +
      statItem('Devices', data.ap_online + ' / ' + data.ap_total + ' online');
    if (hasWan) {
      const wanCls = data.wan_status === 'ok' ? 'ok' : 'crit';
      statsHtml =
        statItem('WAN', data.wan_status === 'ok' ? 'connected' : 'error', wanCls) +
        (data.wan_ip ? statItem('WAN IP', data.wan_ip) : '') +
        statItem('↓ Down', fmtRate(data.wan_down_bps), 'accent') +
        statItem('↑ Up',   fmtRate(data.wan_up_bps),   'ok') +
        statsHtml;
    }

    let body = '<div class="detail-section"><div class="detail-stats">' + statsHtml + '</div></div>';

    const clients = data.client_list || [];
    if (clients.length) {
      body += '<div class="detail-section"><h3>Clients (' + clients.length + ')</h3>' +
        '<div class="iface-list">' +
        clients.map(c => {
          const type = c.type === 'wireless' ? '📶' : '🔌';
          const rssi = c.rssi != null ? ' · ' + c.rssi + ' dBm' : '';
          const hasRates = (c.dl_bps || 0) > 0 || (c.ul_bps || 0) > 0;
          const rateStr = hasRates
            ? fmtRate(c.dl_bps) + ' ↓ · ' + fmtRate(c.ul_bps) + ' ↑'
            : fmtBytes(c.dl_bytes || 0) + ' ↓ · ' + fmtBytes(c.ul_bytes || 0) + ' ↑';
          return '<div class="iface-item">' +
            '<div class="iface-head">' +
              '<span class="iface-name">' + type + ' ' + esc(c.hostname || c.ip || '—') + '</span>' +
              '<span class="iface-rates">' + rateStr + '</span>' +
            '</div>' +
            (c.ip ? '<div class="iface-totals">' + esc(c.ip) + rssi + '</div>' : '') +
          '</div>';
        }).join('') +
        '</div></div>';
    }

    const devices = data.device_list || [];
    if (devices.length) {
      body += '<div class="detail-section"><h3>Devices (' + devices.length + ')</h3>' +
        '<div class="iface-list">' +
        devices.map(d => {
          const statusCls = d.online ? 'dot dot-on' : 'dot dot-off';
          let html = '<div class="iface-item">' +
            '<div class="iface-head">' +
              '<span class="iface-name"><span class="' + statusCls + '" style="margin-right:6px"></span>' + esc(d.name) + '</span>' +
              '<span class="iface-rates">' + esc(d.model || d.type || '') + '</span>' +
            '</div>' +
            (d.version ? '<div class="iface-totals">v' + esc(d.version) + (d.clients ? ' · ' + d.clients + ' clients' : '') + '</div>' : '');

          if (d.snmp) {
            const s = d.snmp;
            if (s.uptime) {
              html += '<div class="iface-totals" style="color:var(--dim)">uptime ' + fmtUptime(s.uptime) + (s.sysname ? ' · ' + esc(s.sysname) : '') + '</div>';
            }
            const ifaces = (s.interfaces || []).filter(i => i.up || i.in_bytes > 0 || i.out_bytes > 0);
            if (ifaces.length) {
              html += '<div class="iface-list" style="margin-top:4px;border-top:1px solid var(--border)">' +
                ifaces.map(iface => {
                  const portDot = iface.up ? 'dot dot-on' : 'dot dot-off';
                  const speed = iface.speed_bps >= 1e9 ? (iface.speed_bps / 1e9).toFixed(0) + 'G'
                              : iface.speed_bps >= 1e6 ? (iface.speed_bps / 1e6).toFixed(0) + 'M'
                              : '';
                  const hasRates = (iface.in_bps || 0) > 0 || (iface.out_bps || 0) > 0;
                  const trafficStr = hasRates
                    ? fmtRate(iface.in_bps) + ' ↓ · ' + fmtRate(iface.out_bps) + ' ↑'
                    : fmtBytes(iface.in_bytes) + ' ↓ · ' + fmtBytes(iface.out_bytes) + ' ↑';
                  const errStr = (iface.in_err || iface.out_err)
                    ? '<div class="iface-totals" style="color:var(--crit)">' + iface.in_err + ' in err · ' + iface.out_err + ' out err</div>'
                    : '';
                  return '<div class="iface-item">' +
                    '<div class="iface-head">' +
                      '<span class="iface-name"><span class="' + portDot + '" style="margin-right:4px"></span>' +
                        esc(iface.name) + (speed ? ' <span class="meta-dim">' + speed + '</span>' : '') + '</span>' +
                      '<span class="iface-rates">' + trafficStr + '</span>' +
                    '</div>' + errStr +
                  '</div>';
                }).join('') +
              '</div>';
            }
          }

          html += '</div>';
          return html;
        }).join('') +
        '</div></div>';
    }

    $('detail-body').innerHTML = body;
  }

  function renderTempsDetail(data) {
    const sensors = data.sensors || [];
    const fans    = data.fans    || [];
    if (sensors.length > 0) pushTempHistory(sensors);

    const fanLabel = fans.length ? ' · ' + fans.length + (fans.length === 1 ? ' fan' : ' fans') : '';
    $('detail-meta').textContent = sensors.length + (sensors.length === 1 ? ' sensor' : ' sensors') + fanLabel;

    let body = '';

    if (sensors.length === 0) {
      body = '<div class="detail-section"><div class="empty">no sensors detected (mount /sys in container)</div></div>';
      $('detail-body').innerHTML = body;
      return;
    }

    // Stats row
    const hottest = sensors.reduce((a, b) => b.current > a.current ? b : a);
    const statsHtml =
      statItem('Sensors', sensors.length) +
      statItem('Hottest', esc(hottest.label) + ' · ' + hottest.current.toFixed(1) + '°C',
               tempClass(hottest.current, hottest.high, hottest.critical)) +
      statItem('Fans', fans.length);
    body += '<div class="detail-section"><div class="detail-stats">' + statsHtml + '</div></div>';

    // Trend graph
    body += '<div class="detail-section"><h3>60-second trend</h3>' +
      '<canvas id="temp-detail-canvas" style="width:100%;height:180px;display:block;margin-bottom:10px"></canvas>' +
      '<div class="temp-legend">' +
      sensors.map((s, si) => {
        const color = TEMP_COLORS[si % TEMP_COLORS.length];
        const cls = tempClass(s.current, s.high, s.critical);
        return '<div class="temp-legend-item">' +
          '<span class="temp-legend-dot" style="background:' + color + '"></span>' +
          '<span class="temp-legend-label">' + esc(s.label) + '</span>' +
          '<span class="temp-legend-value ' + cls + '">' + s.current.toFixed(1) + '°C</span>' +
          '</div>';
      }).join('') +
      '</div></div>';

    // Full sensor list
    body += '<div class="detail-section"><h3>Sensors (' + sensors.length + ')</h3>' +
      '<div class="sensor-detail-list">' +
      sensors.map((s, si) => {
        const color = TEMP_COLORS[si % TEMP_COLORS.length];
        const cls = tempClass(s.current, s.high, s.critical);
        const limits = [
          s.high     ? 'high ' + s.high + '°C'     : '',
          s.critical ? 'crit ' + s.critical + '°C' : '',
        ].filter(Boolean).join(' · ');
        return '<div class="sensor-detail-item">' +
          '<span class="sensor-detail-dot" style="background:' + color + '"></span>' +
          '<span class="sensor-detail-chip">' + esc(s.chip) + '</span>' +
          '<span class="sensor-detail-label">' + esc(s.label) + '</span>' +
          '<span class="sensor-detail-temp ' + cls + '">' + s.current.toFixed(1) + '°C</span>' +
          (limits ? '<span class="sensor-detail-limits">' + esc(limits) + '</span>' : '') +
          '</div>';
      }).join('') +
      '</div></div>';

    // Fan list
    if (fans.length) {
      body += '<div class="detail-section"><h3>Fans (' + fans.length + ')</h3>' +
        '<div class="fan-detail-list">' +
        fans.map(f => {
          return '<div class="fan-detail-item">' +
            '<span class="fan-detail-label">' + esc(f.label) + '</span>' +
            '<span class="fan-detail-rpm">' + f.rpm.toLocaleString() + ' RPM</span>' +
            '</div>';
        }).join('') +
        '</div></div>';
    }

    $('detail-body').innerHTML = body;
    mountCanvas('temp-detail-canvas', (c) => drawTempGraph(c, sensors));

    // Append 14-day history chart asynchronously
    fetch('/api/history/system').then(r => r.ok ? r.json() : null).then(hist => {
      if (!hist || !hist.temp || hist.temp.length < 2) return;
      const section = document.createElement('div');
      section.className = 'detail-section';
      section.innerHTML = '<h3>14-day temperature trend</h3>' +
        '<canvas id="temp-hist-canvas" style="width:100%;height:160px;display:block"></canvas>';
      const detailBody = $('detail-body');
      const sections = detailBody.querySelectorAll('.detail-section');
      // Insert after the 60-second trend section
      if (sections[1]) sections[1].after(section); else detailBody.appendChild(section);
      mountCanvas('temp-hist-canvas', c => drawHistChart(c, hist.temp, '#e22828', v => v.toFixed(0) + '°'));
    }).catch(() => {});
  }

  function renderNetworkDetail(data) {
    const ifaces = data.interfaces || [];
    pushNetHistory(data);

    $('detail-meta').textContent = ifaces.length + (ifaces.length === 1 ? ' interface' : ' interfaces');

    const statsHtml =
      statItem('↓ Down', fmtRate(data.rate_recv_bps), 'accent') +
      statItem('↑ Up',   fmtRate(data.rate_sent_bps), 'ok') +
      statItem('Interfaces', ifaces.length) +
      (data.total_bytes_recv ? statItem('Total received', fmtBytes(data.total_bytes_recv)) : '') +
      (data.total_bytes_sent ? statItem('Total sent',     fmtBytes(data.total_bytes_sent)) : '');

    let body = '<div class="detail-section"><div class="detail-stats">' + statsHtml + '</div></div>';

    // Trend graph
    body += '<div class="detail-section"><h3>60-second rate trend</h3>' +
      '<canvas id="net-detail-canvas" style="width:100%;height:160px;display:block;margin-bottom:10px"></canvas>' +
      '<div class="net-graph-legend">' +
      '<span class="net-legend-item"><span class="net-legend-dot" style="background:#e22828"></span>↓ Down</span>' +
      '<span class="net-legend-item"><span class="net-legend-dot" style="background:#4caf50"></span>↑ Up</span>' +
      '</div></div>';

    // Per-interface breakdown
    if (ifaces.length) {
      body += '<div class="detail-section"><h3>Interfaces</h3>' +
        '<div class="iface-list">' +
        ifaces.map(iface => {
          return '<div class="iface-item">' +
            '<div class="iface-head">' +
              '<span class="iface-name">' + esc(iface.name) + '</span>' +
              '<span class="iface-rates">' +
                '↓ ' + fmtRate(iface.rate_recv_bps || 0) +
                ' &nbsp; ↑ ' + fmtRate(iface.rate_sent_bps || 0) +
              '</span>' +
            '</div>' +
            '<div class="iface-totals">' +
              'recv ' + fmtBytes(iface.bytes_recv || 0) +
              ' · sent ' + fmtBytes(iface.bytes_sent || 0) +
            '</div>' +
            '</div>';
        }).join('') +
        '</div></div>';
    }

    $('detail-body').innerHTML = body;
    mountCanvas('net-detail-canvas', drawNetGraph);

    // Append 14-day history charts asynchronously
    fetch('/api/history/system').then(r => r.ok ? r.json() : null).then(hist => {
      if (!hist) return;
      const hasRecv = hist.net_recv && hist.net_recv.length >= 2;
      const hasSent = hist.net_sent && hist.net_sent.length >= 2;
      if (!hasRecv && !hasSent) return;
      const section = document.createElement('div');
      section.className = 'detail-section';
      section.innerHTML = '<h3>14-day network trend</h3>' +
        (hasRecv ? '<canvas id="net-hist-recv-canvas" style="width:100%;height:120px;display:block;margin-bottom:6px"></canvas>' : '') +
        (hasSent ? '<canvas id="net-hist-sent-canvas" style="width:100%;height:120px;display:block"></canvas>' : '') +
        '<div class="net-graph-legend" style="margin-top:6px">' +
        (hasRecv ? '<span class="net-legend-item"><span class="net-legend-dot" style="background:#e22828"></span>↓ Down</span>' : '') +
        (hasSent ? '<span class="net-legend-item"><span class="net-legend-dot" style="background:#4caf50"></span>↑ Up</span>' : '') +
        '</div>';
      const detailBody = $('detail-body');
      const sections = detailBody.querySelectorAll('.detail-section');
      if (sections[1]) sections[1].after(section); else detailBody.appendChild(section);
      if (hasRecv) mountCanvas('net-hist-recv-canvas', c => drawHistChart(c, hist.net_recv, '#e22828', v => fmtBytes(v) + '/s'));
      if (hasSent) mountCanvas('net-hist-sent-canvas', c => drawHistChart(c, hist.net_sent, '#4caf50', v => fmtBytes(v) + '/s'));
    }).catch(() => {});
  }

  function _deviceIcon(type) {
    const t = (type || '').toLowerCase();
    if (t === 'smartphone')  return '📱';
    if (t === 'computer')    return '💻';
    if (t === 'speaker')     return '🔊';
    if (t === 'tv')          return '📺';
    if (t === 'automobile')  return '🚗';
    if (t === 'gameconsole') return '🎮';
    return '🎵';
  }

  function _timeAgo(iso) {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (diff < 1)  return 'just now';
    if (diff < 60) return diff + 'm ago';
    const h = Math.floor(diff / 60);
    if (h < 24)    return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function renderSpotifyDetail(data) {
    const pb = data.playback || {};

    if (!pb.authorized) {
      $('detail-meta').textContent = 'not authorised';
      $('detail-body').innerHTML =
        '<div class="detail-section"><div class="spotify-auth">' +
          '<p>Authorise Brainless-Dash to read and control Spotify playback.</p>' +
          '<a href="/api/spotify/auth" class="spotify-auth-btn">Connect Spotify</a>' +
        '</div></div>';
      return;
    }

    if (!pb.active) {
      _spPlaying = false;
      $('detail-meta').textContent = 'idle';

      // Still render recently played and devices when idle
      const idleDevices = data.devices || [];
      const idleRecent  = data.recently_played || [];
      let idleBody = '<div class="detail-section"><div class="spotify-idle">No active playback</div></div>';

      if (idleDevices.length) {
        idleBody += '<div class="detail-section"><h3>Devices</h3><div class="sp-device-list">' +
          idleDevices.map(dev => {
            const activeCls = dev.is_active ? ' sp-device-active' : '';
            const switchAttrs = !dev.is_active
              ? ' data-device-id="' + esc(dev.id) + '" role="button" tabindex="0" title="Switch to this device"'
              : '';
            const metaParts = [dev.type];
            if (dev.is_active) metaParts.push('<span class="sp-device-playing">· playing</span>');
            if (dev.volume != null) metaParts.push(dev.volume + '%');
            return '<div class="sp-device-item' + activeCls + '"' + switchAttrs + '>' +
              '<span class="sp-device-icon">' + _deviceIcon(dev.type) + '</span>' +
              '<div class="sp-device-info">' +
                '<div class="sp-device-name">' + esc(dev.name) + '</div>' +
                '<div class="sp-device-meta">' + metaParts.join(' ') + '</div>' +
              '</div></div>';
          }).join('') +
        '</div></div>';
      }

      if (data.recent_scope_missing) {
        idleBody += '<div class="detail-section"><h3>Recently Played</h3>' +
          '<div class="sp-scope-hint">Re-authorise Spotify to see history — the app needs the <code>user-read-recently-played</code> scope. ' +
            '<a href="/api/spotify/auth">Re-authorise</a></div></div>';
      } else if (idleRecent.length) {
        idleBody += '<div class="detail-section"><h3>Recently Played</h3><div class="sp-track-list">' +
          idleRecent.map(t => {
            const artEl = t.art_url
              ? '<img class="sp-track-art" src="' + esc(t.art_url) + '" alt="">'
              : '<div class="sp-track-art"></div>';
            const sub = [t.artist, t.album].filter(Boolean).join(' · ');
            return '<div class="sp-track-item">' +
              artEl +
              '<div class="sp-track-info">' +
                '<div class="sp-track-name">' + esc(t.name) + '</div>' +
                (sub ? '<div class="sp-track-sub">' + esc(sub) + '</div>' : '') +
              '</div>' +
              '<span class="sp-track-dur sp-track-ago">' + (t.played_at ? _timeAgo(t.played_at) : '') + '</span>' +
            '</div>';
          }).join('') +
        '</div></div>';
      }

      $('detail-body').innerHTML = idleBody;

      // Wire device transfer buttons
      document.querySelectorAll('.sp-device-item[data-device-id]').forEach(el => {
        const deviceId = el.getAttribute('data-device-id');
        const transfer = () => _spotifyControl('transfer', { device_id: deviceId });
        el.addEventListener('click', transfer);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); transfer(); }
        });
      });
      return;
    }

    $('detail-meta').textContent = pb.device_name || 'playing';

    // Update progress interpolation state
    _spLastPoll   = Date.now();
    _spProgressMs = pb.progress_ms || 0;
    _spDurationMs = pb.duration_ms || 0;
    _spPlaying    = pb.is_playing;
    _startSpProgressTimer();

    const pct = _spDurationMs > 0 ? Math.min(100, (_spProgressMs / _spDurationMs) * 100) : 0;

    const artHtml = pb.art_url
      ? '<img class="sp-detail-art" src="' + esc(pb.art_url) + '" alt="">'
      : '<div class="sp-detail-art sp-art-empty"></div>';

    const ctx = data.context || {};
    const ctxHtml = ctx.name
      ? '<div class="sp-context">Playing from <span class="sp-context-name">' + esc(ctx.name) + '</span>' +
          (ctx.owner ? ' by ' + esc(ctx.owner) : '') + '</div>'
      : '';

    const shuffleCls = pb.shuffle ? ' active' : '';
    const repeatCls  = pb.repeat !== 'off' ? ' active' : '';
    const repeatTitle = pb.repeat === 'track' ? 'Repeat: track' : pb.repeat === 'context' ? 'Repeat: playlist' : 'Repeat: off';
    const nextRepeat  = { off: 'context', context: 'track', track: 'off' }[pb.repeat] || 'off';

    const volHtml = pb.volume != null
      ? '<label class="spotify-vol">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>' +
          '<input type="range" class="spotify-vol-range" id="sp-det-vol" min="0" max="100" value="' + pb.volume + '" aria-label="Volume">' +
        '</label>'
      : '';

    // Section 1: Now Playing
    const nowPlayingHtml =
      '<div class="detail-section">' +
        '<div class="sp-detail-now-playing">' +
          artHtml +
          '<div class="sp-detail-info">' +
            '<div class="sp-detail-track">' + esc(pb.track || '—') + '</div>' +
            '<div class="sp-detail-artist">' + esc(pb.artist || '—') + '</div>' +
            (pb.album ? '<div class="sp-detail-album">' + esc(pb.album) + '</div>' : '') +
            ctxHtml +
            '<div class="sp-detail-progress">' +
              '<span id="sp-det-pos" class="spotify-time">' + fmtMs(pb.progress_ms) + '</span>' +
              '<div class="bar sp-prog-bar" id="sp-seek-bar" style="cursor:pointer">' +
                '<div class="bar-fill spotify-prog-fill" id="sp-det-bar" style="width:' + pct.toFixed(1) + '%"></div>' +
              '</div>' +
              '<span class="spotify-time">' + fmtMs(pb.duration_ms) + '</span>' +
            '</div>' +
            '<div class="spotify-controls">' +
              '<button class="spotify-btn' + shuffleCls + '" id="sp-det-shuffle" title="' + (pb.shuffle ? 'Shuffle on' : 'Shuffle off') + '" aria-pressed="' + pb.shuffle + '">' +
                '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>' +
              '</button>' +
              '<button class="spotify-btn" id="sp-det-prev" title="Previous">' +
                '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>' +
              '</button>' +
              '<button class="spotify-btn spotify-btn-play" id="sp-det-toggle" title="' + (pb.is_playing ? 'Pause' : 'Play') + '">' +
                (pb.is_playing
                  ? '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
                  : '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>') +
              '</button>' +
              '<button class="spotify-btn" id="sp-det-next" title="Next">' +
                '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>' +
              '</button>' +
              '<button class="spotify-btn' + repeatCls + '" id="sp-det-repeat" title="' + repeatTitle + '" aria-label="' + repeatTitle + '">' +
                (pb.repeat === 'track'
                  ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></svg>'
                  : '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>') +
              '</button>' +
              volHtml +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Section 2: Up Next
    const queue = data.queue || [];
    const queueHtml =
      '<div class="detail-section"><h3>Up Next</h3>' +
        '<div class="sp-track-list">' +
          (queue.length
            ? queue.map(t => {
                const artEl = t.art_url
                  ? '<img class="sp-track-art" src="' + esc(t.art_url) + '" alt="">'
                  : '<div class="sp-track-art"></div>';
                const sub = [t.artist, t.album].filter(Boolean).join(' · ');
                return '<div class="sp-track-item">' +
                  artEl +
                  '<div class="sp-track-info">' +
                    '<div class="sp-track-name">' + esc(t.name) + '</div>' +
                    (sub ? '<div class="sp-track-sub">' + esc(sub) + '</div>' : '') +
                  '</div>' +
                  '<span class="sp-track-dur">' + fmtMs(t.duration_ms) + '</span>' +
                '</div>';
              }).join('')
            : '<div class="empty">queue empty</div>') +
        '</div>' +
      '</div>';

    // Section 3: Devices
    const devices = data.devices || [];
    const devicesHtml =
      '<div class="detail-section"><h3>Devices</h3>' +
        '<div class="sp-device-list">' +
          (devices.length
            ? devices.map(dev => {
                const activeCls = dev.is_active ? ' sp-device-active' : '';
                const switchAttrs = !dev.is_active
                  ? ' data-device-id="' + esc(dev.id) + '" role="button" tabindex="0" title="Switch to this device"'
                  : '';
                const metaParts = [dev.type];
                if (dev.is_active) metaParts.push('<span class="sp-device-playing">· playing</span>');
                if (dev.volume != null) metaParts.push(dev.volume + '%');
                return '<div class="sp-device-item' + activeCls + '"' + switchAttrs + '>' +
                  '<span class="sp-device-icon">' + _deviceIcon(dev.type) + '</span>' +
                  '<div class="sp-device-info">' +
                    '<div class="sp-device-name">' + esc(dev.name) + '</div>' +
                    '<div class="sp-device-meta">' + metaParts.join(' ') + '</div>' +
                  '</div>' +
                '</div>';
              }).join('')
            : '<div class="empty">no devices found</div>') +
        '</div>' +
      '</div>';

    // Section 4: Recently Played
    const recentlyPlayed = data.recently_played || [];
    let recentHtml;
    if (data.recent_scope_missing) {
      recentHtml =
        '<div class="detail-section"><h3>Recently Played</h3>' +
          '<div class="sp-scope-hint">Re-authorise Spotify to see history — the app needs the <code>user-read-recently-played</code> scope. ' +
            '<a href="/api/spotify/auth">Re-authorise</a>' +
          '</div>' +
        '</div>';
    } else {
      recentHtml =
        '<div class="detail-section"><h3>Recently Played</h3>' +
          '<div class="sp-track-list">' +
            (recentlyPlayed.length
              ? recentlyPlayed.map(t => {
                  const artEl = t.art_url
                    ? '<img class="sp-track-art" src="' + esc(t.art_url) + '" alt="">'
                    : '<div class="sp-track-art"></div>';
                  const sub = [t.artist, t.album].filter(Boolean).join(' · ');
                  return '<div class="sp-track-item">' +
                    artEl +
                    '<div class="sp-track-info">' +
                      '<div class="sp-track-name">' + esc(t.name) + '</div>' +
                      (sub ? '<div class="sp-track-sub">' + esc(sub) + '</div>' : '') +
                    '</div>' +
                    '<span class="sp-track-dur sp-track-ago">' + (t.played_at ? _timeAgo(t.played_at) : '') + '</span>' +
                  '</div>';
                }).join('')
              : '<div class="empty">no history</div>') +
          '</div>' +
        '</div>';
    }

    $('detail-body').innerHTML = nowPlayingHtml + queueHtml + devicesHtml + recentHtml;

    // Wire controls
    $('sp-det-shuffle').addEventListener('click', () => _spotifyControl('shuffle', { state: !pb.shuffle }));
    $('sp-det-prev').addEventListener('click',    () => _spotifyControl('previous'));
    $('sp-det-toggle').addEventListener('click',  () => _spotifyControl(pb.is_playing ? 'pause' : 'play'));
    $('sp-det-next').addEventListener('click',    () => _spotifyControl('next'));
    $('sp-det-repeat').addEventListener('click',  () => _spotifyControl('repeat', { mode: nextRepeat }));

    // Seek bar
    const seekBar = $('sp-seek-bar');
    if (seekBar && _spDurationMs) {
      seekBar.addEventListener('click', (e) => {
        const rect = seekBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const position_ms = Math.floor(ratio * _spDurationMs);
        _spotifyControl('seek', { position_ms });
      });
    }

    // Volume slider with 400ms debounce
    const volSlider = $('sp-det-vol');
    if (volSlider) {
      let volTimer = null;
      volSlider.addEventListener('input', () => {
        clearTimeout(volTimer);
        volTimer = setTimeout(() => _spotifyControl('volume', { volume_percent: parseInt(volSlider.value, 10) }), 400);
      });
    }

    // Device transfer
    document.querySelectorAll('.sp-device-item[data-device-id]').forEach(el => {
      const deviceId = el.getAttribute('data-device-id');
      const transfer = () => _spotifyControl('transfer', { device_id: deviceId });
      el.addEventListener('click', transfer);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); transfer(); }
      });
    });
  }

  function renderStorageDetail(data) {
    const disks = data.disks || [];
    let totalUsed = 0, totalSize = 0;
    disks.forEach(d => { totalUsed += d.used; totalSize += d.total; });
    const overall = totalSize > 0 ? ((totalUsed / totalSize) * 100) : 0;

    $('detail-meta').textContent = disks.length + (disks.length === 1 ? ' mount' : ' mounts');

    const statsHtml =
      statItem('Used',    fmtBytes(totalUsed),           'accent') +
      statItem('Free',    fmtBytes(totalSize - totalUsed), 'ok') +
      statItem('Total',   fmtBytes(totalSize)) +
      statItem('Overall', overall.toFixed(0) + '%',      barClass(overall));

    let body = '<div class="detail-section"><div class="detail-stats">' + statsHtml + '</div></div>';

    if (disks.length) {
      body += '<div class="detail-section"><h3>Mounts (' + disks.length + ')</h3>' +
        '<div class="disk-list">' +
        disks.map(disk => {
          return '<div class="disk-item">' +
            '<div class="disk-head">' +
              '<span class="disk-name">' + esc(disk.name) + '</span>' +
              '<div class="disk-head-right">' +
                (disk.fstype ? '<span class="disk-fstype">' + esc(disk.fstype) + '</span>' : '') +
                '<span class="disk-stats">' + fmtBytes(disk.used) + ' / ' + fmtBytes(disk.total) +
                  ' (' + disk.percent.toFixed(0) + '%)</span>' +
              '</div>' +
            '</div>' +
            '<div class="bar"><div class="bar-fill ' + barClass(disk.percent) +
              '" style="width:' + disk.percent + '%"></div></div>' +
            '<div class="disk-detail-sub">' +
              '<span class="disk-mount">' + esc(disk.mount) + '</span>' +
              '<span class="disk-free">free: ' + fmtBytes(disk.free) + '</span>' +
            '</div>' +
            '</div>';
        }).join('') +
        '</div></div>';
    } else {
      body += '<div class="detail-section"><div class="empty">no mounts found</div></div>';
    }

    if (data.array_status) {
      body += '<div class="detail-section"><h3>Array status</h3>' +
        '<pre class="mdstat-block">' + esc(data.array_status) + '</pre>' +
        '</div>';
    }

    $('detail-body').innerHTML = body;
  }

  function attachModuleClicks() {
    document.querySelectorAll('[data-module]').forEach(card => {
      const mod = card.getAttribute('data-module');
      if (!MODULES[mod]) return;
      const go = (e) => {
        if (_layoutUnlocked) return;
        if (e.target.closest('a, button, input, label')) return;
        e.preventDefault();
        location.hash = '#/' + mod;
      };
      card.addEventListener('click', go);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') go(e);
      });
    });
  }

  async function init() {
    _applyCardOrder();
    attachModuleClicks();
    window.addEventListener('hashchange', () => {
      applyRoute();
      if (currentModule) renderDetail();
    });
    $('layout-lock-btn').addEventListener('click', () => {
      if (_layoutUnlocked) _setLayoutLocked(); else _setLayoutUnlocked();
    });
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (r.ok) {
        const cfg = await r.json();
        if (cfg.refresh_ms && cfg.refresh_ms >= 500) REFRESH_MS = cfg.refresh_ms;
      }
    } catch (e) { /* use default */ }
    applyRoute();
    tick();
    _startWeatherPolling();
    _refreshTimer = setInterval(() => {
      if (currentModule) renderDetail();
      else tick();
    }, REFRESH_MS);
  }

  init();
})();
