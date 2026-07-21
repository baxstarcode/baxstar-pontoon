/**
 * =============================================================================
 * BAXSTAR PONTOON — FILING BACKEND
 * Google Apps Script web app. Receives POSTs from baxstar_pontoon_form.html.
 *
 *   Phase 1 (LIVE): finalize a completed rental — file the JSON record to
 *     Drive, append one row to a Google Sheet, email the customer their copy.
 *   Phase 2 (LIVE): cloud draft sync for cross-device handoff —
 *     saveDraft / getActive / deleteDraft keep in-progress rentals in a Drive
 *     "Pontoon Drafts" folder so any device can list and resume an open rental.
 *     Plus a 6-month retention sweep that ARCHIVES (never silently deletes)
 *     old finalized records.
 *   Phase 3 (LIVE): FareHarbor booking lookup — getTodaysBookings
 *     scans Gmail for FareHarbor notification emails (no FareHarbor API),
 *     reconstructs the real PONTOON bookings (new / rebooked / cancelled,
 *     latest email wins), and serves them to the form's reservation-advisory
 *     auto-fill. Read-only: touches no Drive files, sends no email.
 *   Tombstones (v8 — this update): when a rental is finalized or its draft
 *     deleted, the rentalId is tombstoned (Script Properties, timestamped,
 *     now WITH a reason: 'finalized' or 'deleted'). A stale phone re-pushing
 *     its old local copy gets an OK-but-ignored response (tombstoned: true +
 *     reason) instead of resurrecting the draft. v8 CHANGE: a merely NEWER
 *     push no longer clears the tombstone — "newer" proved meaningless,
 *     since just reopening the app on a stale phone bumps updatedAt (that is
 *     how the Debra draft resurrected 50 minutes after filing). Only an
 *     EXPLICIT resurrect:true push clears a tombstone, and the form sends
 *     that from exactly two deliberate human actions: Unlock, and the
 *     Restore button on a deleted-elsewhere rental. The reason rides back on
 *     every refusal so the form knows whether to lock the local copy (record
 *     filed elsewhere) or park it with a Restore offer.
 *   Early check-in (LIVE): the lookup window widens from "today only"
 *     to TODAY + TOMORROW, so a customer whose FareHarbor booking is dated
 *     tomorrow can be checked in the evening before and still auto-fill —
 *     with the booking's ACTUAL rental date (the legal date), never the
 *     handoff date. Guard rail: if today has its own booking and that rental
 *     has NOT been finalized yet (no finalized record for today's date in
 *     the Pontoon Rentals folder), tomorrow's bookings are SUPPRESSED from
 *     the response — tomorrow's customer can't auto-fill while today's boat
 *     is still out. One booking per day is the operating reality, so the
 *     gate is simply "is there a finalized record dated today". The response
 *     reports how many were suppressed (earlySuppressed) so the form can say
 *     WHY a name isn't matching instead of claiming "no reservation". The
 *     gate is computed FRESH on every request (only the Gmail scan is
 *     cached) so a finalize opens the gate immediately, not after the cache
 *     expires. The Sheet log gains an "Early Possession" column (appended
 *     last so existing rows keep their meaning; the header row of an
 *     existing sheet is extended automatically).
 *
 * DEPLOY STEPS (Brady)
 * 1. Go to https://script.google.com → open the existing "Baxstar Pontoon
 *    Filing" project (or New project if starting fresh).
 * 2. Replace Code.gs with this entire file. Save.
 * 3. Run "setupCheck" once from the toolbar (▶) and authorize Drive/Sheets/
 *    Gmail when asked. It creates the Pontoon Rentals folder + log Sheet AND
 *    the Pontoon Drafts folder if they don't exist yet. (Phase 3 adds a Gmail
 *    READ scope — the authorize prompt will reappear once even on an existing
 *    deployment. setupCheck now also runs a live getTodaysBookings and logs
 *    what it found, so you can sanity-check the Gmail scan from the editor.)
 * 3b. (Phase 3) Project Settings (gear icon) → check the script time zone is
 *    America/Chicago. The Gmail scan matches "today" using the script TZ; a
 *    UTC-set project would roll to the wrong day in the evening.
 * 4. (Retention, optional but recommended) Run "setupRetention" once and
 *    authorize when asked. It installs a monthly trigger that ARCHIVES
 *    finalized records older than 6 months into "Pontoon Rentals Archive".
 *    Nothing is ever deleted by the script — Brady empties the archive folder
 *    on his own cadence.
 * 5. Deploy:
 *    - FIRST TIME: Deploy → New deployment → Web app →
 *        Execute as: Me (brady@baxstarfishing.com) · Who has access: Anyone.
 *      Copy the /exec URL into FILING_URL in baxstar_pontoon_form.html.
 *    - UPDATING an existing deployment (the normal case after a code change):
 *        Deploy → Manage deployments → edit (pencil) the existing deployment →
 *        Version: New version → Deploy. This KEEPS the same /exec URL so the
 *        form keeps working.
 * 6. Live test: finalize a test rental with all four signatures → confirm the
 *    JSON in Drive, the Sheet row, and the email. For Phase 2, save a draft on
 *    one device and confirm it appears under "Saved" on a second device.
 *    For Phase 3, GET the /exec URL and confirm 'getTodaysBookings' is in the
 *    actions list, then type a real booked customer's name into the form on a
 *    day with a pontoon booking and confirm the advisory offers it.
 *    For early check-in: with a booking dated TOMORROW in FareHarbor (and no
 *    unfinalized booking today), type that customer's name today — the form
 *    must show the amber EARLY CHECK-IN banner and fill tomorrow's date.
 *    For v8 tombstones: GET the /exec URL and confirm version says
 *    sync-truth-v8 and formBuild is 10 (cleanscreen-v10: no backend behavior
 *    change — the bump makes every pre-v10 form tab show its reload banner).
 *
 * SECURITY — honest limits: the form lives in a public GitHub repo, so the
 * /exec URL and TOKEN are both publicly readable. The token stops casual abuse
 * and stray POSTs, not a determined attacker. Real worst case (accepted risk,
 * stated plainly):
 *   - Anyone with the public token can LIST every draft's rentalId (getActive
 *     list mode) and then FETCH any draft in full — including in-progress
 *     customer names, details, and signature images. Finalized records are
 *     NOT fetchable; drafts are.
 *   - The finalize action sends a customer-copy email FROM Brady's Gmail with
 *     an attacker-supplied recipient and largely attacker-supplied body text
 *     (summaryText), gated only by four strings that merely need to start
 *     with "data:image/". That is usable as an outbound mail relay for
 *     phishing and can burn the daily Gmail quota (blocking real customer
 *     copies). It also creates junk record files and Sheet rows.
 *   - (Phase 3) Anyone with the public token can fetch TODAY'S + TOMORROW'S
 *     pontoon bookings — customer name, phone, email, booking #. Same PII
 *     class the draft listing already exposes; the early-check-in update
 *     widens the window by exactly one day. The action stays strictly
 *     read-only (no Drive writes, no mail sends, bounded Gmail searches; the
 *     finalize-gate check is a Drive READ of filenames only).
 * Mitigations if ever needed: rebuild the email body server-side from
 * structured fields, rate-limit finalize emails via CacheService, or require
 * a per-draft secret for fetch mode.
 * =============================================================================
 */

