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

  const empty = {type: 'FeatureCollection', features: []};
  const GRID = 0.12;
  let cells = [];
  let generated = null;
  let selectedMinutes = 60;
  let lastRenderedMinute = -1;
  let version = '';
  let loaded = false;

  // Compatible with older data until the first compact-data workflow completes.
  function compactLegacy(flashes) {
    const bins = new Map();
    for (const f of flashes) {
      const time = Date.parse(f.time);
      if (!Number.isFinite(time) || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
      const la = Math.floor(f.lat / GRID), lo = Math.floor(f.lon / GRID), minute = Math.floor(time / 60000);
      const key = la + ':' + lo + ':' + minute;
      bins.set(key, (bins.get(key) || 0) + 1);
    }
    return Array.from(bins, ([key, count]) => {
      const [la, lo, minute] = key.split(':').map(Number);
      return [Number(((la + 0.5) * GRID).toFixed(3)), Number(((lo + 0.5) * GRID).toFixed(3)), minute, count];
    });
  }

  function render(force = false) {
    if (!loaded) return;
    const nowMinute = Math.floor(Date.now() / 60000);
    if (!force && nowMinute === lastRenderedMinute) return;
    lastRenderedMinute = nowMinute;

    const totals = {5: 0, 15: 0, 60: 0};
    const visible = new Map();
    // Display one 0.5-degree activity marker per area, merging time bins.
    const displayGrid = 0.5;

    for (const [lat, lon, minute, count] of cells) {
      const age = nowMinute - minute;
      if (age < 0 || age >= 60) continue;
      if (age < 5) totals[5] += count;
      if (age < 15) totals[15] += count;
      totals[60] += count;
      if (age >= selectedMinutes) continue;

      const latBin = Math.floor(lat / displayGrid);
      const lonBin = Math.floor(lon / displayGrid);
      const key = latBin + ':' + lonBin;
      const previous = visible.get(key);
      if (previous) {
        previous.count += count;
        previous.latest = Math.max(previous.latest, minute);
      } else {
        visible.set(key, {lat: (latBin + 0.5) * displayGrid, lon: (lonBin + 0.5) * displayGrid, count, latest: minute});
      }
    }

    for (const n of [5, 15, 60]) $('count' + n).textContent = totals[n].toLocaleString();
    const features = Array.from(visible.values(), f => ({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [f.lon, f.lat]},
      properties: {count: f.count, age: nowMinute - f.latest}
    }));
    const source = map.getSource('activity');
    if (source) source.setData({type: 'FeatureCollection', features});

    $('updated').textContent = generated
      ? 'Last NOAA dataset: ' + new Date(generated).toLocaleString() + ' · ' + features.length.toLocaleString() + ' activity areas'
      : 'Waiting for first NOAA data run';
  }

  map.on('load', () => {
    map.addSource('activity', { type: 'geojson', data: empty });
    map.addLayer({
      id: 'flash-dots',
      type: 'circle',
      source: 'activity',
      paint: {
        'circle-color': ['step', ['get', 'age'], '#71e6ff', 5, '#ffc26d', 15, '#ff7e9b'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 2.5, 7, 5, 11, 7],
        'circle-opacity': 0.85
      }
    });
    map.on('click', 'flash-dots', e => {
      const item = e.features && e.features[0];
      if (!item) return;
      new maplibregl.Popup()
        .setLngLat(item.geometry.coordinates)
        .setText(Number(item.properties.count).toLocaleString() +
          ' approximate flashes in this area during the selected time window')
        .addTo(map);
    });
    map.on('mouseenter', 'flash-dots', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'flash-dots', () => { map.getCanvas().style.cursor = ''; });
    render(true);
  });

  $('window').addEventListener('change', e => {
    selectedMinutes = Number(e.target.value);
    render(true);
  });

  async function refresh() {
    try {
      // Shared 5-minute URL allows browser/CDN caching instead of a new download per visitor every minute.
      const slot = Math.floor(Date.now() / 300000);
      const response = await fetch('data/flashes.json?v=' + slot);
      if (!response.ok) throw new Error('Dataset unavailable (HTTP ' + response.status + ')');
      const data = await response.json();
      if (data.generated_at && data.generated_at === version) return;

      let next = Array.isArray(data.cells) ? data.cells : compactLegacy(data.flashes || []);
      cells = next.filter(c => Array.isArray(c) && c.length === 4 &&
        Number.isFinite(c[0]) && Number.isFinite(c[1]) &&
        Number.isInteger(c[2]) && Number.isFinite(c[3]) && c[3] > 0);
      generated = data.generated_at;
      version = data.generated_at || '';
      loaded = true;
      status.textContent = generated ? 'NOAA DATA · ' + new Date(generated).toLocaleTimeString() : 'NO DATA YET';
      render(true);
    } catch (err) {
      status.textContent = 'DATA NOT AVAILABLE';
      console.error('Thunderhead data refresh failed:', err);
    }
  }

  refresh();
  setInterval(refresh, 300000);
  setInterval(() => render(), 30000);
})();
