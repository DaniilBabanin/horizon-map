#!/usr/bin/env bash
#
# Rebuild data/world.json and data/lakes.json.
#
# world.json is byte-for-byte world-atlas@2.0.2 `countries-10m.json` with the
# country property `name` renamed to `n` (verified against data/world.json on
# 2026-11-07). world-atlas builds that file from Natural Earth 1:10m
# admin_0_countries with `geo2topo -q 1e5` and `topomerge land=countries`
# (https://github.com/topojson/world-atlas/blob/master/prepublish). Re-running
# mapshaper over the file rebuilds the topology and changes 18 arcs, so the
# property is renamed in place instead.
#
# lakes.json is Natural Earth 1:10m lakes v4.1.0 (1,354 polygons, public domain).
# It replaced an earlier file of unknown source and licence on 2026-11-07 (user
# decision): 2,690 polygons clipped along Web Mercator zoom-5 tile edges, with
# Antarctic lakes that Natural Earth does not have.
#
# Usage: scripts/build_outlines.sh [--out DIR]
#
set -euo pipefail

readonly MAPSHAPER_VERSION=0.6.102
readonly WORLD_ATLAS_VERSION=2.0.2
readonly NE_TAG=v4.1.0
readonly WORLD_ATLAS_URL="https://cdn.jsdelivr.net/npm/world-atlas@${WORLD_ATLAS_VERSION}/countries-10m.json"
readonly WORLD_ATLAS_SHA256=3bc6f1d367a9bcec479841bae0e76092f512838411d0cef124e92eec4db45f79
readonly NE_LAKES_URL="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_TAG}/geojson/ne_10m_lakes.geojson"
readonly NE_LAKES_SHA256=77ce51b3bb70b4135384fbe1591c4f0fc7910a49cd81d7560f904aa2357a8892

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/horizonmap/ne"
OUT_DIR="$SCRIPT_DIR/../data"

usage() {
  cat <<'USAGE'
Usage: scripts/build_outlines.sh [--out DIR]

Download the pinned source files into ~/.cache/horizonmap/ne and write
world.json and lakes.json into DIR (default: data/).
USAGE
}

while (( $# > 0 )); do
  case "$1" in
    --out)
      if (( $# < 2 )); then
        echo "build_outlines.sh: --out needs a directory" >&2
        exit 2
      fi
      OUT_DIR=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "build_outlines.sh: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for required_command in curl node npx sha256sum; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "build_outlines.sh: missing required command: $required_command" >&2
    exit 1
  fi
done

mkdir -p "$CACHE_DIR" "$OUT_DIR"
readonly WORLD_ATLAS_JSON="$CACHE_DIR/world-atlas-$WORLD_ATLAS_VERSION-countries-10m.json"
readonly NE_LAKES_JSON="$CACHE_DIR/ne_${NE_TAG}_10m_lakes.geojson"

download() {
  local source_url=$1 destination=$2
  if [[ -s $destination ]]; then
    echo "==> cached $(basename "$destination")"
    return
  fi
  echo "==> downloading $source_url"
  curl -fSL --retry 3 --max-time 600 -o "$destination.part" "$source_url"
  mv "$destination.part" "$destination"
}

verify_checksum() {
  local file_path=$1 expected_sha256=$2
  echo "==> verifying $(basename "$file_path")"
  echo "$expected_sha256  $file_path" | sha256sum -c -
}

download "$WORLD_ATLAS_URL" "$WORLD_ATLAS_JSON"
verify_checksum "$WORLD_ATLAS_JSON" "$WORLD_ATLAS_SHA256"

echo "==> building world.json"
node - "$WORLD_ATLAS_JSON" "$OUT_DIR/world.json" <<'NODE'
const fs = require("node:fs");
const [sourcePath, destinationPath] = process.argv.slice(2);
const topology = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const countries = topology.objects.countries;
const land = topology.objects.land;
if (!countries || countries.geometries.length !== 255) {
  throw new Error("expected 255 country geometries in world-atlas countries-10m.json");
}
if (!land || land.geometries.length !== 1) {
  throw new Error("expected 1 land geometry in world-atlas countries-10m.json");
}
for (const geometry of countries.geometries) {
  const name = geometry.properties && geometry.properties.name;
  if (typeof name !== "string") {
    throw new Error("country geometry without a name property");
  }
  geometry.properties = { n: name };
}
fs.writeFileSync(destinationPath, JSON.stringify(topology));
NODE

download "$NE_LAKES_URL" "$NE_LAKES_JSON"
verify_checksum "$NE_LAKES_JSON" "$NE_LAKES_SHA256"

echo "==> building lakes.json with mapshaper $MAPSHAPER_VERSION"
npx --yes "mapshaper@${MAPSHAPER_VERSION}" "$NE_LAKES_JSON" \
  -rename-layers map.geo \
  -o format=topojson quantization=400000 drop-table "$OUT_DIR/lakes.json"

echo "==> summarizing output"
node - "$OUT_DIR/world.json" "$OUT_DIR/lakes.json" <<'NODE'
const fs = require("node:fs");
for (const filePath of process.argv.slice(2)) {
  const topology = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let pointCount = 0;
  for (const arc of topology.arcs) pointCount += arc.length;
  const objects = Object.entries(topology.objects)
    .map(([name, object]) => `${name}:${object.geometries.length}`)
    .join(", ");
  console.log(`    ${filePath}: ${fs.statSync(filePath).size} bytes, ${topology.arcs.length} arcs, ${pointCount} points, objects ${objects}`);
}
NODE
