(() => {
  const $ = id => document.getElementById(id);
  const status = $('status');
  const dataAlert = $('data-alert');
  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/dark',
    center: [-100, 39],
    zoom: 3,
    attributionControl: true
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  // Unlike geographic bin-centres, these points are actual NOAA flash centroids.
  // A light, sampled density layer provides detail without drawing tens of thousands of circles.
  const canvas = document.createElement('canvas');
  canvas.id = 'lightning-overlay';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;';
  document.querySelector('main').appendChild(canvas);
  const ctx = canvas.getContext('2d', {alpha: true});
  const SAMPLE_LIMIT_HEAT = 1600;
  const SAMPLE_LIMIT_DOTS = 2200;
  const STALE_AFTER_MS = 15 * 60 * 1000;
  const REGION_DEGREES = 3;

  let samples = [];
  let minuteCounts = [];
  let generated = null;
  let version = '';
  let selectedMinutes = 60;
  let loaded = false;
  let fetchFailed = false;
  let fetchInProgress = false;
  let lastFetchAttempt = 0;
  let lastMinute = -1;
  let renderPending = false;
  let spatialRegions = [];
  let viewportPoints = [];

  function createGlow(red, green, blue) {
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 72;
    const c = sprite.getContext('2d');
    const grad = c.createRadialGradient(36, 36, 0, 36, 36, 35);
    grad.addColorStop(0, 'rgba(' + red + ',' + green + ',' + blue + ',0.78)');
    grad.addColorStop(0.22, 'rgba(' + red + ',' + green + ',' + blue + ',0.48)');
    grad.addColorStop(0.65, 'rgba(' + red + ',' + green + ',' + blue + ',0.14)');
    grad.addColorStop(1, 'rgba(' + red + ',' + green + ',' + blue + ',0)');
    c.fillStyle = grad;
    c.fillRect(0, 0, 72, 72);
    return sprite;
  }
  const glows = [
    createGlow(113, 230, 255),
    createGlow(255, 194, 109),
    createGlow(255, 126, 155)
  ];
  const colours = ['#71e6ff', '#ffc26d', '#ff7e9b'];

  function ageLabel(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.floor(minutes / 60);
    return hours + ' hr ' + (minutes % 60) + ' min ago';
  }

  function showFreshness() {
    const stamp = generated ? Date.parse(generated) : NaN;
    const age = Number.isFinite(stamp) ? Math.max(0, Date.now() - stamp) : null;
    const delayed = age !== null && age > STALE_AFTER_MS;

    if (!loaded) status.textContent = fetchFailed ? 'NOAA · OFFLINE' : 'Loading observations…';
    else if (fetchFailed) status.textContent = 'NOAA · CHECK FAILED';
    else if (age === null) status.textContent = 'NOAA · NO DATA';
    else status.textContent = (delayed ? 'NOAA · DELAYED ' : 'NOAA · ') + ageLabel(age);

    if (!dataAlert) return;
    const warning = fetchFailed
      ? 'Could not check for fresh NOAA data. Showing the last available dataset.'
      : age === null
        ? 'No NOAA dataset is available yet.'
        : delayed
          ? 'NOAA data is delayed (last update ' + ageLabel(age) +
            '). Recent flash counts may be zero because observations have expired. GitHub Actions schedules are not guaranteed.'
          : '';
    dataAlert.hidden = !warning;
    dataAlert.textContent = warning;
  }

  function recompute() {
    if (!loaded) return;
    const now = Math.floor(Date.now() / 60000);
    lastMinute = now;
    const totals = {5: 0, 15: 0, 60: 0};
    for (const [minute, count] of minuteCounts) {
      const age = now - minute;
      if (age < 0 || age >= 60) continue;
      if (age < 5) totals[5] += count;
      if (age < 15) totals[15] += count;
      totals[60] += count;
    }
    for (const n of [5, 15, 60]) $('count' + n).textContent = totals[n].toLocaleString();

    // Organize display samples into broad *lookup* regions only.
    // Coordinates are never snapped to the region boundaries or their centres.
    const regions = new Map();
    for (const [lat, lon, minute] of samples) {
      const age = now - minute;
      if (age < 0 || age >= selectedMinutes) continue;
      const latBin = Math.floor(lat / REGION_DEGREES);
      const lonBin = Math.floor(lon / REGION_DEGREES);
      const key = latBin + ':' + lonBin;
      let region = regions.get(key);
      if (!region) {
        region = {south: latBin * REGION_DEGREES,
          north: (latBin + 1) * REGION_DEGREES,
          west: lonBin * REGION_DEGREES,
          east: (lonBin + 1) * REGION_DEGREES,
          points: []};
        regions.set(key, region);
      }
      region.points.push({lat, lon, minute, age, band: age < 5 ? 0 : age < 15 ? 1 : 2});
    }
    spatialRegions = Array.from(regions.values());
    schedulePaint();
  }

  function schedulePaint() {
    if (!ctx || renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
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
    const pixelWidth = Math.round(width * scale);
    const pixelHeight = Math.round(height * scale);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    viewportPoints = [];

    const zoom = map.getZoom();
    const heat = zoom < 8;
    const limit = heat ? SAMPLE_LIMIT_HEAT : SAMPLE_LIMIT_DOTS;
    const bounds = map.getBounds();
    const south = bounds.getSouth() - REGION_DEGREES;
    const north = bounds.getNorth() + REGION_DEGREES;
    const west = bounds.getWest() - REGION_DEGREES;
    const east = bounds.getEast() + REGION_DEGREES;
    const regularLongitudes = west >= -180 && east <= 180;

    const candidates = [];
    for (const region of spatialRegions) {
      if (region.north < south || region.south > north) continue;
      if (regularLongitudes && (region.east < west || region.west > east)) continue;
      candidates.push(...region.points);
    }

    // Stable thinning in *screen space*: never move a point to a geographic grid centre.
    const stride = Math.max(1, Math.ceil(candidates.length / limit));
    const seenPixels = heat ? null : new Set();
    const radius = zoom < 4 ? 19 : zoom < 6 ? 24 : 29;
    ctx.globalCompositeOperation = heat ? 'lighter' : 'source-over';
    ctx.globalAlpha = heat ? Math.min(0.76, 0.32 + Math.log2(stride) * 0.06) : 0.92;

    for (let i = 0; i < candidates.length; i += stride) {
      const item = candidates[i];
      const p = map.project([item.lon, item.lat]);
      if (p.x < -radius || p.y < -radius ||
          p.x > width + radius || p.y > height + radius) continue;

      if (heat) {
        // Soft overlapping kernels show storm density without fake dot lattices.
        ctx.drawImage(glows[item.band], p.x - radius, p.y - radius,
          radius * 2, radius * 2);
      } else {
        const pixelKey = Math.floor(p.x / 7) + ':' + Math.floor(p.y / 7);
        if (seenPixels.has(pixelKey)) continue;
        seenPixels.add(pixelKey);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.7, 0, Math.PI * 2);
        ctx.fillStyle = colours[item.band];
        ctx.fill();
        viewportPoints.push({x: p.x, y: p.y, item});
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (loaded) {
      const updated = generated ? new Date(generated).toLocaleString() : 'Unknown';
      $('updated').textContent = 'NOAA data: ' + updated +
        ' · ' + (heat ? 'Activity density' : 'Sampled flash locations') +
        ' · ' + selectedMinutes + '-minute view';
    }
  }

  map.on('move', schedulePaint);
  map.on('resize', schedulePaint);
  map.on('load', schedulePaint);
  window.addEventListener('resize', schedulePaint);

  map.on('click', e => {
    if (map.getZoom() < 8) return;
    let nearest = null;
    let best = 14;
    for (const point of viewportPoints) {
      const distance = Math.hypot(point.x - e.point.x, point.y - e.point.y);
      if (distance < best) {
        nearest = point;
        best = distance;
      }
    }
    if (!nearest) return;
    const f = nearest.item;
    new maplibregl.Popup()
      .setLngLat([f.lon, f.lat])
      .setText('Sampled NOAA optical flash · approximate location · ' +
        new Date(f.minute * 60000).toLocaleTimeString())
      .addTo(map);
  });

  $('window').addEventListener('change', e => {
    selectedMinutes = Number(e.target.value);
    recompute();
  });

  function normalizeData(data) {
    if (Array.isArray(data.samples) && Array.isArray(data.counts)) {
      return {
        points: data.samples.filter(s => Array.isArray(s) && s.length === 3 &&
          Number.isFinite(s[0]) && Number.isFinite(s[1]) && Number.isInteger(s[2])),
        counts: data.counts.filter(c => Array.isArray(c) && c.length === 2 &&
          Number.isInteger(c[0]) && Number.isFinite(c[1]))
      };
    }
    // Older deployment compatibility until the next NOAA ingestion completes.
    const cells = Array.isArray(data.cells) ? data.cells : [];
    if (!cells.length && !Array.isArray(data.flashes)) throw Error('Unknown NOAA data format');
    const points = [], countMap = new Map();
    if (cells.length) {
      for (const c of cells) {
        if (!Array.isArray(c) || c.length !== 4) continue;
        points.push([c[0], c[1], c[2]]);
        countMap.set(c[2], (countMap.get(c[2]) || 0) + c[3]);
      }
    } else {
      for (const f of data.flashes) {
        const minute = Math.floor(Date.parse(f.time) / 60000);
        if (!Number.isFinite(minute)) continue;
        points.push([f.lat, f.lon, minute]);
        countMap.set(minute, (countMap.get(minute) || 0) + 1);
      }
    }
    return {points, counts: Array.from(countMap)};
  }

  async function refresh() {
    if (fetchInProgress) return;
    fetchInProgress = true;
    lastFetchAttempt = Date.now();
    try {
      const slot = Math.floor(Date.now() / 60000);
      const response = await fetch('data/flashes.json?refresh=' + slot, {cache: 'no-store'});
      if (!response.ok) throw Error('HTTP ' + response.status);
      const data = await response.json();
      if (data.generated_at && generated &&
          Date.parse(data.generated_at) < Date.parse(generated)) return;
      if (data.generated_at && version === data.generated_at) return;

      const parsed = normalizeData(data);
      samples = parsed.points;
      minuteCounts = parsed.counts;
      generated = data.generated_at || null;
      version = generated || '';
      loaded = true;
      fetchFailed = false;
      recompute();
    } catch (error) {
      fetchFailed = true;
      console.error('Thunderhead NOAA data error:', error);
    } finally {
      fetchInProgress = false;
      showFreshness();
    }
  }

  refresh();
  setInterval(refresh, 300000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' &&
        Date.now() - lastFetchAttempt >= 60000) refresh();
  });
  window.addEventListener('pageshow', () => {
    if (Date.now() - lastFetchAttempt >= 60000) refresh();
  });
  setInterval(() => {
    const minute = Math.floor(Date.now() / 60000);
    if (minute !== lastMinute) recompute();
    showFreshness();
  }, 30000);
})();
