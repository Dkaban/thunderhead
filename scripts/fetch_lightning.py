"""Fetch recent GOES GLM flash centroids from anonymous NOAA AWS buckets."""
import json
import logging
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

import boto3
import numpy as np
from botocore import UNSIGNED
from botocore.config import Config
from netCDF4 import Dataset

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "flashes.json"
WINDOW = timedelta(minutes=60)
NOW = datetime.now(timezone.utc)
CUTOFF = NOW - WINDOW
s3 = boto3.client("s3", config=Config(signature_version=UNSIGNED, retries={"max_attempts": 3}))
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
# HDF5/netCDF4 is not reliably thread-safe: serialize all Dataset access.
NETCDF_LOCK = Lock()


def keys_for_satellite(satellite):
    bucket = f"noaa-goes{satellite}"
    hour = NOW.replace(minute=0, second=0, microsecond=0)
    hours = [hour - timedelta(hours=i) for i in range(2)]
    keys = []
    for moment in hours:
        prefix = f"GLM-L2-LCFA/{moment:%Y}/{moment.timetuple().tm_yday:03d}/{moment:%H}/"
        try:
            paginator = s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
                for entry in page.get("Contents", []):
                    key = entry["Key"]
                    # NOAA filenames encode scan start as sYYYYDDDHHMMSS... .
                    start = key.split("_s")[1][:13]
                    at = datetime.strptime(start, "%Y%j%H%M%S").replace(tzinfo=timezone.utc)
                    if CUTOFF - timedelta(minutes=5) <= at <= NOW:
                        keys.append((bucket, key, satellite))
        except Exception as exc:
            logging.warning("Could not list %s %s: %s", bucket, prefix, exc)
    return keys


def read_file(item):
    bucket, key, satellite = item
    fd, filename = tempfile.mkstemp(suffix=".nc")
    os.close(fd)
    try:
        s3.download_file(bucket, key, filename)
        with NETCDF_LOCK, Dataset(filename) as ds:
            lat = np.asarray(ds.variables["flash_lat"][:])
            lon = np.asarray(ds.variables["flash_lon"][:])
            offset = np.asarray(ds.variables["flash_time_offset_of_first_event"][:])
            start_text = ds.getncattr("time_coverage_start")
            start = datetime.fromisoformat(start_text.replace("Z", "+00:00"))
            result = []
            for a,b,c in zip(lat,lon,offset):
                if np.ma.is_masked(a) or np.ma.is_masked(b) or np.ma.is_masked(c):
                    continue
                at = start + timedelta(seconds=float(c))
                if CUTOFF <= at <= NOW and -180 <= float(b) <= 180 and -90 <= float(a) <= 90:
                    result.append({"lat": round(float(a),4), "lon": round(float(b),4), "time": at.isoformat().replace("+00:00","Z"),"sat":satellite})
            return result
    except Exception as exc:
        logging.warning("Skipping %s: %s", key, exc)
        return []
    finally:
        os.unlink(filename)


def main():
    items = keys_for_satellite(18) + keys_for_satellite(19)
    logging.info("Reading %d NOAA GLM files", len(items))
    data=[]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for future in as_completed([pool.submit(read_file,item) for item in items]):
            data.extend(future.result())
    # Two GOES satellites can view the same flash. Keep one approximate location.
    # This is a heuristic, not scientifically validated cross-satellite matching.
    seen=set()
    unique=[]
    for flash in sorted(data,key=lambda f:f["time"]):
        ts=int(datetime.fromisoformat(flash["time"].replace("Z","+00:00")).timestamp())
        k=(round(flash["lat"],1),round(flash["lon"],1),ts//3)
        if k not in seen:
            seen.add(k)
            unique.append({"lat":flash["lat"],"lon":flash["lon"],"time":flash["time"]})
    OUTPUT.parent.mkdir(parents=True,exist_ok=True)
    # Exact total per minute for accurate dashboard totals; never infer
    # totals from the thinned visualization sample.
    counts = {}
    # Retain original measured centroids for the map. Keep at most 12000
    # observations, evenly spread across time buckets and geographic regions.
    groups = {}
    for flash in unique:
        timestamp = datetime.fromisoformat(flash["time"].replace("Z", "+00:00"))
        minute = int(timestamp.timestamp()) // 60
        counts[minute] = counts.get(minute, 0) + 1
        lat, lon = flash["lat"], flash["lon"]
        key = (minute, int(lat // 3), int(lon // 3))
        groups.setdefault(key, []).append([lat, lon, minute])

    # Fair per-region sampling, avoiding both global hotspots monopolizing
    # all samples and artificial grid-center marker coordinates.
    max_samples = 12000
    samples = []
    keys = sorted(groups)
    budget = max(1, max_samples // max(1, len(keys)))
    remaining = []
    for key in keys:
        group = groups[key]
        if len(group) <= budget:
            samples.extend(group)
        else:
            stride = len(group) / budget
            samples.extend(group[int((i + 0.5) * stride)] for i in range(budget))
            remaining.append(group)
    if len(samples) < max_samples and remaining:
        capacity = max_samples - len(samples)
        extras = []
        for group in remaining:
            step = max(1, len(group) // max(1, capacity // len(remaining)))
            extras.extend(group[::step])
        if extras:
            stride = max(1, len(extras) / capacity)
            samples.extend(extras[int(i * stride)] for i in range(min(capacity, len(extras))))
    if len(samples) > max_samples:
        step = len(samples) / max_samples
        samples = [samples[int(i * step)] for i in range(max_samples)]

    OUTPUT.write_text(json.dumps({
        "generated_at": NOW.isoformat().replace("+00:00", "Z"),
        "source": "NOAA GOES-18/19 GLM-L2-LCFA",
        "counts": sorted([[m, n] for m, n in counts.items()]),
        "samples": [[round(p[0], 4), round(p[1], 4), p[2]] for p in samples],
        "sampled": True,
        "sampling_note": "Display sample only; minute counts retain full dataset"
    }, separators=(",", ":")))
    logging.info("Saved %d total flashes and %d display samples", len(unique), len(samples))


if __name__=="__main__":
    main()
