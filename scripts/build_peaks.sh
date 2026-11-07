#!/usr/bin/env bash
# Build Horizon Finder's per-cell peak files from the OSM planet PBF.
#
# By default the script downloads the planet file from the FAU mirror (one
# consistent snapshot, no extract overlap to merge), filters it down to nodes
# tagged natural=peak with osmium, exports a GeoJSON sequence and hands it to
# scripts/build_peaks.py, which writes the cell files and index.json.
#
# --continents uses the eight Geofabrik continent extracts instead (the old
# behaviour, for when the mirror is down).  Their overlap is deduplicated by
# OSM id in scripts/build_peaks.py.  --only processes a single extract URL.
#
# Downloads use parallel HTTP range requests: --connections ranges (default 8),
# each capped at --max-rate / connections bytes per second.  Each range is kept
# in its own `<file>.part<N>` file, so an interrupted run resumes where it
# stopped.  The joined file is checked against Content-Length and, when the
# server publishes `<url>.md5`, against its MD5.
#
# The downloaded PBF is deleted after filtering unless --keep-extracts is
# given; the small peaks-*.osm.pbf files stay.
#
# --reuse-filtered skips the download and filtering of a source whose
# peaks-<slug>.osm.pbf is already in the cache (and is non-empty): the script
# prints "reusing ..." and goes straight to the export.  Without the flag the
# source is downloaded and filtered again, as before.  This is how the cells
# are rebuilt after the 96 GB planet file has been deleted.
#
# Default output is data/peaks; use --out for a validation run.  The cache
# defaults to $HORIZONMAP_OSM_CACHE, else
# ${XDG_CACHE_HOME:-$HOME/.cache}/horizonmap/osm; use --cache to keep a
# validation run away from the real cache.
#
# Usage:
#   scripts/build_peaks.sh [--out DIR] [--cache DIR] [--connections N]
#                          [--max-rate BYTES_PER_S] [--keep-extracts]
#                          [--reuse-filtered]
#   scripts/build_peaks.sh --continents [options]
#   scripts/build_peaks.sh --only URL [options]
#
# ODbL: the generated files are a derived database of OpenStreetMap data.  The
# page must credit "© OpenStreetMap contributors" with a link to the Open
# Database License (https://www.openstreetmap.org/copyright); redistributing
# these files means redistributing them under the ODbL
# (https://opendatacommons.org/licenses/odbl/).

set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cache_directory="${HORIZONMAP_OSM_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/horizonmap/osm}"
output_directory="data/peaks"
only_url=""
use_continents=false
keep_extracts=false
reuse_filtered=false
planet_url="https://ftp.fau.de/osm-planet/pbf/planet-latest.osm.pbf"
connections=8
# Measured 2026-11-07 at the same moment (curl, 8 s each, in parallel):
# Geofabrik 3.7-7.1 MB/s, GWDG planet mirror 10.6 MB/s, FAU planet mirror
# 31.1 MB/s.  The FAU planet PBF (95,715,394,709 B) with 8 parallel range
# requests at --limit-rate 10600K each ran at 78 MB/s total (about 62 % of
# 1 Gbit/s) and took about 20 min instead of about 7 h with one connection.
# 70 % of 1 Gbit/s = 87.5 MB/s total; 87500000 / 8 = 10,937,500 B/s per
# connection, above the measured 10600 KiB/s = 10,854,400 B/s.  The per-
# connection limit is passed as a plain byte count, so curl's K = 1024 cannot
# round it up over the total.
max_rate_bytes_per_second=87500000
download_pids=()

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

remote_md5() {
    local url="$1" text hash
    if ! text=$(curl -fsSL --retry 2 --retry-delay 5 "$url.md5" 2>/dev/null); then
        return 0
    fi
    hash=$(printf '%s\n' "$text" \
        | awk 'NR == 1 && $1 ~ /^[0-9a-fA-F]{32}$/ { print tolower($1) }')
    if [ -z "$hash" ]; then
        echo "    warning: no MD5 in $url.md5, skipping the MD5 check" >&2
    fi
    printf '%s\n' "$hash"
}

