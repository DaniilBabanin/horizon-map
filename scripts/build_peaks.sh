#!/usr/bin/env bash
# Build Horizon Finder's per-cell peak files from Geofabrik continent extracts.
#
# For each extract the script downloads it into a cache (unless a file of the
# same size from the server's Content-Length is already there), filters it down
# to nodes tagged natural=peak with osmium, merges the per-continent peak files
# (the extracts can overlap; scripts/build_peaks.py dedupes by OSM id), exports
# a GeoJSON sequence and hands it to scripts/build_peaks.py, which writes the
# cell files and index.json.
#
# Default output is data/peaks; use --out for a validation run.
#
# Usage:
#   scripts/build_peaks.sh [--out DIR]
#   scripts/build_peaks.sh --only URL [--out DIR]
#
# --only processes a single extract URL instead of the eight continents.  The
# cache defaults to ${XDG_CACHE_HOME:-$HOME/.cache}/horizonmap/osm.
#
# ODbL: the generated files are a derived database of OpenStreetMap data.  The
# page must credit "© OpenStreetMap contributors" with a link to the Open
# Database License (https://www.openstreetmap.org/copyright); redistributing
# these files means redistributing them under the ODbL
# (https://opendatacommons.org/licenses/odbl/).

set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cache_directory="${XDG_CACHE_HOME:-$HOME/.cache}/horizonmap/osm"
output_directory="data/peaks"
only_url=""

usage() {
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

die() {
    echo "build_peaks.sh: $*" >&2
    exit 1
}

human_size() {
    awk -v bytes="$1" 'BEGIN {
        if (bytes >= 1073741824) printf "%.1f GiB", bytes / 1073741824;
        else if (bytes >= 1048576) printf "%.1f MiB", bytes / 1048576;
        else printf "%.1f KiB", bytes / 1024;
    }'
}

url_file_name() {
    local url="$1"
    url="${url%%\?*}"
    printf '%s\n' "${url##*/}"
}

url_slug() {
    local url="$1" name
    name=$(url_file_name "$url")
    name="${name%-latest.osm.pbf}"
    name="${name%.osm.pbf}"
    printf '%s\n' "$name"
}

remote_size() {
    local url="$1" size
    if ! size=$(curl -fsSIL --retry 2 --retry-delay 5 "$url" \
        | tr -d '\r' \
        | awk 'tolower($1) == "content-length:" { size = $2 } END { print size }'); then
        die "could not read Content-Length for $url"
    fi
    [ -n "$size" ] || die "no Content-Length for $url"
    if ! [ "$size" -ge 0 ] 2>/dev/null; then
        die "bad Content-Length '$size' for $url"
    fi
    printf '%s\n' "$size"
}

download_extract() {
    local url="$1" destination="$2" server_size local_size
    server_size=$(remote_size "$url")
    if [ -f "$destination" ]; then
        local_size=$(stat -c %s "$destination")
        if [ "$local_size" = "$server_size" ]; then
            echo "    cached $destination ($(human_size "$local_size"))"
            return 0
        fi
        echo "    size mismatch ($local_size != $server_size bytes), downloading again"
    fi
    echo "    downloading $url ($(human_size "$server_size"))"
    curl -fL --retry 3 --retry-delay 10 -o "$destination.part" "$url"
    mv "$destination.part" "$destination"
}

filter_peaks() {
    local extract="$1" destination="$2"
    echo "==> Filtering $(basename "$extract") for n/natural=peak"
    osmium tags-filter "$extract" n/natural=peak -o "$destination" --overwrite
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --only)
            [ "$#" -ge 2 ] || die "--only needs a URL"
            only_url="$2"
            shift 2
            ;;
        --out)
            [ "$#" -ge 2 ] || die "--out needs a directory"
            output_directory="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage >&2
            die "unknown argument: $1"
            ;;
    esac
done

command -v osmium >/dev/null 2>&1 || die "osmium (osmium-tool) is not installed"
command -v curl >/dev/null 2>&1 || die "curl is not installed"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed"
[ -f "$script_directory/build_peaks.py" ] || die "missing $script_directory/build_peaks.py"

mkdir -p "$cache_directory"

urls=()
if [ -n "$only_url" ]; then
    urls=("$only_url")
else
    for continent in africa antarctica asia australia-oceania central-america \
        europe north-america south-america; do
        urls+=("https://download.geofabrik.de/${continent}-latest.osm.pbf")
    done
fi

# Download each extract and keep only its peaks, so later steps never touch
# the full-size files again.
peak_extracts=()
for url in "${urls[@]}"; do
    slug=$(url_slug "$url")
    extract="$cache_directory/$(url_file_name "$url")"
    peak_extract="$cache_directory/peaks-${slug}.osm.pbf"
    echo "==> $slug"
    download_extract "$url" "$extract"
    filter_peaks "$extract" "$peak_extract"
    peak_extracts+=("$peak_extract")
done

if [ "${#peak_extracts[@]}" -gt 1 ]; then
    merged="$cache_directory/peaks-all.osm.pbf"
    echo "==> Merging ${#peak_extracts[@]} peak extracts into $(basename "$merged")"
    osmium merge "${peak_extracts[@]}" -o "$merged" --overwrite
else
    merged="${peak_extracts[0]}"
fi

echo "==> Exporting GeoJSON sequence and writing cells to $output_directory"
mkdir -p "$output_directory"
osmium export -a id,type -f geojsonseq "$merged" \
    | python3 "$script_directory/build_peaks.py" --out "$output_directory"

echo "==> Done; cells are in $output_directory"
