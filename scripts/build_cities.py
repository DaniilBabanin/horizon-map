#!/usr/bin/env python3
"""Build data/cities.json from the GeoNames cities1000 dump.

Source: https://download.geonames.org/export/dump/cities1000.zip
Licence: GeoNames data is licensed under Creative Commons Attribution 4.0
(https://creativecommons.org/licenses/by/4.0/). Attribution: "GeoNames".

The dump is a tab-separated text file with one place per line. This script keeps
name, country code, latitude, longitude and population from each row, rounds the
coordinates to 4 decimals, and writes compact JSON sorted by population
descending (ties by name) as [name, countryCode, lat, lon, population]. Rows
with a population below --min-population (default 0) are left out.

The page ships two files: a small one for map labels (and search until the full
file arrives) and the full dump loaded lazily when a search starts. Regenerate
them from the repository root with:

    python3 scripts/build_cities.py --min-population 5000 --out data/cities.json
    python3 scripts/build_cities.py --out data/cities-1000.json

Other options:

    python3 scripts/build_cities.py --cache ~/.cache/horizonmap --out data/cities.json
    python3 scripts/build_cities.py --selftest

The archive is cached and reused on later runs. Python standard library only.
"""

import argparse
import csv
import io
import json
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

SOURCE_URL = "https://download.geonames.org/export/dump/cities1000.zip"
ARCHIVE_NAME = "cities1000.zip"
MEMBER_NAME = "cities1000.txt"
DEFAULT_CACHE = "~/.cache/horizonmap"
DEFAULT_OUT = "data/cities.json"
USER_AGENT = "horizonmap-build-cities/1.0"

# Zero-based column positions in the GeoNames dump (fields 2, 5, 6, 9 and 15 in
# the readme's 1-based numbering).
NAME = 1
LATITUDE = 4
LONGITUDE = 5
COUNTRY_CODE = 8
POPULATION = 14
MIN_FIELDS = POPULATION + 1
COORDINATE_DECIMALS = 4


def city_sort_key(row):
    """Sort by population descending, then by name, so the output is stable."""
    return (-row[4], row[0])


def build_rows(field_rows, min_population=0):
    """Turn parsed GeoNames fields into [name, cc, lat, lon, population] rows."""
    rows = []
    for record_number, fields in enumerate(field_rows, 1):
        if not fields:
            continue
        if len(fields) < MIN_FIELDS:
            raise ValueError(
                f"{MEMBER_NAME}: record {record_number}: expected at least "
                f"{MIN_FIELDS} columns, got {len(fields)}"
            )
        population = int(fields[POPULATION] or 0)
        if population < min_population:
            continue
        rows.append([
            fields[NAME],
            fields[COUNTRY_CODE],
            round(float(fields[LATITUDE]), COORDINATE_DECIMALS),
            round(float(fields[LONGITUDE]), COORDINATE_DECIMALS),
            population,
        ])
    rows.sort(key=city_sort_key)
    return rows


def read_rows(archive_path, min_population=0):
    """Read cities1000.txt from the downloaded archive and build the rows."""
    with zipfile.ZipFile(archive_path) as archive:
        with archive.open(MEMBER_NAME) as member:
            text = io.TextIOWrapper(member, encoding="utf-8", newline="")
            # QUOTE_NONE keeps apostrophes and quotation marks in place names
            # exactly as GeoNames writes them; the format has no quoting.
            return build_rows(
                csv.reader(text, delimiter="\t", quoting=csv.QUOTE_NONE),
                min_population=min_population,
            )