# Kill the range downloads this script started, wait for them to flush what
# they have into their part files, and exit.  The part files stay behind so a
# rerun can resume them.
on_interrupt() {
    local status="$1" pid
    echo "build_peaks.sh: interrupted; partial ranges are kept for a resume" >&2
    for pid in "${download_pids[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    for pid in "${download_pids[@]}"; do
        wait "$pid" 2>/dev/null || true
    done
    exit "$status"
}

trap 'on_interrupt 130' INT
trap 'on_interrupt 143' TERM

# Fetch `url` into `destination` with $connections parallel ranges, appending
# each range to its own .partN file so a rerun continues from the current file
# size.  Concatenate the complete parts into `destination.tmp` and check the
# total against Content-Length; the caller verifies MD5 before moving it into
# place.
download_ranges() {
    local url="$1" destination="$2" size="$3"
    local chunk=$(( (size + connections - 1) / connections ))
    local index start end part have want
    local attempt incomplete pid joined joined_size

    echo "==> Downloading $(human_size "$size") in $connections ranges at most $connection_rate B/s each"
    for attempt in 1 2 3 4 5; do
        download_pids=()
        for (( index = 0; index < connections; index++ )); do
            start=$(( index * chunk ))
            end=$(( start + chunk - 1 ))
            if [ "$end" -ge "$size" ]; then
                end=$(( size - 1 ))
            fi
            part="$destination.part$index"
            have=0
            if [ -f "$part" ]; then
                have=$(stat -c %s "$part")
            fi
            want=$(( end - start + 1 ))
            if [ "$have" -eq "$want" ]; then
                continue
            fi
            if [ "$have" -gt "$want" ]; then
                die "part $part is larger than its range ($have > $want bytes); remove it to start over"
            fi
            echo "    range $(( index + 1 ))/$connections: bytes $(( start + have ))-$end"
            curl -fsSL --limit-rate "$connection_rate" \
                -r "$(( start + have ))-$end" "$url" >> "$part" &
            download_pids+=("$!")
        done
        if [ "${#download_pids[@]}" -eq 0 ]; then
            break
        fi
        for pid in "${download_pids[@]}"; do
            if ! wait "$pid"; then
                echo "    connection failed; retrying the missing bytes" >&2
            fi
        done
        download_pids=()
        incomplete=false
        for (( index = 0; index < connections; index++ )); do
            start=$(( index * chunk ))
            end=$(( start + chunk - 1 ))
            if [ "$end" -ge "$size" ]; then
                end=$(( size - 1 ))
            fi
            part="$destination.part$index"
            want=$(( end - start + 1 ))
            have=0
            if [ -f "$part" ]; then
                have=$(stat -c %s "$part")
            fi
            if [ "$have" -ne "$want" ]; then
                incomplete=true
                break
            fi
        done
        if [ "$incomplete" = false ]; then
            break
        fi
        if [ "$attempt" -ge 5 ]; then
            die "download of $url incomplete after 5 attempts (parts in $destination.part*)"
        fi
        echo "    retrying missing bytes in 5 s (attempt $(( attempt + 1 ))/5)"
        sleep 5
    done

    joined="$destination.tmp"
    : > "$joined"
    for (( index = 0; index < connections; index++ )); do
        cat "$destination.part$index" >> "$joined"
    done
    joined_size=$(stat -c %s "$joined")
    if [ "$joined_size" -ne "$size" ]; then
        die "joined size $joined_size != Content-Length $size for $url (left $joined for inspection)"
    fi
}

verify_md5() {
    local file="$1" expected="$2" destination="$3" actual
    if [ -z "$expected" ]; then
        return 0
    fi
    echo "    checking MD5"
    actual=$(md5sum "$file" | awk '{print $1}')
    if [ "$actual" != "$expected" ]; then
        die "MD5 mismatch for $file: got $actual, expected $expected (left $file and $destination.part* for inspection)"
    fi
}

