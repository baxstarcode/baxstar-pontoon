/**
 * =============================================================================
 * BAXSTAR PONTOON — FILING BACKEND (Phase 1)
 * Google Apps Script web app. Receives the finalize POST from
 * baxstar_pontoon_form.html, files the complete rental record as a JSON
 * file in Drive, writes one log row to a Google Sheet, and emails the
 * customer their copy when an email address is on the record.
 *
 * DEPLOY STEPS (Brady)
 * 1. Go to https://script.google.com → New project → name it
 *    "Baxstar Pontoon Filing".
 * 2. Delete the starter code and paste this entire file into Code.gs. Save.
 * 3. Run the function "setupCheck" once from the toolbar (▶). Google will
 *    ask you to authorize Drive, Sheets, and Gmail access — allow it.
 *    The run log should report the folder and Sheet are ready (it creates
 *    the "Pontoon Rentals" folder and "Pontoon_Rentals_Log" Sheet inside
 *    Baxstar Data Engine if they don't exist yet).
 * 4. Deploy → New deployment → type "Web app":
 *      - Execute as:        Me (brady@baxstarfishing.com)
 *      - Who has access:    Anyone
 *    Click Deploy and copy the Web app URL (ends in /exec).
 * 5. In baxstar_pontoon_form.html, paste that URL into FILING_URL.
 *    FILING_TOKEN in the form must match TOKEN below (it already does
 *    unless you change one of them). Commit and push.
 * 6. Live test: finalize a test rental with all four signatures →
 *    confirm the JSON file in Drive, the row in the Sheet, and the email
 *    (if you entered a customer email).
 *
 * NOTE — after any code change here, use Deploy → Manage deployments →
 * edit (pencil) → "New version" on the EXISTING deployment, so the /exec
 * URL stays the same and the form keeps working.
 *
 * SECURITY — honest limits: the form lives in a public GitHub repo, so the
 * /exec URL and TOKEN are both publicly readable. The token stops casual
 * abuse and stray POSTs, not a determined attacker. Worst case, someone
 * can file junk records into the folder/Sheet; they cannot read records,
 * which live only in Brady's Drive.
 *
 * Phase 2 (multi-device draft sync) will add actions to the router in
 * doPost — e.g. 'saveDraft' / 'getActive'. Not built in this phase.
 * =============================================================================
 */

var CONFIG = {
  // Must match FILING_TOKEN in baxstar_pontoon_form.html
  TOKEN: '122e17decac6b1e5fd414886f5ca95b7',
  // "Baxstar Data Engine" folder — parent of everything this app creates
  DATA_ENGINE_FOLDER_ID: '1WghhwpLQfFfODtmnkTx__hTOaF3YDchW',
  RENTALS_FOLDER_NAME: 'Pontoon Rentals',
  LOG_SHEET_NAME: 'Pontoon_Rentals_Log',
  EMAIL_SUBJECT: 'Your Baxstar Outdoors pontoon rental record'
};

var LOG_HEADERS = [
  'Filed At', 'Client', 'Date', 'Unit', 'Booking #', 'Check-Out Time',
  'Check-In Time', 'Condition Summary', 'Check-Out Notes', 'Check-In Notes',
  'Customer Email', 'Emailed', 'Record File'
];

/* ---- ENTRY POINTS --------------------------------------------------------- */

// The form POSTs as Content-Type text/plain (a CORS "simple request" —
// Apps Script cannot answer a preflight) with one JSON object as the body:
// the finalize payload plus { action: 'finalize', token: '...' }.
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
      // Phase 2 will add: case 'saveDraft': ...  case 'getActive': ...
      default:
        return jsonOut({ ok: false, error: 'Unknown action: ' + String(data.action) });
    }
  } catch (err) {
    return jsonOut({ ok: false, error: 'Backend error: ' + String(err && err.message || err) });
  }
}

// Sanity check in a browser: the /exec URL should show this JSON.
function doGet() {
  return jsonOut({ ok: true, service: 'baxstar-pontoon-filing', actions: ['finalize'] });
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
    appendLogRow(folder, p, file, email);
    return {
      ok: true,
      rentalId: String(p.rentalId || ''),
      fileUrl: file.getUrl(),
      emailed: email.sent
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
  // Never overwrite: a re-file after unlock gets a numbered name.
  var finalName = name;
  for (var n = 2; folder.getFilesByName(finalName).hasNext(); n++) {
    finalName = name.replace(/\.json$/, '_r' + n + '.json');
  }
  return folder.createFile(finalName, JSON.stringify(p, null, 2), 'application/json');
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

/* ---- ONE-TIME SETUP / AUTH HELPER ------------------------------------------
   Run this once from the editor (step 3 of the deploy steps). It triggers
   the Drive/Sheets/Gmail permission prompts and pre-creates the folder
   and log Sheet so the first live finalize doesn't have to. */
function setupCheck() {
  var folder = getRentalsFolder();
  var sheet = getLogSheet(folder);
  Logger.log('Folder ready: ' + folder.getName() + ' (' + folder.getUrl() + ')');
  Logger.log('Log sheet ready: ' + sheet.getParent().getUrl());
  Logger.log('Gmail quota remaining today: ' + MailApp.getRemainingDailyQuota());
}
