"""Mock of the Apps Script filing backend for cross-origin form testing.

Mimics the CORS behavior of a GAS web app: answers POST with
Access-Control-Allow-Origin: * but does NOT answer preflight (OPTIONS gets
405 with no CORS headers) — so a form that triggers a preflight fails here
exactly like it would against the real backend.

Phase 1 action: finalize (validates token + 4 signatures, "files" the record).
Phase 2 actions: saveDraft / getActive / deleteDraft — an in-memory mirror of
the Drive "Pontoon Drafts" folder, so the cross-device draft handoff can be
driven end-to-end locally. Drafts persist for the life of the process.
Phase 3 action: getTodaysBookings — serves whatever a test staged via
POST /__set_bookings {"bookings": [...]} (or {"fail": true} to simulate a
Gmail-scan failure). Defaults to an empty list, like a day with no bookings.

Logs every request to mock_log.jsonl. Also accepts POST /report/<name>
from test pages, saved to report_<name>.txt.
"""
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKEN = '122e17decac6b1e5fd414886f5ca95b7'
LOG = open('mock_log.jsonl', 'a')

# In-memory stand-in for the Drive "Pontoon Drafts" folder, keyed by rentalId.
DRAFTS = {}
# Mirror of Code.gs tombstones (v8): {rentalId: {'t': epoch_ms, 'reason':
# 'finalized'|'deleted'}}. ANY saveDraft against a tombstoned id is
# acknowledged but ignored (tombstoned: true + reason) regardless of its
# updatedAt — only an explicit resurrect:true push clears the stamp and is
# accepted. (v7 cleared on any newer updatedAt, which let an incidental
# app-open touch on a stale phone resurrect a finalized rental's draft.)
TOMBSTONES = {}

# Phase 3: what getTodaysBookings serves. Tests stage this via /__set_bookings.
BOOKINGS = {'fail': False, 'bookings': []}


def log(entry):
    LOG.write(json.dumps(entry) + '\n')
    LOG.flush()


def sig_ok(section):
    sigs = (section or {}).get('signatures') or {}
    return {k: isinstance(v, str) and v.startswith('data:image/') for k, v in
            {'rentee': sigs.get('rentee', ''), 'baxstar': sigs.get('baxstar', '')}.items()}


def now_ms():
    return int(time.time() * 1000)


