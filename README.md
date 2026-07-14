# baxstar-pontoon

Everything pontoon-side for **Baxstar Outdoors** (the rental brand of Baxstar Fishing LLC, Detroit Lakes, MN): website embed sections, the rental check-in/check-out form app and its backend, and ad/marketing assets.

**Public repo — code and assets only.** Strategy docs, customer data, and business planning live elsewhere. Sibling repo `bax1` holds the Baxstar Fishing website sections.

---

## 1. Website sections (Wix embeds)

Self-contained HTML sections for baxstaroutdoors.com, pasted into Wix **Embed → Custom Embeds → Embed HTML** blocks. Each file is standalone: fonts, scoped CSS, and JS inlined; scroll-safe inside the Wix iframe; `prefers-reduced-motion` supported; each posts its height via `postMessage` (`type: 'bx-embed-height'`).

| File | What it is | Status |
|---|---|---|
| `baxstar_outdoors_boat_hero_house.html` | "I'm on a boat." animated homepage section — **Baxstar house style** (near-black, grid texture, red glow, Bebas Neue / Barlow Condensed / Cormorant) | **Production pick** — goes directly below the homepage hero |
| `baxstar_outdoors_boat_hero.html` | Same section, dark navy-dusk styling | Kept alternate (V1) |
| `baxstar_outdoors_boat_hero_sunset.html` | Same section, sunset/beach-bar styling | Kept alternate — candidate for seasonal/campaign use |

To embed: copy the entire file (`<!DOCTYPE html>` → `</html>`) into the Wix HTML block, full width, initial height ≈ 560px desktop / 540px mobile. The booking CTA links to the live FareHarbor flow (`?full-items=yes&flow=591376`) with `target="_top"` so booking opens outside the iframe — verify against the site's current button before changing.

GitHub Pages serves this repo, so any section can be previewed live at
`https://baxstarcode.github.io/baxstar-pontoon/<filename>.html` before it goes into Wix.

## 2. Pontoon rental form (operations app)

- **`baxstar_pontoon_form.html`** — mobile-first check-out/check-in form used at rental handoff: client + unit details, safety checklist, condition checklist, tap-to-mark damage diagram, signatures, multi-rental session manager. Served via GitHub Pages.
- Syncs to the Google Apps Script backend (below). Supports multiple devices editing the same rental.

## 3. Backend (`backend/Code.gs`)

Google Apps Script backend for the form. Deployed manually: paste `Code.gs` into the **Baxstar Pontoon Filing** project at script.google.com and deploy. Current capabilities:

- **Rental sync** across devices.
- **Tombstones** — finalized/deleted rentals are tombstoned server-side so stale device copies self-delete on next sync; newer edits clear the tombstone; auto-purge after 90 days. (See `TOMBSTONES_REPORT.md`; branch `tombstones-v2`.)
- **FareHarbor booking lookup (Phase 3)** — `getTodaysBookings` scans Gmail for `messages@fareharbor.com` notifications, reconstructs today's pontoon bookings (new / staff-created / rebooked / cancelled), and auto-fills booking number, date, time, and customer email in the form. Strict validation (booking IDs `/^\d{6,12}$/`); parse failures return a safe error state, never silent bad data. (See `PHASE3_PLAN.md`, `MORNING_REPORT.md`; branch `phase3-fareharbor-lookup`.)

After deploying, verify the backend version string matches the reports (e.g., `phase3+tombstones-1`) before merging form changes.

## 4. Tests (`.devtest/`)

Test harness for the form and backend: `run_phase3_backend_tests.sh` plus browser suites (`test_current.html`, `test_phase2.html`, `race_test.html`). Generated artifacts (build outputs, logs, reports) are untracked via `.gitignore`. Run the browser suites by opening them locally; run backend tests via the shell script.

## 5. Assets

- `baxstar_outdoors_logo_white.svg` — Baxstar Outdoors white logo.
- `public/assets/` — ad and promo assets (e.g., rod-and-reel upgrade banner).

## 6. Working docs

- `TOMBSTONES_REPORT.md` — tombstone sync design, test results, deployment steps.
- `PHASE3_PLAN.md` — FareHarbor Gmail-scan plan and completion status.
- `MORNING_REPORT.md` — overnight Phase 3 run report and deploy checklist.

## Conventions

- Section files follow the `baxstar_*.html` naming convention and must be self-contained (no external CSS/JS beyond Google Fonts).
- Embeds stay scroll-safe: no body-level scroll locks, `overflow-x: hidden; overflow-y: visible` baseline, one height reporter per file.
- Nothing in this repo should contain customer data, credentials, or internal strategy — it's public and Pages-deployed.
