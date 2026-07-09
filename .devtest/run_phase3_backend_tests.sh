#!/bin/sh
# Phase 3 backend suite — runs the REAL Code.gs parse/merge/handler code under
# macOS JavaScriptCore (no Chrome, no Apps Script, immune to display-sleep).
# Run from anywhere:  sh .devtest/run_phase3_backend_tests.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
BUNDLE="$DIR/phase3_backend_bundle.js"   # generated, untracked
cat "$DIR/../backend/Code.gs" "$DIR/test_phase3_backend.js" > "$BUNDLE"
OUT="$("$JSC" "$BUNDLE" 2>&1)" || { echo "$OUT"; echo "jsc crashed"; exit 2; }
echo "$OUT"
echo "$OUT" | grep -q 'RESULT: ' || { echo "suite did not complete"; exit 2; }
echo "$OUT" | grep -q ' 0 failed' || exit 1
