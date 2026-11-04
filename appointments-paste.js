/* Pixel paste-to-Tarcza page v7.6.0. Uses the existing Sheets backend; no workday logic. */
(function (root, factory) {
  const C = typeof module === 'object' && module.exports ? require('./appointments-core.js') : root.TarczaAppointmentsCore;
  const api = factory(C);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TarczaPaste = api; if (document.getElementById('pasteForm')) api.start(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  async function parseInput(raw, selectedDate, cryptography = globalThis.crypto) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 100000) throw Error('Wklej cały blok terminówki.');
    let input = raw.trim(), text, date, id, explicitDate = false;
    if (/^```(?:json)?\s*\n[\s\S]*\n```$/i.test(input)) input = input.replace(/^```(?:json)?\s*\n/i, '').replace(/\n```$/, '');
    if (input.startsWith('{')) {
      let object;
      try { object = JSON.parse(input); } catch { throw Error('Blok jest niepełny albo ma uszkodzony format. Skopiuj cały blok z ChatGPT.'); }
      if (!object || typeof object.text !== 'string' || !C.validDate(object.date || '')) throw Error('Blok musi zawierać datę YYYY-MM-DD i pełną treść text.');
      if (object.id && !UUID.test(object.id)) throw Error('ID w bloku jest nieprawidłowe. Poproś ChatGPT o poprawny UUID.');
      text = object.text; date = object.date; id = object.id?.toLowerCase(); explicitDate = true;
    } else {
      text = raw;
      try { date = C.parseText(text).date; explicitDate = true; } catch { date = selectedDate; }
    }
    const parsed = C.parseText(text, { date });
    if (date && parsed.date !== date) throw Error('Data w bloku i treści jest różna. Wyjaśnij ją przed wysłaniem.');
    if (!id) {
      const canonical = 'tarcza-paste-v1\0' + parsed.date + '\0' + parsed.text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
      const bytes = new Uint8Array(await cryptography.subtle.digest('SHA-256', new TextEncoder().encode(canonical))).slice(0, 16);
      bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return { id, parsed, explicitDate };
  }
  class Importer {
    constructor(repository, getConfig, options = {}) {
      this.repository = repository; this.getConfig = getConfig;
      // Native Window.fetch requires its Window receiver; an importer method call is invalid on Android Chrome.
      this.fetcher = options.fetch || ((...args) => globalThis.fetch(...args));
      this.online = options.online || (() => navigator.onLine); this.time = options.now || (() => Date.now());
      this.capabilityUrl = ''; this.inFlight = null;
    }
    config() {
      const cfg = this.getConfig();
      if (!cfg?.url || !cfg.pin) throw Error('Ustaw raz adres połączenia i PIN, takie jak w Tarczy.');
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec$/.test(cfg.url)) throw Error('Sprawdź adres wdrożenia Apps Script — powinien kończyć się /exec.');
      return cfg;
    }
    async json(url, body) {
      const response = await this.fetcher(url, { method: body ? 'POST' : 'GET', mode: 'cors', credentials: 'omit', redirect: 'follow', cache: 'no-store',
        headers: body ? { 'Content-Type': 'text/plain;charset=utf-8' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw Error('Brak odpowiedzi połączenia. Dane pozostają zapisane na Pixelu.');
      try { return await response.json(); } catch { throw Error('Najpierw zaktualizuj istniejący Apps Script. Dane pozostają na Pixelu.'); }
    }
    async exchange(cfg, operations) {
      const sent = this.time(), response = await this.json(cfg.url, { action: 'appointmentsSync', pin: cfg.pin, operations });
      await this.repository.accept(response, sent, this.time());
      return response;
    }
    async sync() {
      if (this.inFlight) return this.inFlight;
      this.inFlight = this.performSync().finally(() => { this.inFlight = null; });
      return this.inFlight;
    }
    async performSync() {
      if (!this.online()) throw Error('Offline — wpisy czekają na Pixelu. Otwórz tę stronę po odzyskaniu sieci.');
      const cfg = this.config();
      if (this.capabilityUrl !== cfg.url) {
        const caps = await this.json(cfg.url + '?action=appointmentsCapabilities');
        if (!caps.ok || caps.schema !== C.SCHEMA || caps.protocol !== 1) throw Error('Najpierw zaktualizuj istniejący Apps Script. Nie wysłano danych do starego skryptu.');
        this.capabilityUrl = cfg.url;
      }
      const downloaded = await this.exchange(cfg, []);
      await this.repository.reconcileImports(downloaded.records);
      for (let round = 0; round < 6; round++) {
        const operations = await this.repository.outgoing(); if (!operations.length) break;
        await this.exchange(cfg, operations);
      }
      return this.repository.store.read();
    }
    async submit(raw, date) {
      const entry = await parseInput(raw, date);
      await this.repository.draft('paste-input', raw);
      const before = await this.repository.store.read(), now = this.time() + (before.serverOffset || 0);
      if (Date.parse(entry.parsed.endAt) <= now) throw Error('Ten kurs już się zakończył. Sprawdź datę i godziny; niczego nie dodano.');
      const saved = await this.repository.importEntry(entry.parsed, entry.id, now);
      let problem = '';
      try { await this.sync(); } catch (error) { problem = error.message; }
      const state = await this.repository.store.read();
      let record = state.records[saved.id];
      const conflict = state.conflicts.find(c => c.appointmentId === saved.id);
      if (!record && !conflict) {
        const matches = Object.values(state.records).filter(r => (r.originalDate || r.date) === entry.parsed.date && C.equivalentText(r.originalText, entry.parsed.text));
        if (matches.length === 1) record = matches[0];
      }
      if (record && record.id !== saved.id) { saved.id = record.id; saved.duplicate = true; }
      if (record?.deletedAt || record?.expiredAt) return { status: 'blocked', id: saved.id, message: 'Wpis został już usunięty lub wygasł. Ponowienie nie odtworzyło go.', state };
      if (conflict) return { status: 'conflict', id: saved.id, message: 'Zapis wymaga decyzji. Blok zachowano na Pixelu; porównaj go z terminówką na drugim telefonie.', state };
      const pending = state.outbox.some(o => o.id === saved.id);
      if (record?.revision > 0 && !pending && !problem) return { status: 'confirmed', id: saved.id, duplicate: saved.duplicate,
        message: saved.duplicate ? 'Ten wpis jest już w Arkuszu — nie dodano duplikatu.' : 'Potwierdzono zapis w Arkuszu. Tarcza na drugim telefonie pobierze go podczas połączenia.', state };
      return { status: 'queued', id: saved.id, message: 'Zapisano na Pixelu. Nie ma jeszcze potwierdzenia wysłania. ' + problem, state };
    }
  }
  async function start() {
    const $ = id => document.getElementById(id), store = new C.IndexedStore(indexedDB), repo = new C.Repository(store);
    const importer = new Importer(repo, () => ({ url: localStorage.getItem('tarcza_appscript_url') || '', pin: localStorage.getItem('tarcza_sync_pin') || '' }));
    let working = false, submitting = false, userDate = false, parsed = null, previewSequence = 0, retry;
    const status = (text, kind = '', submission = false) => {
      $('pasteStatus').textContent = text; $('pasteStatus').dataset.kind = kind;
      if (submission || !$('pasteSendStatus').hidden) { $('pasteSendStatus').hidden = false; $('pasteSendStatus').textContent = text; $('pasteSendStatus').dataset.kind = kind; }
    };
    const fullTime = at => { const p = C.parts(Date.parse(at)); return `${p.date} ${p.time}`; };
    async function refreshQueue() {
      const state = await store.read(), pending = state.outbox.filter(o => o.origin === 'paste-create');
      $('pasteQueue').replaceChildren();
      for (const op of pending) {
        const li = document.createElement('li'); li.textContent = `${fullTime(op.record.pickupAt)} ${op.record.location} — czeka na potwierdzenie`;
        $('pasteQueue').appendChild(li);
      }
      $('pasteQueueSection').hidden = !pending.length;
    }
    async function preview() {
      const sequence = ++previewSequence; parsed = null; $('pastePreview').hidden = true; $('pasteSend').disabled = true; $('pasteDate').readOnly = false; $('pasteSendStatus').hidden = true;
      if (!$('pasteText').value.trim()) return;
      try {
        const entry = await parseInput($('pasteText').value, userDate ? $('pasteDate').value : undefined); if (sequence !== previewSequence) return;
        parsed = entry; $('pasteDate').value = entry.parsed.date; $('pasteDate').readOnly = entry.explicitDate;
        $('previewStart').textContent = fullTime(entry.parsed.startAt); $('previewPickup').textContent = fullTime(entry.parsed.pickupAt);
        $('previewEnd').textContent = fullTime(entry.parsed.endAt); $('previewText').textContent = entry.parsed.text;
        $('pastePreview').hidden = false; $('pasteSend').disabled = submitting; status('Sprawdź datę i godziny, następnie wyślij.');
      } catch (error) { if (sequence === previewSequence) status(error.message, 'error'); }
    }
    async function sync() {
      if (working || submitting || document.hidden) return;
      working = true;
      try {
        const state = await importer.sync(); await refreshQueue();
        if (parsed) {
          const matches = Object.values(state.records).filter(r => (r.originalDate || r.date) === parsed.parsed.date && C.equivalentText(r.originalText, parsed.parsed.text));
          if (matches.length === 1) {
            const r = matches[0];
            if (r.deletedAt || r.expiredAt) status('Ten wpis został usunięty lub wygasł. Nie został odtworzony.', 'pending');
            else if (r.revision > 0 && !state.outbox.some(o => o.id === r.id)) status('Potwierdzono zapis w Arkuszu. Telefon z Tarczą może pobrać wpis.', 'ok');
          }
        }
      }
      catch (error) { status(error.message, 'pending'); }
      finally { working = false; clearTimeout(retry); retry = setTimeout(sync, 30000); }
    }
    try {
      const state = await store.read(); $('pasteText').value = state.drafts['paste-input'] || '';
      try { const savedDate = JSON.parse(state.drafts['paste-date-context'] || 'null'); if (savedDate?.raw === $('pasteText').value && C.validDate(savedDate.date)) { userDate = true; $('pasteDate').value = savedDate.date; } } catch {}
      $('connectionUrl').value = localStorage.getItem('tarcza_appscript_url') || '';
      $('connectionPin').value = localStorage.getItem('tarcza_sync_pin') || '';
      $('pasteConnection').open = !$('connectionUrl').value || !$('connectionPin').value;
      await refreshQueue(); if ($('pasteText').value) await preview();
    } catch { status('Nie można otworzyć lokalnego zapisu. Nie zamykaj strony bez zachowania tekstu.', 'error'); return; }
    $('pasteClipboard').addEventListener('click', async () => {
      try { $('pasteText').value = await navigator.clipboard.readText(); $('pasteText').dispatchEvent(new Event('input')); }
      catch { status('Przytrzymaj pole tekstu i wybierz „Wklej”. Przeglądarka nie udostępniła schowka.'); $('pasteText').focus(); }
    });
    $('pasteText').addEventListener('input', async () => {
      userDate = false;
      try { await repo.draft('paste-input', $('pasteText').value); await preview(); }
      catch { status('Nie udało się zapisać szkicu. Zachowaj kopię tekstu.', 'error'); }
    });
    $('pasteDate').addEventListener('change', async () => { userDate = true; await repo.draft('paste-date-context', JSON.stringify({ raw: $('pasteText').value, date: $('pasteDate').value })); preview(); });
    $('pasteSettings').addEventListener('submit', event => {
      event.preventDefault();
      const cfg = { url: $('connectionUrl').value.trim(), pin: $('connectionPin').value.trim() };
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec$/.test(cfg.url) || !cfg.pin) { status('Podaj poprawny adres /exec i PIN synchronizacji.', 'error'); return; }
      localStorage.setItem('tarcza_appscript_url', cfg.url); localStorage.setItem('tarcza_sync_pin', cfg.pin);
      $('pasteConnection').open = false; status('Połączenie zapisane tylko na tym urządzeniu.'); sync();
    });
    $('pasteForm').addEventListener('submit', async event => {
      event.preventDefault(); if (submitting || !parsed) return; submitting = true; $('pasteSend').disabled = true; $('pasteText').readOnly = true; status('Zachowuję wpis i sprawdzam potwierdzenie…', '', true);
      try { const result = await importer.submit($('pasteText').value, $('pasteDate').value); status(result.message, result.status === 'confirmed' ? 'ok' : 'pending'); await refreshQueue(); }
      catch (error) { status(error.message, 'error'); }
      finally { submitting = false; $('pasteText').readOnly = false; $('pasteSend').disabled = !parsed; clearTimeout(retry); retry = setTimeout(sync, 30000); }
    });
    $('pasteRetry').addEventListener('click', sync);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); }); window.addEventListener('online', sync);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    window.TarczaPasteImporter = importer; document.body.dataset.ready = 'true'; sync();
  }
  return { parseInput, Importer, start };
});
