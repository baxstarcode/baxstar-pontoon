# Morning Report — Phase 3: FareHarbor Gmail-scan booking lookup
2026-07-09 overnight run. **DONE on mocks.** Live verification is yours by definition.

## Where the work lives
- Branch **`phase3-fareharbor-lookup`**, pushed to origin. Built in a separate
  worktree at `~/baxstar-overnight/phase3-fareharbor`.
- ⚠️ Your Desktop checkout (`~/Desktop/baxstar-pontoon`) is on a branch
  **`tombstones`** with UNCOMMITTED changes to Code.gs, the form, the mock, and
  test_phase2.html — some other session's in-flight work. I did not touch it.
  Don't lose it when you switch branches.
- `main` untouched. Live backend untouched. No live POSTs, no Drive access.

## What's built (commits on the branch)
- `e938335` backend: `getTodaysBookings` action — scans Gmail for FareHarbor
  operator emails and reconstructs TODAY's real pontoon bookings.
- `37e1500` form + harness: the advisory pipeline now feeds from that action;
  auto-fills booking #, date, check-out time, and (when the confirmation has
  one) customer email — empty fields only, never overwrites typing. Advisory
  line now names the item so a wrong-item match is visible.
- `<this commit>` plan + this report.

How it works: no FareHarbor API. FareHarbor emails you an operator
notification for every booking event. The backend searches Gmail for
`from:messages@fareharbor.com "<today's date phrase>"`, parses
new/rebooked/cancelled emails (formats verified against four real emails in
your inbox — read-only), merges latest-email-wins per booking id, drops
cancelled and rebooked-away ids, filters to items matching /pontoon/i
(a fishing-trip booking # must never land on a pontoon check-in), then runs a
per-id verification search on each survivor. Result cached 120s server-side,
60s in the form.

Key facts learned from your real inbox:
- A **rebook issues a NEW booking id** — the old id is dead from that moment.
- Staff-created bookings usually have **no customer email** (your conditional
  field) — handled: email just isn't auto-filled.
- Manifests/reminders/support/login-code emails are classified as noise.

## Test results (all green tonight, all runnable by you)
| Suite | Command | Result |
|---|---|---|
| Backend parse/merge/handler (no Chrome needed) | `sh .devtest/run_phase3_backend_tests.sh` | **58/0** |
| Main bench suite | headless Chrome → `test_current.html` | **80/0** (was 78) |
| Cloud suite (+ new real-path Scenario H) | `race_webroot/test_phase2.html` | **41/0** (was 34) |
| Race harness | `race_test.html` | **20 pass / 2 expected FAILs** (pre-fix control + closed hole-probe — unchanged signature) |

Self-review catch worth knowing about: my first sender check accepted a
**display-name spoof** (`"messages@fareharbor.com" <evil@example>` passes
Gmail's `from:` search AND a substring check). Fixed to compare the address
only; regression-tested. That was exactly the "fake data with a verified
checkmark" class from 7/06.

## Your steps, in order
1. **Deploy the backend FIRST** (before any merge — the new form on the old
   backend shows a harmless-but-noisy "couldn't verify" advisory on every
   name you type):
   a. script.google.com → Baxstar Pontoon Filing → replace Code.gs with the
      branch's `backend/Code.gs` (complete file, delete-all/paste-all).
   b. Project Settings (gear) → confirm time zone **America/Chicago** —
      the scan derives "today" from it.
   c. Run `setupCheck` once from the editor — it will ask for a NEW Gmail
      READ permission (that's Phase 3), and its log now prints a live
      `getTodaysBookings` result so you can eyeball today's scan right there.
   d. Deploy → Manage deployments → pencil → **New version** → Deploy
      (same /exec URL, form keeps working).
2. **Verify the deployment**: open the /exec URL in a browser — the actions
   list must now include `getTodaysBookings`.
3. **Live test** (2 min): on a day with a real pontoon booking, type that
   customer's name into the form → advisory should show
   "✓ Reservation found: name · item · time · #booking" and fill the empty
   fields. On a no-booking day it stays silent. If Gmail scan breaks you get
   "Couldn't verify reservation — enter details manually", never a guess.
4. When 1–3 look good: merge `phase3-fareharbor-lookup` to main on your
   go — Pages then serves the new form. (I don't merge without your word.)

## Honest uncertainties (PROVISIONAL until your live test)
- **Email formats**: parser is built from 4 real emails + noise inventory from
  your actual inbox, but I couldn't see every variant (e.g. a multi-day
  booking's confirmation shows only the START date — multi-day rentals are
  served on their start date only; a customer-initiated rebook email I've
  never seen). Malformed/unknown variants are skipped, never guessed.
- **Item filter is /pontoon/i on the item name.** If you ever rename rental
  items to something without "pontoon", the lookup goes silent for them.
- **Staleness window**: server cache 120s + form cache 60s → a cancellation
  can be served up to ~3 min after the email lands. A cancelled-booking
  auto-fill inside that window is possible; the advisory showing item+time
  is your visual check.
- **Bounds**: scan reads at most 50 Gmail threads mentioning today's date and
  verifies at most 10 surviving bookings — far above your volumes; a miss
  degrades to "walk-up is fine" or silence, never to a wrong verified fill.
- The live Gmail quota/scope behavior of `GmailApp.search` under the web-app
  identity is the one thing mocks can't prove — that's what step 1c shows you.
