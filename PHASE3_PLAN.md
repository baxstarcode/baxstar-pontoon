# Phase 3 — FareHarbor Gmail-scan booking lookup

Overnight run 2026-07-09. Branch `phase3-fareharbor-lookup` (worktree at
`~/baxstar-overnight/phase3-fareharbor`; the Desktop checkout is on someone
else's in-flight `tombstones` branch and is deliberately untouched).

## Objective
Backend action `getTodaysBookings`: scan Gmail for FareHarbor notification
emails, reconstruct today's REAL pontoon bookings (new / rebooked / cancelled,
latest state wins), and serve them to the form's existing advisory
name-match/auto-fill pipeline — replacing the dormant empty list.

## Ground truth (from Brady's real inbox, read-only, 2026-07-09)
All operator notifications come from `messages@fareharbor.com`:
- `New online booking: <Item> on <Weekday>, <Month D, YYYY> at <h:mm am[ - h:mm pm]>`
- `New booking: ...` (staff-created — customer **Email/Phone often absent**)
- `Rebooked: <Item> on <NEW date...>` — body has Old/New table; **rebooking
  issues a NEW booking ID**; old ID is superseded; old date appears in body
  (so a date-phrase search still finds rebook-aways)
- `Booking #N Cancelled (<Item> on <date...>)`
- Noise that must be ignored: manifests, reminders, support threads, login
  codes, customer-facing "Your booking has been cancelled"
Body fields (HTML): `Booking #N` (h3), `Name:`, optional `Phone:`, optional
`Email:`, item name, `<Weekday>, <Month D, YYYY> at <start>[ - <end>]`,
`Created by:`.
Items: pontoon bookings identifiable by /pontoon/i in item name; fishing-trip
bookings MUST be filtered out (wrong booking # for a pontoon check-in).

## Hard safety rules (from the 7/06 fake-data incident)
- Serve only bookings parsed from real emails whose trip date == today and
  item matches /pontoon/i.
- Latest-email-wins per booking ID; cancelled and rebooked-away IDs dropped;
  per-ID verification search closes any gap.
- Booking IDs validated /^\d{6,12}$/ server-side AND client-side before any
  DOM/URL interpolation.
- Advisory UI must show item + start so Brady sees exactly what matched.
- Any parse/search failure → ok:false → form shows the existing
  "couldn't verify" advisory. Never a silent wrong answer.

## Checklist — ALL DONE on mocks (2026-07-09 overnight run)
- [x] 1. Capture real email formats (4 variants + noise inventory)
- [x] 2. `backend/Code.gs` — pure parse/merge functions + `getTodaysBookings`
        action + doGet actions list (commit e938335, hardened 37e1500)
- [x] 3. Chrome-free backend suite under JavaScriptCore:
        `.devtest/run_phase3_backend_tests.sh` → **58/0** (all planned cases
        + sender display-name-spoof rejection)
- [x] 4. Form — real `fetchTodaysReservations()`, email auto-fill, item in
        advisory (commit 37e1500)
- [x] 5. Mock server — `getTodaysBookings` + `/__set_bookings` staging hook
- [x] 6. Browser suites: main **80/0** (was 78), cloud **41/0** (was 34;
        new Scenario H real-path), race **20/2 expected signature** —
        all run headless tonight, no display-sleep hang
- [x] 7. Hostile self-review — found + fixed one real hole: sender check
        accepted a display-name spoof ('"messages@fareharbor.com" <evil@x>'),
        which could have served an attacker-crafted booking as verified.
        Address-only comparison now, with jsc regression tests.
- [x] 8. MORNING_REPORT.md at repo root

## Known limitations (by design, for the report)
- Multi-day rentals are served on their START date only (check-out day).
- Server cache (CacheService, 120s) + client cache (60s): a cancellation can
  lag up to ~3 min behind Gmail.
- Gmail search depends on script TZ matching email date phrasing — deploy
  step: script timezone must be America/Chicago.