var CONFIG = {
  // Must match FILING_TOKEN in baxstar_pontoon_form.html
  TOKEN: '122e17decac6b1e5fd414886f5ca95b7',
  // "Baxstar Data Engine" folder — parent of everything this app creates
  DATA_ENGINE_FOLDER_ID: '1WghhwpLQfFfODtmnkTx__hTOaF3YDchW',
  RENTALS_FOLDER_NAME: 'Pontoon Rentals',
  DRAFTS_FOLDER_NAME: 'Pontoon Drafts',
  ARCHIVE_FOLDER_NAME: 'Pontoon Rentals Archive',
  LOG_SHEET_NAME: 'Pontoon_Rentals_Log',
  EMAIL_SUBJECT: 'Your Baxstar Outdoors pontoon rental record',
  // Finalized records older than this are archived by the retention sweep.
  RETENTION_MONTHS: 6,
  // ---- Phase 3: FareHarbor Gmail scan ----
  // Operator notifications sender. All parsed email MUST be from here.
  FAREHARBOR_SENDER: 'messages@fareharbor.com',
  // Only bookings whose item name matches this serve the pontoon form —
  // a fishing-trip booking # must never auto-fill a pontoon check-in.
  FAREHARBOR_ITEM_FILTER: /pontoon/i,
  // Result cache. Keeps repeated keystroke-triggered lookups (and several
  // devices) from re-running Gmail searches; worst case a cancellation is
  // served this many seconds stale. NOTE: only the Gmail SCAN is cached —
  // the early-check-in finalize gate is re-checked on every request, so a
  // finalize opens the gate immediately.
  LOOKUP_CACHE_SECONDS: 120,
  // Bounds so a runaway inbox can't blow the 30s Apps Script budget.
  LOOKUP_MAX_THREADS: 50,
  LOOKUP_MAX_VERIFY_IDS: 10
};

// "Early Possession" is appended LAST so rows written before this update keep
// their column meaning. getLogSheet extends an existing sheet's header row.
var LOG_HEADERS = [
  'Filed At', 'Client', 'Date', 'Unit', 'Booking #', 'Check-Out Time',
  'Check-In Time', 'Condition Summary', 'Check-Out Notes', 'Check-In Notes',
  'Customer Email', 'Emailed', 'Record File', 'Early Possession',
  'Reservation Notes'
];

/* ---- ENTRY POINTS --------------------------------------------------------- */

// The form POSTs as Content-Type text/plain (a CORS "simple request" —
// Apps Script cannot answer a preflight) with one JSON object as the body:
// an action payload plus { action: '...', token: '...' }.
function doPost(e) {
  var data;
  try {
    data = JSON.parse(e && e.postData && e.postData.contents || '');
  } catch (err) {
    return jsonOut({ ok: false, error: 'Request body is not valid JSON' });
  }
  if (!data || data.token !== CONFIG.TOKEN) {
    return jsonOut({ ok: false, error: 'Bad or missing token' });
  }
  try {
    switch (data.action) {
      case 'finalize':
        return jsonOut(handleFinalize(data));
      case 'saveDraft':
        return jsonOut(handleSaveDraft(data));
      case 'getActive':
        return jsonOut(handleGetActive(data));
      case 'deleteDraft':
        return jsonOut(handleDeleteDraft(data));
      case 'getTodaysBookings':
        return jsonOut(handleGetTodaysBookings(data));
      case 'scheduleDay1Copy':
        return jsonOut(handleScheduleDay1Copy(data));
      case 'cancelDay1Copy':
        return jsonOut(handleCancelDay1Copy(data));
      default:
        return jsonOut({ ok: false, error: 'Unknown action: ' + String(data.action) });
    }
  } catch (err) {
    return jsonOut({ ok: false, error: 'Backend error: ' + String(err && err.message || err) });
  }
}

// Sanity check in a browser: the /exec URL should show this JSON.
// `version` bumps with behavior changes so a deploy can be verified from a
// browser — sync-truth-v8 means tombstones carry reasons and only explicit
// resurrect pushes can clear them (no more resurrection-by-newer-timestamp).
// cleanscreen-v10 changes NOTHING server-side: it exists so formBuild says 10
// and every phone still on a v8/v9 tab shows the reload banner.
function doGet() {
  return jsonOut({
    ok: true,
    service: 'baxstar-pontoon-filing',
    version: 'phase3+tombstones+early-checkin-1+day1copy-1+v6-1+sync-truth-v8+cleanscreen-v10',
    formBuild: 10,  // latest shipped form build — older tabs show a reload banner
    actions: ['finalize', 'saveDraft', 'getActive', 'deleteDraft', 'getTodaysBookings',
      'scheduleDay1Copy', 'cancelDay1Copy']
  });
}

/* ---- FINALIZE ------------------------------------------------------------- */

function handleFinalize(p) {
  var missing = missingSignatures(p);
  if (missing.length) {
    return { ok: false, error: 'Cannot file — missing signatures: ' + missing.join(', ') };
  }

  // Two devices can finalize at once; serialize Drive/Sheet writes.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var folder = getRentalsFolder();
    var file = saveRecordFile(folder, p);
    var email = sendCustomerCopy(p);
    // Best-effort, like draft cleanup below: by this point the record file
    // exists and the customer may already be emailed — throwing here would
    // return ok:false for a filing that actually happened, and the client's
    // retry would file a duplicate _r2.json and email the customer again.
    var logRowOk = true;
    try { appendLogRow(folder, p, file, email); }
    catch (errLog) { logRowOk = false; }
    // The rental is now permanently filed — drop any in-progress cloud draft
    // for it so it stops showing as "open" on other devices, and tombstone
    // the id so a stale phone's old copy can't resurrect it. Best-effort:
    // a draft-cleanup hiccup must never fail an otherwise-good filing.
    var draftRemoved = false;
    try { draftRemoved = removeDraftFile(String(p.rentalId || '')); } catch (err2) {}
    try { addTombstone(String(p.rentalId || ''), 'finalized'); } catch (err3) {}
    // Finalize supersedes a pending day-1 send: the customer gets the full
    // record now, so a scheduled check-out-only copy is dropped.
    try { day1Unqueue(String(p.rentalId || '')); } catch (err4) {}
    return {
      ok: true,
      rentalId: String(p.rentalId || ''),
      fileUrl: file.getUrl(),
      emailed: email.sent,
      draftRemoved: draftRemoved,
      logRowAppended: logRowOk
    };
  } finally {
    lock.releaseLock();
  }
}

function missingSignatures(p) {
  var required = [
    ['checkOut', 'rentee', 'Rentee (check out)'],
    ['checkOut', 'baxstar', 'Baxstar (check out)'],
    ['checkIn', 'rentee', 'Rentee (check in)'],
    ['checkIn', 'baxstar', 'Baxstar (check in)']
  ];
  var missing = [];
  for (var i = 0; i < required.length; i++) {
    var section = p && p[required[i][0]];
    var sig = section && section.signatures && section.signatures[required[i][1]];
    if (!(typeof sig === 'string' && sig.indexOf('data:image/') === 0)) {
      missing.push(required[i][2]);
    }
  }
  return missing;
}

