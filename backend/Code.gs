/**
 * =============================================================================
 * BAXSTAR PONTOON — FILING BACKEND
 * Google Apps Script web app. Receives POSTs from baxstar_pontoon_form.html.
 *
 *   Phase 1 (LIVE): finalize a completed rental — file the JSON record to
 *     Drive, append one row to a Google Sheet, email the customer their copy.
 *   Phase 2 (this update): cloud draft sync for cross-device handoff —
 *     saveDraft / getActive / deleteDraft keep in-progress rentals in a Drive
 *     "Pontoon Drafts" folder so any device can list and resume an open rental.
 *     Plus a 6-month retention sweep that ARCHIVES (never silently deletes)
 *     old finalized records.
 *
 * DEPLOY STEPS (Brady)
 * 1. Go to https://script.google.com → open the existing "Baxstar Pontoon
 *    Filing" project (or New project if starting fresh).
 * 2. Replace Code.gs with this entire file. Save.
 * 3. Run "setupCheck" once from the toolbar (▶) and authorize Drive/Sheets/
 *    Gmail when asked. It creates the Pontoon Rentals folder + log Sheet AND
 *    the Pontoon Drafts folder if they don't exist yet.
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
  RETENTION_MONTHS: 6
};

var LOG_HEADERS = [
  'Filed At', 'Client', 'Date', 'Unit', 'Booking #', 'Check-Out Time',
  'Check-In Time', 'Condition Summary', 'Check-Out Notes', 'Check-In Notes',
  'Customer Email', 'Emailed', 'Record File'
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
      default:
        return jsonOut({ ok: false, error: 'Unknown action: ' + String(data.action) });
    }
  } catch (err) {
    return jsonOut({ ok: false, error: 'Backend error: ' + String(err && err.message || err) });
  }
}

// Sanity check in a browser: the /exec URL should show this JSON.
function doGet() {
  return jsonOut({
    ok: true,
    service: 'baxstar-pontoon-filing',
    actions: ['finalize', 'saveDraft', 'getActive', 'deleteDraft']
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
    // for it so it stops showing as "open" on other devices. Best-effort:
    // a draft-cleanup hiccup must never fail an otherwise-good filing.
    var draftRemoved = false;
    try { draftRemoved = removeDraftFile(String(p.rentalId || '')); } catch (err2) {}
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
  try {
    GmailApp.sendEmail(to, CONFIG.EMAIL_SUBJECT,
      'Hi ' + (String(p.client || '').trim() || 'there') + ',\n\n'
      + 'Thanks for renting with Baxstar Outdoors. Your rental record is below '
      + 'for your files.\n\n'
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
    state: data.state
  };
  var meta = {
    client: record.client, date: record.date, pontoon: record.pontoon,
    updatedAt: record.updatedAt, hasCheckIn: record.hasCheckIn, finalized: record.finalized
  };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
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
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (!/^Draft_.*\.json$/.test(f.getName())) continue;
    // Trashed drafts still appear in folder iterators — without this guard a
    // DELETED draft keeps showing on every device until Trash purges (~30d),
    // which reproduces the "delete didn't take" live symptom by itself.
    if (f.isTrashed()) continue;
    drafts.push(draftMeta(f));
  }
  drafts.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  return { ok: true, drafts: drafts };
}

function handleDeleteDraft(data) {
  var rentalId = String(data.rentalId || '').trim();
  if (!rentalId) return { ok: false, error: 'deleteDraft: missing rentalId' };
  var removed = removeDraftFile(rentalId);
  return { ok: true, rentalId: rentalId, removed: removed };
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
  }
  return sheet;
}

// One at-a-glance row per filed rental. The Sheet is an index only —
// signatures and diagram marks live in the JSON file, never in cells.
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
    file.getUrl()
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
}
