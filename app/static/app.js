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
            '<span class="sensor-row-value' + (f.rpm === 0 ? ' warn' : '') + '">' + f.rpm.toLocaleString() + ' RPM</span>' +
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
    minecraft:   { title: 'Minecraft',     endpoint: '/api/minecraft',   render: renderMinecraftDetail },
    qbittorrent: { title: 'qBittorrent',   endpoint: '/api/qbittorrent', render: renderQbDetail },
    sabnzbd:     { title: 'SABnzbd',       endpoint: '/api/sabnzbd',     render: renderSabDetail },
    sonarr:      { title: 'Sonarr',        endpoint: '/api/sonarr',      render: renderSonarrDetail },
    plex:        { title: 'Plex',          endpoint: '/api/plex',        render: renderPlexDetail },
    temps:       { title: 'Temperatures',  endpoint: '/api/temps',       render: renderTempsDetail },
    network:     { title: 'Network',       endpoint: '/api/network',     render: renderNetworkDetail },
    storage:     { title: 'Storage',       endpoint: '/api/storage',     render: renderStorageDetail },
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
    try {
      const r = await fetch(mod.endpoint, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      mod.render(data);
    } catch (e) {
      console.error(e);
      $('detail-body').innerHTML = '<div class="empty">failed to load: ' + esc(e.message) + '</div>';
      $('detail-meta').textContent = '';
    }
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

    $('detail-body').innerHTML =
      '<div class="detail-section">' +
        '<div class="mc-detail-banner">' + favHtml +
          '<div><div class="mc-detail-name">' + esc(mc.version || 'Minecraft Server') + '</div>' +
          '<div class="mc-motd">' + motdLines + '</div></div>' +
        '</div>' +
      '</div>' +
      (diagHtml ? '<div class="detail-section">' + diagHtml + '</div>' : '') +
      '<div class="detail-section"><div class="detail-stats">' + stats + '</div></div>' +
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
          const cls = f.rpm === 0 ? 'warn' : '';
          return '<div class="fan-detail-item">' +
            '<span class="fan-detail-chip">' + esc(f.chip) + '</span>' +
            '<span class="fan-detail-label">' + esc(f.label) + '</span>' +
            '<span class="fan-detail-rpm ' + cls + '">' + f.rpm.toLocaleString() + ' RPM</span>' +
            '</div>';
        }).join('') +
        '</div></div>';
    }

    $('detail-body').innerHTML = body;
    mountCanvas('temp-detail-canvas', (c) => drawTempGraph(c, sensors));
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
      const go = (e) => { e.preventDefault(); location.hash = '#/' + mod; };
      card.addEventListener('click', go);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') go(e);
      });
    });
  }

  async function init() {
    attachModuleClicks();
    window.addEventListener('hashchange', () => {
      applyRoute();
      if (currentModule) renderDetail();
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
    setInterval(() => {
      if (currentModule) renderDetail();
      else tick();
    }, REFRESH_MS);
  }

  init();
})();