function saveRecordFile(folder, p) {
  // Rebuild the filename server-side (same convention the form documents)
  // rather than trusting the client-supplied one.
  var name = buildFilename(p) + '.json';
  // Never overwrite: a re-file after unlock gets a numbered name. Trashed
  // files don't count as collisions (name iterators include them otherwise).
  var finalName = name;
  for (var n = 2; hasLiveFile(folder, finalName); n++) {
    finalName = name.replace(/\.json$/, '_r' + n + '.json');
  }
  return folder.createFile(finalName, JSON.stringify(p, null, 2), 'application/json');
}

function hasLiveFile(folder, name) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) { if (!it.next().isTrashed()) return true; }
  return false;
}

function buildFilename(p) {
  var client = String(p.client || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Unnamed';
  var date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? p.date : 'no_date';
  var booking = String(p.bookingId || '').replace(/[^A-Za-z0-9]+/g, '') || 'walkup';
  return 'Pontoon_' + client + '_' + date + '_' + booking;
}

/* ---- CUSTOMER EMAIL --------------------------------------------------------
   Walk-ups and records without an email are normal: the record still files
   to Drive and the Sheet; only the email step is skipped. An email FAILURE
   also never blocks filing — it's recorded in the Sheet's Emailed column. */

function sendCustomerCopy(p) {
  var to = String(p.customerEmail || '').trim();
  if (!to) return { sent: false, status: 'no email on record' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { sent: false, status: 'invalid email: ' + to };
  }
  // A customer who already received the day-1 check-out copy gets an
  // "update" subject on the final record so the two emails read as one story.
  var day1AlreadySent = false;
  try {
    day1AlreadySent = day1LoadMap(DAY1_SENT_PROP)[String(p.rentalId || '')] !== undefined;
  } catch (e) { /* property store hiccup — default to standard subject */ }
  var subject = day1AlreadySent
    ? 'Notice: There has been an update to your Baxstar Pontoon Check Out Form'
    : CONFIG.EMAIL_SUBJECT;
  var lead = day1AlreadySent
    ? 'Thanks for renting with Baxstar Outdoors. Your rental is complete — the '
      + 'full record below replaces the check-out copy you received earlier.\n\n'
    : 'Thanks for renting with Baxstar Outdoors. Your rental record is below '
      + 'for your files.\n\n';
  try {
    GmailApp.sendEmail(to, subject,
      'Hi ' + (String(p.client || '').trim() || 'there') + ',\n\n'
      + lead
      + String(p.summaryText || '(summary unavailable)')
      + '\n\nQuestions? Just reply to this email.\n\nBaxstar Outdoors\n');
    return { sent: true, status: 'YES' };
  } catch (err) {
    return { sent: false, status: 'FAILED: ' + String(err && err.message || err) };
  }
}

/* ---- PHASE 2: CLOUD DRAFT SYNC ---------------------------------------------
   In-progress (not-yet-finalized) rentals are mirrored to a "Pontoon Drafts"
   Drive folder, one JSON file per rentalId. This is what makes the day-1-Brady
   / day-N-wife cross-device handoff possible. Drafts are transient working
   copies: finalize files the permanent record and deletes the draft.

   Each draft file:
     name        Draft_<rentalId>.json
     content     the full draft object { rentalId, updatedAt, ...meta, state }
                 (state includes signatures captured so far)
     description a small JSON of listing meta only, so getActive's list mode
                 never has to parse/return the heavy signature data. */

function getDraftsFolder() {
  var parent = DriveApp.getFolderById(CONFIG.DATA_ENGINE_FOLDER_ID);
  var existing = parent.getFoldersByName(CONFIG.DRAFTS_FOLDER_NAME);
  return existing.hasNext() ? existing.next() : parent.createFolder(CONFIG.DRAFTS_FOLDER_NAME);
}

function draftFileName(rentalId) {
  // rentalIds are generated as r_<ts>_<rand>; keep only safe chars defensively.
  return 'Draft_' + String(rentalId || '').replace(/[^A-Za-z0-9_]+/g, '') + '.json';
}

function findDraftFile(folder, rentalId) {
  // DriveApp name iterators also return TRASHED files (trashed items keep
  // their parent folder). Without this guard, a deleted draft gets found and
  // setContent()'d by a later saveDraft — the draft silently lives on in
  // Trash and is destroyed at purge. Skip trashed explicitly.
  var it = folder.getFilesByName(draftFileName(rentalId));
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) return f;
  }
  return null;
}

// Pull the listing meta from a draft, preferring the file description (cheap)
// and falling back to parsing content if an older file lacks one.
function draftMeta(file) {
  var rentalId = file.getName().replace(/^Draft_/, '').replace(/\.json$/, '');
  var meta = null;
  try { meta = JSON.parse(file.getDescription() || 'null'); } catch (err) { meta = null; }
  if (!meta) {
    try {
      var obj = JSON.parse(file.getBlob().getDataAsString());
      meta = {
        client: obj.client || '', date: obj.date || '', pontoon: obj.pontoon || '',
        updatedAt: obj.updatedAt || 0, hasCheckIn: !!obj.hasCheckIn
      };
    } catch (err2) { meta = {}; }
  }
  return {
    rentalId: rentalId,
    client: meta.client || '',
    date: meta.date || '',
    pontoon: meta.pontoon || '',
    updatedAt: Number(meta.updatedAt || 0),
    hasCheckIn: !!meta.hasCheckIn,
    finalized: !!meta.finalized
  };
}

// Upsert one draft. Last-write-wins, but we return the PREVIOUS updatedAt so
// the client can detect (and warn) if its write just clobbered a newer cloud
// copy from another device. We never reject a save — losing an in-progress
// edit is worse than a stale overwrite the user is told about.
function handleSaveDraft(data) {
  var rentalId = String(data.rentalId || '').trim();
  if (!rentalId) return { ok: false, error: 'saveDraft: missing rentalId' };
  if (!data.state || typeof data.state !== 'object') {
    return { ok: false, error: 'saveDraft: missing state' };
  }
  var updatedAt = Number(data.updatedAt || 0) || Date.now();
  var record = {
    rentalId: rentalId,
    updatedAt: updatedAt,
    client: String(data.client || ''),
    date: String(data.date || ''),
    pontoon: String(data.pontoon || ''),
    hasCheckIn: !!data.hasCheckIn,
    finalized: !!data.finalized,
    // Day-1 copy: the check-out summary text the scheduled send emails. The
    // form re-sends it with every sync, so the copy that goes out reflects
    // the draft as of the last autosave before the timer fires.
    day1Summary: String(data.day1Summary || ''),
    state: data.state
  };
  var meta = {
    client: record.client, date: record.date, pontoon: record.pontoon,
    updatedAt: record.updatedAt, hasCheckIn: record.hasCheckIn, finalized: record.finalized
  };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // Tombstone gate (v8): this rental was finalized or its draft deleted —
    // acknowledge the push (ok:true so the sender's retry queue drains) but
    // write NOTHING, and say why, so the sender can lock or park its copy.
    // Only an EXPLICIT resurrect:true push (the form sends it from Unlock and
    // from the Restore button — deliberate human actions) clears the stamp.
    // v7 cleared on any newer updatedAt, but "newer" proved meaningless:
    // merely reopening the app on a stale phone bumps updatedAt, which
    // resurrected the Debra draft 50 minutes after her rental was filed.
    var stone = tombstoneEntry(rentalId);
    if (stone) {
      if (data.resurrect === true) {
        clearTombstone(rentalId);
      } else {
        return { ok: true, rentalId: rentalId, updatedAt: updatedAt,
                 tombstoned: true, reason: stone.reason };
      }
    }

    var folder = getDraftsFolder();
    var file = findDraftFile(folder, rentalId);
    var previousUpdatedAt = 0;
    if (file) {
      try { previousUpdatedAt = Number((JSON.parse(file.getDescription() || '{}')).updatedAt || 0); } catch (err) {}
      file.setContent(JSON.stringify(record));
      file.setDescription(JSON.stringify(meta));
    } else {
      file = folder.createFile(draftFileName(rentalId), JSON.stringify(record), 'application/json');
      file.setDescription(JSON.stringify(meta));
    }
    return { ok: true, rentalId: rentalId, updatedAt: updatedAt, previousUpdatedAt: previousUpdatedAt };
  } finally {
    lock.releaseLock();
  }
}

