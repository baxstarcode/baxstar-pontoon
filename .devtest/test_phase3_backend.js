/* =============================================================================
 * PHASE 3 BACKEND SUITE — FareHarbor Gmail-scan parse/merge/handler tests.
 *
 * Runs WITHOUT Chrome or Apps Script, under macOS JavaScriptCore:
 *     sh .devtest/run_phase3_backend_tests.sh
 * (the runner concatenates ../backend/Code.gs + this file and runs `jsc`,
 * so every fh* function and handleGetTodaysBookings are the REAL ones).
 *
 * Fixtures are structurally faithful replicas of Brady's real FareHarbor
 * operator emails (verified 2026-07-09) with FICTIONAL customer data —
 * this repo is public, so no real names/emails/phones/booking #s.
 * ========================================================================== */

/* ---- tiny harness ---- */
var _pass = 0, _fail = 0;
function t(name, cond, detail) {
  if (cond) { _pass++; print('PASS  ' + name); }
  else { _fail++; print('FAIL  ' + name + (detail !== undefined ? '  [' + JSON.stringify(detail) + ']' : '')); }
}

/* ---- fixture builders (shape mirrors the real emails) ---- */
function bookingHtml(o) {
  // o: {id, name, phone, email, item, dateLine, createdBy, blurb}
  return '<!DOCTYPE html><html><head><style>body{margin:0} .x{color:#fff}</style></head><body>' +
    '<table><tr><td><h2 style="color:#1D875A">New Booking for \r\n ' + o.item + '\r\n</h2></td></tr>' +
    '<tr><td><p><b>Created by:</b>\r\n ' + (o.createdBy || 'Online customer') + '\r\n <br />' +
    '<b>Created at:</b> 7/1/2026 at 9:00 am</p></td></tr></table>' +
    '<h3>Booking #' + o.id + '</h3>' +
    '<div>' + o.item + '</div>' +
    '<table><tr><td>' + o.dateLine + '</td></tr></table>' +
    (o.blurb ? '<div>' + o.blurb + '</div>' : '') +
    '<div><b>Name:</b> ' + o.name + '</div>' +
    (o.phone ? '<div><b>Phone:</b> ' + o.phone + '</div>' : '') +
    (o.email ? '<div><b>Email:</b> ' + o.email + '</div>' : '') +
    '<h2>Payments</h2><div><b>Booking total</b> $500.00</div>' +
    '<p><b>You received this email because you&#039;re subscribed.</b></p>' +
    '</body></html>';
}
function rebookHtml(o) {
  // o: {oldId, newId, name, item, oldDate, newDateLine, email}
  return '<!DOCTYPE html><html><head><style>.y{}</style></head><body>' +
    '<h2>Booking #' + o.oldId + ' Rebooked</h2>' +
    '<p><b>Rebooked by:</b> Brady Baxter (Baxstar Fishing Guide Service)<br />' +
    '<b>Rebooked at:</b> 7/8/2026 at 3:06 pm</p>' +
    '<table><thead><tr><th></th><th>Old</th><th>New</th></tr></thead><tbody>' +
    '<tr><td><b>ID</b></td><td><a href="#">#' + o.oldId + '</a></td><td><a href="#">#' + o.newId + '</a></td></tr>' +
    '<tr><td><b>Item</b></td><td>' + o.item + '</td><td>' + o.item + '</td></tr>' +
    '<tr><td><b>Date</b></td><td>' + o.oldDate + '</td><td></td></tr>' +
    '</tbody></table>' +
    '<h3>Booking #' + o.newId + '</h3>' +
    '<div>' + o.item + '</div>' +
    '<table><tr><td>' + o.newDateLine + '</td></tr></table>' +
    '<div><b>Name:</b> ' + o.name + '</div>' +
    (o.email ? '<div><b>Email:</b> ' + o.email + '</div>' : '') +
    '</body></html>';
}

var PONTOON_SD = 'Pontoon Rental – Single Day';
var PONTOON_MD = 'Pontoon Rental with 115 hp– Multi-Day (Delivered to your lake)';
var FISHING = 'Detroit Lakes Area Fishing Guide Trip';
var TODAY_PHRASE = 'July 9, 2026';         // what the fake Utilities serves
var TODAY_ISO = '2026-07-09';

/* =============================================================
 * 1. fhTo24h
 * ============================================================= */
