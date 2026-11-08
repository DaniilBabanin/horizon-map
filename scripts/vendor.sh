#!/usr/bin/env bash
#
# Download the page's third-party assets into vendor/ and verify them.
#
# Usage: scripts/vendor.sh
#
# The page used to load Google Fonts from fonts.googleapis.com and d3 /
# topojson-client from cdnjs and jsDelivr, which sends every visitor's IP
# address to those providers (LG München, 3 O 17493/20, 20 Jan 2022). This
# script keeps local copies in vendor/ so the site serves them itself.
#
# Everything is fetched into a temporary directory first; vendor/ is only
# replaced when every request succeeded. d3 and topojson-client are checked
# against the SHA-256 constants below, so a changed upstream file fails the run
# instead of silently entering the site. Downloaded and verified 2026-11-08.
#
set -euo pipefail

readonly D3_VERSION=7.8.5
readonly D3_URL="https://cdnjs.cloudflare.com/ajax/libs/d3/${D3_VERSION}/d3.min.js"
readonly D3_SHA256=d6b03aefc9f6c44c7bc78713679c78c295028fa914319119e5cc4b4954855b1c

readonly TOPOJSON_CLIENT_VERSION=3.1.0
readonly TOPOJSON_CLIENT_URL="https://cdn.jsdelivr.net/npm/topojson-client@${TOPOJSON_CLIENT_VERSION}/dist/topojson-client.min.js"
readonly TOPOJSON_CLIENT_SHA256=25cd02ae486cc5063e0215a4e4cfb15de83700c87ac48bac4d57dc6aaf3ebb89

readonly FONTS_CSS_URL='https://fonts.googleapis.com/css2?family=Saira+Semi+Condensed:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap'
# Google Fonts returns woff2 only to browsers that identify as a current
# desktop Chrome; older or unknown agents get ttf files. 156.0.8078.4 is the
# Chrome in this project's headless test browser (2026-11-08).
readonly CHROME_UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

readonly OFL_URL='https://openfontlicense.org/documents/OFL.txt'
readonly D3_LICENSE_URL="https://cdn.jsdelivr.net/npm/d3@${D3_VERSION}/LICENSE"
readonly TOPOJSON_CLIENT_LICENSE_URL="https://cdn.jsdelivr.net/npm/topojson-client@${TOPOJSON_CLIENT_VERSION}/LICENSE"

readonly RUN_DATE=2026-11-08

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
readonly REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
readonly OUT_DIR="$REPO_ROOT/vendor"

die() {
  echo "vendor.sh: $*" >&2
  exit 1
}

sha256_of() {
  sha256sum -- "$1" | cut -d' ' -f1
}

download() {
  local url=$1
  local destination=$2
  curl -fsSL --retry 3 --retry-delay 2 -o "$destination" "$url" \
    || die "download failed: $url"
}

download_checked() {
  local url=$1
  local destination=$2
  local expected_sha256=$3
  download "$url" "$destination"
  local actual_sha256
  actual_sha256=$(sha256_of "$destination")
  if [[ $actual_sha256 != "$expected_sha256" ]]; then
    die "SHA-256 mismatch for $url: expected $expected_sha256, got $actual_sha256"
  fi
  printf '%s  %s\n' "$actual_sha256" "$(basename -- "$destination")"
}

command -v curl >/dev/null || die "curl is required"

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/horizonmap-vendor.XXXXXX")
readonly tmp_dir
trap 'rm -rf -- "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/fonts"

# The two libraries, with their hashes checked.
download_checked "$D3_URL" "$tmp_dir/d3.min.js" "$D3_SHA256"
download_checked "$TOPOJSON_CLIENT_URL" "$tmp_dir/topojson-client.min.js" "$TOPOJSON_CLIENT_SHA256"