// Two modes:
//   { action:'getActive' }                  → list mode: lightweight meta only
//   { action:'getActive', rentalId:'r_..' }  → fetch mode: one draft's full state
function handleGetActive(data) {
  var folder = getDraftsFolder();
  var rentalId = String(data.rentalId || '').trim();

  if (rentalId) {
    var file = findDraftFile(folder, rentalId);
    if (!file) return { ok: false, error: 'No draft for rentalId ' + rentalId, notFound: true };
    var obj;
    try { obj = JSON.parse(file.getBlob().getDataAsString()); }
    catch (err) { return { ok: false, error: 'Draft file unreadable' }; }
    return { ok: true, draft: obj };
  }

  var drafts = [];
  var stones = loadTombstones();
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (!/^Draft_.*\.json$/.test(f.getName())) continue;
    // Trashed drafts still appear in folder iterators — without this guard a
    // DELETED draft keeps showing on every device until Trash purges (~30d),
    // which reproduces the "delete didn't take" live symptom by itself.
    if (f.isTrashed()) continue;
    var meta = draftMeta(f);
    // Belt + suspenders: a tombstoned id should have no live file (saveDraft
    // refuses stale writes), but never list one if it somehow exists.
    if (stones[meta.rentalId] !== undefined) continue;
    drafts.push(meta);
  }
  drafts.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  return { ok: true, drafts: drafts };
}

function handleDeleteDraft(data) {
  var rentalId = String(data.rentalId || '').trim();
  if (!rentalId) return { ok: false, error: 'deleteDraft: missing rentalId' };
  // Lock: tombstone read-modify-write must not interleave with a concurrent
  // saveDraft (this also closes the old "deleteDraft takes no lock" gap).
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var removed = removeDraftFile(rentalId);
    addTombstone(rentalId, 'deleted');
    return { ok: true, rentalId: rentalId, removed: removed };
  } finally {
    lock.releaseLock();
  }
}

// Trash the draft file for a rentalId. Returns whether one was found.
// Used by deleteDraft and after a confirmed finalize.
function removeDraftFile(rentalId) {
  if (!rentalId) return false;
  var folder = getDraftsFolder();
  var file = findDraftFile(folder, rentalId);
  if (!file) return false;
  file.setTrashed(true);
  return true;
}

/* ---- PHASE 3: FAREHARBOR BOOKING LOOKUP (Gmail scan) ------------------------
   No FareHarbor API. FareHarbor emails Brady an operator notification for
   every booking event from messages@fareharbor.com; this reconstructs the
   pontoon bookings from those emails.

   Email anatomy (verified against Brady's real inbox 2026-07-09):
     New:       subject "New booking: <Item> on <Weekday>, <Month D, YYYY> at
                <h:mm am[ - h:mm pm]>" (online bookings say "New online
                booking:"). Body: "Booking #N" heading, then "Name:" and
                OPTIONAL "Phone:" / "Email:" lines — staff-entered bookings
                usually have no customer email.
     Rebooked:  subject "Rebooked: <Item> on <NEW date/time>". Rebooking
                issues a NEW booking id: the body header is "Booking #OLD
                Rebooked" and the main section describes the NEW booking
                ("Booking #NEW"). The OLD id is dead from that moment.
                The old date appears in the body's Old/New table, so a
                date-phrase Gmail search still surfaces rebook-AWAYS.
     Cancelled: subject "Booking #N Cancelled (<Item> on <date>)".
     Noise:     manifests, "starting in 1 day" reminders, support threads,
                login codes, customer-facing copies — all ignored by
                classification, never parsed into bookings.

   EARLY CHECK-IN (window + gate):
     - The scan covers TODAY and TOMORROW (script TZ). Each served booking
       carries its own date, so the form fills the booking's ACTUAL rental
       date — the legal date — never the handoff date.
     - Gate: if today has bookings of its own and NO finalized record dated
       today exists in the Pontoon Rentals folder, tomorrow's bookings are
       suppressed (earlySuppressed reports the count). Today's boat must be
       back and finalized before tomorrow's customer can auto-fill. Today
       having no bookings at all leaves tomorrow's free to serve.
     - Only the Gmail scan result is cached; the gate re-checks Drive on
       every request so a finalize takes effect immediately.

   Safety posture (this feature replaces a mock that once auto-filled FAKE
   booking numbers into real records — never again):
     - only emails from FAREHARBOR_SENDER are parsed;
     - only items matching FAREHARBOR_ITEM_FILTER are served (a fishing-trip
       booking # must never land on a pontoon check-in);
     - events merge latest-email-wins per booking id; cancelled and
       rebooked-away ids are dropped;
     - each surviving id gets a per-id verification search as a second chance
       to catch a cancel/rebook the date search missed;
     - booking ids must match /^\d{5,12}$/ or the record is dropped;
     - any search/parse failure returns ok:false — the form then says
       "couldn't verify", it never silently guesses.

   Everything below except handleGetTodaysBookings/hasFinalizedRecordForDate/
   setupCheck is a PURE function (no Apps Script services) so the whole
   parse/merge pipeline runs under plain JavaScriptCore in
   .devtest/test_phase3_backend.js. */

// Strip an HTML email body to line-oriented text the field regexes can read.
function fhStripHtml(html) {
  var s = String(html || '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
       .replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ');
  // Block-level closers and <br> become newlines; inline tags just vanish
  // (so "<b>Name:</b> Jo" stays on one line).
  s = s.replace(/<br\s*\/?\s*>/gi, '\n')
       .replace(/<\/(p|div|td|tr|table|h1|h2|h3|h4|li|thead|tbody)\s*>/gi, '\n')
       .replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&#0?39;/g, "'")
       .replace(/&quot;/gi, '"')
       .replace(/&ndash;/gi, '–')
       .replace(/&mdash;/gi, '—')
       .replace(/&raquo;/gi, '»')
       .replace(/&bull;/gi, '•')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>');
  var lines = s.split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (line) out.push(line);
  }
  return out.join('\n');
}

