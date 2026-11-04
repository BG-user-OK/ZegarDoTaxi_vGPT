/* Tarcza occupancy scheduler v7.5.0. Independent of workday snapshots. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TarczaAppointmentsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '7.5.0', SCHEMA = 'tarcza-appointments-v1', ZONE = 'Europe/Warsaw';
  const MINUTE = 60000, HORIZON = 720 * MINUTE;
  const clone = value => JSON.parse(JSON.stringify(value));
  const pad = value => String(value).padStart(2, '0');
  const formatters = new Map();
  function parts(at, zone = ZONE) {
    if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }));
    const p = Object.fromEntries(formatters.get(zone).formatToParts(new Date(at)).map(p => [p.type, p.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, hour: +p.hour, minute: +p.minute, second: +p.second };
  }
  function validDate(date) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T00:00:00Z')) &&
      new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
  }
  function addDays(date, days) {
    if (!validDate(date)) throw Error('Podaj prawidłową datę.');
    return new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  }
  function localInstant(date, time, offset, zone = ZONE) {
    if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error('Nieprawidłowa data lub godzina.');
    const wall = Date.parse(`${date}T${time}:00Z`), candidates = [];
    for (const delta of [-120, -60]) {
      const at = wall + delta * MINUTE, p = parts(at, zone);
      if (p.date === date && p.time === time && (!offset || offset === (delta === -120 ? '+02:00' : '+01:00'))) candidates.push(at);
    }
    if (!candidates.length) throw Error('Ta godzina nie istnieje w strefie Europe/Warsaw (zmiana czasu) albo ma błędne przesunięcie UTC.');
    if (candidates.length > 1) throw Error('Ta godzina występuje dwa razy. Dopisz +02:00 albo +01:00 przy godzinie.');
    return new Date(candidates[0]).toISOString();
  }
  function parseText(text, options = {}) {
    if (typeof text !== 'string' || !text.trim()) throw Error('Wpisz pełną treść terminówki.');
    if (text.length > 20000) throw Error('Wpis jest za długi (limit 20 000 znaków). Zachowaj jego kopię.');
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const stamp = '(?:(\\d{4}-\\d{2}-\\d{2})\\s+)?([0-2]\\d:[0-5]\\d)([+]0[12]:00)?';
    const re = new RegExp('^\\s*' + stamp + '\\s*[–—-]\\s*' + stamp + '\\s*\\(\\s*na\\s+' + stamp + '\\s*\\)\\s*_?\\s*(.*?)\\s*$', 'i');
    const index = lines.findIndex(line => re.test(line));
    if (index < 0) throw Error('Format: 12:50–13:55 (na 13:30)_Luboń. Datę podaj w polu lub osobnym wierszu YYYY-MM-DD.');
    const m = lines[index].match(re);
    const precedingDate = lines.slice(0, index).map(line => line.trim()).find(line => /^\d{4}-\d{2}-\d{2}$/.test(line));
    const date = m[1] || precedingDate || options.date;
    if (!validDate(date || '')) throw Error('Terminówka wymaga jawnej daty YYYY-MM-DD.');
    const endDate = m[4] || (m[5] < m[2] ? addDays(date, 1) : date);
    const pickupDate = m[7] || (m[8] < m[2] ? addDays(date, 1) : date);
    const result = {
      date, timeZone: ZONE, startAt: localInstant(date, m[2], m[3]),
      endAt: localInstant(endDate, m[5], m[6]), pickupAt: localInstant(pickupDate, m[8], m[9]),
      location: m[10], text
    };
    validateInterval(result);
    return result;
  }
  function validateInterval(record) {
    const start = Date.parse(record.startAt), pickup = Date.parse(record.pickupAt), end = Date.parse(record.endAt);
    if (![start, pickup, end].every(Number.isFinite) || start >= end || pickup < start || pickup > end)
      throw Error('Kolejność musi być poprawna: początek < koniec, a odbiór pomiędzy nimi. Przy zmianie dnia podaj datę.');
    if (end - start > 31 * 86400000) throw Error('Przedział przekracza 31 dni. Sprawdź daty.');
    if (record.timeZone !== ZONE || record.date !== parts(start).date) throw Error('Nieprawidłowa data lub strefa terminówki.');
    return record;
  }
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    if (typeof crypto === 'undefined' || !crypto.getRandomValues) throw Error('Brak bezpiecznego generatora ID.');
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
      (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c) / 4).toString(16));
  }
  function active(record, now) { return !record.deletedAt && !record.expiredAt && Date.parse(record.endAt) > now; }
  function contentSignature(record) {
    return JSON.stringify(['text', 'date', 'startAt', 'pickupAt', 'endAt', 'deletedAt', 'expiredAt'].map(key => record[key] || null));
  }
  function equivalentText(a, b) { return String(a).normalize('NFC').replace(/\r\n?/g, '\n').trim() === String(b).normalize('NFC').replace(/\r\n?/g, '\n').trim(); }
  function ordered(records) { return records.slice().sort((a, b) => Date.parse(a.pickupAt) - Date.parse(b.pickupAt) || a.id.localeCompare(b.id)); }
  function angle(at) { const p = parts(at); return ((p.hour % 12) * 60 + p.minute + p.second / 60) * 0.5 - 90; }
  function point(at, radius = 200) {
    const a = angle(at) * Math.PI / 180;
    return { x: 200 + Math.cos(a) * radius, y: 200 + Math.sin(a) * radius };
  }
  function offsetAt(at) {
    const p = parts(at);
    return Date.parse(`${p.date}T${p.time}:${pad(p.second)}Z`) - Math.floor(at / 1000) * 1000;
  }
  function arcPath(start, end, radius = 200) {
    if (!(end > start)) return '';
    // Split full circles and clock-offset transitions; never interpret equal angles as an empty interval.
    const pieces = [], max = 180 * MINUTE;
    let a = start;
    while (a < end) {
      let b = Math.min(end, a + max), next = b;
      if (offsetAt(a) !== offsetAt(b)) {
        let lo = a, hi = b;
        while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (offsetAt(mid) === offsetAt(a)) lo = mid; else hi = mid; }
        next = hi; b = hi - 1;
      }
      const p = point(a, radius), q = point(b, radius);
      pieces.push(`M ${p.x.toFixed(3)} ${p.y.toFixed(3)} A ${radius} ${radius} 0 0 1 ${q.x.toFixed(3)} ${q.y.toFixed(3)}`);
      a = next;
    }
    return pieces.join(' ');
  }
  function visibleIntervals(records, now, horizon = HORIZON) {
    return records.filter(r => active(r, now)).map(record => ({
      record, start: Math.max(now, Date.parse(record.startAt)), end: Math.min(now + horizon, Date.parse(record.endAt)),
      continues: Date.parse(record.endAt) > now + horizon
    })).filter(item => item.end > item.start);
  }
  function segments(records, now, horizon = HORIZON) {
    const intervals = visibleIntervals(records, now, horizon), endpoints = [];
    intervals.forEach(i => { endpoints.push({ at: i.start, d: 1 }); endpoints.push({ at: i.end, d: -1 }); });
    endpoints.sort((a, b) => a.at - b.at || a.d - b.d);
    const result = []; let count = 0, previous;
    for (let i = 0; i < endpoints.length;) {
      const at = endpoints[i].at;
      if (previous !== undefined && at > previous && count > 0) result.push({ start: previous, end: at, count, conflict: count > 1 });
      while (i < endpoints.length && endpoints[i].at === at) count += endpoints[i++].d;
      previous = at;
    }
    return result;
  }
  function defaultText(now = Date.now()) {
    const p = parts(now + 8 * 60 * MINUTE), pickup = localInstant(p.date, `${pad(p.hour)}:00`);
    const start = parts(Date.parse(pickup) - 30 * MINUTE), end = parts(Date.parse(pickup) + 30 * MINUTE);
    // Suggested fields remain editable and are validated before confirmation.
    return `${start.date}\n${start.time}–${end.date !== start.date ? end.date + ' ' : ''}${end.time} (na ${p.date !== start.date ? p.date + ' ' : ''}${pad(p.hour)}:00)_\n\nUwagi:\n`;
  }
  function emptyState() { return { schema: SCHEMA, records: {}, outbox: [], conflicts: [], drafts: {}, serverOffset: 0, lastSyncAt: 0 }; }
  class IndexedStore {
    constructor(indexedDB) { this.indexedDB = indexedDB; this.db = null; }
    async open() {
      if (this.db) return this.db;
      this.db = await new Promise((resolve, reject) => {
        const r = this.indexedDB.open('tarcza-appointments-v1', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('state');
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      return this.db;
    }
    async transact(change) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite'), os = tx.objectStore('state'), request = os.get('root');
        let result;
        request.onsuccess = () => {
          try { result = request.result || emptyState(); change(result); os.put(result, 'root'); }
          catch (error) { tx.abort(); reject(error); }
        };
        tx.oncomplete = () => resolve(clone(result)); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('Zapis lokalny został przerwany.'));
      });
    }
    read() { return this.transact(() => {}); }
  }
  class Repository {
    constructor(store, idFactory = uuid) { this.store = store; this.idFactory = idFactory; }
    async save(parsed, existingId, now = Date.now(), expectedContent) {
      validateInterval(parsed);
      return this.store.transact(state => {
        const old = existingId && state.records[existingId];
        if (existingId && expectedContent !== undefined && (!old || contentSignature(old) !== expectedContent)) {
          const error = Error('Terminówka zmieniła się podczas edycji. Zachowano szkic do porównania.');
          error.code = 'appointmentChanged'; throw error;
        }
        if (existingId && !old) throw Error('Nie znaleziono terminówki.');
        if (old && (old.deletedAt || old.expiredAt)) throw Error('Terminówka została usunięta lub wygasła.');
        const id = existingId || this.idFactory(), timestamp = new Date(now).toISOString();
        const record = Object.assign({}, old || {}, parsed, { id, revision: old ? old.revision : 0,
          originalText: old ? old.originalText : parsed.text, createdAt: old ? old.createdAt : timestamp,
          originalDate: old ? old.originalDate || old.date : parsed.date,
          updatedAt: timestamp, deletedAt: null, expiredAt: null, source: old ? old.source : 'manual' });
        state.records[id] = record;
        const prior = state.outbox.filter(o => o.id === id).at(-1);
        state.outbox.push({ opId: this.idFactory(), id, kind: 'put', baseRevision: record.revision,
          waitsFor: prior ? prior.opId : '', record: clone(record), attempted: false });
        delete state.drafts[existingId || 'new'];
      });
    }
    async importEntry(parsed, id, now = Date.now()) {
      validateInterval(parsed);
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw Error('Nieprawidłowe ID wpisu.');
      let result;
      const state = await this.store.transact(s => {
        let existing = s.records[id];
        if (existing && (existing.deletedAt || existing.expiredAt)) throw Error('Ten wpis został usunięty lub wygasł. Ponowne wklejenie go nie odtworzy.');
        const same = r => ((r.originalDate || r.date) === parsed.date && equivalentText(r.originalText, parsed.text)) ||
          (r.date === parsed.date && r.text === parsed.text && r.startAt === parsed.startAt && r.pickupAt === parsed.pickupAt && r.endAt === parsed.endAt);
        if (existing && !same(existing)) throw Error('To ID należy już do innego lub zmienionego wpisu. Edytuj terminówkę w Tarczy; nie nadpisano jej.');
        if (!existing) {
          const matches = Object.values(s.records).filter(r => active(r, now) && same(r));
          if (matches.length > 1) throw Error('Istnieje kilka identycznych terminówek. Sprawdź listę w Tarczy; niczego nie dodano.');
          existing = matches[0];
        }
        if (existing) { result = { id: existing.id, duplicate: true }; return; }
        const timestamp = new Date(now).toISOString();
        const record = Object.assign({}, parsed, { id, revision: 0, originalText: parsed.text, originalDate: parsed.date,
          source: 'paste', createdAt: timestamp, updatedAt: timestamp, deletedAt: null, expiredAt: null });
        s.records[id] = record;
        s.outbox.push({ opId: this.idFactory(), id, kind: 'put', baseRevision: 0, waitsFor: '', record: clone(record), attempted: false, origin: 'paste-create' });
        result = { id, duplicate: false };
      });
      return Object.assign(result, { state });
    }
    async reconcileImports(remoteRecords) {
      return this.store.transact(s => {
        for (const op of s.outbox.filter(o => o.origin === 'paste-create' && o.baseRevision === 0)) {
          const same = r => equivalentText(r.originalText, op.record.originalText) && (r.originalDate || r.date) === (op.record.originalDate || op.record.date);
          const exact = remoteRecords.find(r => r.id === op.id);
          const matches = exact ? [exact] : remoteRecords.filter(same);
          if (!matches.length || (exact && !same(exact) && !exact.deletedAt && !exact.expiredAt)) continue;
          if (matches.length > 1) {
            s.conflicts.push({ id: this.idFactory(), appointmentId: op.id, operations: [clone(op)], remote: null, reason: 'W Arkuszu jest kilka identycznych terminówek. Nie wybrano żadnej automatycznie.' });
          } else if (!s.outbox.some(o => o.id === matches[0].id && o.opId !== op.opId)) s.records[matches[0].id] = clone(matches[0]);
          s.outbox = s.outbox.filter(o => o.opId !== op.opId);
          if ((!exact || matches.length > 1) && !s.outbox.some(o => o.id === op.id)) delete s.records[op.id];
        }
      });
    }
    async remove(id, now = Date.now()) {
      return this.store.transact(state => {
        const record = state.records[id];
        if (!record || record.deletedAt) return;
        record.deletedAt = new Date(now).toISOString();
        const prior = state.outbox.filter(o => o.id === id).at(-1);
        state.outbox.push({ opId: this.idFactory(), id, kind: 'delete', baseRevision: record.revision,
          waitsFor: prior ? prior.opId : '', record: clone(record), attempted: false });
      });
    }
    draft(key, text) { return this.store.transact(state => { state.drafts[key || 'new'] = text; }); }
    async outgoing() {
      let operations = [];
      await this.store.transact(state => {
        operations = state.outbox.filter(o => !o.waitsFor).slice(0, 30);
        operations.forEach(o => { o.attempted = true; });
      });
      return clone(operations);
    }
    async accept(response, sentAt, receivedAt) {
      if (!response || response.ok !== true || response.schema !== SCHEMA || !Array.isArray(response.records) || !Array.isArray(response.receipts)) throw Error('Nieprawidłowe potwierdzenie serwera.');
      for (const record of response.records) {
        if (!record.id || !Number.isSafeInteger(record.revision) || record.revision < 1) throw Error('Nieprawidłowa rewizja serwera.');
        if (!record.deletedAt && !record.expiredAt) validateInterval(record);
      }
      return this.store.transact(state => {
        const remoteById = new Map(response.records.map(r => [r.id, r]));
        for (const receipt of response.receipts) {
          const op = state.outbox.find(o => o.opId === receipt.opId);
          if (!op) continue;
          const remote = receipt.record || remoteById.get(op.id);
          if (receipt.status === 'applied' || receipt.status === 'duplicate') {
            if (!remote || !Number.isSafeInteger(remote.revision)) throw Error('Brak rewizji w potwierdzeniu zapisu.');
            state.outbox = state.outbox.filter(o => o.opId !== op.opId);
            state.outbox.filter(o => o.waitsFor === op.opId).forEach(o => { o.waitsFor = ''; o.baseRevision = receipt.revision || remote.revision; });
          } else if (receipt.status === 'conflict' || receipt.status === 'invalid') {
            const affected = state.outbox.filter(o => o.id === op.id);
            state.conflicts.push({ id: this.idFactory(), appointmentId: op.id, operations: clone(affected), remote: remote || null,
              reason: receipt.message || 'Równoczesna zmiana na innym urządzeniu.' });
            state.outbox = state.outbox.filter(o => o.id !== op.id);
            if (!remote) delete state.records[op.id];
          } else throw Error('Nieznany status operacji.');
        }
        for (const record of response.records) {
          if (state.outbox.some(o => o.id === record.id)) continue;
          const local = state.records[record.id];
          if (!local || record.revision >= local.revision) state.records[record.id] = clone(record);
        }
        const serverNow = Date.parse(response.serverNow);
        if (Number.isFinite(serverNow)) state.serverOffset = serverNow - (sentAt + receivedAt) / 2;
        state.lastSyncAt = receivedAt;
      });
    }
  }
  return { VERSION, SCHEMA, ZONE, MINUTE, HORIZON, parts, validDate, addDays, localInstant, parseText, validateInterval,
    uuid, active, contentSignature, equivalentText, ordered, angle, point, offsetAt, arcPath, visibleIntervals, segments, defaultText, emptyState, IndexedStore, Repository };
});