t('to24h 8:00 am → 08:00', fhTo24h('8:00 am') === '08:00');
t('to24h 1:00 pm → 13:00', fhTo24h('1:00 pm') === '13:00');
t('to24h 12:15 pm → 12:15', fhTo24h('12:15 pm') === '12:15');
t('to24h 12:00 am → 00:00', fhTo24h('12:00 am') === '00:00');
t('to24h garbage → ""', fhTo24h('25:99 xm') === '' && fhTo24h('') === '' && fhTo24h('noonish') === '');

/* =============================================================
 * 2. fhParseEmail — well-formed ONLINE pontoon booking
 * ============================================================= */
var evOnline = fhParseEmail(
  'New online booking: ' + PONTOON_SD + ' on Thursday, July 9, 2026 at 1:00 pm - 9:00 pm',
  bookingHtml({ id: '900000001', name: "D'Angelo Testman", phone: '(555) 010-0001',
    email: 'dangelo.testman@example.com', item: PONTOON_SD,
    dateLine: 'Thursday, July 9, 2026 at 1:00 pm - 9:00 pm', blurb: 'Single Day Pontoon Rental' }),
  1000);
t('online booking parses', !!evOnline && evOnline.kind === 'new');
t('  … bookingId', evOnline && evOnline.booking.bookingId === '900000001', evOnline);
t("  … name (apostrophe entity decoded)", evOnline && evOnline.booking.name === "D'Angelo Testman", evOnline && evOnline.booking.name);
t('  … phone', evOnline && evOnline.booking.phone === '(555) 010-0001');
t('  … email', evOnline && evOnline.booking.email === 'dangelo.testman@example.com');
t('  … item', evOnline && evOnline.booking.item === PONTOON_SD);
t('  … date iso', evOnline && evOnline.booking.date === '2026-07-09');
t('  … start 24h', evOnline && evOnline.booking.start === '13:00');
t('  … end 24h', evOnline && evOnline.booking.end === '21:00');
t('  … multiDay false', evOnline && evOnline.booking.multiDay === false);
t('  … createdBy', evOnline && evOnline.booking.createdBy === 'Online customer');

/* =============================================================
 * 3. STAFF booking — customer email/phone ABSENT (Brady's manual entry case)
 * ============================================================= */
var evStaff = fhParseEmail(
  'New booking: ' + PONTOON_MD + ' on Thursday, July 9, 2026 at 10:00 am',
  bookingHtml({ id: '900000002', name: 'Testy McBookface', item: PONTOON_MD,
    dateLine: 'Thursday, July 9, 2026 at 10:00 am',
    createdBy: 'Brady Baxter (Baxstar Fishing Guide Service)' }),
  2000);
t('staff booking parses', !!evStaff && evStaff.kind === 'new');
t('  … email empty (conditional field)', evStaff && evStaff.booking.email === '');
t('  … phone empty', evStaff && evStaff.booking.phone === '');
t('  … multiDay true (no end time)', evStaff && evStaff.booking.multiDay === true);
t('  … end empty', evStaff && evStaff.booking.end === '');

/* =============================================================
 * 4. Malformed / noise emails → null, never a throw
 * ============================================================= */
t('noise: manifest', fhParseEmail('Manifest for 7/9/2026', '<html><body>hi</body></html>', 1) === null);
t('noise: reminder', fhParseEmail('Manifest for ' + PONTOON_MD + ' starting in 1 day', '<html></html>', 1) === null);
t('noise: support thread', fhParseEmail('[FareHarbor] Re: Hi — two requests', '<html></html>', 1) === null);
t('noise: login code', fhParseEmail('FareHarbor verification code for login', '<html></html>', 1) === null);
t('noise: customer-facing cancel', fhParseEmail('Your booking has been cancelled', '<html></html>', 1) === null);
t('malformed: booking subject, gutted body (no Booking #)',
  fhParseEmail('New booking: ' + PONTOON_SD + ' on Thursday, July 9, 2026 at 1:00 pm',
    '<html><body>Totally unexpected redesign</body></html>', 1) === null);
t('malformed: body missing Name line',
  fhParseEmail('New booking: ' + PONTOON_SD + ' on Thursday, July 9, 2026 at 1:00 pm',
    '<html><body><h3>Booking #900000003</h3></body></html>', 1) === null);
t('malformed: unparseable subject date',
  fhParseEmail('New booking: ' + PONTOON_SD + ' on someday soonish',
    bookingHtml({ id: '900000004', name: 'X Y', item: PONTOON_SD, dateLine: 'x' }), 1) === null);