// "8:00 am" → "08:00"; "12:15 pm" → "12:15"; "12:00 am" → "00:00".
// Returns '' for anything it doesn't recognize.
function fhTo24h(t) {
  var m = /^(\d{1,2}):(\d{2})\s*([ap])m$/i.exec(String(t || '').trim());
  if (!m) return '';
  var h = Number(m[1]), min = m[2], pm = m[3].toLowerCase() === 'p';
  if (h < 1 || h > 12) return '';
  if (h === 12) h = 0;
  if (pm) h += 12;
  return (h < 10 ? '0' : '') + h + ':' + min;
}

var FH_MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

// "July 9, 2026" (or "<Weekday>, July 9, 2026") → {y, m, d, iso} or null.
function fhParseDatePhrase(phrase) {
  var m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(String(phrase || ''));
  if (!m) return null;
  var mon = FH_MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  var d = Number(m[2]), y = Number(m[3]);
  if (d < 1 || d > 31) return null;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return { y: y, m: mon, d: d, iso: y + '-' + pad(mon) + '-' + pad(d) };
}

// Subject tail shared by New/Rebooked subjects:
//   "<Item> on <Weekday>, <Month D, YYYY> at <h:mm am>[ - <h:mm pm>]"
// Greedy item match means an item name containing " on " still parses:
// backtracking anchors on the LAST " on <Weekday>, ...".
var FH_SUBJECT_TAIL =
  /^(.+) on [A-Za-z]+day, ([A-Za-z]+ \d{1,2}, \d{4}) at (\d{1,2}:\d{2} [ap]m)(?: - (\d{1,2}:\d{2} [ap]m))?$/;

// Classify + parse one email into an event, or null if it's noise/malformed.
// PURE: subject + html body + epoch ms in, event out.
//   {kind:'new',       atMs, booking:{...}}
//   {kind:'rebooked',  atMs, oldId, booking:{...the NEW booking...}}
//   {kind:'cancelled', atMs, bookingId}
function fhParseEmail(subject, htmlBody, atMs) {
  var subj = String(subject || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  atMs = Number(atMs || 0);

  var cancelled = /^Booking #(\d{5,12}) Cancelled\b/.exec(subj);
  if (cancelled) return { kind: 'cancelled', atMs: atMs, bookingId: cancelled[1] };

  var isNew = /^New (?:online )?booking: /.test(subj);
  var isRebook = /^Rebooked: /.test(subj);
  if (!isNew && !isRebook) return null;   // manifests, reminders, support, …

  var tail = FH_SUBJECT_TAIL.exec(subj.replace(/^New (?:online )?booking: |^Rebooked: /, ''));
  if (!tail) return null;                 // recognized prefix but unparseable
  var date = fhParseDatePhrase(tail[2]);
  var start = fhTo24h(tail[3]);
  if (!date || !start) return null;
  var end = tail[4] ? fhTo24h(tail[4]) : '';

  var text = fhStripHtml(htmlBody);
  var ids = [];
  var idRe = /Booking\s*#\s*(\d{5,12})/g, im;
  while ((im = idRe.exec(text))) ids.push(im[1]);
  if (!ids.length) return null;

  var field = function (label) {
    var fm = new RegExp('^' + label + ':\\s*(.+)$', 'm').exec(text);
    return fm ? fm[1].replace(/^\s+|\s+$/g, '') : '';
  };
  var email = field('Email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) email = '';

  var booking = {
    // Rebooked emails contain "Booking #OLD Rebooked" first and the NEW
    // "Booking #NEW" section last; new-booking emails have exactly one.
    bookingId: ids[ids.length - 1],
    name: field('Name').slice(0, 200),
    phone: field('Phone').slice(0, 40),
    email: email.slice(0, 200),
    item: tail[1].replace(/^\s+|\s+$/g, '').slice(0, 200),
    date: date.iso,
    start: start,
    end: end,
    multiDay: !end || /multi[\s–—-]*day/i.test(tail[1]),
    createdBy: field('Created by').slice(0, 200)
  };
  if (!booking.name) return null;         // a booking we can't name-match is useless

  if (isRebook) {
    var oldM = /Booking\s*#\s*(\d{5,12})\s+Rebooked/.exec(text);
    return { kind: 'rebooked', atMs: atMs, oldId: oldM ? oldM[1] : '', booking: booking };
  }
  return { kind: 'new', atMs: atMs, booking: booking };
}

// Merge events (any order) into the surviving bookings for the allowed dates
// (a "yyyy-mm-dd" string or an array of them — the early-check-in window
// passes [today, tomorrow]). Latest email wins per id; cancelled/superseded
// ids drop; only pontoon items on an allowed date survive. PURE.
function fhMergeEvents(events, allowedDates) {
  var allowed = {};
  var dateList = typeof allowedDates === 'string' ? [allowedDates] : (allowedDates || []);
  for (var a = 0; a < dateList.length; a++) allowed[dateList[a]] = true;

  var sorted = (events || []).slice().sort(function (a, b) { return (a.atMs || 0) - (b.atMs || 0); });
  var state = {};
  var touch = function (id) {
    if (!state[id]) state[id] = { booking: null, cancelled: false, superseded: false };
    return state[id];
  };
  for (var i = 0; i < sorted.length; i++) {
    var ev = sorted[i];
    if (!ev) continue;
    if (ev.kind === 'cancelled') {
      touch(ev.bookingId).cancelled = true;
    } else if (ev.kind === 'new') {
      var sn = touch(ev.booking.bookingId);
      sn.booking = ev.booking;
      // A duplicate/re-send of the confirmation does NOT resurrect a
      // cancelled id — cancellation is terminal for that id.
    } else if (ev.kind === 'rebooked') {
      // Observed format: a rebook issues a NEW id and kills the old one. If
      // FareHarbor ever re-uses the id (time-only change), don't let the
      // booking supersede itself.
      if (ev.oldId && ev.oldId !== ev.booking.bookingId) touch(ev.oldId).superseded = true;
      var sr = touch(ev.booking.bookingId);
      sr.booking = ev.booking;
    }
  }
  var out = [];
  for (var id in state) {
    var s = state[id];
    if (!s.booking || s.cancelled || s.superseded) continue;
    if (!allowed[s.booking.date]) continue;
    if (!CONFIG.FAREHARBOR_ITEM_FILTER.test(s.booking.item)) continue;
    if (!/^\d{5,12}$/.test(s.booking.bookingId)) continue;
    out.push(s.booking);
  }
  out.sort(function (a, b) {
    // Date first (today before tomorrow), then start time.
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
  });
  return out;
}

// The ADDRESS part of a From header. "Name <a@b>" → "a@b"; bare address
// passes through. A display name is attacker-chosen — Gmail's from: operator
// matches display names too, so '"messages@fareharbor.com" <evil@x>' would
// sail through both the search AND a substring check. Compare addresses only.
function fhSenderAddress(from) {
  var s = String(from || '');
  var m = /<([^<>]+)>\s*$/.exec(s);
  return (m ? m[1] : s).replace(/^\s+|\s+$/g, '').toLowerCase();
}

// Pull parse-able events out of Gmail threads. Non-FareHarbor senders and
// noise subjects contribute nothing; one malformed email never poisons the
// batch (it is skipped, not fatal).
function fhEventsFromThreads(threads) {
  var events = [];
  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages();
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m];
      if (fhSenderAddress(msg.getFrom()) !== CONFIG.FAREHARBOR_SENDER) continue;
      var ev = null;
      try { ev = fhParseEmail(msg.getSubject(), msg.getBody(), msg.getDate().getTime()); }
      catch (err) { ev = null; }
      if (ev) events.push(ev);
    }
  }
  return events;
}

