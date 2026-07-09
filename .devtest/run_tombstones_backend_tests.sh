#!/bin/sh
# Tombstones backend suite — the REAL Code.gs gate under JavaScriptCore.
# Run from anywhere:  sh .devtest/run_tombstones_backend_tests.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
BUNDLE="$DIR/tombstones_backend_bundle.js"   # generated, untracked
cat "$DIR/../backend/Code.gs" "$DIR/test_tombstones_backend.js" > "$BUNDLE"
OUT="$("$JSC" "$BUNDLE" 2>&1)" || { echo "$OUT"; echo "jsc crashed"; exit 2; }
echo "$OUT"
echo "$OUT" | grep -q 'RESULT: ' || { echo "suite did not complete"; exit 2; }
echo "$OUT" | grep -q ' 0 failed' || exit 1