t('malformed: invalid email in body → dropped, booking kept',
  (function () {
    var ev = fhParseEmail('New booking: ' + PONTOON_SD + ' on Thursday, July 9, 2026 at 1:00 pm',
      bookingHtml({ id: '900000005', name: 'Val I. Dation', email: 'not-an-email', item: PONTOON_SD,
        dateLine: 'Thursday, July 9, 2026 at 1:00 pm' }), 1);
    return !!ev && ev.booking.email === '' && ev.booking.bookingId === '900000005';
  })());

/* =============================================================
 * 5. Cancelled + Rebooked parsing
 * ============================================================= */
var evCan = fhParseEmail('Booking #900000001 Cancelled (' + PONTOON_SD + ' on Thursday, July 9, 2026 at 1:00 pm - 9:00 pm)', '<html></html>', 3000);
t('cancelled parses from subject', !!evCan && evCan.kind === 'cancelled' && evCan.bookingId === '900000001', evCan);

var evReb = fhParseEmail(
  'Rebooked: ' + PONTOON_SD + ' on Thursday, July 9, 2026 at 4:00 pm - 9:00 pm',
  rebookHtml({ oldId: '900000010', newId: '900000011', name: 'Rhea Booker',
    item: PONTOON_SD, oldDate: 'Friday, July 10, 2026',
    newDateLine: 'Thursday, July 9, 2026 at 4:00 pm - 9:00 pm' }),
  4000);
t('rebooked parses', !!evReb && evReb.kind === 'rebooked');
t('  … oldId', evReb && evReb.oldId === '900000010', evReb);
t('  … NEW id served (last Booking # wins)', evReb && evReb.booking.bookingId === '900000011', evReb && evReb.booking.bookingId);
t('  … new start', evReb && evReb.booking.start === '16:00');

/* =============================================================
 * 6. Item containing " on " still parses (greedy anchor on last " on <Weekday>")
 * ============================================================= */
var evOn = fhParseEmail(
  'New booking: Pontoon Party on the Bay on Thursday, July 9, 2026 at 2:00 pm - 6:00 pm',
  bookingHtml({ id: '900000012', name: 'Onna Boat', item: 'Pontoon Party on the Bay',
    dateLine: 'Thursday, July 9, 2026 at 2:00 pm - 6:00 pm' }), 1);
t('item containing " on " parses', !!evOn && evOn.booking.item === 'Pontoon Party on the Bay', evOn && evOn.booking.item);

/* =============================================================
 * 7. fhMergeEvents
 * ============================================================= */
function mkBooking(id, over) {
  var b = { bookingId: id, name: 'N ' + id, phone: '', email: '', item: PONTOON_SD,
    date: TODAY_ISO, start: '13:00', end: '21:00', multiDay: false, createdBy: 'Online customer' };
  for (var k in (over || {})) b[k] = over[k];
  return b;
}
t('merge: duplicate confirmations → one record',
  fhMergeEvents([
    { kind: 'new', atMs: 1, booking: mkBooking('900000020') },
    { kind: 'new', atMs: 2, booking: mkBooking('900000020') }
  ], TODAY_ISO).length === 1);
t('merge: latest duplicate wins',
  fhMergeEvents([
    { kind: 'new', atMs: 5, booking: mkBooking('900000021', { name: 'Newer Name' }) },
    { kind: 'new', atMs: 1, booking: mkBooking('900000021', { name: 'Older Name' }) }
  ], TODAY_ISO)[0].name === 'Newer Name');
t('merge: cancelled booking dropped',
  fhMergeEvents([
    { kind: 'new', atMs: 1, booking: mkBooking('900000022') },
    { kind: 'cancelled', atMs: 2, bookingId: '900000022' }
  ], TODAY_ISO).length === 0);
t('merge: cancellation is terminal (later re-send does not resurrect)',
  fhMergeEvents([
    { kind: 'new', atMs: 1, booking: mkBooking('900000023') },
    { kind: 'cancelled', atMs: 2, bookingId: '900000023' },
    { kind: 'new', atMs: 3, booking: mkBooking('900000023') }
  ], TODAY_ISO).length === 0);
t('merge: rebook-AWAY drops old id today, new id not served today',
  fhMergeEvents([
    { kind: 'new', atMs: 1, booking: mkBooking('900000024') },
    { kind: 'rebooked', atMs: 2, oldId: '900000024', booking: mkBooking('900000025', { date: '2026-07-12' }) }
  ], TODAY_ISO).length === 0);
