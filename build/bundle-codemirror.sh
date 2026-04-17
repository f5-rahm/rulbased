#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# bundle-codemirror.sh
#
# Downloads CodeMirror 5 (the last version with a simple single-file
# distribution) and bundles the minimum needed for the Rülbased GUI:
#   - core (codemirror.js + codemirror.css)
#   - TCL mode (mode/tcl/tcl.js)
#   - matchbrackets addon
#   - show-hint addon (for future completion support)
#
# Output:
#   presentation/vendor/codemirror.min.js   (~130KB minified)
#   presentation/vendor/codemirror.min.css  (~10KB minified)
#
# Requirements (build machine only, NOT on BIG-IP):
#   - curl or wget
#   - node (for minification via uglify-js) OR cat if you skip minification
#
# Usage:
#   cd rulbased/
#   bash build/bundle-codemirror.sh
#
# Offline / air-gapped option:
#   1. Download codemirror-5.65.17.zip from
#      https://github.com/codemirror/codemirror5/releases
#   2. Pass the zip path as argument:
#      bash build/bundle-codemirror.sh /path/to/codemirror-5.65.17.zip
# ---------------------------------------------------------------------------
set -euo pipefail

CM_VERSION="5.65.17"
VENDOR_DIR="presentation/vendor"
TMP_DIR=$(mktemp -d)

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

cd "$(dirname "$0")/.."
mkdir -p "$VENDOR_DIR"

echo "==> CodeMirror bundler for Rülbased"
echo "    Target: $VENDOR_DIR"
echo "    Version: CodeMirror $CM_VERSION"

# ---------------------------------------------------------------------------
# Step 1: Obtain CodeMirror source
# ---------------------------------------------------------------------------
if [ -n "${1:-}" ] && [ -f "$1" ]; then
    echo "==> Using local zip: $1"
    unzip -q "$1" -d "$TMP_DIR"
    CM_SRC=$(find "$TMP_DIR" -maxdepth 2 -name "codemirror.js" | grep "lib/codemirror" | head -1 | xargs dirname | xargs dirname)
else
    echo "==> Downloading CodeMirror $CM_VERSION from GitHub..."
    ZIP_URL="https://github.com/codemirror/codemirror5/archive/refs/tags/$CM_VERSION.tar.gz"
    curl -sSL "$ZIP_URL" | tar -xz -C "$TMP_DIR"
    CM_SRC="$TMP_DIR/codemirror5-$CM_VERSION"
fi

echo "    Source dir: $CM_SRC"

# ---------------------------------------------------------------------------
# Step 2: Concatenate JS sources in order
# ---------------------------------------------------------------------------
echo "==> Concatenating JS..."
BUNDLE_JS="$TMP_DIR/bundle_raw.js"

# Header comment
cat > "$BUNDLE_JS" <<'HEADER'
/*!
 * CodeMirror 5 bundle for Rülbased
 * Includes: core + TCL mode + matchbrackets + show-hint
 * License: MIT — https://codemirror.net/LICENSE
 */
HEADER

# Core
cat "$CM_SRC/lib/codemirror.js" >> "$BUNDLE_JS"

# Addons needed
cat "$CM_SRC/addon/edit/matchbrackets.js" >> "$BUNDLE_JS"
cat "$CM_SRC/addon/hint/show-hint.js"     >> "$BUNDLE_JS"

# TCL mode
cat "$CM_SRC/mode/tcl/tcl.js" >> "$BUNDLE_JS"

# ---------------------------------------------------------------------------
# Step 3: Concatenate CSS
# ---------------------------------------------------------------------------
echo "==> Concatenating CSS..."
BUNDLE_CSS="$TMP_DIR/bundle_raw.css"

cat "$CM_SRC/lib/codemirror.css" > "$BUNDLE_CSS"
cat "$CM_SRC/addon/hint/show-hint.css" >> "$BUNDLE_CSS"

# ---------------------------------------------------------------------------
# Step 4: Minify if uglify-js / cleancss are available, otherwise copy as-is
# ---------------------------------------------------------------------------
if command -v uglifyjs &>/dev/null; then
    echo "==> Minifying JS with uglify-js..."
    uglifyjs "$BUNDLE_JS" \
        --compress \
        --mangle \
        --comments "/^!/" \
        -o "$VENDOR_DIR/codemirror.min.js"
elif command -v npx &>/dev/null && npx --yes uglify-js --version &>/dev/null 2>&1; then
    echo "==> Minifying JS with npx uglify-js..."
    npx uglify-js "$BUNDLE_JS" \
        --compress \
        --mangle \
        --comments "/^!/" \
        -o "$VENDOR_DIR/codemirror.min.js"
else
    echo "    uglify-js not found — copying unminified JS (still works, just larger)"
    cp "$BUNDLE_JS" "$VENDOR_DIR/codemirror.min.js"
fi

if command -v cleancss &>/dev/null; then
    echo "==> Minifying CSS with clean-css..."
    cleancss "$BUNDLE_CSS" -o "$VENDOR_DIR/codemirror.min.css"
else
    echo "    clean-css not found — copying unminified CSS"
    cp "$BUNDLE_CSS" "$VENDOR_DIR/codemirror.min.css"
fi

# ---------------------------------------------------------------------------
# Step 5: Report sizes
# ---------------------------------------------------------------------------
JS_SIZE=$(wc -c < "$VENDOR_DIR/codemirror.min.js")
CSS_SIZE=$(wc -c < "$VENDOR_DIR/codemirror.min.css")
echo ""
echo "==> Bundle complete"
printf "    %-35s  %6d KB\n" "presentation/vendor/codemirror.min.js"  $((JS_SIZE / 1024))
printf "    %-35s  %6d KB\n" "presentation/vendor/codemirror.min.css" $((CSS_SIZE / 1024))
echo ""
echo "    Commit both files to your repo so the RPM includes them."
echo "    app.html will use these local files and will NOT load from CDN."
