# Tombstones — run report (2026-07-09 afternoon)
Branch **tombstones-v2** (pushed). DONE on mocks; your Code.gs paste + deploy remains.

## What it does
Finalize/delete now tombstones the rentalId server-side. A stale phone
re-pushing its old copy is acknowledged-but-ignored (`tombstoned:true`) and
drops its own stale local copy; a NEWER edit (unlock-and-edit) clears the
tombstone and syncs normally. Retires the "refresh the other phone" rule.
Tombstones self-prune after 90 days.

## Provenance
Recovered from the interrupted 7/8 session's parked WIP (90a920a), rebased
onto live main (Phase 3), conflicts reconciled, then tested for real.

## Test results
- NEW `sh .devtest/run_tombstones_backend_tests.sh` — the REAL Code.gs gate
  under JavaScriptCore (fake Drive/Properties/Lock): **19/0**
  (stale refused / tie refused / newer clears / TTL prune / corrupt store safe)
- Phase 3 jsc suite: **58/0** (unchanged)
- Cloud suite + new T1–T3 (Dustin two-phone zombie, deliberate resurrection,
  finalize tombstones): **50/0**
- Main suite: **80/0** · Race harness: **20/2 expected signature**
- Suite made idempotent: it now resets the mock at start (fixed-id scenarios
  would otherwise trip over last run's tombstones).

## Your steps
1. Paste `backend/Code.gs` from this branch into script.google.com → Save →
   Deploy → Manage deployments → pencil → **New version** → Deploy.
   (No new permissions this time. setupCheck optional.)
2. Verify: /exec URL should show `"version":"phase3+tombstones-1"`.
3. Say "merge" — form side ships via Pages.
   Order matters again: backend first, then merge (old backend ignores the
   tombstoned flag harmlessly, but new-form-first buys nothing).

## Honest residuals
- `updatedAt` is client-clock time. Phones are NTP-synced, so real skew is
  sub-second; a devil's-advocate case (phone clock minutes slow during an
  unlock-and-edit right after finalize) could get an edit silently ignored.
  Not observed, not likely, stated for the record.
- If a phone keeps editing OFFLINE while another finalizes, its later push is
  NEWER and deliberately resurrects the draft — that's the app's
  never-silently-lose-work rule, unchanged.
- Deployed live, Dustin's finalize tomorrow becomes the first real-world test:
  after the parents finalize, your phone's stale copy should vanish on its
  next sync with NO manual refresh.
