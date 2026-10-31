# ⚡ Thunderhead

Free lightning activity map for North America, powered by NOAA GOES-18 and GOES-19 Geostationary Lightning Mapper (GLM) public data.

## Features
- Dark interactive map with MapLibre and OpenFreeMap
- Approximate satellite optical flash centroids (not exact ground strikes)
- 5 / 15 / 60-minute flash counters
- Responsive mobile layout
- Python data ingestion and GitHub Pages-ready static site

## Publish
1. In **Settings → Pages**, choose **Deploy from a branch**, branch `main`, folder `/(root)`, then save.
2. Upload `.github/workflows/update-lightning.yml` from the starter bundle if it is not present. GitHub restricts apps without workflow-writing permission from uploading workflow files.
3. Under **Settings → Actions → General**, ensure the workflow has **Read and write permissions** so it can update the JSON dataset.
4. Go to **Actions → Update NOAA lightning data → Run workflow**.
5. Once the workflow has succeeded, the map will display NOAA observations when lightning is available.

## Local development
`python -m http.server 8000` then open `http://localhost:8000`.
To fetch fresh data locally: `pip install -r requirements.txt` and `python scripts/fetch_lightning.py`.

## Data caveats
Data is from anonymous S3 NOAA GOES GLM-L2-LCFA buckets. Flash positions are approximate optical centroids, not confirmed cloud-to-ground strikes. Coverage deteriorates at high northern latitudes, including parts of Alberta. Scheduled Actions can be delayed. The current satellite-deduplication heuristic and counts are experimental. Do not use for safety or emergency decisions.

No API keys required. GitHub Pages and public-repo Actions can be used at no charge within service policies.

NOAA: https://www.ncei.noaa.gov/products/goes-r-geostationary-lightning-mapper