download_extract() {
    local url="$1" destination="$2" server_size server_md5 local_size
    server_size=$(remote_size "$url")
    server_md5=$(remote_md5 "$url")
    if [ -f "$destination" ]; then
        local_size=$(stat -c %s "$destination")
        if [ "$local_size" = "$server_size" ]; then
            echo "    cached $destination ($(human_size "$local_size"))"
            return 0
        fi
        echo "    size mismatch ($local_size != $server_size bytes), downloading again"
        rm -f "$destination"
    fi
    download_ranges "$url" "$destination" "$server_size"
    verify_md5 "$destination.tmp" "$server_md5" "$destination"
    mv "$destination.tmp" "$destination"
    rm -f "$destination".part*
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
        --continents)
            use_continents=true
            shift
            ;;
        --out)
            [ "$#" -ge 2 ] || die "--out needs a directory"
            output_directory="$2"
            shift 2
            ;;
        --cache)
            [ "$#" -ge 2 ] || die "--cache needs a directory"
            cache_directory="$2"
            shift 2
            ;;
        --connections)
            [ "$#" -ge 2 ] || die "--connections needs a number"
            connections="$2"
            shift 2
            ;;
        --max-rate)
            [ "$#" -ge 2 ] || die "--max-rate needs a number of bytes per second"
            max_rate_bytes_per_second="$2"
            shift 2
            ;;
        --keep-extracts)
            keep_extracts=true
            shift
            ;;
        --reuse-filtered)
            reuse_filtered=true
            shift
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

if [ -n "$only_url" ] && [ "$use_continents" = true ]; then
    die "--only and --continents are mutually exclusive"
fi
case "$connections" in
    ''|*[!0-9]*)
        die "--connections must be a positive integer, got '$connections'"
        ;;
esac
[ "$connections" -ge 1 ] || die "--connections must be at least 1"
case "$max_rate_bytes_per_second" in
    ''|*[!0-9]*)
        die "--max-rate must be a positive integer of bytes per second, got '$max_rate_bytes_per_second'"
        ;;
esac
[ "$max_rate_bytes_per_second" -ge 1 ] || die "--max-rate must be at least 1"
connection_rate=$(( max_rate_bytes_per_second / connections ))
if [ "$connection_rate" -lt 1 ]; then
    die "--max-rate $max_rate_bytes_per_second is too small for $connections connections (0 bytes/s each)"
fi

command -v osmium >/dev/null 2>&1 || die "osmium (osmium-tool) is not installed"
command -v curl >/dev/null 2>&1 || die "curl is not installed"
command -v md5sum >/dev/null 2>&1 || die "md5sum is not installed"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed"
[ -f "$script_directory/build_peaks.py" ] || die "missing $script_directory/build_peaks.py"

mkdir -p "$cache_directory"

urls=()
if [ -n "$only_url" ]; then
    urls=("$only_url")
elif [ "$use_continents" = true ]; then
    for continent in africa antarctica asia australia-oceania central-america \
        europe north-america south-america; do
        urls+=("https://download.geofabrik.de/${continent}-latest.osm.pbf")
    done
else
    urls=("$planet_url")
fi

# Download each source and keep only its peaks, so later steps never touch the
# full-size file again.  Without --keep-extracts the big download is deleted
# after filtering; only the small peaks-*.osm.pbf stays in the cache.
# --reuse-filtered exports an existing peaks-*.osm.pbf instead of rebuilding it.
peak_extracts=()
for url in "${urls[@]}"; do
    slug=$(url_slug "$url")
    extract="$cache_directory/$(url_file_name "$url")"
    peak_extract="$cache_directory/peaks-${slug}.osm.pbf"
    echo "==> $slug"
    if [ "$reuse_filtered" = true ] && [ -s "$peak_extract" ]; then
        echo "    reusing $peak_extract ($(human_size "$(stat -c %s "$peak_extract")"))"
    else
        download_extract "$url" "$extract"
        filter_peaks "$extract" "$peak_extract"
        if [ "$keep_extracts" = false ]; then
            rm -f "$extract"
            echo "    removed $extract (use --keep-extracts to keep it)"
        fi
    fi
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