def draft_meta(rec):
    """The lightweight listing meta — never includes state/signatures."""
    return {
        'rentalId': rec.get('rentalId', ''),
        'client': rec.get('client', ''),
        'date': rec.get('date', ''),
        'pontoon': rec.get('pontoon', ''),
        'updatedAt': rec.get('updatedAt', 0),
        'hasCheckIn': bool(rec.get('hasCheckIn')),
        'finalized': bool(rec.get('finalized')),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _respond(self, code, obj, cors=True):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        if cors:
            self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # GAS never answers preflight — log it as a violation and refuse.
        log({'method': 'OPTIONS', 'path': self.path,
             'violation': 'preflight sent — form request is not CORS-simple'})
        self._respond(405, {'error': 'no preflight support'}, cors=False)

    # GET sanity endpoint, mirrors doGet().
    def do_GET(self):
        self._respond(200, {'ok': True, 'service': 'baxstar-pontoon-filing-mock',
                            'actions': ['finalize', 'saveDraft', 'getActive',
                                        'deleteDraft', 'getTodaysBookings']})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        ctype = self.headers.get('Content-Type', '')

        if self.path.startswith('/report/'):
            name = self.path.split('/report/', 1)[1].replace('/', '_') or 'unnamed'
            with open(f'report_{name}.txt', 'wb') as f:
                f.write(raw)
            self._respond(200, {'ok': True})
            return

        # Test-only: wipe the in-memory draft store so a scenario can start from
        # a genuinely empty cloud (used by the local-only list-rendering tests,
        # which must not see drafts auto-pushed by earlier scenarios).
        if self.path == '/__reset':
            DRAFTS.clear()
            BOOKINGS['fail'] = False
            BOOKINGS['bookings'] = []
            TOMBSTONES.clear()
            log({'method': 'POST', 'path': '/__reset', 'cleared': True})
            self._respond(200, {'ok': True})
            return

        # Test-only: stage what getTodaysBookings serves.
        if self.path == '/__set_bookings':
            try:
                staged = json.loads(raw)
            except Exception:
                self._respond(200, {'ok': False, 'error': 'not JSON'})
                return
            BOOKINGS['fail'] = bool(staged.get('fail'))
            BOOKINGS['bookings'] = staged.get('bookings') or []
            log({'method': 'POST', 'path': '/__set_bookings',
                 'fail': BOOKINGS['fail'], 'count': len(BOOKINGS['bookings'])})
            self._respond(200, {'ok': True})
            return

        try:
            data = json.loads(raw)
        except Exception:
            log({'method': 'POST', 'path': self.path, 'contentType': ctype,
                 'error': 'body not JSON'})
            self._respond(200, {'ok': False, 'error': 'Request body is not valid JSON'})
            return

        if data.get('token') != TOKEN:
            log({'method': 'POST', 'action': data.get('action'), 'tokenOk': False})
            self._respond(200, {'ok': False, 'error': 'Bad or missing token'})
            return

        action = data.get('action')
        if action == 'finalize':
            return self._finalize(data, ctype)
        if action == 'saveDraft':
            return self._save_draft(data)
        if action == 'getActive':
            return self._get_active(data)
        if action == 'deleteDraft':
            return self._delete_draft(data)
        if action == 'getTodaysBookings':
            return self._get_todays_bookings()

        log({'method': 'POST', 'action': action, 'error': 'unknown action'})
        self._respond(200, {'ok': False, 'error': 'Unknown action: ' + str(action)})

    # ---- Phase 1 -----------------------------------------------------------
    def _finalize(self, data, ctype):
        out = sig_ok(data.get('checkOut'))
        inn = sig_ok(data.get('checkIn'))
        entry = {
            'method': 'POST', 'path': self.path, 'contentType': ctype,
            'action': 'finalize', 'tokenOk': True,
            'client': data.get('client'), 'bookingId': data.get('bookingId'),
            'customerEmail': data.get('customerEmail'),
            'sigs': {'outRentee': out['rentee'], 'outBaxstar': out['baxstar'],
                     'inRentee': inn['rentee'], 'inBaxstar': inn['baxstar']},
            'hasSummary': isinstance(data.get('summaryText'), str) and len(data['summaryText']) > 100,
            'hasChecklists': bool((data.get('checkOut') or {}).get('safetyChecklist')),
            'marksOut': len((data.get('checkOut') or {}).get('damageMarks') or []),
            'marksIn': len((data.get('checkIn') or {}).get('damageMarks') or []),
        }
        log(entry)

        missing = [k for k, v in {**{'out ' + k: v for k, v in entry['sigs'].items() if k.startswith('out')},
                                  **{k: v for k, v in entry['sigs'].items() if k.startswith('in')}}.items() if not v]
        if missing:
            self._respond(200, {'ok': False,
                                'error': 'Cannot file — missing signatures: ' + ', '.join(missing)})
            return
        # A confirmed filing drops the in-progress draft (mirror of Code.gs).
        rid = data.get('rentalId', '')
        draft_removed = DRAFTS.pop(rid, None) is not None
        if rid:
            TOMBSTONES[rid] = {'t': now_ms(), 'reason': 'finalized'}
        emailed = bool((data.get('customerEmail') or '').strip())
        self._respond(200, {'ok': True, 'rentalId': rid,
                            'fileUrl': 'mock://drive/' + (data.get('filename') or 'record'),
                            'emailed': emailed, 'draftRemoved': draft_removed})

    # ---- Phase 2 -----------------------------------------------------------
    def _save_draft(self, data):
        rid = str(data.get('rentalId') or '').strip()
        if not rid:
            self._respond(200, {'ok': False, 'error': 'saveDraft: missing rentalId'})
            return
        if not isinstance(data.get('state'), dict):
            self._respond(200, {'ok': False, 'error': 'saveDraft: missing state'})
            return
        updated = int(data.get('updatedAt') or 0) or now_ms()
        stone = TOMBSTONES.get(rid)
        if stone is not None:
            if data.get('resurrect') is True:
                del TOMBSTONES[rid]
            else:
                log({'method': 'POST', 'action': 'saveDraft', 'rentalId': rid,
                     'tombstoned': True, 'reason': stone['reason']})
                self._respond(200, {'ok': True, 'rentalId': rid,
                                    'updatedAt': updated, 'tombstoned': True,
                                    'reason': stone['reason']})
                return
        prev = int((DRAFTS.get(rid) or {}).get('updatedAt', 0))
        DRAFTS[rid] = {
            'rentalId': rid, 'updatedAt': updated,
            'client': str(data.get('client') or ''),
            'date': str(data.get('date') or ''),
            'pontoon': str(data.get('pontoon') or ''),
            'hasCheckIn': bool(data.get('hasCheckIn')),
            'finalized': bool(data.get('finalized')),
            'state': data.get('state'),
        }
        log({'method': 'POST', 'action': 'saveDraft', 'rentalId': rid,
             'updatedAt': updated, 'draftCount': len(DRAFTS)})
        self._respond(200, {'ok': True, 'rentalId': rid,
                            'updatedAt': updated, 'previousUpdatedAt': prev})

    def _get_active(self, data):
        rid = str(data.get('rentalId') or '').strip()
        if rid:
            rec = DRAFTS.get(rid)
            if not rec:
                self._respond(200, {'ok': False, 'notFound': True,
                                    'error': 'No draft for rentalId ' + rid})
                return
            log({'method': 'POST', 'action': 'getActive', 'mode': 'fetch', 'rentalId': rid})
            self._respond(200, {'ok': True, 'draft': rec})
            return
        drafts = sorted((draft_meta(r) for r in DRAFTS.values()),
                        key=lambda m: m['updatedAt'], reverse=True)
        log({'method': 'POST', 'action': 'getActive', 'mode': 'list', 'count': len(drafts)})
        self._respond(200, {'ok': True, 'drafts': drafts})

    # ---- Phase 3 -----------------------------------------------------------
    def _get_todays_bookings(self):
        log({'method': 'POST', 'action': 'getTodaysBookings',
             'fail': BOOKINGS['fail'], 'count': len(BOOKINGS['bookings'])})
        if BOOKINGS['fail']:
            self._respond(200, {'ok': False, 'error': 'Booking lookup failed: mock failure'})
            return
        self._respond(200, {'ok': True, 'date': time.strftime('%Y-%m-%d'),
                            'bookings': BOOKINGS['bookings']})

    def _delete_draft(self, data):
        rid = str(data.get('rentalId') or '').strip()
        if not rid:
            self._respond(200, {'ok': False, 'error': 'deleteDraft: missing rentalId'})
            return
        removed = DRAFTS.pop(rid, None) is not None
        TOMBSTONES[rid] = {'t': now_ms(), 'reason': 'deleted'}
        log({'method': 'POST', 'action': 'deleteDraft', 'rentalId': rid, 'removed': removed})
        self._respond(200, {'ok': True, 'rentalId': rid, 'removed': removed})


HTTPServer(('127.0.0.1', 8809), Handler).serve_forever()
