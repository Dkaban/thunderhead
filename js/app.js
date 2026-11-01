(() => {
  const $ = id => document.getElementById(id);
  const status = $('status');
  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/dark',
    center: [-100, 39],
    zoom: 3,
    attributionControl: true
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  // Lightning uses a lightweight canvas rather than GeoJSON style layers.
  // This makes marker rendering independent of when map tiles finish loading.
  const canvas = document.createElement('canvas');
  canvas.id = 'lightning-overlay';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;';
  document.querySelector('main').appendChild(canvas);
  const ctx = canvas.getContext('2d', {alpha: true});

  let cells = [];
  let generated = null;
  let selectedMinutes = 60;
  let version = '';
  let loaded = false;
  // Four spatial resolutions, precomputed only when the dataset/time window changes.
  // Moving the map only redraws the already-aggregated cells, keeping mobile smooth.
  const DETAIL_LEVELS = [1.5, 0.5, 0.24, 0.12];
  let activityByGrid = new Map();
  let viewportPoints = [];
  let scheduled = false;
  let lastMinute = -1;
  const GRID = 0.12;

  function compactLegacy(flashes) {
    const bins = new Map();
    for (const f of flashes) {
      const timestamp = Date.parse(f.time);
      if (!Number.isFinite(timestamp) || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
      const a = Math.floor(f.lat / GRID);
      const b = Math.floor(f.lon / GRID);
      const minute = Math.floor(timestamp / 60000);
      const key = a + ':' + b + ':' + minute;
      bins.set(key, (bins.get(key) || 0) + 1);
    }
    return Array.from(bins, ([key, count]) => {
      const [a, b, minute] = key.split(':').map(Number);
      return [Number(((a + 0.5) * GRID).toFixed(3)),
              Number(((b + 0.5) * GRID).toFixed(3)), minute, count];
    });
  }

  function recompute() {
    if (!loaded) return;
    const now = Math.floor(Date.now() / 60000);
    lastMinute = now;
    const totals = {5: 0, 15: 0, 60: 0};
    const levelBins = new Map(DETAIL_LEVELS.map(grid => [grid, new Map()]));

    // Walk the compact NOAA data only once per update (not on every pan/zoom).
    for (const [lat, lon, minute, count] of cells) {
      const age = now - minute;
      if (age < 0 || age >= 60) continue;
      if (age < 5) totals[5] += count;
      if (age < 15) totals[15] += count;
      totals[60] += count;
      if (age >= selectedMinutes) continue;

      for (const grid of DETAIL_LEVELS) {
        const la = Math.floor(lat / grid);
        const lo = Math.floor(lon / grid);
        const key = la + ':' + lo;
        const bins = levelBins.get(grid);
        let bin = bins.get(key);
        if (!bin) {
          bin = {lat:(la + 0.5) * grid, lon:(lo + 0.5) * grid,
                 count:0, latest:minute};
          bins.set(key, bin);
        }
        bin.count += count;
        bin.latest = Math.max(bin.latest, minute);
      }
    }

    activityByGrid = new Map(DETAIL_LEVELS.map(grid => [
      grid,
      Array.from(levelBins.get(grid).values(), item => ({
        ...item, age: now - item.latest
      }))
    ]));
    for (const n of [5, 15, 60]) {
      $('count' + n).textContent = totals[n].toLocaleString();
    }
    schedulePaint();
  }

  function schedulePaint() {
    if (scheduled || !ctx) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      paint();
    });
  }

  function paint() {
    if (!ctx) return;
    const container = map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;

    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    viewportPoints = [];
    const zoom = map.getZoom();

    const grid = zoom >= 9 ? 0.12 : zoom >= 7 ? 0.24 : zoom >= 5 ? 0.5 : 1.5;
    const activity = activityByGrid.get(grid) || [];
    const bounds = map.getBounds();
    const south = bounds.getSouth() - grid;
    const north = bounds.getNorth() + grid;
    // Longitude filtering is only needed in the standard [-180, 180] view.
    // When panning across the date line, let screen coordinates handle wrapping.
    const west = bounds.getWest() - grid;
    const east = bounds.getEast() + grid;
    const standardLongitude = west >= -180 && east <= 180;

    for (const item of activity) {
      if (item.lat < south || item.lat > north) continue;
      if (standardLongitude && (item.lon < west || item.lon > east)) continue;
      // Avoid sending 10s of thousands of positions through MapLibre's worker.
      // Project only the already-aggregated geographic activity areas.
      const p = map.project([item.lon, item.lat]);
      if (p.x < -12 || p.y < -12 || p.x > width + 12 || p.y > height + 12) continue;

      const radius = Math.min(8, (zoom < 4 ? 3.5 : 4.5) + Math.log10(item.count + 1));
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = item.age < 5 ? '#71e6ff' : item.age < 15 ? '#ffc26d' : '#ff7e9b';
      ctx.globalAlpha = 0.82;
      ctx.fill();
      viewportPoints.push({x:p.x, y:p.y, radius, item});
    }
    ctx.globalAlpha = 1;

    if (loaded) {
      const updated = generated ? new Date(generated).toLocaleString() : 'Unknown';
      const detail = grid === 1.5 ? 'Regional' : grid === 0.5 ? 'Local' : grid === 0.24 ? 'Detailed' : 'High detail';
      $('updated').textContent = 'NOAA data: ' + updated +
        ' · ' + viewportPoints.length.toLocaleString() + ' visible areas · ' + detail + ' view';
    }
  }

  map.on('move', schedulePaint);
  map.on('resize', schedulePaint);
  map.on('style.load', schedulePaint);
  map.on('load', schedulePaint);
  window.addEventListener('resize', schedulePaint);

  map.on('click', event => {
    const p = event.point;
    let closest = null;
    let closestDistance = 14;
    for (const point of viewportPoints) {
      const distance = Math.hypot(point.x - p.x, point.y - p.y);
      if (distance < closestDistance) {
        closest = point;
        closestDistance = distance;
      }
    }
    if (!closest) return;
    new maplibregl.Popup()
      .setLngLat([closest.item.lon, closest.item.lat])
      .setText(closest.item.count.toLocaleString() +
        ' approximate flashes in this area over the selected time window')
      .addTo(map);
  });

  $('window').addEventListener('change', e => {
    selectedMinutes = Number(e.target.value);
    recompute();
  });

  async function refresh() {
    try {
      const slot = Math.floor(Date.now() / 300000);
      const response = await fetch('data/flashes.json?v=' + slot);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (data.generated_at && version === data.generated_at) return;

      const next = Array.isArray(data.cells) ? data.cells : compactLegacy(data.flashes || []);
      cells = next.filter(c => Array.isArray(c) && c.length === 4 &&
        Number.isFinite(c[0]) && Number.isFinite(c[1]) &&
        Number.isInteger(c[2]) && Number.isFinite(c[3]) && c[3] > 0);
      generated = data.generated_at || null;
      version = data.generated_at || '';
      loaded = true;
      status.textContent = generated
        ? 'NOAA DATA · ' + new Date(generated).toLocaleTimeString()
        : 'NO DATA YET';
      recompute();
    } catch (error) {
      status.textContent = 'DATA NOT AVAILABLE';
      console.error('Thunderhead data error:', error);
    }
  }

  refresh();
  setInterval(refresh, 300000);
  setInterval(() => {
    const now = Math.floor(Date.now() / 60000);
    if (now !== lastMinute) recompute();
  }, 30000);
})();
