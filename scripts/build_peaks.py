#!/usr/bin/env python3
"""Build Horizon Finder's per-cell peak files from an OSM GeoJSON sequence.

Input is the GeoJSON feature sequence produced by
``osmium export -a id,type -f geojsonseq`` on a filtered
``natural=peak`` extract (see ``scripts/build_peaks.sh``).  One output file
per 2x2 degree cell is written, named by the cell's south-west corner with
even latitude and longitude, e.g. ``N50E008.json``, ``S34W072.json``.
Each file holds a compact JSON array of ``[name, lat, lon, ele]`` rows.

Cells are half-open: a point on a cell edge belongs to the cell whose south-west
corner it is, i.e. latitudes use ``floor(lat / 2) * 2`` (same for longitudes).
Coordinates are rounded to 5 decimals *before* the cell is chosen, so a point
just below an edge that rounds onto it lands in the cell containing the stored
coordinates.

Rows are sorted by ``ele`` descending, rows without ``ele`` last, ties by
name (then by latitude and longitude, for a deterministic file).  Peaks without
a ``name`` are dropped.  ``ele`` is an integer number of metres or ``null``;
OSM values are parsed as follows:

* a bare number, or one with a trailing ``m`` / ``metre`` / ``meter`` suffix
  (case-insensitive), is metres;
* a trailing apostrophe, ``ft``, ``feet`` or ``foot`` marks feet, converted
  at 0.3048 m per foot (exact international foot);
* with both ``.`` and ``,`` present, the rightmost is the decimal separator and
  the other is a thousands separator (``1,234.5`` -> 1234.5);
* a single comma followed by exactly three digits is a thousands separator
  (``1,234`` -> 1234), otherwise a comma is a decimal comma (``1234,5``);
* spaces between digits are thousands separators (``1 234`` -> 1234);
* anything else (angles, ranges, unknown units, empty values) becomes ``null``;
* the result is rounded half away from zero to whole metres.

Duplicate OSM objects (the continent extracts overlap) are deduplicated by
``(@type, @id)``; the first occurrence wins.  The output ends with
``index.json``: a compact JSON array of the cell names that exist, so the page
never requests a cell that was not built.

ODbL: the generated files are a derived database of OpenStreetMap data.
The page must credit "© OpenStreetMap contributors" with a link to the
Open Database License (https://www.openstreetmap.org/copyright, licence text
https://opendatacommons.org/licenses/odbl/), and any redistributed version of
these files must stay under the ODbL.

Usage:
    python3 scripts/build_peaks.py [--out DIR] [INPUT]
    python3 scripts/build_peaks.py --selftest

``INPUT`` is a GeoJSON sequence file, or ``-`` / omitted for stdin.
"""

import argparse
import json
import math
import os
import re
import sys
import tempfile

CELL_DEGREES = 2
COORDINATE_DECIMALS = 5
FOOT_IN_METRES = 0.3048
INDEX_FILE_NAME = "index.json"

_FEET_SUFFIX = re.compile(r"\s*(?:'|\u2032|ft\.?|feet\.?|foot\.?)\s*$", re.IGNORECASE)
_METRE_SUFFIX = re.compile(r"\s*(?:m|metres?|meters?)\s*$", re.IGNORECASE)
_DIGIT_SPACE = re.compile(r"(?<=\d)[ \u00a0\u2009\u202f](?=\d)")
_PLAIN_NUMBER = re.compile(r"[+-]?\d+(?:\.\d+)?")


def round_half_away_from_zero(value):
    """Round ``value`` to the nearest integer, ties away from zero."""
    if value >= 0:
        return int(math.floor(value + 0.5))
    return -int(math.floor(-value + 0.5))


