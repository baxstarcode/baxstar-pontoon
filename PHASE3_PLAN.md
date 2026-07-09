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

## Checklist
- [x] 1. Capture real email formats (4 variants + noise inventory)
- [ ] 2. `backend/Code.gs` — pure parse/merge functions + `getTodaysBookings`
        action + doGet actions list; complete replacement file
- [ ] 3. Parser/merge unit suite runnable WITHOUT Chrome (JavaScriptCore
        `jsc`, display-sleep-proof): `.devtest/test_phase3_backend.js` with
        fake-GmailApp inbox fixtures — FICTIONAL customer data only (repo is
        public). Cases: well-formed online booking; staff booking w/o email;
        malformed email; zero-bookings-today; duplicate confirmations;
        cancelled; rebooked-to-today; rebooked-away; non-pontoon filtered;
        noise ignored; ID charset; multi-day (no end time)
- [ ] 4. Form — `fetchTodaysReservations()` calls `getTodaysBookings`
        (webhookConfigured-gated, 60s client cache, field whitelist +
        ID validation); `applyReservation` additionally fills empty
        email field; advisory shows item; complete replacement file
- [ ] 5. `.devtest/mock_gas_server.py` — `getTodaysBookings` action with
        settable fixture (`/_set_bookings` test hook)
- [ ] 6. Browser suites: extend Scenario B for server-shape data + email
        fill; full regression — main 78+new/0, cloud 34/0 (needs awake
        display; run opportunistically, fall back to jsc coverage + morning
        note if Chrome hangs)
- [ ] 7. Hostile self-review of full diff (hunt: any path where unverified/
        stale booking # looks verified)
- [ ] 8. MORNING_REPORT.md

## Known limitations (by design, for the report)
- Multi-day rentals are served on their START date only (check-out day).
- Server cache (CacheService, 120s) + client cache (60s): a cancellation can
  lag up to ~3 min behind Gmail.
- Gmail search depends on script TZ matching email date phrasing — deploy
  step: script timezone must be America/Chicago.
