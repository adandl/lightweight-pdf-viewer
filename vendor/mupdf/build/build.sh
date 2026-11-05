#!/bin/bash
# Rebuild the MuPDF.js WASM bundle with the separation additions used by
# mupdf.html. Requires git, make, Node.js and ~2 GB of disk.
#
#   bash vendor/mupdf/build/build.sh            # builds into vendor/mupdf/
#
set -euo pipefail
MUPDF_TAG=${MUPDF_TAG:-1.28.1}
EMSDK_VERSION=4.0.8
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/.."
WORK=${WORK:-"$(mktemp -d)"}

cd "$WORK"
[ -d emsdk ] || git clone --depth 1 https://github.com/emscripten-core/emsdk.git
emsdk/emsdk install $EMSDK_VERSION
emsdk/emsdk activate $EMSDK_VERSION

[ -d mupdf ] || git clone --depth 1 --branch "$MUPDF_TAG" https://github.com/ArtifexSoftware/mupdf.git
cd mupdf
git submodule update --init --depth 1 thirdparty/jbig2dec thirdparty/mujs thirdparty/freetype \
  thirdparty/gumbo-parser thirdparty/harfbuzz thirdparty/libjpeg thirdparty/lcms2 \
  thirdparty/openjpeg thirdparty/zlib thirdparty/extract thirdparty/brotli thirdparty/cmark-gfm
git apply "$HERE/separations.patch"

cd platform/wasm
EMSDK="$WORK/emsdk" make
cp dist/mupdf.js dist/mupdf-wasm.js dist/mupdf-wasm.wasm "$OUT/"
cp ../../COPYING "$OUT/LICENSE"
echo "Done. Files copied to $OUT"