// EARLY CHECK-IN GATE: is there a finalized record dated `dateIso` in the
// Pontoon Rentals folder? Finalized filenames are built server-side as
// Pontoon_{client}_{date}_{bookingID}[.._rN].json, so a filename containing
// "_<date>_" is a finalized rental for that date. Filename READ only — no
// content parsing, no writes. The retention sweep keeps this folder small
// (≤ ~6 months of records), so a full iterate is cheap.
function hasFinalizedRecordForDate(dateIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso || ''))) return false;
  var folder = getRentalsFolder();
  var re = new RegExp('_' + dateIso + '_');
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.isTrashed()) continue;
    if (!/\.json$/.test(f.getName())) continue;
    if (re.test(f.getName())) return true;
  }
  return false;
}

// { action:'getTodaysBookings' } → { ok:true, date:'yyyy-mm-dd',
//   tomorrowDate:'yyyy-mm-dd', earlySuppressed:N, bookings:[
//   { bookingId, name, phone, email, item, date, start, end, multiDay,
//     createdBy } ] }
// start/end are 24h "HH:MM" (ready for the form's <input type="time">).
// Window: today + tomorrow. Tomorrow's bookings are suppressed while today
// has a booking of its own with no finalized record yet (earlySuppressed
// reports how many were held back). STRICTLY READ-ONLY: no Drive writes, no
// mail — the gate is a filename read. Errors → { ok:false }.
function handleGetTodaysBookings(data) {
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var todayIso = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var todayPhrase = Utilities.formatDate(now, tz, 'MMMM d, yyyy');
  var tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  var tomorrowIso = Utilities.formatDate(tomorrow, tz, 'yyyy-MM-dd');
  var tomorrowPhrase = Utilities.formatDate(tomorrow, tz, 'MMMM d, yyyy');

  // Only the Gmail SCAN is cached. The finalize gate below runs fresh on
  // every request — otherwise a finalize wouldn't unlock tomorrow's customer
  // until the cache expired, which is exactly wrong at the dock.
  var cache = null, cacheKey = 'fh_bookings_v2_' + todayIso;
  try { cache = CacheService.getScriptCache(); } catch (errCache) { cache = null; }
  var scan = null;
  if (cache) {
    var hit = cache.get(cacheKey);
    if (hit) { try { scan = JSON.parse(hit); } catch (errHit) { scan = null; } }
  }

  if (!scan || !isArray(scan.all)) {
    try {
      // Pass 1: everything FareHarbor sent that mentions today's OR
      // tomorrow's date phrase ({} is Gmail's OR). New bookings and
      // cancellations carry it in the subject; a rebook AWAY carries it in
      // the body's Old/New table — Gmail full-text search matches bodies,
      // so all three surface here.
      var query = 'from:' + CONFIG.FAREHARBOR_SENDER
        + ' {"' + todayPhrase + '" "' + tomorrowPhrase + '"}';
      var threads = GmailApp.search(query, 0, CONFIG.LOOKUP_MAX_THREADS);
      var events = fhEventsFromThreads(threads);
      var bookings = fhMergeEvents(events, [todayIso, tomorrowIso]);

      // Pass 2: per-id verification — a targeted search per surviving id
      // catches any cancel/rebook the date search missed (odd formatting,
      // clipped body, future template drift). Merge re-runs with the extra
      // events so ordering stays time-based.
      var verified = bookings;
      if (bookings.length) {
        var extra = [];
        var limit = Math.min(bookings.length, CONFIG.LOOKUP_MAX_VERIFY_IDS);
        for (var i = 0; i < limit; i++) {
          var idThreads = GmailApp.search(
            'from:' + CONFIG.FAREHARBOR_SENDER + ' "' + bookings[i].bookingId + '"', 0, 10);
          extra = extra.concat(fhEventsFromThreads(idThreads));
        }
        verified = fhMergeEvents(events.concat(extra), [todayIso, tomorrowIso]);
        if (bookings.length > CONFIG.LOOKUP_MAX_VERIFY_IDS) {
          // Never serve more than we could verify.
          verified = verified.slice(0, CONFIG.LOOKUP_MAX_VERIFY_IDS);
        }
      }

      scan = { all: verified };
      if (cache) {
        try { cache.put(cacheKey, JSON.stringify(scan), CONFIG.LOOKUP_CACHE_SECONDS); }
        catch (errPut) {}
      }
    } catch (err) {
      // Honest failure: the form shows "couldn't verify — enter manually".
      return { ok: false, error: 'Booking lookup failed: ' + String(err && err.message || err) };
    }
  }

  // Split the window and apply the early-check-in gate (fresh every call).
  var todays = [], tomorrows = [];
  for (var j = 0; j < scan.all.length; j++) {
    var b = scan.all[j];
    if (b && b.date === todayIso) todays.push(b);
    else if (b && b.date === tomorrowIso) tomorrows.push(b);
  }
  var earlySuppressed = 0;
  if (tomorrows.length && todays.length) {
    var gateOpen = false;
    // A Drive hiccup fails CLOSED: better to make Brady enter tomorrow's
    // booking manually than to auto-fill it past an unfinalized rental.
    try { gateOpen = hasFinalizedRecordForDate(todayIso); } catch (errGate) { gateOpen = false; }
    if (!gateOpen) {
      earlySuppressed = tomorrows.length;
      tomorrows = [];
    }
  }

  return {
    ok: true,
    date: todayIso,
    tomorrowDate: tomorrowIso,
    earlySuppressed: earlySuppressed,
    bookings: todays.concat(tomorrows)
  };
}

// Array.isArray shim-style helper (Apps Script V8 has Array.isArray; this
// just keeps the call sites short and null-safe).
function isArray(v) {
  return Object.prototype.toString.call(v) === '[object Array]';
}

/* ---- DAY-1 COPY (scheduled check-out email) ---------------------------------
   The form asks for a day-1 copy the moment the customer's check-out
   signature lands; the send happens ~1 HOUR later so Brady has a generous
   cancel window. The timer is a one-shot Apps Script trigger (server-side —
   phones can lock and die, the send still fires, running as Brady so
   GmailApp works). State in Script Properties:
     DAY1_QUEUE {rentalId: dueAtMs} — pending sends
     DAY1_SENT  {rentalId: sentAtMs} — permanent once-per-rental guard
   At fire time the handler reads the CLOUD DRAFT as it exists then — the
   emailed text (draft.day1Summary) and recipient (draft.state.inputs.email)
   are whatever the last autosave synced, so in-hour fixes ride along. If the
   draft is gone (finalized/deleted) the send is skipped: the finalize email
   already covers it. Scheduling is IDEMPOTENT per rentalId — two phones both
   asking is harmless. One trigger serves the whole queue: it is recreated
   for the earliest remaining due time after every change/fire. */

var DAY1_QUEUE_PROP = 'DAY1_QUEUE';
var DAY1_SENT_PROP = 'DAY1_SENT';
var DAY1_DELAY_MS = 60 * 60 * 1000;   // 1 hour
var DAY1_HANDLER = 'sendDueDay1Copies';
var DAY1_EMAIL_SUBJECT = 'Your Baxstar Outdoors pontoon check-out record';

