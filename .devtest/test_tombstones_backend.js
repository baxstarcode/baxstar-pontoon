/* =============================================================================
 * TOMBSTONES BACKEND SUITE — runs the REAL Code.gs tombstone gate under
 * JavaScriptCore with faked Apps Script services (PropertiesService, Drive,
 * LockService). The browser T-scenarios exercise the python mock's MIRROR of
 * this logic; this file is what proves the actual Code.gs behaves the same.
 *     sh .devtest/run_tombstones_backend_tests.sh
 * ========================================================================== */

var _pass = 0, _fail = 0;
function t(name, cond, detail) {
  if (cond) { _pass++; print('PASS  ' + name); }
  else { _fail++; print('FAIL  ' + name + (detail !== undefined ? '  [' + JSON.stringify(detail) + ']' : '')); }
}

/* ---- fake Apps Script services ---- */
var _props = {};
var PropertiesService = {
  getScriptProperties: function () {
    return {
      getProperty: function (k) { return _props[k] === undefined ? null : _props[k]; },
      setProperty: function (k, v) { _props[k] = String(v); }
    };
  }
};
var LockService = {
  getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; }
};

// One in-memory Drive folder that serves as parent AND drafts folder.
var _files = {};   // name -> file object
function mkFile(name, content) {
  return {
    _name: name, _content: content, _desc: '', _trashed: false,
    getName: function () { return this._name; },
    isTrashed: function () { return this._trashed; },
    setTrashed: function (v) { this._trashed = v; },
    setContent: function (c) { this._content = c; },
    setDescription: function (d) { this._desc = d; },
    getDescription: function () { return this._desc; },
    getBlob: function () { var s = this; return { getDataAsString: function () { return s._content; } }; }
  };
}
function iter(list) { var i = 0; return { hasNext: function () { return i < list.length; }, next: function () { return list[i++]; } }; }
var _folder = {
  getFilesByName: function (name) { return iter(_files[name] ? [_files[name]] : []); },
  getFiles: function () { return iter(Object.keys(_files).map(function (k) { return _files[k]; })); },
  createFile: function (name, content) { var f = mkFile(name, content); _files[name] = f; return f; },
  getFoldersByName: function () { return iter([_folder]); }
};
var DriveApp = { getFolderById: function () { return _folder; } };

var STATE = { inputs: {}, checks: {}, sigs: {}, marks: { out: [], in: [] } };
function save(rid, updatedAt, client) {
  return handleSaveDraft({ rentalId: rid, updatedAt: updatedAt, client: client || 'T', date: '2026-07-09', pontoon: 'U1', hasCheckIn: false, state: STATE });
}
function listed(rid) {
  var out = handleGetActive({});
  for (var i = 0; i < out.drafts.length; i++) if (out.drafts[i].rentalId === rid) return true;
  return false;
}

/* ---- 1. normal save/list/delete lifecycle with tombstoning ---- */
var t0 = Date.now() - 10 * 60 * 1000;   // "10 minutes ago": the stale copy's edit time
var r1 = save('r_100_aaa', t0, 'Zombie Case');
t('save: accepted, not tombstoned', r1.ok === true && !r1.tombstoned, r1);
t('save: listed by getActive', listed('r_100_aaa'));

var d1 = handleDeleteDraft({ rentalId: 'r_100_aaa' });
t('delete: ok + removed', d1.ok === true && d1.removed === true, d1);
t('delete: tombstone stamped', tombstoneTime('r_100_aaa') > 0);
t('delete: no longer listed', !listed('r_100_aaa'));

/* ---- 2. the Dustin case: stale re-push is acknowledged but ignored ---- */
var r2 = save('r_100_aaa', t0, 'Zombie Case');   // same old updatedAt — stale phone
t('stale re-push: ok:true (sender queue drains)', r2.ok === true, r2);
t('stale re-push: flagged tombstoned', r2.tombstoned === true, r2);
t('stale re-push: draft NOT resurrected', !listed('r_100_aaa'));
t('stale re-push: file stays trashed', _files[draftFileName('r_100_aaa')]._trashed === true);

/* equal-timestamp edge: <= is stale (tombstone wins ties) */
var tsEq = tombstoneTime('r_100_aaa');
var r2b = save('r_100_aaa', tsEq, 'Zombie Case');
t('push at exactly tombstone time: still refused', r2b.tombstoned === true, r2b);

/* ---- 3. deliberate resurrection: newer edit clears the tombstone ---- */
var r3 = save('r_100_aaa', Date.now() + 1000, 'Lazarus Edit');
t('newer push: accepted (no tombstoned flag)', r3.ok === true && !r3.tombstoned, r3);
t('newer push: tombstone cleared', tombstoneTime('r_100_aaa') === 0);
t('newer push: draft listed again', listed('r_100_aaa'));

/* ---- 4. getActive belt-and-suspenders: live file + tombstone → hidden ---- */
save('r_200_bbb', Date.now(), 'Belt Suspenders');
addTombstone('r_200_bbb');    // simulate a partial failure that left the file live
t('tombstoned id hidden from list even with a live file', !listed('r_200_bbb'));
clearTombstone('r_200_bbb');

/* ---- 5. TTL prune: >90d tombstones drop when a new one is written ---- */
_props = {};
var old = Date.now() - 91 * 24 * 60 * 60 * 1000;
saveTombstones({ 'r_old_1': old, 'r_recent': Date.now() - 1000 });
addTombstone('r_new');
var mapNow = loadTombstones();
t('prune: expired tombstone dropped', mapNow['r_old_1'] === undefined, mapNow);
t('prune: recent tombstone kept', mapNow['r_recent'] !== undefined);
t('prune: new tombstone present', mapNow['r_new'] !== undefined);

/* ---- 6. corrupted properties store degrades safely ---- */
_props['TOMBSTONES'] = '{not json';
t('corrupt store: loadTombstones → {}', JSON.stringify(loadTombstones()) === '{}');
var r6 = save('r_300_ccc', Date.now(), 'After Corruption');
t('corrupt store: saves still work', r6.ok === true && !r6.tombstoned, r6);

print('RESULT: ' + _pass + ' passed, ' + _fail + ' failed');