t('merge: rebook-TO-today serves NEW id only',
  (function () {
    var out = fhMergeEvents([
      { kind: 'new', atMs: 1, booking: mkBooking('900000026', { date: '2026-07-12' }) },
      { kind: 'rebooked', atMs: 2, oldId: '900000026', booking: mkBooking('900000027') }
    ], TODAY_ISO);
    return out.length === 1 && out[0].bookingId === '900000027';
  })());
t('merge: same-id rebook does not supersede itself',
  fhMergeEvents([
    { kind: 'rebooked', atMs: 2, oldId: '900000028', booking: mkBooking('900000028') }
  ], TODAY_ISO).length === 1);
t('merge: fishing-trip item filtered out',
  fhMergeEvents([{ kind: 'new', atMs: 1, booking: mkBooking('900000029', { item: FISHING }) }], TODAY_ISO).length === 0);
t('merge: other-day booking filtered out',
  fhMergeEvents([{ kind: 'new', atMs: 1, booking: mkBooking('900000030', { date: '2026-07-10' }) }], TODAY_ISO).length === 0);
t('merge: malformed id filtered out',
  fhMergeEvents([{ kind: 'new', atMs: 1, booking: mkBooking('12<script>') }], TODAY_ISO).length === 0);
t('merge: zero events → empty list', fhMergeEvents([], TODAY_ISO).length === 0);
t('merge: sorted by start time',
  (function () {
    var out = fhMergeEvents([
      { kind: 'new', atMs: 1, booking: mkBooking('900000031', { start: '15:00' }) },
      { kind: 'new', atMs: 2, booking: mkBooking('900000032', { start: '09:00' }) }
    ], TODAY_ISO);
    return out.length === 2 && out[0].bookingId === '900000032';
  })());

/* =============================================================
 * 8. handleGetTodaysBookings against a FAKE GmailApp inbox
 * ============================================================= */
var Session = { getScriptTimeZone: function () { return 'America/Chicago'; } };
var Utilities = {
  formatDate: function (d, tz, fmt) {
    if (fmt === 'yyyy-MM-dd') return TODAY_ISO;
    if (fmt === 'MMMM d, yyyy') return TODAY_PHRASE;
    throw new Error('unexpected format: ' + fmt);
  }
};
function fakeMsg(from, subject, body, ms) {
  return {
    getFrom: function () { return from; },
    getSubject: function () { return subject; },
    getBody: function () { return body; },
    getDate: function () { return new Date(ms); }
  };
}
function fakeThread(msgs) { return { getMessages: function () { return msgs; } }; }

// Inbox scenario:
//  - pontoon booking A (online, today) — should be served
//  - pontoon booking B (staff, today, no email) — cancelled ONLY in the
//    per-id search results (not in the date search) — must be dropped by pass 2
//  - fishing booking (today) — filtered
//  - manifest noise + spoofed sender — ignored
var A = bookingHtml({ id: '910000001', name: 'Ada Renter', phone: '(555) 010-0002',
  email: 'ada.renter@example.com', item: PONTOON_SD,
  dateLine: 'Thursday, July 9, 2026 at 1:00 pm - 9:00 pm' });
var B = bookingHtml({ id: '910000002', name: 'Bob Boater', item: PONTOON_SD,
  dateLine: 'Thursday, July 9, 2026 at 9:00 am - 5:00 pm',
  createdBy: 'Brady Baxter (Baxstar Fishing Guide Service)' });
var F = bookingHtml({ id: '910000003', name: 'Finn Fisher', item: FISHING,
  dateLine: 'Thursday, July 9, 2026 at 8:00 am' });

var FH = 'Baxstar via FareHarbor <messages@fareharbor.com>';
var subjA = 'New online booking: ' + PONTOON_SD + ' on Thursday, July 9, 2026 at 1:00 pm - 9:00 pm';
var subjB = 'New booking: ' + PONTOON_SD + ' on Thursday, July 9, 2026 at 9:00 am - 5:00 pm';
var subjF = 'New online booking: ' + FISHING + ' on Thursday, July 9, 2026 at 8:00 am';
var subjBCancel = 'Booking #910000002 Cancelled (' + PONTOON_SD + ' on Thursday, July 9, 2026 at 9:00 am - 5:00 pm)';