# Licence texts, kept verbatim for vendor/LICENSES.md.
download "$D3_LICENSE_URL" "$tmp_dir/d3.LICENSE"
download "$TOPOJSON_CLIENT_LICENSE_URL" "$tmp_dir/topojson-client.LICENSE"
download "$OFL_URL" "$tmp_dir/OFL.txt"

# Google Fonts CSS2 is a flat list of "/* subset */" comments followed by
# @font-face blocks. Turn it into one TSV line per face.
cat > "$tmp_dir/parse-fonts.awk" <<'AWK'
BEGIN { OFS = "\t" }

/^\/\* [^*]+ \*\/[[:space:]]*$/ {
  subset = $0
  sub(/^\/\* /, "", subset)
  sub(/[[:space:]]*\*\/[[:space:]]*$/, "", subset)
  next
}

/@font-face[[:space:]]*\{/ {
  family = ""
  style = ""
  weight = ""
  source_url = ""
  unicode_range = ""
  next
}

/^[[:space:]]*font-family:/ {
  family = $0
  sub(/^[[:space:]]*font-family:[[:space:]]*/, "", family)
  sub(/;.*$/, "", family)
  gsub(/['"]/, "", family)
  next
}

/^[[:space:]]*font-style:/ {
  style = $0
  sub(/^[[:space:]]*font-style:[[:space:]]*/, "", style)
  sub(/;.*$/, "", style)
  next
}

/^[[:space:]]*font-weight:/ {
  weight = $0
  sub(/^[[:space:]]*font-weight:[[:space:]]*/, "", weight)
  sub(/;.*$/, "", weight)
  next
}

/^[[:space:]]*src:/ {
  if (match($0, /url\([^)]*\)/)) {
    source_url = substr($0, RSTART + 4, RLENGTH - 5)
  }
  next
}

/^[[:space:]]*unicode-range:/ {
  unicode_range = $0
  sub(/^[[:space:]]*unicode-range:[[:space:]]*/, "", unicode_range)
  sub(/;.*$/, "", unicode_range)
  next
}

/^}/ {
  if (family != "" && source_url != "") {
    print subset, family, style, weight, source_url, unicode_range
    subset = ""
  }
  next
}
AWK

curl -fsSL --retry 3 --retry-delay 2 -A "$CHROME_UA" -o "$tmp_dir/fonts-source.css" "$FONTS_CSS_URL" \
  || die "download failed: $FONTS_CSS_URL"
tr -d '\r' < "$tmp_dir/fonts-source.css" | awk -f "$tmp_dir/parse-fonts.awk" > "$tmp_dir/fonts.tsv"

font_count=$(grep -c . "$tmp_dir/fonts.tsv" || true)
[[ $font_count -gt 0 ]] || die "no @font-face blocks found in $FONTS_CSS_URL"

# Download each face under <family>-<weight>-<subset>.woff2 and remember its row
# for vendor/fonts.css and vendor/LICENSES.md.
: > "$tmp_dir/fonts-installed.tsv"
declare -A seen_font_files=()
while IFS=$'\t' read -r subset family style weight source_url unicode_range; do
  safe_family=${family//[^A-Za-z0-9]/-}
  file_name="${safe_family}-${weight}-${subset}.woff2"
  [[ -z ${seen_font_files[$file_name]:-} ]] \
    || die "duplicate font file name: $file_name"
  seen_font_files[$file_name]=$source_url
  download "$source_url" "$tmp_dir/fonts/$file_name"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$file_name" "$subset" "$family" "$style" "$weight" "$source_url" "$unicode_range" \
    >> "$tmp_dir/fonts-installed.tsv"
done < "$tmp_dir/fonts.tsv"

# Same @font-face rules as Google served, with relative font URLs.
{
  printf '/* Self-hosted copy of the Google Fonts CSS2 stylesheet the page used to load.\n'
  printf '   Generated by scripts/vendor.sh on %s; font files are in fonts/ next to this file. */\n' "$RUN_DATE"
  printf '\n'
  while IFS=$'\t' read -r file_name subset family style weight source_url unicode_range; do
    printf '/* %s */\n' "$subset"
    printf '@font-face {\n'
    printf "  font-family: '%s';\n" "$family"
    printf '  font-style: %s;\n' "$style"
    printf '  font-weight: %s;\n' "$weight"
    printf '  font-display: swap;\n'
    printf "  src: url(fonts/%s) format('woff2');\n" "$file_name"
    printf '  unicode-range: %s;\n' "$unicode_range"
    printf '}\n'
    printf '\n'
  done < "$tmp_dir/fonts-installed.tsv"
} > "$tmp_dir/fonts.css"

# LICENSES.md: one table row per file, then the full licence texts.
{
  printf '# Third-party assets in vendor/\n\n'
  printf 'These files are served from this site rather than from Google Fonts, cdnjs or\n'
  printf 'jsDelivr, so a visit does not disclose the visitor IP address to those\n'
  printf 'providers (LG München, 3 O 17493/20, 20 Jan 2022).\n\n'
  printf 'Downloaded by `scripts/vendor.sh` on %s.\n\n' "$RUN_DATE"
  printf '## Files\n\n'
  printf '| File | Contents | Version | Source | Licence |\n'
  printf '| --- | --- | --- | --- | --- |\n'
  printf '| `d3.min.js` | d3 | %s | %s | ISC |\n' "$D3_VERSION" "$D3_URL"
  printf '| `topojson-client.min.js` | topojson-client | %s | %s | ISC |\n' \
    "$TOPOJSON_CLIENT_VERSION" "$TOPOJSON_CLIENT_URL"
  while IFS=$'\t' read -r file_name subset family style weight source_url unicode_range; do
    font_path=${source_url#https://fonts.gstatic.com/s/}
    font_version=${font_path#*/}
    font_version=${font_version%%/*}
    printf '| `fonts/%s` | %s %s, %s (%s) | %s | %s | SIL OFL 1.1 |\n' \
      "$file_name" "$family" "$weight" "$style" "$subset" "$font_version" "$source_url"
  done < "$tmp_dir/fonts-installed.tsv"
  printf '\n## Fonts: SIL Open Font License 1.1\n\n'
  printf 'The three families (Saira Semi Condensed, IBM Plex Sans, IBM Plex Mono) are\n'
  printf 'licensed under the SIL Open Font License, Version 1.1. Full text from\n'
  printf '<%s>:\n\n' "$OFL_URL"
  printf '```text\n'
  cat "$tmp_dir/OFL.txt"
  printf '```\n\n'
  printf '## d3: ISC licence\n\n'
  printf 'From <%s>:\n\n' "$D3_LICENSE_URL"
  printf '```text\n'
  cat "$tmp_dir/d3.LICENSE"
  printf '```\n\n'
  printf '## topojson-client: ISC licence\n\n'
  printf 'From <%s>:\n\n' "$TOPOJSON_CLIENT_LICENSE_URL"
  printf '```text\n'
  cat "$tmp_dir/topojson-client.LICENSE"
  printf '```\n'
} > "$tmp_dir/LICENSES.md"

# Publish only after every download and all parsing succeeded.
mkdir -p "$OUT_DIR"
rm -rf -- "$OUT_DIR/fonts"
mkdir -p "$OUT_DIR/fonts"
cp -- "$tmp_dir"/fonts/*.woff2 "$OUT_DIR/fonts/"
cp -- "$tmp_dir/fonts.css" "$OUT_DIR/fonts.css"
cp -- "$tmp_dir/d3.min.js" "$OUT_DIR/d3.min.js"
cp -- "$tmp_dir/topojson-client.min.js" "$OUT_DIR/topojson-client.min.js"
cp -- "$tmp_dir/LICENSES.md" "$OUT_DIR/LICENSES.md"

printf 'wrote %s font files, fonts.css, d3.min.js, topojson-client.min.js and LICENSES.md to %s\n' \
  "$font_count" "$OUT_DIR"