def download_archive(cache_dir):
    """Return the cached archive, downloading it once if it is missing."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive_path = cache_dir / ARCHIVE_NAME
    if archive_path.is_file():
        return archive_path

    request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    part_file = tempfile.NamedTemporaryFile(
        mode="wb", dir=cache_dir, prefix=ARCHIVE_NAME + ".", suffix=".part", delete=False
    )
    try:
        with part_file, urllib.request.urlopen(request, timeout=300) as response:
            shutil.copyfileobj(response, part_file)
        os.replace(part_file.name, archive_path)
    except BaseException:
        Path(part_file.name).unlink(missing_ok=True)
        raise
    return archive_path


def write_rows(rows, out_path):
    """Write compact UTF-8 JSON without a trailing newline; return its byte size."""
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(payload)
    return len(payload)


def selftest():
    """Check order, rounding and row format on a small inline sample."""
    sample = "\n".join([
        # name, lat, lon, country, population; Zürich checks UTF-8 handling and
        # a coordinate that needs rounding.
        "\t".join(["1", "Zürich", "Zurich", "", "47.376871", "8.541700",
                   "P", "PPL", "CH", "", "ZH", "", "", "", "1000",
                   "408", "429", "Europe/Zurich", "2026-11-07"]),
        # Bbb and Aaa tie on population, so the name decides their order.
        "\t".join(["2", "Bbb", "Bbb", "", "50.000000", "8.000000",
                   "P", "PPL", "DE", "", "", "", "", "", "2000",
                   "", "", "", "2026-11-07"]),
        "\t".join(["3", "Aaa", "Aaa", "", "48.000000", "7.000000",
                   "P", "PPL", "FR", "", "", "", "", "", "2000",
                   "", "", "", "2026-11-07"]),
    ]) + "\n"

    rows = build_rows(csv.reader(io.StringIO(sample), delimiter="\t", quoting=csv.QUOTE_NONE))
    expected = [
        ["Aaa", "FR", 48.0, 7.0, 2000],
        ["Bbb", "DE", 50.0, 8.0, 2000],
        ["Zürich", "CH", 47.3769, 8.5417, 1000],
    ]
    assert rows == expected, f"unexpected rows: {rows!r}"
    for row in rows:
        assert len(row) == 5, f"row does not have 5 fields: {row!r}"
        assert isinstance(row[0], str) and isinstance(row[1], str), f"bad text fields: {row!r}"
        assert isinstance(row[2], float) and isinstance(row[3], float), f"bad coordinates: {row!r}"
        assert isinstance(row[4], int), f"bad population: {row!r}"

    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    assert " " not in payload, f"JSON is not compact: {payload!r}"
    assert "Zürich" in payload, f"name was escaped: {payload!r}"
    assert json.loads(payload) == expected, f"JSON round trip changed rows: {payload!r}"

    filtered_rows = build_rows(
        csv.reader(io.StringIO(sample), delimiter="\t", quoting=csv.QUOTE_NONE),
        min_population=2000,
    )
    assert filtered_rows == [
        ["Aaa", "FR", 48.0, 7.0, 2000],
        ["Bbb", "DE", 50.0, 8.0, 2000],
    ], f"min_population did not drop smaller places: {filtered_rows!r}"
    print("OK")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build data/cities.json from GeoNames cities1000.")
    parser.add_argument("--cache", default=DEFAULT_CACHE,
                        help=f"directory for the downloaded archive (default: {DEFAULT_CACHE})")
    parser.add_argument("--out", default=DEFAULT_OUT,
                        help=f"output JSON path (default: {DEFAULT_OUT})")
    parser.add_argument("--min-population", type=int, default=0,
                        help="leave out rows with a population below this (default: 0)")
    parser.add_argument("--selftest", action="store_true",
                        help="run the built-in sample check and exit")
    args = parser.parse_args(argv)

    if args.selftest:
        selftest()
        return 0

    cache_dir = Path(os.path.expanduser(args.cache))
    out_path = Path(args.out)
    archive_path = download_archive(cache_dir)
    rows = read_rows(archive_path, min_population=args.min_population)
    byte_size = write_rows(rows, out_path)
    print(f"{len(rows)} rows, {byte_size} bytes -> {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