function day1LoadMap(prop) {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(prop) || '{}') || {};
  } catch (err) { return {}; }
}

function day1SaveMap(prop, map) {
  PropertiesService.getScriptProperties().setProperty(prop, JSON.stringify(map));
}

// Point the single day-1 trigger at the earliest pending send. Deletes any
// existing day-1 triggers first so they never stack.
function day1ResetTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === DAY1_HANDLER) ScriptApp.deleteTrigger(triggers[i]);
  }
  var queue = day1LoadMap(DAY1_QUEUE_PROP);
  var earliest = 0;
  for (var id in queue) {
    var due = Number(queue[id]) || 0;
    if (due && (!earliest || due < earliest)) earliest = due;
  }
  if (earliest) {
    var waitMs = Math.max(earliest - Date.now(), 15 * 1000);
    ScriptApp.newTrigger(DAY1_HANDLER).timeBased().after(waitMs).create();
  }
}

// Remove one rental from the pending queue (finalize/cancel path). Caller
// holds the script lock. Returns whether it was queued.
function day1Unqueue(rentalId) {
  if (!rentalId) return false;
  var queue = day1LoadMap(DAY1_QUEUE_PROP);
  if (queue[rentalId] === undefined) return false;
  delete queue[rentalId];
  day1SaveMap(DAY1_QUEUE_PROP, queue);
  day1ResetTrigger();
  return true;
}

// { action:'scheduleDay1Copy', rentalId } → { ok:true, dueAt } (idempotent:
// re-asking returns the existing dueAt; already-sent returns sent:true).
function handleScheduleDay1Copy(data) {
  var rentalId = String(data.rentalId || '').trim();
  if (!rentalId) return { ok: false, error: 'scheduleDay1Copy: missing rentalId' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sent = day1LoadMap(DAY1_SENT_PROP);
    if (sent[rentalId] !== undefined) {
      return { ok: true, rentalId: rentalId, sent: true, sentAt: Number(sent[rentalId]) };
    }
    var queue = day1LoadMap(DAY1_QUEUE_PROP);
    if (queue[rentalId] !== undefined) {
      return { ok: true, rentalId: rentalId, dueAt: Number(queue[rentalId]) };
    }
    var dueAt = Date.now() + DAY1_DELAY_MS;
    queue[rentalId] = dueAt;
    day1SaveMap(DAY1_QUEUE_PROP, queue);
    day1ResetTrigger();
    return { ok: true, rentalId: rentalId, dueAt: dueAt };
  } finally {
    lock.releaseLock();
  }
}

// { action:'cancelDay1Copy', rentalId } → { ok:true, cancelled } (cancelled
// is false when nothing was pending — already sent or never scheduled).
function handleCancelDay1Copy(data) {
  var rentalId = String(data.rentalId || '').trim();
  if (!rentalId) return { ok: false, error: 'cancelDay1Copy: missing rentalId' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var cancelled = day1Unqueue(rentalId);
    return { ok: true, rentalId: rentalId, cancelled: cancelled };
  } finally {
    lock.releaseLock();
  }
}

// Trigger handler: send every due day-1 copy, then re-arm for the earliest
// remaining one. Skips (and clears) rentals whose draft is gone — finalize
// or delete happened inside the hour and the finalize email supersedes.
function sendDueDay1Copies() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var queue = day1LoadMap(DAY1_QUEUE_PROP);
    var sent = day1LoadMap(DAY1_SENT_PROP);
    var now = Date.now();
    var changed = false;
    var folder = null;
    for (var rentalId in queue) {
      if (Number(queue[rentalId]) > now) continue;   // not due yet
      delete queue[rentalId];
      changed = true;
      if (sent[rentalId] !== undefined) continue;    // once per rental, ever
      if (!folder) folder = getDraftsFolder();
      var file = findDraftFile(folder, rentalId);
      if (!file) { Logger.log('day1: draft gone for ' + rentalId + ' — skipped (finalized/deleted)'); continue; }
      var draft = null;
      try { draft = JSON.parse(file.getBlob().getDataAsString()); } catch (errRead) { draft = null; }
      if (!draft) { Logger.log('day1: draft unreadable for ' + rentalId + ' — skipped'); continue; }
      var to = String(draft.state && draft.state.inputs && draft.state.inputs.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        Logger.log('day1: no valid email for ' + rentalId + ' — skipped');
        continue;
      }
      var summary = String(draft.day1Summary || '');
      if (!summary) { Logger.log('day1: no summary synced for ' + rentalId + ' — skipped'); continue; }
      try {
        GmailApp.sendEmail(to, DAY1_EMAIL_SUBJECT,
          'Hi ' + (String(draft.client || '').trim() || 'there') + ',\n\n'
          + 'Thanks for renting with Baxstar Outdoors. Below is the check-out '
          + 'record from your pontoon handoff, for your files. The complete '
          + 'record including check-in will follow when the rental closes.\n\n'
          + summary
          + '\n\nQuestions? Just reply to this email.\n\nBaxstar Outdoors\n');
        sent[rentalId] = Date.now();
        Logger.log('day1: sent for ' + rentalId + ' to ' + to);
      } catch (errSend) {
        // Send failed (quota, transient): put it back 10 minutes out rather
        // than losing it, and let the re-armed trigger retry.
        queue[rentalId] = Date.now() + 10 * 60 * 1000;
        Logger.log('day1: send FAILED for ' + rentalId + ': ' + String(errSend && errSend.message || errSend));
      }
    }
    if (changed) {
      day1SaveMap(DAY1_QUEUE_PROP, queue);
      day1SaveMap(DAY1_SENT_PROP, sent);
    }
    day1ResetTrigger();
  } finally {
    lock.releaseLock();
  }
}

/* ---- TOMBSTONES (v8) --------------------------------------------------------
   { rentalId: { t: epochMs, reason: 'finalized'|'deleted' } } map in Script
   Properties, stamped when a rental is finalized ('finalized') or its draft
   deleted ('deleted'). saveDraft refuses EVERY push against a tombstoned id —
   regardless of timestamps — unless the push carries resurrect:true, which
   the form sends only from deliberate human actions (Unlock, Restore).
   The reason rides back on the refusal so the form knows whether to lock the
   local copy (record filed elsewhere) or park it with a Restore offer.
   Legacy entries from the v7 numeric format ({ rentalId: epochMs }) are still
   readable; they carry no reason. Entries self-prune after 90 days.
   Callers that WRITE (add/clear) must hold the script lock; reads are safe. */

var TOMBSTONE_PROP = 'TOMBSTONES';
var TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function loadTombstones() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(TOMBSTONE_PROP) || '{}') || {};
  } catch (err) {
    return {};
  }
}

function saveTombstones(map) {
  PropertiesService.getScriptProperties().setProperty(TOMBSTONE_PROP, JSON.stringify(map));
}

// Normalize one raw map value to { t, reason } — accepts the v8 object shape
// and the legacy v7 bare-number shape. Returns null for absent/garbage.
function normalizeTombstone(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return { t: v, reason: '' };            // legacy v7
  if (typeof v === 'object' && isFinite(Number(v.t))) {
    return { t: Number(v.t), reason: String(v.reason || '') };
  }
  return null;
}

