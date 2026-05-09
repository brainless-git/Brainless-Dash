/* Unraid Monitor frontend */
(() => {
  let REFRESH_MS = 2000;

  const $ = (id) => document.getElementById(id);

  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0, v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 && i > 0 ? 2 : v < 100 ? 1 : 0) + ' ' + units[i];
  }

  function fmtRate(bps) { return fmtBytes(bps) + '/s'; }

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
  let tempCanvasW = 0;

  function initCanvas() {
    const canvas = $('temp-canvas');
    if (!canvas) return;
    // Use ResizeObserver so we only measure on actual layout changes
    if (window.ResizeObserver) {
      new ResizeObserver(entries => {
        const w = Math.round(entries[0].contentRect.width);
        if (w > 0 && w !== tempCanvasW) { tempCanvasW = w; canvas.width = w; }
      }).observe(canvas);
    } else {
      window.addEventListener('resize', () => {
        const w = canvas.offsetWidth;
        if (w > 0 && w !== tempCanvasW) { tempCanvasW = w; canvas.width = w; }
      });
    }
    tempCanvasW = canvas.offsetWidth;
    canvas.width = tempCanvasW;
  }

  function drawTempGraph(sensors) {
    const canvas = $('temp-canvas');
    if (!canvas || !canvas.getContext || sensors.length === 0) return;

    // Push snapshot as a label→temp map (O(1) lookup later)
    const frame = {};
    sensors.forEach(s => { frame[s.label] = s.current; });
    tempHistory.push(frame);
    if (tempHistory.length > TEMP_HISTORY_MAX) tempHistory.shift();
    if (tempHistory.length < 2) return;

    const ctx = canvas.getContext('2d');
    const w = tempCanvasW || canvas.width;
    const h = canvas.height;
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

  // ── Sonarr change detection ──────────────────────────────────────────────────

  let _sonarrHash = '';
  function sonarrKey(episodes) {
    return episodes.map(e => e.air_date + e.show + e.episode + e.downloaded).join('|');
  }

  // ── Main render ──────────────────────────────────────────────────────────────

  function render(d) {
    $('hostname').textContent = d.hostname || 'unknown';
    $('status-dot').className = 'dot dot-on';

    // System
    $('uptime').textContent  = 'up ' + fmtUptime(d.uptime);
    $('load1').textContent   = d.cpu.load_1m.toFixed(2);
    $('load5').textContent   = d.cpu.load_5m.toFixed(2);
    $('load15').textContent  = d.cpu.load_15m.toFixed(2);
    $('cores').textContent   = d.cpu.cores + ' / ' + d.cpu.threads + 't';

    // CPU & Memory
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
    $('resource-meta').textContent = 'CPU ' + cpuPct.toFixed(0) + '% · MEM ' + m.percent.toFixed(0) + '%';

    // Temperatures
    const temps = d.temps || [];
    if (temps.length === 0) {
      $('temp-count').textContent = '0 sensors';
      $('temp-legend').innerHTML = '<div class="empty">no sensors detected (mount /sys in container)</div>';
    } else {
      $('temp-count').textContent = temps.length + (temps.length === 1 ? ' sensor' : ' sensors');
      drawTempGraph(temps);
      // Build legend as a single innerHTML string — no per-item reflow
      $('temp-legend').innerHTML = temps.map((s, si) => {
        const color = TEMP_COLORS[si % TEMP_COLORS.length];
        const cls = tempClass(s.current, s.high, s.critical);
        return '<div class="temp-legend-item">' +
          '<span class="temp-legend-dot" style="background:' + color + '"></span>' +
          '<span class="temp-legend-label">' + s.label + '</span>' +
          '<span class="temp-legend-value ' + cls + '">' + s.current.toFixed(1) + '°C</span>' +
          '</div>';
      }).join('');
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
            '<span class="disk-name">' + disk.name + '</span>' +
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
    const ifaceCount = d.network.interfaces.length;
    $('net-iface-count').textContent = ifaceCount + (ifaceCount === 1 ? ' interface' : ' interfaces');

    // Sonarr — skip DOM rebuild if episodes haven't changed
    const sonarrCard = $('card-sonarr');
    if (d.sonarr) {
      sonarrCard.style.display = '';
      const sonarr = d.sonarr;
      const list = $('sonarr-list');
      if (!sonarr.available) {
        const msg = sonarr.error ? 'sonarr unavailable: ' + sonarr.error : 'sonarr unavailable';
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
                '<div class="sonarr-day-label">' + eps[0].day_label + '</div>' +
                eps.map(ep => {
                  const epNum = 'S' + String(ep.season).padStart(2, '0') + 'E' + String(ep.episode).padStart(2, '0');
                  const badge = ep.downloaded
                    ? '<span class="sonarr-badge downloaded">Downloaded</span>'
                    : '<span class="sonarr-badge upcoming">Upcoming</span>';
                  return '<div class="sonarr-episode">' +
                    '<div class="sonarr-left">' +
                      '<span class="sonarr-show">' + ep.show + '</span>' +
                      '<span class="sonarr-ep-title">' + ep.title + '</span>' +
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
        const msg = plex.error ? 'plex unavailable: ' + plex.error : 'plex unavailable';
        streamList.innerHTML = '<div class="empty">' + msg + '</div>';
      } else if (!plex.sessions.length) {
        streamList.innerHTML = '<div class="empty">no active streams</div>';
      } else {
        streamList.innerHTML = plex.sessions.map(s => {
          const heading = s.show ? s.show + ' — ' + s.title : s.title;
          const pausedBadge = s.state === 'paused' ? ' <span class="plex-paused">(paused)</span>' : '';
          const streamBadge = s.transcoding
            ? '<span class="plex-transcode">transcoding</span>'
            : '<span class="plex-direct">direct play</span>';
          return '<div class="plex-session">' +
            '<div class="plex-title">' + heading + pausedBadge + '</div>' +
            '<div class="plex-meta"><span>' + s.user + ' · ' + s.player + '</span>' + streamBadge + '</div>' +
            '<div class="bar"><div class="bar-fill" style="width:' + s.progress_pct + '%"></div></div>' +
            '</div>';
        }).join('');
      }
    } else {
      plexCard.style.display = 'none';
    }

    // Footer
    $('last-update').textContent = new Date().toLocaleTimeString();
    $('refresh-rate').textContent = (REFRESH_MS / 1000) + 's';
  }

  function setError() {
    $('status-dot').className = 'dot dot-off';
    $('hostname').textContent = 'connection lost';
  }

  async function tick() {
    try {
      const r = await fetch('/api/stats', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      render(await r.json());
    } catch (e) {
      console.error(e);
      setError();
    }
  }

  async function init() {
    initCanvas();
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (r.ok) {
        const cfg = await r.json();
        if (cfg.refresh_ms && cfg.refresh_ms >= 500) REFRESH_MS = cfg.refresh_ms;
      }
    } catch (e) { /* use default */ }
    tick();
    setInterval(tick, REFRESH_MS);
  }

  init();
})();
