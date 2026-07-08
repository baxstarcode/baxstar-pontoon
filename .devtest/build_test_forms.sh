#!/bin/sh
# Build the form variants the bench suites expect. Run from .devtest/.
#
#   form_phase2.html   — FILING_URL EMPTY. Scenario C ("finalize + queue with
#                        NO webhook URL") depends on the send being unable to
#                        run; cloud-draft sync is also off in this variant.
#   form_with_url.html — FILING_URL = https://hooks.test.invalid/exec. Used by
#                        scenarios D-G, which stub window.fetch themselves; the
#                        URL only needs to satisfy the /^https?:\/\// gate and
#                        match the suite's hooks.test.invalid assertion.
#   race webroot copy  — FILING_URL = http://localhost:8809 (the live mock).
#                        Used by race_test.html via run_race_test.py.
#
# (History: these generated files were never committed, and rebuilding them
# wrong produces confusing partial failures — 73/75 instead of 78/0.)
set -e
FORM=../baxstar_pontoon_form.html
swap() { sed "s|const FILING_URL = '[^']*'|const FILING_URL = '$1'|" "$FORM"; }
swap ""                                > form_phase2.html
swap "https://hooks.test.invalid/exec" > form_with_url.html
mkdir -p race_webroot
swap "http://localhost:8809"           > race_webroot/form_phase2.html
# the pre-fix control for the race harness comes from git:
git -C .. show 3b25b92^:baxstar_pontoon_form.html | sed "s|const FILING_URL = '[^']*'|const FILING_URL = 'http://localhost:8809'|" > race_webroot/form_prefix.html
cp race_test.html race_webroot/ 2>/dev/null || true
# the cloud-sync suite needs the localhost:8809 form variant, so it runs from
# race_webroot/ too (open http://localhost:8001/race_webroot/test_phase2.html)
cp test_phase2.html race_webroot/ 2>/dev/null || true
echo "built: form_phase2.html (no URL), form_with_url.html (hooks.test.invalid), race_webroot/ (localhost:8809)"