function addTombstone(rentalId, reason) {
  if (!rentalId) return;
  var map = loadTombstones();
  var cutoff = Date.now() - TOMBSTONE_TTL_MS;
  for (var id in map) {
    var e = normalizeTombstone(map[id]);
    if (!e || e.t < cutoff) delete map[id];
  }
  map[rentalId] = { t: Date.now(), reason: String(reason || '') };
  saveTombstones(map);
}

function clearTombstone(rentalId) {
  var map = loadTombstones();
  if (map[rentalId] !== undefined) {
    delete map[rentalId];
    saveTombstones(map);
  }
}

function tombstoneEntry(rentalId) {
  return normalizeTombstone(loadTombstones()[rentalId]);
}

function tombstoneTime(rentalId) {
  var e = tombstoneEntry(rentalId);
  return e ? e.t : 0;
}

/* ---- DRIVE / SHEET PLUMBING ------------------------------------------------ */

function getRentalsFolder() {
  var parent = DriveApp.getFolderById(CONFIG.DATA_ENGINE_FOLDER_ID);
  var existing = parent.getFoldersByName(CONFIG.RENTALS_FOLDER_NAME);
  return existing.hasNext() ? existing.next() : parent.createFolder(CONFIG.RENTALS_FOLDER_NAME);
}

function getLogSheet(folder) {
  var files = folder.getFilesByName(CONFIG.LOG_SHEET_NAME);
  var ss;
  if (files.hasNext()) {
    ss = SpreadsheetApp.open(files.next());
  } else {
    ss = SpreadsheetApp.create(CONFIG.LOG_SHEET_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
  }
  var sheet = ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(LOG_HEADERS);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < LOG_HEADERS.length) {
    // A pre-early-check-in sheet lacks the trailing "Early Possession"
    // header — extend the header row in place so new rows line up. New
    // columns are appended at the END only; existing columns never move.
    var startCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, startCol, 1, LOG_HEADERS.length - startCol + 1)
      .setValues([LOG_HEADERS.slice(startCol - 1)]);
  }
  return sheet;
}

// One at-a-glance row per filed rental. The Sheet is an index only —
// signatures and diagram marks live in the JSON file, never in cells.
// "Early Possession" holds the date the customer physically took the boat
// when it differs from the booking date; blank for normal rentals.
function appendLogRow(folder, p, file, email) {
  var sheet = getLogSheet(folder);
  sheet.appendRow([
    new Date(),
    String(p.client || ''),
    String(p.date || ''),
    String(p.pontoonUnit || ''),
    String(p.bookingId || '') || 'walk-up',
    String(p.checkOut && p.checkOut.time || ''),
    String(p.checkIn && p.checkIn.time || ''),
    conditionSummary(p),
    String(p.checkOut && p.checkOut.notes || ''),
    String(p.checkIn && p.checkIn.notes || ''),
    String(p.customerEmail || ''),
    email.status,
    file.getUrl(),
    p.earlyPossession ? ('taken ' + String(p.possessionDate || '(date not recorded)')) : '',
    String(p.reservationNotes || '')
  ]);
}

function conditionSummary(p) {
  var checked = function (list) {
    list = list || [];
    var n = 0;
    for (var i = 0; i < list.length; i++) if (list[i].checked) n++;
    return n + '/' + list.length;
  };
  var marks = function (list) { return (list || []).length; };
  return checked(p.checkOut && p.checkOut.safetyChecklist) + ' safety · '
    + checked(p.checkOut && p.checkOut.conditionChecklist) + ' out-condition · '
    + checked(p.checkIn && p.checkIn.conditionChecklist) + ' in-condition · '
    + marks(p.checkOut && p.checkOut.damageMarks) + ' existing marks · '
    + marks(p.checkIn && p.checkIn.damageMarks) + ' new marks';
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---- RETENTION SWEEP -------------------------------------------------------
   Brady keeps every finalized record 6 months, then it can go. To avoid a
   script ever silently destroying a signed liability document, this MOVES
   over-age records into "Pontoon Rentals Archive" instead of deleting them.
   Brady empties that folder on his own cadence. Run setupRetention() once to
   install the monthly trigger. */

function getArchiveFolder() {
  var parent = DriveApp.getFolderById(CONFIG.DATA_ENGINE_FOLDER_ID);
  var existing = parent.getFoldersByName(CONFIG.ARCHIVE_FOLDER_NAME);
  return existing.hasNext() ? existing.next() : parent.createFolder(CONFIG.ARCHIVE_FOLDER_NAME);
}

// A record's age is its finalizedAt (from the JSON), falling back to the
// file's created date if that's missing/unparseable.
function recordAgeCutoffMs() {
  var d = new Date();
  d.setMonth(d.getMonth() - CONFIG.RETENTION_MONTHS);
  return d.getTime();
}

function purgeOldRecords() {
  var cutoff = recordAgeCutoffMs();
  var rentals = getRentalsFolder();
  var archive = getArchiveFolder();
  var moved = 0, scanned = 0;
  var it = rentals.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (!/\.json$/.test(f.getName())) continue;   // leave the log Sheet alone
    scanned++;
    var ts = f.getDateCreated().getTime();
    try {
      var obj = JSON.parse(f.getBlob().getDataAsString());
      var fin = Date.parse(obj.finalizedAt);
      if (!isNaN(fin)) ts = fin;
    } catch (err) { /* use file date */ }
    if (ts < cutoff) { f.moveTo(archive); moved++; }
  }
  Logger.log('Retention sweep: scanned ' + scanned + ' records, archived ' + moved
    + ' older than ' + CONFIG.RETENTION_MONTHS + ' months into ' + archive.getName());
  return { scanned: scanned, moved: moved };
}

// Run ONCE from the editor. Installs a monthly trigger (and clears any prior
// copy of it so re-running doesn't stack duplicates).
function setupRetention() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'purgeOldRecords') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('purgeOldRecords').timeBased().onMonthDay(1).atHour(3).create();
  var archive = getArchiveFolder();
  Logger.log('Retention installed: purgeOldRecords runs monthly (1st, ~3am). '
    + 'Archive folder: ' + archive.getName() + ' (' + archive.getUrl() + ')');
}

/* ---- ONE-TIME SETUP / AUTH HELPER ------------------------------------------
   Run this once from the editor (step 3 of the deploy steps). It triggers
   the Drive/Sheets/Gmail permission prompts and pre-creates the folders and
   log Sheet so the first live request doesn't have to. */
function setupCheck() {
  var folder = getRentalsFolder();
  var sheet = getLogSheet(folder);
  var drafts = getDraftsFolder();
  Logger.log('Rentals folder ready: ' + folder.getName() + ' (' + folder.getUrl() + ')');
  Logger.log('Drafts folder ready: ' + drafts.getName() + ' (' + drafts.getUrl() + ')');
  Logger.log('Log sheet ready: ' + sheet.getParent().getUrl());
  Logger.log('Gmail quota remaining today: ' + MailApp.getRemainingDailyQuota());
  // Phase 3 + early check-in: exercise the Gmail READ scope + show what the
  // today+tomorrow scan finds (and whether the finalize gate suppressed
  // anything).
  var lookup = handleGetTodaysBookings({});
  Logger.log('FareHarbor lookup (today+tomorrow): ' + JSON.stringify(lookup));
}