var searchLog = [];
var GmailApp = {
  search: function (query, start, max) {
    searchLog.push(query);
    if (query.indexOf('"' + TODAY_PHRASE + '"') !== -1) {
      return [
        fakeThread([fakeMsg(FH, subjA, A, 1000)]),
        fakeThread([fakeMsg(FH, subjB, B, 2000)]),
        fakeThread([fakeMsg(FH, subjF, F, 3000)]),
        fakeThread([fakeMsg(FH, 'Manifest for 7/9/2026', '<html><body>manifest</body></html>', 4000)]),
        // spoofed sender with a perfect-looking booking — must be ignored
        fakeThread([fakeMsg('Mallory <mallory@evil.example>', subjA,
          bookingHtml({ id: '999999999', name: 'Ada Renter', item: PONTOON_SD,
            dateLine: 'Thursday, July 9, 2026 at 1:00 pm - 9:00 pm' }), 5000)]),
        // DISPLAY-NAME spoof: Gmail's from: search matches display names, and
        // a substring sender check would too. Address-only comparison must
        // reject this.
        fakeThread([fakeMsg('"messages@fareharbor.com" <mallory@evil.example>',
          'New online booking: ' + PONTOON_SD + ' on Thursday, July 9, 2026 at 3:00 pm - 8:00 pm',
          bookingHtml({ id: '999999998', name: 'Eve L. Genius', item: PONTOON_SD,
            dateLine: 'Thursday, July 9, 2026 at 3:00 pm - 8:00 pm' }), 5500)])
      ];
    }
    if (query.indexOf('"910000002"') !== -1) {
      // per-id verification surfaces the cancellation the date search missed
      return [fakeThread([fakeMsg(FH, subjB, B, 2000), fakeMsg(FH, subjBCancel, '<html></html>', 6000)])];
    }
    if (query.indexOf('"910000001"') !== -1) {
      return [fakeThread([fakeMsg(FH, subjA, A, 1000)])];
    }
    return [];
  }
};

var res = handleGetTodaysBookings({});
t('handler: ok', res && res.ok === true, res);
t('handler: date is today', res && res.date === TODAY_ISO);
t('handler: exactly one booking survives', res && res.ok && res.bookings.length === 1, res && res.bookings);
t('handler: survivor is A with full fields',
  res && res.ok && res.bookings.length === 1 && (function (b) {
    return b.bookingId === '910000001' && b.name === 'Ada Renter'
      && b.email === 'ada.renter@example.com' && b.start === '13:00' && b.end === '21:00';
  })(res.bookings[0]), res && res.bookings[0]);
t('handler: per-id verification searches ran', (function () {
  var perId = 0;
  for (var i = 0; i < searchLog.length; i++) if (/"91000000\d"/.test(searchLog[i])) perId++;
  return perId >= 2;
})(), searchLog);
t('handler: spoofed sender contributed nothing',
  res && res.ok && (function () {
    for (var i = 0; i < res.bookings.length; i++) if (res.bookings[i].bookingId === '999999999') return false;
    return true;
  })());
t('handler: display-name spoof contributed nothing',
  res && res.ok && (function () {
    for (var i = 0; i < res.bookings.length; i++) if (res.bookings[i].bookingId === '999999998') return false;
    return true;
  })());
t('sender address extraction: bare, bracketed, display-name-spoofed',
  fhSenderAddress('messages@fareharbor.com') === 'messages@fareharbor.com'
  && fhSenderAddress('Baxstar via FareHarbor <MESSAGES@FareHarbor.com>') === 'messages@fareharbor.com'
  && fhSenderAddress('"messages@fareharbor.com" <mallory@evil.example>') === 'mallory@evil.example');

/* zero-bookings-today */
GmailApp = { search: function () { return []; } };
var resEmpty = handleGetTodaysBookings({});
t('handler: zero today → ok:true, empty list', resEmpty && resEmpty.ok === true && resEmpty.bookings.length === 0, resEmpty);

/* Gmail failure → honest ok:false */
GmailApp = { search: function () { throw new Error('Gmail quota'); } };
var resErr = handleGetTodaysBookings({});
t('handler: Gmail failure → ok:false with error', resErr && resErr.ok === false && /Gmail quota/.test(resErr.error), resErr);

/* =============================================================
 * summary
 * ============================================================= */
print('RESULT: ' + _pass + ' passed, ' + _fail + ' failed');
