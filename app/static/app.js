/* Unraid Monitor frontend */
(() => {
  let REFRESH_MS = 2000;

  const $ = (id) => document.getElementById(id);

  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return ',';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    let v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 && i > 0 ? 2 : v < 100 ? 1 : 0) + ' ' + units[i];
  }

  function fmtRate(bps) {
    return fmtBytes(bps) + '/s';
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
    if (pct >= 90) return 'crit';
    if (pct >= 75) return 'warn';
    return '';
  }

  function tempClass(t, high, crit) {
    if (crit && t >= crit) return 'crit';
    if (high && t >= high) return 'warn';
    if (t >= 80) return 'crit';
    if (t >= 65) return 'warn';
    return '';
  }

  function render(d) {
    // Header
    $('hostname').textContent = d.hostname || 'unknown';
    $('status-dot').className = 'dot dot-on';

    // System
    $('uptime').textContent = 'up ' + fmtUptime(d.uptime);
    $('load1').textContent = d.cpu.load_1m.toFixed(2);
    $('load5').textContent = d.cpu.load_5m.toFixed(2);
    $('load15').textContent = d.cpu.load_15m.toFixed(2);
    $('cores').textContent = d.cpu.cores + ' / ' + d.cpu.threads + 't';

    // CPU
    const cpuPct = d.cpu.percent;
    $('cpu-percent').textContent = cpuPct.toFixed(0);
    $('cpu-freq').textContent = d.cpu.freq_mhz ? '@ ' + (d.cpu.freq_mhz / 1000).toFixed(2) + ' GHz' : '';
    const cpuBar = $('cpu-bar');
    cpuBar.style.width = cpuPct + '%';
    cpuBar.className = 'bar-fill ' + barClass(cpuPct);

    const coresEl = $('cpu-cores');
    coresEl.innerHTML = '';
    d.cpu.per_cpu.forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'core';
      div.innerHTML =
        '<div class="core-label">CPU' + i + '</div>' +
        '<div class="core-value">' + p.toFixed(0) + '%</div>' +
        '<div class="core-bar"><div class="core-bar-fill" style="width:' + p + '%"></div></div>';
      coresEl.appendChild(div);
    });

    // Memory
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
    const tList = $('temp-list');
    tList.innerHTML = '';
    if (!d.temps || d.temps.length === 0) {
      tList.innerHTML = '<div class="empty">no sensors detected (mount /sys in container)</div>';
      $('temp-count').textContent = '0';
    } else {
      $('temp-count').textContent = d.temps.length + ' sensors';
      d.temps.forEach((s) => {
        const cls = tempClass(s.current, s.high, s.critical);
        const row = document.createElement('div');
        row.className = 'temp-item ' + cls;
        row.innerHTML =
          '<span class="label">' + s.label + '</span>' +
          '<span class="value">' + s.current.toFixed(1) + '°C</span>';
        tList.appendChild(row);
      });
    }

    // Storage
    const dList = $('disk-list');
    dList.innerHTML = '';
    let totalUsed = 0, totalSize = 0;
    if (!d.storage.disks.length) {
      dList.innerHTML = '<div class="empty">no mounts found</div>';
      $('storage-summary').textContent = '0 mounts';
    } else {
      d.storage.disks.forEach((disk) => {
        totalUsed += disk.used;
        totalSize += disk.total;
        const item = document.createElement('div');
        item.className = 'disk-item';
        item.innerHTML =
          '<div class="disk-head">' +
            '<span class="disk-name">' + disk.name + '</span>' +
            '<span class="disk-stats">' + fmtBytes(disk.used) + ' / ' + fmtBytes(disk.total) + ' (' + disk.percent.toFixed(0) + '%)</span>' +
          '</div>' +
          '<div class="bar"><div class="bar-fill ' + barClass(disk.percent) + '" style="width:' + disk.percent + '%"></div></div>';
        dList.appendChild(item);
      });
      const overall = totalSize > 0 ? ((totalUsed / totalSize) * 100).toFixed(0) : 0;
      $('storage-summary').textContent = fmtBytes(totalUsed) + ' / ' + fmtBytes(totalSize) + ' (' + overall + '%)';
    }

    // Network
    $('net-down').textContent = fmtRate(d.network.rate_recv_bps);
    $('net-up').textContent = fmtRate(d.network.rate_sent_bps);
    $('net-iface-count').textContent = d.network.interfaces.length + ' interfaces';

    const ifaceList = $('iface-list');
    ifaceList.innerHTML = '';
    d.network.interfaces.forEach((i) => {
      const row = document.createElement('div');
      row.className = 'iface-item';
      row.innerHTML =
        '<span class="iface-name">' + i.name + '</span>' +
        '<span class="iface-totals">↓ ' + fmtBytes(i.bytes_recv) + ' &nbsp; ↑ ' + fmtBytes(i.bytes_sent) + '</span>';
      ifaceList.appendChild(row);
    });

    // Plex
    const plexCard = $('card-plex');
    if (d.plex) {
      plexCard.style.display = '';
      const plex = d.plex;
      $('plex-count').textContent = plex.stream_count === 1 ? '1 stream' : plex.stream_count + ' streams';
      const streamList = $('plex-streams');
      streamList.innerHTML = '';
      if (!plex.available) {
        streamList.innerHTML = '<div class="empty">plex unavailable</div>';
      } else if (!plex.sessions.length) {
        streamList.innerHTML = '<div class="empty">no active streams</div>';
      } else {
        plex.sessions.forEach((s) => {
          const item = document.createElement('div');
          item.className = 'plex-session';
          const heading = s.show ? s.show + ' — ' + s.title : s.title;
          const pausedBadge = s.state === 'paused' ? ' <span class="plex-paused">(paused)</span>' : '';
          const streamBadge = s.transcoding
            ? '<span class="plex-transcode">transcoding</span>'
            : '<span class="plex-direct">direct play</span>';
          item.innerHTML =
            '<div class="plex-title">' + heading + pausedBadge + '</div>' +
            '<div class="plex-meta"><span>' + s.user + ' · ' + s.player + '</span>' + streamBadge + '</div>' +
            '<div class="bar"><div class="bar-fill" style="width:' + s.progress_pct + '%"></div></div>';
          streamList.appendChild(item);
        });
      }
    } else {
      plexCard.style.display = 'none';
    }

    // Footer
    const t = new Date();
    $('last-update').textContent = t.toLocaleTimeString();
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
      const data = await r.json();
      render(data);
    } catch (e) {
      console.error(e);
      setError();
    }
  }

  async function init() {
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (r.ok) {
        const cfg = await r.json();
        if (cfg.refresh_ms && cfg.refresh_ms >= 500) {
          REFRESH_MS = cfg.refresh_ms;
        }
      }
    } catch (e) {
      /* fall back to default */
    }
    tick();
    setInterval(tick, REFRESH_MS);
  }

  init();
})();