def normalise_number(text):
    """Turn a number string with dot/comma separators into plain dot form.

    Returns ``None`` when the separator pattern cannot be read.
    """
    if "," in text and "." in text:
        decimal_separator = "," if text.rfind(",") > text.rfind(".") else "."
        thousands_separator = "." if decimal_separator == "," else ","
        text = text.replace(thousands_separator, "")
        if decimal_separator == ",":
            text = text.replace(",", ".")
        return text

    if "," in text:
        groups = text.split(",")
        if len(groups) == 2 and len(groups[1]) != 3:
            return groups[0] + "." + groups[1]
        if groups[0] and all(len(group) == 3 for group in groups[1:]):
            return "".join(groups)
        return None

    if text.count(".") > 1:
        groups = text.split(".")
        if groups[0] and all(len(group) == 3 for group in groups[1:]):
            return "".join(groups)
        return None

    return text


def parse_ele(value):
    """Parse an OSM ``ele`` tag value into integer metres, or ``None``."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        metres = float(value)
    else:
        if not isinstance(value, str):
            return None
        text = value.strip()
        if not text:
            return None
        text = text.replace("\u00a0", " ").replace("\u202f", " ").replace("\u2009", " ")

        is_feet = False
        if _FEET_SUFFIX.search(text):
            is_feet = True
            text = _FEET_SUFFIX.sub("", text)
        elif _METRE_SUFFIX.search(text):
            text = _METRE_SUFFIX.sub("", text)

        text = _DIGIT_SPACE.sub("", text).strip()
        normalised = normalise_number(text)
        if normalised is None or not _PLAIN_NUMBER.fullmatch(normalised):
            return None
        try:
            metres = float(normalised)
        except ValueError:
            return None
        if not math.isfinite(metres):
            return None
        if is_feet:
            metres *= FOOT_IN_METRES

    return round_half_away_from_zero(metres)


def clean_coordinate(value):
    """Round a lat/lon to 5 decimals, folding -0.0 into 0.0."""
    rounded = round(float(value), COORDINATE_DECIMALS)
    return 0.0 if rounded == 0 else rounded


def cell_name(latitude, longitude):
    """Return the SW-corner name of the half-open 2x2 degree cell."""
    south = math.floor(latitude / CELL_DEGREES) * CELL_DEGREES
    west = math.floor(longitude / CELL_DEGREES) * CELL_DEGREES
    latitude_label = ("N" if south >= 0 else "S") + f"{abs(south):02d}"
    longitude_label = ("E" if west >= 0 else "W") + f"{abs(west):03d}"
    return latitude_label + longitude_label


def peak_sort_key(peak):
    """Sort by elevation descending, nulls last, then name/lat/lon."""
    name, latitude, longitude, elevation = peak
    return (
        elevation is None,
        -(elevation if elevation is not None else 0),
        name,
        latitude,
        longitude,
    )


def iter_features(stream):
    """Yield GeoJSON features from a record-separated sequence."""
    for line_number, line in enumerate(stream, 1):
        line = line.lstrip("\x1e").strip()
        if not line:
            continue
        try:
            feature = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"input line {line_number}: invalid JSON: {error}") from error
        if not isinstance(feature, dict):
            raise ValueError(f"input line {line_number}: expected a JSON object")
        yield feature


def build_cells(features):
    """Group peaks into cells; returns ``(cells, stats)``.

    ``cells`` maps cell names to lists of ``(name, lat, lon, ele)`` tuples.
    """
    cells = {}
    seen_objects = set()
    stats = {"features": 0, "duplicates": 0, "unnamed": 0, "non_point": 0, "peaks": 0}

    for feature in features:
        stats["features"] += 1
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            stats["non_point"] += 1
            continue
        coordinates = geometry.get("coordinates")
        if not isinstance(coordinates, (list, tuple)) or len(coordinates) < 2:
            raise ValueError(f"feature {stats['features']}: geometry has no [lon, lat]")
        properties = feature.get("properties") or {}
        object_id = properties.get("@id", properties.get("id"))
        if object_id is None:
            raise ValueError(
                f"feature {stats['features']}: no OSM id; export with "
                "`osmium export -a id,type`"
            )
        object_key = (properties.get("@type"), object_id)
        if object_key in seen_objects:
            stats["duplicates"] += 1
            continue
        seen_objects.add(object_key)

        name = properties.get("name")
        if not isinstance(name, str) or not name.strip():
            stats["unnamed"] += 1
            continue
        name = name.strip()

        try:
            longitude = clean_coordinate(coordinates[0])
            latitude = clean_coordinate(coordinates[1])
        except (TypeError, ValueError) as error:
            raise ValueError(
                f"feature {stats['features']}: bad coordinates {coordinates!r}: {error}"
            ) from error

        elevation = parse_ele(properties.get("ele"))
        peak = (name, latitude, longitude, elevation)
        cells.setdefault(cell_name(latitude, longitude), []).append(peak)
        stats["peaks"] += 1

    return cells, stats


def write_cells(cells, out_directory):
    """Write one compact JSON file per cell plus ``index.json``; return names."""
    os.makedirs(out_directory, exist_ok=True)
    cell_names = []
    for name in sorted(cells):
        rows = sorted(cells[name], key=peak_sort_key)
        path = os.path.join(out_directory, name + ".json")
        with open(path, "w", encoding="utf-8") as output:
            json.dump(rows, output, ensure_ascii=False, separators=(",", ":"))
            output.write("\n")
        cell_names.append(name)

    index_path = os.path.join(out_directory, INDEX_FILE_NAME)
    with open(index_path, "w", encoding="utf-8") as output:
        json.dump(cell_names, output, ensure_ascii=False, separators=(",", ":"))
        output.write("\n")
    return cell_names


def selftest():
    """Run the parser and cell assignment on fixed sample features."""
    elevation_cases = [
        (None, None),
        ("", None),
        ("abc", None),
        ("12-13", None),
        ("1234 m above sea level", None),
        ("1234", 1234),
        ("1234 m", 1234),
        ("1234m", 1234),
        ("1234,5", 1235),
        ("1.234,5", 1235),
        ("1,234.5", 1235),
        ("1,234", 1234),
        ("1 234", 1234),
        ("8848.86", 8849),
        ("-430.5", -431),
        ("4000'", 1219),
        ("4000 ft", 1219),
        ("4000ft", 1219),
    ]
    for raw, expected in elevation_cases:
        actual = parse_ele(raw)
        if actual != expected:
            raise AssertionError(f"parse_ele({raw!r}): expected {expected!r}, got {actual!r}")

    cell_cases = [
        ((50.0, 8.0), "N50E008"),
        ((-32.6532, -70.0108), "S34W072"),
        ((-0.5, -0.5), "S02W002"),
        ((0.0, 0.0), "N00E000"),
        ((49.999999, 7.999999), "N48E006"),
    ]
    for (latitude, longitude), expected in cell_cases:
        actual = cell_name(latitude, longitude)
        if actual != expected:
            raise AssertionError(
                f"cell_name({latitude}, {longitude}): expected {expected!r}, got {actual!r}"
            )

    def feature(object_id, name, latitude, longitude, elevation, object_type="node"):
        properties = {"@type": object_type, "@id": object_id}
        if name is not None:
            properties["name"] = name
        if elevation is not None:
            properties["ele"] = elevation
        return {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
            "properties": properties,
        }

    sample_features = [
        feature(1001, "Großer Feldberg", 50.2326, 8.4586, "879"),
        feature(1002, "Edge Peak", 50.0, 8.0, "500"),
        feature(1003, "Aconcagua", -32.6532, -70.0108, "6961"),
        # 49.9 / 7.9 tells floor() from nearest-even rounding.
        feature(1004, "Feet Peak", 49.9, 7.9, "4000'"),
        feature(1005, "Comma Peak", 51.9, 9.9, "1234,5"),
        # Same OSM object twice: the first one wins.
        feature(9001, "Duplicate First", -34.0, -70.0, "100"),
        feature(9001, "Duplicate Second", -34.0, -70.0, "9999"),
        feature(9002, None, 50.5, 8.5, "100"),
        feature(9003, "Zeta Peak", 50.5, 8.5, None),
        feature(9004, "Alpha Peak", 50.5, 8.5, "300"),
        feature(9005, "Beta Peak", 50.5, 8.5, "300"),
        feature(9007, None, 10.5, 20.5, "100"),
        # Rounds across the 50/8 cell edge, so it belongs to N50E008.
        feature(1006, "Rounded Edge", 49.999999, 7.999999, "1"),
    ]

    cells, stats = build_cells(sample_features)
    expected_cells = {
        "N50E008": [
            ("Comma Peak", 51.9, 9.9, 1235),
            ("Großer Feldberg", 50.2326, 8.4586, 879),
            ("Edge Peak", 50.0, 8.0, 500),
            ("Alpha Peak", 50.5, 8.5, 300),
            ("Beta Peak", 50.5, 8.5, 300),
            ("Rounded Edge", 50.0, 8.0, 1),
            ("Zeta Peak", 50.5, 8.5, None),
        ],
        "N48E006": [("Feet Peak", 49.9, 7.9, 1219)],
        "S34W070": [("Duplicate First", -34.0, -70.0, 100)],
        "S34W072": [("Aconcagua", -32.6532, -70.0108, 6961)],
    }
    actual_cells = {name: sorted(rows, key=peak_sort_key) for name, rows in cells.items()}
    if actual_cells != expected_cells:
        raise AssertionError(f"cells: expected {expected_cells!r}, got {actual_cells!r}")

    expected_stats = {
        "features": 13,
        "duplicates": 1,
        "unnamed": 2,
        "non_point": 0,
        "peaks": 10,
    }
    if stats != expected_stats:
        raise AssertionError(f"stats: expected {expected_stats!r}, got {stats!r}")

    with tempfile.TemporaryDirectory(prefix="horizonmap-peaks-") as temporary_directory:
        written = write_cells(cells, temporary_directory)
        expected_index = ["N48E006", "N50E008", "S34W070", "S34W072"]
        if written != expected_index:
            raise AssertionError(f"index: expected {expected_index!r}, got {written!r}")
        with open(
            os.path.join(temporary_directory, INDEX_FILE_NAME), encoding="utf-8"
        ) as index_file:
            if json.load(index_file) != expected_index:
                raise AssertionError("index.json does not match the written cells")
        for name, expected_rows in expected_cells.items():
            path = os.path.join(temporary_directory, name + ".json")
            if not os.path.exists(path):
                raise AssertionError(f"{name}.json was not written")
            with open(path, encoding="utf-8") as cell_file:
                stored_rows = json.load(cell_file)
            if [tuple(row) for row in stored_rows] != expected_rows:
                raise AssertionError(
                    f"{name}.json: expected {expected_rows!r}, got {stored_rows!r}"
                )
        if os.path.exists(os.path.join(temporary_directory, "N10E020.json")):
            raise AssertionError("a cell with only unnamed peaks was written")

    print("OK")


def parse_arguments(argv):
    parser = argparse.ArgumentParser(
        description="Build per-cell peak files from an OSM GeoJSON sequence.",
        epilog="ODbL: data © OpenStreetMap contributors; see "
        "https://www.openstreetmap.org/copyright",
    )
    parser.add_argument(
        "input",
        nargs="?",
        default="-",
        help="GeoJSON sequence file, or - for stdin (default)",
    )
    parser.add_argument(
        "--out",
        default="data/peaks",
        help="output directory (default: data/peaks)",
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="run built-in parser and cell-assignment checks and exit",
    )
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    if arguments.selftest:
        selftest()
        return 0

    if arguments.input == "-":
        if hasattr(sys.stdin, "reconfigure"):
            sys.stdin.reconfigure(encoding="utf-8")
        stream = sys.stdin
    else:
        stream = open(arguments.input, encoding="utf-8")

    try:
        cells, stats = build_cells(iter_features(stream))
        cell_names = write_cells(cells, arguments.out)
    finally:
        if arguments.input != "-":
            stream.close()

    print(
        f"read {stats['features']} features, kept {stats['peaks']} peaks in "
        f"{len(cell_names)} cells (dropped {stats['duplicates']} duplicates, "
        f"{stats['unnamed']} unnamed, {stats['non_point']} non-points)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
