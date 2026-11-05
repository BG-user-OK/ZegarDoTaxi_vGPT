/* Occupancy scheduler UI and transport v7.7.0. Compact dial annotations. */
(function (root) {
  'use strict';
  const C = root.TarczaAppointmentsCore, NS = 'http://www.w3.org/2000/svg';
  let host, repository, state = C.emptyState(), layer, dialog, status, busy = false, timer, channel;
  let lastRender = '', ready = false, syncing = false, syncAgain = false, statusKind = 'local', importer;
  let gesture = null, fanIds = [], view = '', editorKey = '', editorDirty = false, lastConfigKey = '';
  let arcs, annotations, drawTarget = null, annotationSignature = '', listSignature = '';
  let suppressOpeningClick = false;
  let editorBase, editorConflictId = '';
  let refreshingWorkday = false;
  const transfers = () => Object.values(state.deliveries || {});
  function isTransferring() { return !ready || view === 'paste' || refreshingWorkday || transfers().some(t => t.status === 'confirmed' && t.refresh) || state.outbox.some(o => state.deliveries?.[o.id]); }
  function deliveryStatus(id) { return state.deliveries?.[id]?.status || ''; }
  async function updateDeliveries(failed = false) {
    state = await repository.store.transact(s => {
      for (const [id, transfer] of Object.entries(s.deliveries || {})) {
        const matches = Object.values(s.records).filter(r => (r.originalDate || r.date) === transfer.date && C.equivalentText(r.originalText, transfer.text));
        const record = s.records[id] || (matches.length === 1 ? matches[0] : null);
        const pending = s.outbox.some(o => o.id === (record?.id || id));
        const conflict = s.conflicts.some(c => c.appointmentId === id || c.appointmentId === record?.id);
        transfer.status = conflict || record?.deletedAt || record?.expiredAt ? 'error' : record?.revision > 0 && !pending ? 'confirmed' : failed ? 'error' : 'sending';
        if (record && record.id !== id) { s.deliveries[record.id] = transfer; delete s.deliveries[id]; }
      }
    });
    lastRender = ''; render();
  }
  async function refreshWorkday() {
    const waiting = transfers().filter(t => t.status === 'confirmed' && t.refresh);
    if (!waiting.length || !host.refreshWorkday || refreshingWorkday) return;
    refreshingWorkday = true;
    try {
      const result = await host.refreshWorkday();
      if (result === 'deferred') return;
      state = await repository.store.transact(s => {
        for (const t of Object.values(s.deliveries || {})) if (waiting.some(w => w.date === t.date && w.text === t.text)) t.refresh = false;
      });
    } catch { /* Delivery is already confirmed. A read-only refresh can wait for the next retry. */ }
    finally { refreshingWorkday = false; }
  }
  function armOpeningClick() { suppressOpeningClick = true; setTimeout(() => { suppressOpeningClick = false; }, 1000); }
  const now = () => Date.now() + (state.serverOffset || 0);
  const records = () => Object.values(state.records);
  const current = id => state.records[id];
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const el = (tag, attrs, parent = drawTarget || layer) => {
    const node = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    parent.appendChild(node); return node;
  };
  const message = (text, kind = 'local') => {
    status = text; statusKind = kind;
    if (dialog && dialog.open) {
      const target = dialog.querySelector('.appointments-status');
      if (target) { target.textContent = status; target.dataset.kind = kind; }
    }
    const center = document.getElementById('clockResetZone');
    if (center) center.dataset.pending = state.outbox.length ? 'true' : 'false';
  };
  async function load() { state = await repository.store.read(); lastRender = ''; render(); }
  async function changed() { await load(); if (channel) channel.postMessage('changed'); scheduleSync(250); }
  function open(html, type) {
    if (!dialog.open) {
      if (!host.canOpen()) return false;
      dialog.showModal();
    }
    view = type; dialog.innerHTML = `<div class="appointments-content">${html}</div>`;
    dialog.querySelector('[autofocus]')?.focus();
    return true;
  }
  function close() { dialog.close(); fanIds = []; view = ''; lastRender = ''; render(); }
  function statusHtml() { return `<p class="appointments-status" data-kind="${statusKind}" role="status">${escape(status || 'Zapis lokalny gotowy.')}</p>`; }
  function format(at) { const p = C.parts(Date.parse(at)); return `${p.date} ${p.time}`; }
  function header(title) { return `<div class="appointments-heading"><strong>${title}</strong><button type="button" class="appointments-close" data-action="close" aria-label="Zamknij">✕</button></div>`; }
  function list() {
    fanIds = [];
    const active = C.ordered(records().filter(r => C.active(r, now())));
    listSignature = active.map(r => r.id + r.updatedAt).join('|');
    const conflicts = state.conflicts.map(conflict => {
      const local = conflict.operations.at(-1)?.record;
      const remoteActive = conflict.remote && C.active(conflict.remote, now());
      const deleteIntent = conflict.operations.at(-1)?.kind === 'delete';
      const recoveryAction = deleteIntent ? (remoteActive ? `<button type="button" data-action="retryDelete" data-id="${escape(conflict.id)}">Ponów usunięcie aktualnego wpisu</button>` : '') :
        `<button type="button" data-action="recover" data-id="${escape(conflict.id)}">${remoteActive ? 'Edytuj istniejący wpis według mojej wersji' : 'Otwórz moją wersję jako nowy wpis'}</button>`;
      return `<section class="appointments-conflict"><strong>Zmiana wymaga decyzji</strong><p>${escape(conflict.reason)}</p><strong>Twoja wersja · ${escape(local?.date || '')}</strong><pre>${escape(local?.text || 'Usunięcie terminówki')}</pre>
        <strong>Aktualny zapis · ${escape(conflict.remote?.date || '')}</strong><pre>${escape(conflict.remote?.text || 'Brak wpisu')}${conflict.remote?.deletedAt ? '\n[usunięty]' : conflict.remote?.expiredAt ? '\n[wygasły]' : ''}</pre>
        ${recoveryAction}<button type="button" data-action="dismissConflict" data-id="${escape(conflict.id)}">Zachowaj aktualny zapis</button></section>`;
    }).join('');
    const dstNotice = C.offsetAt(now()) !== C.offsetAt(now() + C.HORIZON) ? '<p class="appointments-help">Zmiana czasu w tym oknie: powtórzone godziny mogą mieć wspólne położenie. Sprawdź daty i przesunięcia UTC w treści kursu.</p>' : '';
    open(`${header('Terminówki')}<p class="appointments-horizon">Tarcza: najbliższe 12 godzin · Europe/Warsaw</p>${statusHtml()}
      ${dstNotice}
      <button type="button" class="appointments-yellow appointments-submit-new" data-action="paste">Zgłoś nową</button>
      <div class="appointments-toolbar"><button type="button" class="appointments-green" data-action="new" autofocus>＋ Dodaj</button>
      <button type="button" data-action="sync">↻ Synchronizuj</button></div>
      ${conflicts}${active.length ? active.map(r => `<button type="button" class="appointments-row" data-action="details" data-id="${escape(r.id)}">
      <strong>${escape(format(r.pickupAt))} ${escape(r.location)}</strong><span>${escape(C.parts(Date.parse(r.startAt)).time)}–${escape(C.parts(Date.parse(r.endAt)).time)}${C.parts(Date.parse(r.endAt)).date !== r.date ? ' (+ data końca: ' + escape(C.parts(Date.parse(r.endAt)).date) + ')' : ''}</span>
      <small>${state.outbox.some(o => o.id === r.id) ? 'Zapis lokalny · czeka na potwierdzenie' : (r.revision ? 'Potwierdzono na serwerze' : 'Zapis lokalny')}</small></button>`).join('') : '<p>Brak aktywnych terminówek.</p>'}
      <p class="appointments-help">Dotknij terminu, aby zobaczyć pełną treść. Zmiany tutaj nie zmieniają Google Calendar.</p>`, 'list');
  }
  function details(id) {
    const r = current(id);
    if (!r || !C.active(r, now())) { list(); return; }
    fanIds = [];
    open(`${header('Terminówka')}<p class="appointments-date">${escape(r.date)} · Europe/Warsaw</p>
      <pre class="appointments-full-text">${escape(r.text)}</pre>
      ${Date.parse(r.pickupAt) <= now() ? '<p class="appointments-help">Po czasie odbioru — zajętość trwa do końca kursu.</p>' : ''}
      <p class="appointments-help">Koniec: ${escape(format(r.endAt))}</p>${statusHtml()}
      ${deliveryStatus(id) === 'error' ? '<button type="button" data-action="sync">Ponów wysłanie</button>' : ''}
      <div class="appointments-actions"><button type="button" class="appointments-red" data-action="delete" data-id="${escape(id)}" aria-label="Usuń terminówkę">🗑</button>
      <button type="button" class="appointments-green" data-action="close" autofocus>OK</button>
      <button type="button" class="appointments-yellow" data-action="edit" data-id="${escape(id)}" aria-label="Edytuj terminówkę">✎</button></div>`, 'details:' + id);
  }
  function pasteEditor() {
    open(`${header('Zgłoś nową terminówkę')}<form id="appointmentPasteForm">
      <button type="button" class="appointments-yellow" data-action="clipboard">Wklej ze schowka</button>
      <label>Blok z ChatGPT<textarea id="appointmentPasteText" rows="7" maxlength="100000" spellcheck="false" required>${escape(state.drafts['integrated-paste'] || '')}</textarea></label>
      <div id="appointmentPastePreview" class="appointments-help"></div>
      <p id="appointmentError" class="appointments-error" role="alert"></p>
      <div class="appointments-actions"><button type="button" data-action="close">Anuluj</button><button type="submit" class="appointments-yellow">Wyślij nową</button></div>
      </form>`, 'paste');
    const area = dialog.querySelector('#appointmentPasteText');
    area.addEventListener('input', () => {
      repository.draft('integrated-paste', area.value).catch(() => error('Nie udało się zachować szkicu. Skopiuj blok przed zamknięciem.'));
      previewPaste();
    });
    dialog.querySelector('form').addEventListener('submit', sendPaste);
    previewPaste();
  }
  async function previewPaste() {
    const area = dialog.querySelector('#appointmentPasteText'), target = dialog.querySelector('#appointmentPastePreview');
    if (!area || !target) return;
    const raw = area.value;
    try {
      const { parsed } = await root.TarczaPaste.parseInput(raw);
      if (area.value !== raw) return;
      target.textContent = `Początek: ${format(parsed.startAt)} · Odbiór: ${format(parsed.pickupAt)} · Koniec: ${format(parsed.endAt)}`;
    } catch (cause) { if (area.value === raw) target.textContent = raw.trim() ? cause.message : 'Wklej cały blok z datą. Sprawdź podgląd przed wysłaniem.'; }
  }
  async function sendPaste(event) {
    event.preventDefault(); if (busy) return; busy = true;
    const button = event.submitter; if (button) button.disabled = true;
    try {
      const { id, parsed } = await root.TarczaPaste.parseInput(dialog.querySelector('#appointmentPasteText').value);
      if (Date.parse(parsed.endAt) <= now()) throw Error('Ten kurs już się zakończył. Sprawdź datę i godziny.');
      const saved = await repository.importEntry(parsed, id, now());
      state = await repository.store.transact(s => {
        s.deliveries ||= {};
        s.deliveries[saved.id] = { date: parsed.date, text: parsed.text, status: 'sending', refresh: true };
        delete s.drafts['integrated-paste'];
      });
      close(); // Durable local save precedes closing; no network wait on the main screen.
      message('Terminówka zapisana. Wysyłam do Arkusza…');
      if (channel) channel.postMessage('changed');
      scheduleSync(0);
    } catch (cause) { error(cause.message || 'Nie udało się zapisać. Blok pozostaje w formularzu.'); }
    finally { busy = false; if (button) button.disabled = false; }
  }
  function wheel(label, key, time) {
    const [h, m] = time.split(':');
    return `<fieldset class="appointments-wheel" data-wheel="${key}"><legend>${label}</legend>
      <div class="appointments-time-columns"><div><button type="button" data-action="step" data-key="${key}" data-unit="hour" data-delta="1" aria-label="${label}: godzina plus jeden">▲</button>
      <output data-hour>${h}</output><button type="button" data-action="step" data-key="${key}" data-unit="hour" data-delta="-1" aria-label="${label}: godzina minus jeden">▼</button></div>
      <span>:</span><div><button type="button" data-action="step" data-key="${key}" data-unit="minute" data-delta="1" aria-label="${label}: minuta plus jeden">▲</button>
      <output data-minute>${m}</output><button type="button" data-action="step" data-key="${key}" data-unit="minute" data-delta="-1" aria-label="${label}: minuta minus jeden">▼</button></div></div></fieldset>`;
  }
  function editor(id = '', recoveredText = '', conflictId = '') {
    const r = current(id), key = id || 'new';
    let text = recoveredText || state.drafts[key] || r?.text;
    if (!text) { try { text = C.defaultText(now()); } catch { text = `${C.parts(now()).date}\n12:00–13:00 (na 12:30)_\n\nUwagi:\n`; } }
    let parsed;
    try { parsed = C.parseText(text, { date: r?.date || C.parts(now()).date }); } catch { parsed = null; }
    editorKey = id; editorDirty = !!state.drafts[key];
    editorBase = r ? C.contentSignature(r) : undefined; editorConflictId = conflictId;
    const p = key => parsed ? C.parts(Date.parse(parsed[key])).time : '00:00';
    open(`${header(id ? 'Edytuj terminówkę' : 'Nowa terminówka')}
      <form id="appointmentsForm"><label>Data początku <input type="date" id="appointmentDate" required value="${escape(parsed?.date || r?.date || C.parts(now()).date)}"></label>
      ${id ? '' : `<p class="appointments-help">Odbiór: około +8 godzin. Początek i koniec są propozycją ±30 minut — sprawdź je przed zapisem.</p><div class="appointments-wheels">${wheel('Początek', 'startAt', p('startAt'))}${wheel('Odbiór', 'pickupAt', p('pickupAt'))}${wheel('Koniec', 'endAt', p('endAt'))}</div>`}
      <label>Pełny wpis <textarea id="appointmentText" rows="8" maxlength="20000" spellcheck="false" required>${escape(text)}</textarea></label>
      <p class="appointments-help">Format: 12:50–13:55 (na 13:30)_Luboń. Przez północ: 23:50–00:55 (na 00:30). Inny dzień: dopisz YYYY-MM-DD przed godziną. Przy zmianie czasu można dopisać +01:00 lub +02:00.</p>
      <p id="appointmentError" class="appointments-error" role="alert"></p>
      <div class="appointments-actions"><button type="button" class="appointments-red" data-action="cancelEdit" aria-label="Anuluj">✕</button>
      <button type="submit" class="appointments-green">✓ Zapisz</button></div></form>`, 'editor');
    dialog.querySelector('textarea')?.addEventListener('input', async event => {
      editorDirty = true;
      try { state = await repository.draft(editorKey, event.target.value); updateWheels(); }
      catch { error('Nie udało się zapisać szkicu. Skopiuj tekst przed zamknięciem.'); }
    });
    dialog.querySelector('#appointmentDate')?.addEventListener('change', () => {
      const input = dialog.querySelector('#appointmentDate'), area = dialog.querySelector('textarea');
      if (!C.validDate(input.value)) return;
      const lines = area.value.split('\n'), heading = lines.findIndex(line => /\(\s*na\s/.test(line));
      if (heading >= 0 && /^\s*\d{4}-\d{2}-\d{2}\s/.test(lines[heading])) lines[heading] = lines[heading].replace(/\d{4}-\d{2}-\d{2}/, input.value);
      else {
        const index = lines.findIndex((line, i) => (heading < 0 || i < heading) && /^\d{4}-\d{2}-\d{2}$/.test(line.trim()));
        if (index >= 0) lines[index] = input.value; else lines.unshift(input.value);
      }
      area.value = lines.join('\n');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    dialog.querySelector('form').addEventListener('submit', saveEditor);
  }
  function error(text) { const target = dialog.querySelector('#appointmentError'); if (target) target.textContent = text; }
  function updateWheels() {
    try {
      const area = dialog.querySelector('textarea'), line = area.value.split('\n').find(line => /\(\s*na\s/.test(line));
      const times = [...line.matchAll(/(?:\d{4}-\d{2}-\d{2}\s+)?([01]\d:[0-5]\d)(?:[+]0[12]:00)?/g)].map(m => m[1]);
      const index = { startAt: 0, endAt: 1, pickupAt: 2 };
      dialog.querySelectorAll('[data-wheel]').forEach(w => {
        const value = times[index[w.dataset.wheel]].split(':');
        w.querySelector('[data-hour]').textContent = value[0];
        w.querySelector('[data-minute]').textContent = value[1];
      });
      try { const parsed = C.parseText(area.value, { date: dialog.querySelector('#appointmentDate').value }); dialog.querySelector('#appointmentDate').value = parsed.date; } catch {}
    } catch { /* Keep a freely editable draft. */ }
  }
  function step(button) {
    try {
      const area = dialog.querySelector('textarea'), lines = area.value.split('\n'), i = lines.findIndex(line => /\(\s*na\s/.test(line));
      if (i < 0) throw Error('Najpierw wpisz wiersz z trzema godzinami.');
      const matches = [...lines[i].matchAll(/((?:\d{4}-\d{2}-\d{2}\s+)?)([01]\d:[0-5]\d)([+]0[12]:00)?/g)];
      const match = matches[{ startAt: 0, endAt: 1, pickupAt: 2 }[button.dataset.key]];
      if (matches.length !== 3 || !match) throw Error('Sprawdź format trzech godzin.');
      const [hour, minute] = match[2].split(':').map(Number), delta = Number(button.dataset.delta);
      // Hours and minutes each wrap independently, one step at a time.
      const h = (hour + (button.dataset.unit === 'hour' ? delta : 0) + 24) % 24;
      const m = (minute + (button.dataset.unit === 'minute' ? delta : 0) + 60) % 60;
      const offset = match.index + match[1].length;
      lines[i] = lines[i].slice(0, offset) + `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` + lines[i].slice(offset + 5);
      area.value = lines.join('\n'); area.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (cause) { error(cause.message); }
  }
  async function saveEditor(event) {
    event.preventDefault(); if (busy) return; busy = true;
    const button = dialog.querySelector('[type="submit"]'); button.disabled = true;
    let parsed;
    try {
      parsed = C.parseText(dialog.querySelector('textarea').value, { date: dialog.querySelector('#appointmentDate').value });
      if (Date.parse(parsed.endAt) <= now()) throw Error('Terminówka już się zakończyła. Sprawdź datę i godziny.');
      await repository.save(parsed, editorKey || undefined, now(), editorBase);
      if (editorConflictId) await repository.store.transact(s => { s.conflicts = s.conflicts.filter(c => c.id !== editorConflictId); });
      message('Zapisano na tym urządzeniu. Czeka na potwierdzenie serwera.');
      await changed(); list();
    } catch (cause) {
      if (cause.code === 'appointmentChanged') {
        try {
          state = await repository.store.transact(s => {
            const remote = s.records[editorKey] || null;
            s.conflicts.push({ id: C.uuid(), appointmentId: editorKey, remote,
              operations: [{ kind: 'put', id: editorKey, record: { ...(remote || {}), ...parsed } }], reason: cause.message });
            delete s.drafts[editorKey];
          });
          message(cause.message, 'error'); list();
        } catch { error('Nie udało się zachować konfliktu. Skopiuj tekst przed zamknięciem.'); }
      } else error(cause.message || 'Nie udało się zapisać. Tekst pozostaje w edytorze.');
    }
    finally { busy = false; button.disabled = false; }
  }
  async function action(event) {
    const button = event.target.closest('button[data-action]'); if (!button || busy) return;
    const { action: act, id } = button.dataset;
    if (act === 'close') { close(); return; }
    if (act === 'new') { editor(); return; }
    if (act === 'paste') { pasteEditor(); return; }
    if (act === 'clipboard') {
      try {
        const text = await navigator.clipboard.readText(), area = dialog.querySelector('#appointmentPasteText');
        if (area) { area.value = text; area.dispatchEvent(new Event('input')); }
      } catch { error('Przytrzymaj pole tekstowe i wybierz Wklej.'); }
      return;
    }
    if (act === 'details') { details(id); return; }
    if (act === 'edit') { editor(id); return; }
    if (act === 'step') { step(button); return; }
    if (act === 'cancelEdit') { editorDirty = false; list(); return; } // Draft is kept for recovery.
    if (act === 'sync') { sync(true); return; }
    try {
      if (act === 'delete') { await repository.remove(id, now()); await changed(); message('Usunięto lokalnie. Oczekuje na potwierdzenie serwera.'); list(); }
      if (act === 'recover') {
        const conflict = state.conflicts.find(c => c.id === id);
        if (conflict) {
          const local = conflict.operations.at(-1)?.record;
          let text = local?.text || '';
          try { C.parseText(text); } catch { if (local?.date) text = `${local.date}\n${text}`; }
          const target = conflict.remote && C.active(conflict.remote, now()) ? conflict.appointmentId : '';
          editor(target, text, conflict.id);
        }
      }
      if (act === 'dismissConflict') {
        state = await repository.store.transact(s => { s.conflicts = s.conflicts.filter(c => c.id !== id); }); list();
      }
      if (act === 'retryDelete') {
        const conflict = state.conflicts.find(c => c.id === id);
        if (conflict && C.active(current(conflict.appointmentId) || { endAt: 0 }, now())) await repository.remove(conflict.appointmentId, now());
        await repository.store.transact(s => { s.conflicts = s.conflicts.filter(c => c.id !== id); });
        await changed(); list();
      }
    } catch (cause) { message(cause.message || 'Nie udało się zapisać zmiany.', 'error'); }
  }
  function arrow(at, backwards) {
    const p = C.point(at), a = C.angle(at) * Math.PI / 180, t = backwards ? -1 : 1;
    const ux = -Math.sin(a) * t, uy = Math.cos(a) * t, nx = Math.cos(a), ny = Math.sin(a);
    el('path', { d: `M ${p.x - ux * 8 + nx * 4} ${p.y - uy * 8 + ny * 4} L ${p.x} ${p.y} L ${p.x - ux * 8 - nx * 4} ${p.y - uy * 8 - ny * 4}`,
      fill: 'none', stroke: '#ff6565', 'stroke-width': 2, 'stroke-linecap': 'round', 'pointer-events': 'none' });
  }
  function label(at, text, color, pickup, id, used) {
    const [hour, minutes] = text.split(':'), displayHour = String(Number(hour));
    const size = pickup ? 24 : 18, minuteSize = pickup ? 14 : 11;
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `700 ${size}px Arial`; const hourWidth = measure.measureText(displayHour).width;
    measure.font = `700 ${minuteSize}px Arial`;
    const width = hourWidth + measure.measureText(minutes).width + 6, height = pickup ? 30 : 24;
    const rect = layer.getBoundingClientRect();
    // The tick ring is narrower than the viewport. Use its side margins before moving a label along the ring.
    const left = Math.max(-35, -30 + (2 - rect.left) * 460 / rect.width);
    const right = Math.min(435, -30 + (window.innerWidth - 2 - rect.left) * 460 / rect.width);
    const top = Math.max(-50, -30 + (2 - rect.top) * 460 / rect.height);
    const bottom = Math.min(450, -30 + (window.innerHeight - 2 - rect.top) * 460 / rect.height);
    let chosen;
    for (const shift of [0, 4, -4, 8, -8, 12, -12, 16, -16]) {
      for (const radius of [230, 238, 246]) {
        const a = (C.angle(at) + shift) * Math.PI / 180;
        const x = Math.max(left + width / 2, Math.min(right - width / 2, 200 + Math.cos(a) * radius));
        const y = Math.max(top + height / 2, Math.min(bottom - height / 2, 200 + Math.sin(a) * radius));
        const nearestX = Math.max(x - width / 2, Math.min(x + width / 2, 200));
        const nearestY = Math.max(y - height / 2, Math.min(y + height / 2, 200));
        if (Math.hypot(nearestX - 200, nearestY - 200) < 207) continue;
        if (used.some(b => Math.abs(b.x - x) < (b.width + width) / 2 + 3 && Math.abs(b.y - y) < (b.height + height) / 2 + 3)) continue;
        chosen = { x, y }; break;
      }
      if (chosen) break;
    }
    if (!chosen) return; // Dense groups retain their markers and the selectable chronological list.
    const { x, y } = chosen; used.push({ x, y, width, height });
    const attrs = { x, y, fill: color, 'font-size': size, 'font-family': 'Arial,sans-serif', 'font-weight': '700',
      'data-appointment-time': text,
      'text-anchor': 'middle', 'dominant-baseline': 'middle', stroke: '#000', 'stroke-width': 2.8, 'paint-order': 'stroke', 'pointer-events': pickup ? 'all' : 'none' };
    if (pickup) {
      const record = current(id);
      const statuses = records().filter(r => r.pickupAt === record?.pickupAt && C.active(r, now())).map(r => deliveryStatus(r.id));
      const delivery = statuses.includes('error') ? 'error' : statuses.includes('sending') ? 'sending' : 'confirmed';
      attrs['data-appointment'] = id; attrs.class = 'appointment-pickup-label'; attrs['data-delivery'] = delivery;
      attrs['aria-label'] = `${text}${delivery === 'sending' ? ' · wysyłanie' : delivery === 'error' ? ' · nie wysłano, ponów' : ''}`;
    }
    const node = el('text', attrs);
    el('tspan', {}, node).textContent = displayHour;
    el('tspan', { 'font-size': minuteSize, dy: pickup ? -8 : -6 }, node).textContent = minutes;
  }
  function render() {
    if (!ready || document.hidden) return;
    const time = now(), active = records().filter(r => C.active(r, time));
    const signature = `${Math.floor(time / 1000)}|${active.map(r => r.id + r.updatedAt + r.revision).join(',')}|${fanIds.join(',')}`;
    if (signature === lastRender) return; lastRender = signature;
    arcs.replaceChildren(); drawTarget = arcs;
    C.segments(active, time).forEach(s => el('path', { d: C.arcPath(s.start, s.end), fill: 'none', stroke: s.conflict ? '#74002b' : '#ef1717',
      'stroke-width': 12, 'stroke-linecap': 'butt', 'data-occupancy-count': s.count, 'pointer-events': 'none' }));
    const intervals = C.visibleIntervals(active, time), used = [], pickupLabels = new Set(), endpointLabels = new Set();
    intervals.forEach(i => { arrow(i.start, true); arrow(i.end, false); });
    const nextAnnotations = active.map(r => `${r.id}|${r.updatedAt}|${r.revision}|${deliveryStatus(r.id)}|${time < Date.parse(r.startAt)}|${Date.parse(r.pickupAt) <= time + C.HORIZON}|${Date.parse(r.endAt) <= time + C.HORIZON}`).join(';') + '|' + layer.getBoundingClientRect().width;
    if (nextAnnotations !== annotationSignature) {
    annotationSignature = nextAnnotations; annotations.replaceChildren(); drawTarget = annotations;
    // Endpoints mark their true times. Draw them before pickup dots so coincident pickups stay red.
    const endpointMarkers = new Set();
    intervals.forEach(i => {
      for (const at of [time < Date.parse(i.record.startAt) ? Date.parse(i.record.startAt) : null, !i.continues ? Date.parse(i.record.endAt) : null]) {
        if (at === null || endpointMarkers.has(at)) continue;
        endpointMarkers.add(at); const p = C.point(at);
        el('circle', { cx: p.x, cy: p.y, r: 8, fill: '#ffa21c', stroke: '#fff', 'stroke-width': 1,
          class: 'appointment-endpoint-marker', 'data-endpoint-at': at, 'pointer-events': 'none' });
      }
    });
    // Draw pickup labels first so endpoints yield to them.
    C.ordered(active).forEach(r => {
      const pickup = Date.parse(r.pickupAt);
      if (pickup > time + C.HORIZON) return;
      const p = C.point(pickup);
      const g = el('g', { 'data-appointment': r.id, role: 'button', tabindex: 0, 'aria-label': `${format(r.pickupAt)} ${r.location}` });
      el('circle', { cx: p.x, cy: p.y, r: 8, fill: '#ff1616', stroke: '#fff', 'stroke-width': 1 }, g);
      el('circle', { cx: p.x, cy: p.y, r: Math.max(22, 22 * 460 / layer.getBoundingClientRect().width), fill: 'transparent', class: 'appointment-hit' }, g);
      if (!pickupLabels.has(pickup)) { label(pickup, C.parts(pickup).time, '#ff2727', true, r.id, used); pickupLabels.add(pickup); }
    });
    intervals.forEach(i => {
      const s = Date.parse(i.record.startAt), e = Date.parse(i.record.endAt);
      if (time < s && !endpointLabels.has(s)) { label(s, C.parts(s).time, '#ffa21c', false, '', used); endpointLabels.add(s); }
      if (!i.continues && !endpointLabels.has(e)) { label(e, C.parts(e).time, '#ffa21c', false, '', used); endpointLabels.add(e); }
      else if (i.continues) { const p = C.point(i.end, 198); el('text', { x: p.x, y: p.y, fill: '#ffa21c', 'font-size': 20, 'text-anchor': 'middle', 'pointer-events': 'none' }).textContent = '»'; }
    });
    }
    drawTarget = null;
    if (view.startsWith('details:') && !C.active(current(view.slice(8)) || { endAt: 0 }, time)) list();
    if (view === 'list' && C.ordered(active).map(r => r.id + r.updatedAt).join('|') !== listSignature) list();
  }
  function hitAt(event) {
    const rect = layer.getBoundingClientRect(), x = event.clientX, y = event.clientY, ids = new Set();
    const targeted = event.target.closest('[data-appointment]');
    if (targeted) {
      ids.add(targeted.dataset.appointment);
      const selected = current(targeted.dataset.appointment);
      if (selected) records().filter(r => C.active(r, now()) && r.pickupAt === selected.pickupAt).forEach(r => ids.add(r.id));
    }
    C.ordered(records().filter(r => C.active(r, now()) && Date.parse(r.pickupAt) <= now() + C.HORIZON)).forEach(r => {
      const p = C.point(Date.parse(r.pickupAt)), px = rect.left + (p.x + 30) / 460 * rect.width, py = rect.top + (p.y + 30) / 460 * rect.height;
      if (Math.hypot(px - x, py - y) <= 25) ids.add(r.id);
    });
    return C.ordered([...ids].map(current).filter(Boolean));
  }
  function selectHits(hits) {
    if (hits.length === 1) details(hits[0].id);
    else if (hits.length > 1) {
      fanIds = hits.map(r => r.id);
      open(`${header('Wybierz terminówkę')}<p>W tym miejscu jest kilka terminów. Dotknij właściwego.</p><div class="appointments-fan">${hits.map(r =>
        `<button type="button" data-action="details" data-id="${escape(r.id)}"><strong>${escape(format(r.pickupAt))}</strong><span>${escape(r.location)}</span></button>`).join('')}</div>`, 'fan');
    }
  }
  async function json(url, body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, { method: body ? 'POST' : 'GET', mode: 'cors', credentials: 'omit', redirect: 'follow', cache: 'no-store',
        headers: body ? { 'Content-Type': 'text/plain;charset=utf-8' } : undefined,
        body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      if (!response.ok) throw Error('Serwer jest chwilowo niedostępny.');
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  function scheduleSync(delay = 30000) { clearTimeout(timer); timer = setTimeout(() => sync(false), delay); }
  async function sync(notify = false) {
    if (!ready || document.hidden) return;
    if (!navigator.onLine) { await updateDeliveries(true); message('Offline — dane i kolejka pozostają na urządzeniu.', 'error'); scheduleSync(); return; }
    if (syncing) { syncAgain = true; return; }
    const config = host.getConfig();
    if (!config?.url || !config?.pin) { await updateDeliveries(true); message('Zapis lokalny. Skonfiguruj dotychczasowy adres Apps Script i PIN synchronizacji.'); scheduleSync(); return; }
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec$/.test(config.url)) { await updateDeliveries(true); message('Nieprawidłowy adres Apps Script.', 'error'); scheduleSync(); return; }
    syncing = true;
    try {
      await updateDeliveries();
      message('Sprawdzam terminówki na serwerze…');
      state = await importer.sync();
      await updateDeliveries(true);
      message(state.conflicts.length ? 'Konflikt zmian — otwórz listę terminówek.' : state.outbox.length ? 'Część zmian czeka na wysłanie.' : 'Terminówki potwierdzone na serwerze.', state.conflicts.length ? 'error' : 'ok');
      lastRender = ''; render(); if (channel) channel.postMessage('changed');
      if (view === 'list') list();
      await refreshWorkday();
    } catch { await updateDeliveries(true); message('Brak potwierdzenia serwera. Dane i kolejka są zachowane; ponowię próbę.', 'error'); }
    finally { syncing = false; const again = syncAgain; syncAgain = false; scheduleSync(again ? 500 : 30000); }
  }
  async function start(options) {
    if (ready) return; host = options;
    const store = new C.IndexedStore(root.indexedDB); repository = new C.Repository(store);
    importer = new root.TarczaPaste.Importer(repository, () => host.getConfig());
    dialog = document.createElement('dialog'); dialog.id = 'appointmentsDialog'; dialog.className = 'appointments-dialog';
    dialog.setAttribute('aria-label', 'Harmonogram terminówek'); document.body.appendChild(dialog);
    dialog.addEventListener('click', action);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('pointerdown', event => { if (event.target === dialog) close(); });
    document.addEventListener('pointerdown', () => { suppressOpeningClick = false; }, true);
    document.addEventListener('click', event => {
      if (suppressOpeningClick && event.detail > 0) { suppressOpeningClick = false; event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    const wrap = document.querySelector('.clock-wrap');
    layer = el('svg', { class: 'appointments-layer', viewBox: '-30 -30 460 460', 'aria-label': 'Zajętość kierowcy', role: 'group' }, wrap);
    arcs = el('g', { 'data-appointments-arcs': '' }, layer);
    annotations = el('g', { 'data-appointments-annotations': '' }, layer);
    // Reuse the existing center hit zone. Its short pointer-up opens the scheduler;
    // its original three-second reset hold remains owned by index.html.
    const button = document.getElementById('clockResetZone');
    button.setAttribute('role', 'button'); button.tabIndex = 0;
    button.setAttribute('aria-label', 'Terminówki: dotknij. Reset: przytrzymaj 3 sekundy.'); button.title = 'Terminówki · przytrzymanie: reset';
    button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (ready) list(); } });
    wrap.addEventListener('pointerdown', event => {
      if (!ready || !host.canOpen() || !event.isPrimary || event.button !== 0 || event.target === button) return;
      const hits = hitAt(event); if (!hits.length) return;
      gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, hits };
      wrap.setPointerCapture(event.pointerId); event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    wrap.addEventListener('pointerup', event => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const g = gesture; gesture = null; event.preventDefault(); event.stopImmediatePropagation();
      if (Math.hypot(event.clientX - g.x, event.clientY - g.y) < 16) { armOpeningClick(); selectHits(g.hits); }
      try { wrap.releasePointerCapture(event.pointerId); } catch {}
    }, true);
    wrap.addEventListener('pointercancel', () => { gesture = null; }, true);
    layer.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.dataset.appointment) {
        event.preventDefault(); selectHits(C.ordered(records().filter(r => C.active(r, now()) && Math.abs(Date.parse(r.pickupAt) - Date.parse(current(event.target.dataset.appointment).pickupAt)) < 5 * C.MINUTE)));
      }
    });
    try {
      state = await store.transact(s => {
        // Reuse the queue left by the earlier standalone sender without copying or losing its records.
        for (const op of s.outbox.filter(o => o.origin === 'paste-create')) {
          s.deliveries ||= {};
          s.deliveries[op.id] ||= { date: op.record.originalDate || op.record.date, text: op.record.originalText, status: 'error', refresh: true };
        }
      });
      ready = true; message('Zapis lokalny gotowy.');
    }
    catch { button.title = 'Nie można otworzyć lokalnej bazy terminówek.'; console.error('Nie można otworzyć lokalnej bazy terminówek.'); return; }
    if (typeof BroadcastChannel !== 'undefined') { channel = new BroadcastChannel('tarcza-appointments-v1'); channel.onmessage = () => load().then(() => { if (view === 'list') list(); }); }
    window.addEventListener('online', () => scheduleSync(0));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load().then(() => scheduleSync(0)); });
    window.addEventListener('resize', () => { lastRender = ''; render(); });
    setInterval(() => {
      render();
      const cfg = host.getConfig(), key = cfg?.url + '|' + cfg?.pin;
      if (key !== lastConfigKey) { lastConfigKey = key; importer.capabilityUrl = ''; scheduleSync(500); }
    }, 1000);
    render(); scheduleSync(1500);
  }
  root.TarczaAppointments = { start, isOpen: () => !!dialog?.open, isTransferring, open: () => { if (ready) { armOpeningClick(); list(); } }, sync, version: C.VERSION };
})(window);
