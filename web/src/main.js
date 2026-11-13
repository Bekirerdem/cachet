// The app: one phone column, five steps. The model copies; the checks in ../core decide what
// may be shown; the person confirms every line before it enters the plan. Papers are kept
// on this device only.
import './style.css';
import lensUrl from './assets/glass-lens.jpg?url';
import frostUrl from './assets/glass-frost.jpg?url';
import letterUrl from '../../samples/out/de-letter.photo.png?url';
import labUrl from '../../samples/out/tr-lab.photo.png?url';
import { isVerificationError } from '@nearai/inference-sdk';
import { APP_NAME, LANGUAGE_NAMES, PLAN, RTL, STRINGS, pickLanguage } from './i18n.js';
import { prepareImage, seal } from './image.js';
import { LANGUAGES, createEngine, isEmpty, isLab, recordReceipt } from './engine.js';
import { compareLines, compareRows, differingPart } from '../../core/compare.mjs';
import { openPoints, readSlots } from '../../core/plan.mjs';
import { detectDecimalStyle, placeInRange, tidyRow } from '../../core/ranges.mjs';

const STORE = 'papers.v1';
const EXPLORER = 'https://testnet.nearblocks.io/txns/';
const MAX_PAGES = 6;
const KEPT_PAPERS = 30;
const SECOND_READER_WAIT = 90_000; // after this the paper goes on with one reader, and says so
const FIELDS = { medicines: ['name', 'strength', 'schedule', 'duration'], follow_ups: ['what', 'when'], cautions: ['text'], row: ['value', 'unit', 'range'] };
const STEP = { start: 1, prepare: 2, sending: 2, compare: 3, working: 4, plan: 4, proof: 5 };

const app = document.getElementById('app');
const state = {
  lang: pickLanguage(),
  planLang: localStorage.getItem('planLang'),
  screen: 'start', step: 1, over: null, note: null,
  shots: [], shot: 0, photos: [],
  paper: null, active: 0, editing: false, shownPage: -1,
  checks: {}, reading: 0, engine: null, synced: 0, error: null,
};
// Opened with ?test, the page exposes its state so a scripted browser can follow a run.
if (new URLSearchParams(location.search).has('test')) {
  window.__state = state;
  window.__samples = { letter: letterUrl, lab: labUrl };
}
document.title = APP_NAME;

const t = (key, vars = {}) => (STRINGS[state.lang][key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
const p = (key, vars = {}) => ((PLAN[state.paper?.planLang] ?? PLAN.en)[key] ?? PLAN.en[key]).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const short = (hex) => `${hex.slice(0, 8)}…${hex.slice(-8)}`;
const size = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toLocaleString(state.lang, { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const secondsSince = (start) => Number(((performance.now() - start) / 1000).toFixed(1));

/* ---------- papers kept on this device ---------- */

const loadPapers = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '[]');
  } catch {
    return [];
  }
};
function savePaper() {
  const rest = loadPapers().filter((saved) => saved.id !== state.paper.id);
  localStorage.setItem(STORE, JSON.stringify([state.paper, ...rest].slice(0, KEPT_PAPERS)));
}
function paperKind(paper) {
  const kinds = paper.pages.map((page) => (page.lab ? 'lab' : page.document_kind));
  if (kinds.every((k) => k === 'lab')) return 'kind_lab';
  if (kinds.includes('lab')) return 'kind_mixed';
  if (kinds.every((k) => k === 'prescription')) return 'kind_prescription';
  if (kinds.every((k) => k === 'imaging_report')) return 'kind_imaging';
  return 'kind_letter';
}

/* ---------- frame ---------- */

function render() {
  const screen = SCREENS[state.screen]();
  state.step = STEP[state.screen] ?? state.step;
  app.innerHTML = `
    <header class="head">
      <div class="steps">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= state.step ? 'on' : ''}"></i>`).join('')}</div>
      <div class="headrow">
        ${screen.back ? `<button class="textbtn" data-act="${screen.back[0]}">${t(screen.back[1])}</button>` : `<span class="wordmark">${APP_NAME}</span>`}
        <div class="lang">${Object.keys(STRINGS).map((l) => `<button data-lang="${l}" class="${l === state.lang ? 'on' : ''}" aria-pressed="${l === state.lang}">${l.toUpperCase()}</button>`).join('')}</div>
      </div>
    </header>
    <main class="view" id="view">${screen.view}</main>
    <footer class="dock" id="dock">${screen.dock ?? ''}</footer>
    ${state.over ? overlay() : ''}`;
  document.documentElement.lang = state.lang;
  // Beside the phone column on a wide screen: what this is, in a few plain words.
  document.getElementById('side').innerHTML = `<h2>${t('side_h')}</h2><p>${t('side_p')}</p><ul>${[1, 2, 3].map((n) => `<li><b>${t(`side_${n}`)}</b>${t(`side_${n}t`)}</li>`).join('')}</ul>`;
  screen.after?.();
}

function go(screen) {
  state.screen = screen;
  state.over = null;
  render();
}

/* ---------- 1 · start ---------- */

function startScreen() {
  const papers = loadPapers();
  const date = (at) => new Date(at).toLocaleDateString(state.lang, { day: 'numeric', month: 'short', year: 'numeric' });
  const library = papers.length
    ? `<div class="plate arr"><span class="lbl">${t('papers')}</span>
        ${papers.map((paper) => `<div class="rowp"><button class="rowbtn" data-act="open" data-id="${paper.id}"><b>${t(paperKind(paper))}</b><small>${date(paper.at)}${paper.pages.length > 1 ? ` · ${t('pages_n', { n: paper.pages.length })}` : ''}${paper.title ? ` · ${esc(paper.title)}` : ''}</small></button><button class="more" data-act="delete-one" data-id="${paper.id}">${t('delete_one')}</button></div>`).join('')}
        <div class="rowp"><button class="more" data-act="delete-all">${t('delete_all')}</button></div></div>`
    : '';
  return {
    view: `
      <h1 class="land">${t('start_h')}</h1>
      <p class="lead land">${t('start_p')}</p>
      <button class="more" data-act="how">${t('how')}</button>
      ${library}
      <div class="obj ${papers.length ? 'mid' : ''}" style="background-image:url(${lensUrl})"></div>`,
    dock: `
      <label class="btn">${t('take')}<input type="file" accept="image/*" capture="environment" data-file></label>
      <div class="links">
        <label class="link">${t('choose')}<input type="file" accept="image/*" multiple data-file></label>
        <button class="link" data-act="sample-letter">${t('sample_letter')}</button>
        <button class="link" data-act="sample-lab">${t('sample_lab')}</button>
      </div>
      <p class="foot c">${navigator.onLine ? (state.note ? esc(state.note) : t('disclaimer')) : t('offline')}</p>`,
  };
}

/* ---------- 2a · hide your name ---------- */

async function addShots(files) {
  state.note = null;
  for (const file of [...files].slice(0, MAX_PAGES - state.shots.length)) {
    const { canvas, preview } = await prepareImage(file);
    state.shots.push({ canvas, preview, boxes: [] });
  }
  if (state.shots.length === 0) return;
  state.shot = state.shots.length - 1;
  if (state.screen === 'prepare') render();
  else go('prepare');
}

function prepareScreen() {
  const shot = state.shots[state.shot];
  const total = state.shots.length;
  const planLang = state.planLang ?? state.lang;
  return {
    back: ['home', 'home'],
    view: `
      <h1 class="small land">${t('hide_h')}</h1>
      <p class="lead land" style="max-width:none">${t('hide_p')}</p>
      <div class="pagebar">
        <span class="lbl">${t('page_of', { n: state.shot + 1, total })}</span>
        <div class="chips">${total > 1 ? state.shots.map((_, i) => `<button class="pagechip ${i === state.shot ? 'on' : ''}" data-act="shot" data-i="${i}" aria-label="${t('page_of', { n: i + 1, total })}">${i + 1}</button>`).join('') : ''}</div>
        ${total < MAX_PAGES ? `<label class="more">${t('add_page')}<input type="file" accept="image/*" multiple data-file></label>` : ''}
      </div>
      <div class="stagewrap"><div class="stage" id="stage"><img src="${shot.preview}" alt="" draggable="false">${boxesHtml(shot)}</div></div>
      <div class="links left">
        <button class="link" data-act="top-strip">${t('top_strip')}</button>
        ${shot.boxes.length ? `<button class="link" data-act="clear-boxes">${t('clear_boxes')}</button>` : ''}
        ${total > 1 ? `<button class="link" data-act="remove-shot">${t('remove_page')}</button>` : ''}
      </div>
      <p class="foot" id="boxnote">${shot.boxes.length ? `${t('hidden_n', { n: shot.boxes.length })}. ${t('box_hint')}` : ''}</p>
      <label class="pick"><span class="lbl">${t('plan_lang')}</span>
        <select data-planlang>${Object.keys(LANGUAGES).map((l) => `<option value="${l}" ${l === planLang ? 'selected' : ''}>${LANGUAGE_NAMES[l]}</option>`).join('')}</select></label>`,
    dock: `<button class="btn" data-act="send">${total > 1 ? t('send_many', { n: total }) : t('send_one')}</button><p class="foot c" style="margin-top:10px">${t('not_sent')}</p>`,
    after: bindStage,
  };
}

const boxesHtml = (shot) => shot.boxes.map((b, i) => `<button class="box" data-box="${i}" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%" aria-label="${t('box_hint')}"></button>`).join('');

// Drawing a box: press, drag, release. Works the same with a finger and a mouse.
function bindStage() {
  const stage = document.getElementById('stage');
  if (!stage) return;
  let from = null;
  let live = null;
  const at = (event) => {
    const r = stage.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (event.clientY - r.top) / r.height)) };
  };
  let tapped = null; // a box under the finger: lifting the finger on it removes it
  stage.addEventListener('pointerdown', (event) => {
    const box = event.target.closest('.box');
    if (box) {
      tapped = { index: Number(box.dataset.box), at: at(event) };
      return;
    }
    from = at(event);
    live = document.createElement('div');
    live.className = 'box live';
    stage.appendChild(live);
    stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  stage.addEventListener('pointermove', (event) => {
    if (!from) return;
    const to = at(event);
    Object.assign(live.style, { left: `${Math.min(from.x, to.x) * 100}%`, top: `${Math.min(from.y, to.y) * 100}%`, width: `${Math.abs(to.x - from.x) * 100}%`, height: `${Math.abs(to.y - from.y) * 100}%` });
  });
  const end = (event) => {
    if (tapped) {
      // A touch screen does not always follow a tap with a click, so the tap itself removes the box.
      const to = at(event);
      const { index } = tapped;
      const still = Math.abs(to.x - tapped.at.x) < 0.04 && Math.abs(to.y - tapped.at.y) < 0.04;
      tapped = null;
      if (still && event.type === 'pointerup') {
        state.shots[state.shot].boxes.splice(index, 1);
        state.boxRemovedAt = performance.now();
        render();
      }
      return;
    }
    if (!from) return;
    const to = at(event);
    const box = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
    from = null;
    if (box.w > 0.02 && box.h > 0.008) state.shots[state.shot].boxes.push(box);
    render();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

/* ---------- 2b · sending ---------- */

const CHECKS = [
  ['hw', 'c_hw', 'c_hw_run'],
  ['enc', 'c_enc', 'c_enc_wait'],
  ['read', 'c_read', 'c_read_wait'],
  ['two', 'c_two', 'c_two_wait'],
];

function checkPlate([id, title, idle], i) {
  const check = state.checks[id] ?? { status: 'waiting' };
  // "alone": the second reader did not answer. Not a failure of the reading, and said in its own words.
  const word = { waiting: 'waiting', running: 'running', done: id === 'two' ? 'done' : 'passed', failed: 'failed', alone: 'one_reader' }[check.status];
  return `<div class="plate arr ${check.status === 'done' ? 'clear' : ''}" id="check-${id}" style="--i:${i}">
    <div class="rowp"><b>${t(title)}</b><span class="chip ${check.status === 'waiting' || check.status === 'alone' ? 'wait' : ''} ${check.status === 'running' ? 'running' : ''} ${check.status === 'failed' ? 'bad' : ''}">${t(word)}</span></div>
    <small>${esc(check.detail ?? t(idle))}</small></div>`;
}

function setCheck(id, status, detail) {
  const before = state.checks[id]?.status;
  state.checks[id] = { status, detail };
  const plate = document.getElementById(`check-${id}`);
  if (!plate) return;
  const i = CHECKS.findIndex((c) => c[0] === id);
  plate.outerHTML = checkPlate(CHECKS[i], i).replace('plate arr', 'plate');
  if (status === 'done' && before !== 'done') document.querySelector(`#check-${id} .chip`)?.classList.add('pop');
}

const slab = (low = false) => (state.photos[state.reading] ? `<div class="slab ${low ? 'low' : ''}"><img id="slabimg" src="${state.photos[state.reading]}" alt=""></div>` : `<div class="obj small" style="background-image:url(${frostUrl})"></div>`);

function sendingScreen() {
  const total = state.photos.length;
  return {
    view: `
      <h1 class="land">${t('send_h')}</h1>
      ${slab(true)}
      ${total > 1 ? `<span class="lbl" id="pageinfo" style="text-align:center;margin-bottom:6px">${t('page_of', { n: state.reading + 1, total })}</span>` : ''}
      <div id="checks">${CHECKS.map(checkPlate).join('')}</div>`,
  };
}

/* ---------- reading ---------- */

function failure(error) {
  const text = `${error?.failure?.code ?? ''} ${error?.message ?? error}`;
  if (error?.appKey) return error.appKey;
  if (isVerificationError(error)) return 'err_hw';
  if (/\b429\b|too many/i.test(text)) return 'err_busy';
  if (/not JSON|empty reply|does not match|is not a list|no summary|is not text/i.test(text)) return 'err_reply';
  if (error instanceof TypeError || /network|fetch/i.test(text)) return 'err_net';
  return 'err_other';
}
const appError = (appKey) => Object.assign(new Error(appKey), { appKey });

function fail(error) {
  console.error(error);
  state.error = { key: failure(error), detail: String(error?.message ?? error).slice(0, 220) };
  go('error');
}

const LINE_KINDS = ['medicines', 'follow_ups', 'cautions'];
const rowLine = (r) => [r.name, r.value, r.unit, r.range, r.flag].filter((part) => String(part ?? '').trim() !== '').join('   ');

/** Where a copied line sits in the page text; whitespace may differ, nothing else. */
function locate(text, source) {
  const tokens = String(source ?? '').trim().split(/\s+/).filter(Boolean).map(escRe);
  if (tokens.length === 0) return null;
  const hit = new RegExp(tokens.join('\\s+')).exec(text);
  return hit ? [hit.index, hit.index + hit[0].length] : null;
}

async function send() {
  if (!navigator.onLine) {
    // Nothing can be read without a connection; say so here instead of failing halfway.
    const note = document.querySelector('#dock .foot');
    if (note) note.textContent = t('offline_send');
    return;
  }
  state.photos = state.shots.map((shot) => seal(shot.canvas, shot.boxes));
  state.hidden = state.shots.reduce((n, shot) => n + shot.boxes.length, 0);
  state.shots = [];
  state.planLang ??= state.lang;
  await begin();
}

async function begin() {
  // readers: how many pages two models read, on how many the second did not answer, and on how many lines they parted.
  const paper = { id: Date.now().toString(36), at: Date.now(), planLang: state.planLang, pages: [], entries: [], plain: null, explanation: null, placements: [], exchanges: [], records: [], timings: {}, title: '', hidden: state.hidden, readers: { pages: 0, alone: 0, apart: 0 } };
  Object.assign(state, { paper, checks: { hw: { status: 'running', detail: t('c_hw_run') } }, reading: 0, active: 0, editing: false, shownPage: -1, synced: 0, error: null, note: null });
  go('sending');
  const started = performance.now();
  try {
    const engine = createEngine();
    state.engine = engine;
    paper.timings.hardware = await engine.verifyHardware();
    setCheck('hw', 'done', t('c_hw_done0', { s: paper.timings.hardware }));
    const total = state.photos.length;
    for (let n = 0; n < total; n += 1) {
      state.reading = n;
      if (n > 0) {
        document.getElementById('slabimg')?.setAttribute('src', state.photos[n]);
        const info = document.getElementById('pageinfo');
        if (info) info.textContent = t('page_of', { n: n + 1, total });
      }
      setCheck('enc', 'running', t('c_enc_wait'));
      setCheck('read', 'waiting');
      setCheck('two', 'running', t('c_two_run'));
      // The second reader works on the same page at the same time, on its own. If it fails or takes
      // too long the paper goes on with one reader.
      const second = Promise.race([engine.readSecond(state.photos[n], n), pause(SECOND_READER_WAIT).then(() => null)]).catch(() => null);
      const page = await engine.read(state.photos[n], (wire) => {
        if (!wire.encrypted) return;
        setCheck('enc', 'done', t('c_enc_done', { size: size(wire.bytes), seen: wire.seen.slice(0, 18) }));
        setCheck('read', 'running', t('c_read_copy'));
      }, n);
      if (n === 0) {
        const { hardware } = engine.exchanges.find((x) => x.step === 'read');
        setCheck('hw', 'done', t('c_hw_done', { tcb: hardware.tcbStatus, gpu: t(hardware.gpuEvidence === 'verified' ? 'verified' : 'not_given'), s: paper.timings.hardware }));
      }
      page.rows = page.rows.map(tidyRow);
      page.lab = isLab(page);
      page.skipped = isEmpty(page);
      const mine = []; // this page's lines, in the order the comparison returns them
      let plan = null;
      if (page.skipped) {
        page.paperText = page.text;
      } else if (page.lab) {
        const lines = page.rows.map(rowLine);
        page.paperText = lines.join('\n');
        let at = 0;
        page.rows.forEach((row, i) => {
          mine.push({ page: n, kind: 'row', data: { ...row }, paper: lines[i], span: [at, at + lines[i].length], status: 'pending' });
          at += lines[i].length + 1;
        });
      } else {
        page.paperText = page.text;
        setCheck('read', 'running', t('c_read_plan'));
        ({ plan } = await engine.plan(page.text, n));
        for (const kind of LINE_KINDS) {
          for (const data of plan[kind]) mine.push({ page: n, kind, data: { ...data }, paper: data.source, span: locate(page.text, data.source), status: 'pending' });
        }
      }
      if (!page.skipped) {
        setCheck('read', 'done', t('c_read_done'));
        const other = await second;
        paper.readers.pages += 1;
        if (!other) {
          paper.readers.alone += 1;
          for (const entry of mine) entry.two = { status: 'single' };
        } else if (page.lab) {
          const result = compareRows(page.rows, other.page.rows);
          mine.forEach((entry, i) => { entry.two = result.rows[i]; });
          for (const row of result.extra) mine.push({ page: n, kind: 'row', data: { ...row }, paper: rowLine(row), span: null, status: 'pending', two: { status: 'only2' } });
        } else {
          const result = compareLines(plan, other.page.text, other.plan ?? undefined);
          const at = { medicines: 0, follow_ups: 0, cautions: 0 };
          for (const entry of mine) entry.two = result.lines[entry.kind][at[entry.kind]++];
          for (const kind of LINE_KINDS) {
            for (const data of result.extra[kind]) mine.push({ page: n, kind, data: { ...data }, paper: data.source, span: locate(page.text, data.source), status: 'pending', two: { status: 'only2' } });
          }
        }
        paper.readers.apart += mine.filter((entry) => !['agree', 'single'].includes(entry.two.status)).length;
      }
      paper.entries.push(...mine);
      delete page.rows; // the rows now live in the entries, where the person confirms them
      paper.pages.push(page);
    }
    const { readers } = paper;
    if (readers.pages > 0 && readers.alone === readers.pages) setCheck('two', 'alone', t('c_two_alone'));
    else setCheck('two', 'done', t(readers.alone ? 'c_two_some' : readers.apart ? 'c_two_diff' : 'c_two_same', { n: readers.apart }));
    if (paper.pages.every((page) => page.skipped)) throw appError(paper.pages.some((page) => page.document_kind === 'not_a_medical_document') ? 'err_not_medical' : 'err_empty');
    const first = paper.pages.find((page) => !page.skipped && !page.lab);
    paper.title = (first?.text.split('\n').map((line) => line.trim()).find((line) => line.length > 2) ?? '').slice(0, 48);
    paper.timings.reading = secondsSince(started);
    await pause(reduced ? 0 : 900);
    if (paper.entries.length === 0) await finish();
    else go('compare');
  } catch (error) {
    for (const [id] of CHECKS) if (state.checks[id]?.status === 'running') state.checks[id].status = 'failed';
    fail(error);
  }
}

/* ---------- 3 · same as the paper? ---------- */

const entries = () => state.paper.entries;
const decided = () => entries().filter((e) => e.status !== 'pending').length;
const kept = (kind = null) => entries().filter((e) => (e.status === 'same' || e.status === 'corrected') && (kind === null || e.kind === kind));
const manyPages = () => state.paper.pages.length > 1;

function unreadablePlate() {
  const parts = state.paper.pages.flatMap((page) => page.unreadable ?? []);
  if (parts.length === 0) return '';
  // Where the model itself says it could not read, the lines it did copy deserve less trust. Say so first.
  return `<div class="plate warn"><span class="lbl">${t('unreadable')}</span><div class="item">${t('unreadable_t')}</div><details><summary><span class="more">${t('unreadable_more', { n: parts.length })}</span></summary>${parts.map((u) => `<div class="item sm" dir="auto">${esc(u)}</div>`).join('')}</details></div>`;
}

function compareScreen() {
  state.shownPage = -1;
  return {
    back: ['home', 'home'],
    view: `
      <h1 class="small land">${t('cmp_h')}</h1>
      ${unreadablePlate()}
      <div class="paper" id="paper"><div class="sheet" id="sheet"><pre class="blur" id="blur"></pre><pre class="sharp" id="sharp"></pre><div class="lens" id="lens"></div></div></div>
      ${state.photos.length ? `<button class="more" data-act="photo">${t('photo')}</button>` : ''}
      <div id="entry"></div>`,
    dock: '<div id="cmpdock"></div>',
    after: () => paintCompare(false),
  };
}

function entryPlate(entry) {
  if (!entry) {
    const ok = kept().length;
    return `<div class="plate clear arr"><div class="item">${ok ? t('cmp_done', { ok, left: entries().length - ok }) : t('cmp_nothing')}</div></div>`;
  }
  const fields = FIELDS[entry.kind];
  const where = manyPages() ? ` · ${t('page_tag', { n: entry.page + 1 })}` : '';
  if (apart(entry) && entry.status === 'pending' && !state.editing) return apartPlate(entry, where);
  const head = `<span class="lbl">${t(entry.span ? 'cmp_lens' : 'cmp_line')} · ${t(`k_${entry.kind}`)}${where}</span><span class="quote" dir="auto" style="margin-top:8px">${esc(entry.paper)}</span>${readersNote(entry)}`;
  if (state.editing) {
    return `<div class="plate arr">${head}${fields.map((f) => `<label class="field"><span class="lbl">${t(`f_${f}`)}</span><input data-field="${f}" value="${esc(entry.data[f])}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`).join('')}</div>`;
  }
  const value = (f) => (String(entry.data[f] ?? '').trim() === '' ? `<span class="gen">${t('not_stated')}</span>` : `<b>${esc(entry.data[f])}</b>`);
  const rows = entry.kind === 'cautions' ? '' : fields.map((f) => `<div class="rowp"><span class="k">${t(`f_${f}`)}</span><span class="r">${value(f)}</span></div>`).join('');
  const warn = entry.kind === 'row' && entry.data.readable === false ? `<small>${t('row_unreadable')}</small>` : '';
  const name = entry.kind === 'row' ? `<div class="rowp"><b>${esc(entry.data.name)}</b></div>` : '';
  const body = name || rows || warn ? `<div class="from">${name}${rows}${warn}</div>` : '';
  return `<div class="plate arr ${entry.status === 'pending' ? '' : 'clear'}">${head}${body}${entry.status === 'corrected' ? `<small>${t('by_you')}</small>` : ''}</div>`;
}

/* Two readers. A line they did not copy the same cannot be confirmed with one tap on "Same":
   both readings are shown and the person says which one the paper has. */
const twoStatus = (entry) => entry.two?.status ?? 'unknown'; // papers saved before there were two readers
const apart = (entry) => ['differ', 'missing', 'only2'].includes(twoStatus(entry));
const agreed = (entry) => !apart(entry);
const readersNote = (entry) => {
  const key = { agree: 'two_same', single: 'two_single' }[twoStatus(entry)];
  return key && entry.status === 'pending' && !state.editing ? `<small class="readers ${key === 'two_same' ? 'ok' : ''}">${t(key)}</small>` : '';
};
// The stretch where two readings of a line part, marked in both.
function marked(mine, theirs) {
  const [start, endA, endB] = differingPart(mine, theirs);
  const cut = (text, end) => `${esc(text.slice(0, start))}<mark>${esc(text.slice(start, end))}</mark>${esc(text.slice(end))}`;
  return [cut(mine, endA), cut(theirs, endB)];
}

function apartPlate(entry, where) {
  const status = twoStatus(entry);
  const label = `<span class="lbl">${t(`k_${entry.kind}`)}${where}</span>`;
  if (status === 'only2') {
    const fields = FIELDS[entry.kind].filter((f) => entry.kind !== 'cautions' && String(entry.data[f] ?? '').trim() !== '');
    return `<div class="plate warn arr">${label}<div class="item">${t('two_only2')}</div>
      <div class="from"><span class="lbl">${t('reader2')}</span><span class="quote" dir="auto" style="margin-top:6px">${esc(entry.paper)}</span>${fields.map((f) => `<div class="rowp sm"><span class="k">${t(`f_${f}`)}</span><b class="r">${esc(entry.data[f])}</b></div>`).join('')}</div></div>`;
  }
  const other = entry.two.other ?? null;
  if (entry.kind === 'row') {
    const differs = new Set(entry.two.fields ?? []);
    const shown = ['name', 'value', 'unit', 'range', 'flag'].filter((f) => f === 'name' || f === 'value' || String(entry.data[f] ?? '').trim() !== '' || String(other?.[f] ?? '').trim() !== '');
    // In a field the readers copied differently, the characters that differ are marked in both columns.
    const cell = (f, side) => {
      const mine = String(entry.data[f] ?? '');
      const theirs = String(other?.[f] ?? '');
      const text = differs.has(f) ? marked(mine, theirs)[side] : esc(side === 0 ? mine : theirs);
      return `<span class="cell ${differs.has(f) ? 'diff' : ''}" dir="auto"><i>${t(`r_${f}`)}</i>${text || '&nbsp;'}</span>`;
    };
    const column = (title, side) => `<div class="reading"><span class="lbl">${title}</span>${side === 0 || other ? shown.map((f) => cell(f, side)).join('') : `<span class="cell gen">${t('two_nothing')}</span>`}</div>`;
    return `<div class="plate warn arr">${label}<div class="item">${t(other ? 'two_differ' : 'two_missing')}</div><div class="duo">${column(t('reader1'), 0)}${column(t('reader2'), 1)}</div></div>`;
  }
  const theirs = other?.line ?? '';
  const [a, b] = theirs ? marked(entry.paper, theirs) : [esc(entry.paper), ''];
  return `<div class="plate warn arr">${label}<div class="item">${t(theirs ? 'two_differ' : 'two_missing')}</div>
    <div class="from"><span class="lbl">${t('reader1')}</span><span class="quote marks" dir="auto" style="margin-top:6px">${a}</span></div>
    <div class="from"><span class="lbl">${t('reader2')}</span>${theirs ? `<span class="quote marks" dir="auto" style="margin-top:6px">${b}</span>` : `<span class="gen" style="display:block;margin-top:6px;font-size:13px">${t('two_nothing')}</span>`}</div></div>`;
}

function compareDock(entry) {
  const count = `<p class="foot c" style="margin-top:8px">${t('cmp_progress', { n: decided(), total: entries().length })}</p>`;
  if (!entry) {
    return `<button class="btn" data-act="finish" ${kept().length ? '' : 'disabled'}>${t('make')}</button><div class="links"><button class="link" data-act="prev">${t('prev')}</button></div>`;
  }
  if (state.editing) return `<div class="pair"><button class="btn" data-act="save">${t('save')}</button><button class="btn ghost" data-act="cancel">${t('cancel')}</button></div>${count}`;
  const back = state.active > 0 ? `<button class="link" data-act="prev">${t('prev')}</button>` : '';
  if (apart(entry) && entry.status === 'pending') {
    const status = twoStatus(entry);
    const hasOther = status === 'differ' && (entry.kind === 'row' || Boolean(entry.two.other?.line));
    const buttons = status === 'only2'
      ? `<button class="btn" data-act="pick-1">${t('two_keep')}</button><button class="btn ghost" data-act="leave">${t('two_drop')}</button>`
      : hasOther
        ? `<button class="btn ghost" data-act="pick-1">${t('pick1')}</button><button class="btn ghost" data-act="pick-2">${t('pick2')}</button>`
        : `<button class="btn ghost" data-act="pick-1">${t('pick1')}</button><button class="btn ghost" data-act="edit">${t('correct')}</button>`;
    return `<div class="pair">${buttons}</div>
      <div class="links">${hasOther || status === 'only2' ? `<button class="link" data-act="edit">${t('correct')}</button>` : ''}${status === 'only2' ? '' : `<button class="link" data-act="leave">${t('leave')}</button>`}${back}</div>${count}`;
  }
  const rowsLeft = entries().some((e) => e.status === 'pending' && e.kind === 'row' && agreed(e) && e !== entry);
  return `<div class="pair"><button class="btn" data-act="same">${t('same')}</button><button class="btn ghost" data-act="edit">${t('correct')}</button></div>
    <div class="links"><button class="link" data-act="leave">${t('leave')}</button>${back}${entry.kind === 'row' && rowsLeft ? `<button class="link" data-act="all-same">${t('all_same')}</button>` : ''}</div>${count}`;
}

/** The person says which of two readings the paper has. */
function pick(which) {
  const entry = entries()[state.active];
  if (!entry) return;
  entry.picked = which;
  if (which === 2 && twoStatus(entry) === 'differ') {
    const other = entry.two.other;
    if (entry.kind === 'row') {
      entry.data = { ...other };
      entry.paper = rowLine(other);
    } else if (other.data) {
      entry.data = { ...other.data };
      entry.paper = other.data.source;
    } else {
      // The second reader copied the line but did not list it: its wording becomes the line, and
      // the person fills in the parts from the paper.
      entry.paper = other.line;
      entry.data.source = other.line;
      state.editing = true;
      paintCompare();
      return;
    }
    entry.span = null;
  }
  decide('same');
}

async function paintCompare(swap = true) {
  const entry = entries()[state.active];
  const box = document.getElementById('entry');
  if (!box) return;
  if (swap && box.firstElementChild && !reduced) {
    box.firstElementChild.classList.remove('arr');
    box.firstElementChild.classList.add('out');
    await pause(200);
  }
  box.innerHTML = entryPlate(entry);
  document.getElementById('cmpdock').innerHTML = compareDock(entry);
  moveLens(entry);
  if (state.editing) box.querySelector('input')?.focus();
  // Two readings side by side are tall: bring them into view instead of leaving them under the dock.
  else if (entry && apart(entry) && entry.status === 'pending') {
    const view = document.getElementById('view');
    const over = box.getBoundingClientRect().bottom - view.getBoundingClientRect().bottom + 10;
    const room = box.getBoundingClientRect().top - view.getBoundingClientRect().top - 8;
    if (over > 0) view.scrollBy({ top: Math.min(over, room), behavior: reduced ? 'auto' : 'smooth' });
  }
}

function moveLens(entry) {
  const sheet = document.getElementById('sheet');
  const sharp = document.getElementById('sharp');
  const lens = document.getElementById('lens');
  const paper = document.getElementById('paper');
  if (!sheet) return;
  const pageIndex = entry?.page ?? Math.max(0, state.shownPage);
  const text = state.paper.pages[pageIndex].paperText;
  if (state.shownPage !== pageIndex) {
    state.shownPage = pageIndex;
    document.getElementById('blur').textContent = text;
    sharp.textContent = text;
  }
  if (!entry?.span) {
    lens.classList.remove('on');
    sharp.style.clipPath = 'inset(0 100% 100% 0 round 14px)';
    return;
  }
  const [from, to] = entry.span;
  sharp.innerHTML = `${esc(text.slice(0, from))}<mark>${esc(text.slice(from, to))}</mark>${esc(text.slice(to))}`;
  const base = sheet.getBoundingClientRect();
  const rects = [...sharp.querySelector('mark').getClientRects()];
  if (rects.length === 0) return;
  const top = Math.max(0, Math.min(...rects.map((r) => r.top)) - base.top - 6);
  const bottom = Math.min(base.height, Math.max(...rects.map((r) => r.bottom)) - base.top + 6);
  const left = Math.max(5, Math.min(...rects.map((r) => r.left)) - base.left - 9);
  const right = Math.min(base.width - 5, Math.max(...rects.map((r) => r.right)) - base.left + 9);
  Object.assign(lens.style, { top: `${top}px`, left: `${left}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  lens.classList.add('on');
  sharp.style.clipPath = `inset(${top}px ${base.width - right}px ${base.height - bottom}px ${left}px round 14px)`;
  const room = paper.clientHeight;
  const scroll = Math.max(0, Math.min(base.height - room, top - (room - (bottom - top)) / 2));
  sheet.style.transform = `translateY(${-scroll}px)`;
}

function decide(status) {
  const entry = entries()[state.active];
  if (!entry) return;
  entry.status = status;
  state.editing = false;
  const next = entries().findIndex((e, i) => i > state.active && e.status === 'pending');
  state.active = next === -1 ? entries().length : next;
  paintCompare();
}

function saveEdit() {
  const entry = entries()[state.active];
  for (const input of document.querySelectorAll('[data-field]')) entry.data[input.dataset.field] = input.value.trim();
  // The person's own reading of the paper replaces the copied line for everything that follows.
  if (entry.kind !== 'row') entry.data.source = FIELDS[entry.kind].map((f) => entry.data[f]).filter(Boolean).join(' ');
  decide('corrected');
}

/* ---------- plain words ---------- */

function confirmedPlan() {
  const plan = { medicines: [], follow_ups: [], cautions: [] };
  for (const entry of kept()) if (entry.kind !== 'row') plan[entry.kind].push(entry.data);
  return plan;
}
const hasLines = () => kept().some((e) => e.kind !== 'row');

function workingScreen() {
  const rows = [...(hasLines() ? ['w_plain'] : []), 'w_explain'];
  return {
    view: `
      <h1 class="land">${t('work_h')}</h1>
      ${slab()}
      ${rows.map((key, i) => `<div class="plate arr" id="${key}" style="--i:${i}"><div class="rowp"><b>${t(key)}</b><span class="chip running">${t('running')}</span></div></div>`).join('')}
      <p class="foot" style="margin-top:14px">${t('w_check')}</p>`,
  };
}

function workDone(id, ok) {
  const plate = document.getElementById(id);
  if (!plate) return;
  plate.classList.add('clear');
  const chip = plate.querySelector('.chip');
  chip.className = `chip pop ${ok ? '' : 'bad'}`;
  chip.textContent = t(ok ? 'passed' : 'failed');
}

/** Moves the engine's new signed answers into the paper, each with a place for its chain record. */
function syncExchanges() {
  const fresh = state.engine.exchanges.slice(state.synced).map(({ step, page, model, receipt, wire, seconds, hardware }) => ({ step, page, model, receipt, wire, seconds, hardware }));
  state.synced = state.engine.exchanges.length;
  state.paper.exchanges.push(...fresh);
  state.paper.records.push(...fresh.map(() => ({ status: 'recording' })));
}

async function finish() {
  const { paper } = state;
  state.reading = 0;
  go('working');
  const started = performance.now();
  try {
    if (!state.engine) {
      state.engine = createEngine();
      state.synced = 0;
    }
    const { engine } = state;
    const rows = kept('row');
    const styles = paper.pages.map((_, n) => detectDecimalStyle(rows.filter((e) => e.page === n).map((e) => e.data.value)));
    const placements = rows.map((e) => placeInRange(e.data.value, e.data.range, styles[e.page]));
    let plain = null;
    if (hasLines()) {
      plain = await engine.plain(confirmedPlan(), paper.planLang);
      workDone('w_plain', plain !== null);
    }
    const letters = paper.pages.filter((page) => !page.lab && !page.skipped);
    const merged = {
      document_kind: letters[0]?.document_kind ?? 'lab_results',
      language: (letters[0] ?? paper.pages[0]).language,
      rows: rows.map((e) => e.data),
      text: letters.map((page) => page.text).join('\n\n'),
    };
    const explanation = await engine.explain(merged, placements, paper.planLang);
    workDone('w_explain', explanation !== null);
    // A paper written again in another language keeps its signed copies and replaces the two texts.
    const keep = paper.exchanges.map((x) => ['read', 'plan', 'read2', 'plan2'].includes(x.step));
    paper.exchanges = paper.exchanges.filter((_, i) => keep[i]);
    paper.records = paper.records.filter((_, i) => keep[i]);
    Object.assign(paper, { plain, explanation, placements });
    syncExchanges();
    paper.timings.writing = secondsSince(started);
    savePaper();
    await pause(reduced ? 0 : 700);
    go('plan');
    recordAll();
  } catch (error) {
    fail(error);
  }
}

async function recordAll(only = null) {
  const { paper } = state;
  for (let i = 0; i < paper.exchanges.length; i += 1) {
    if (only !== null && only !== i) continue;
    if (paper.records[i]?.status === 'recorded' || paper.records[i]?.status === 'already') continue;
    paper.records[i] = { status: 'recording' };
    paintRecords();
    const result = await recordReceipt(paper.exchanges[i].receipt);
    paper.records[i] = result.hash ? { status: 'recorded', hash: result.hash } : result.already ? { status: 'already' } : { status: 'failed', error: result.error };
    if (state.paper === paper) paintRecords();
    const rest = loadPapers().map((saved) => (saved.id === paper.id ? paper : saved));
    localStorage.setItem(STORE, JSON.stringify(rest));
  }
}

/* ---------- 4 · the plan ---------- */

// Small facts about a line: how many to take, whether the person corrected it, which page it is on.
const tagline = (entry, count = null) => {
  const parts = [count === null ? '' : `× ${esc(count)}`, entry.status === 'corrected' ? t('by_you') : '', manyPages() ? t('page_tag', { n: entry.page + 1 }) : ''].filter(Boolean);
  return parts.length ? `<span class="tagline" dir="ltr">${parts.join(' · ')}</span>` : '';
};
const item = (main, sub, entry, inside = '', count = null) => `<details class="item"><summary><div class="rowp">${main}</div>${sub || tagline(entry, count) ? `<small>${tagline(entry, count)}${sub}</small>` : ''}</summary>${inside ? `<small>${inside}</small>` : ''}<div class="from"><span class="lbl">${p('on_paper')}${manyPages() ? ` · ${t('page_tag', { n: entry.page + 1 })}` : ''}</span><span class="quote" dir="auto" style="margin-top:6px">${esc(entry.paper)}</span></div></details>`;
const plate = (label, body, i) => (body ? `<div class="plate clear arr" style="--i:${Math.min(i, 8)}"><span class="lbl">${label}</span>${body}</div>` : '');
const joinParts = (parts) => (state.paper.planLang === 'ja' ? parts.join(p('or')) : parts.length > 1 ? `${parts.slice(0, -1).join(', ')} ${p('or')} ${parts.at(-1)}` : parts[0]);

/** Questions the code writes from what the paper leaves open, one per medicine. */
function openQuestions() {
  const open = new Map();
  for (const point of openPoints(confirmedPlan())) open.set(point.index, [...(open.get(point.index) ?? []), point]);
  return [...open.values()].map((points) => p('open_point', { name: points[0].name, things: joinParts(points.map((point) => p(`m_${point.missing}`))) }));
}
const questions = () => [...openQuestions(), ...(state.paper.explanation?.questions ?? [])];

function saysPlate(i) {
  const { explanation } = state.paper;
  if (!explanation) return '';
  const sections = explanation.sections.map((s) => `<div class="item"><b>${esc(s.title)}</b><small>${esc(s.plain)}</small></div>`).join('');
  const terms = explanation.terms.length ? `<div class="item"><b>${p('terms')}</b>${explanation.terms.map((term) => `<small><b>${esc(term.term)}</b>: <span class="gen">${esc(term.meaning)}</span></small>`).join('')}</div>` : '';
  // With no take-home lines the sections are the content, so they are open from the start.
  const more = sections || terms ? `<details ${kept().length === 0 ? 'open' : ''}><summary><span class="more">${p('sections')}</span></summary>${sections}${terms}</details>` : '';
  return plate(p('says'), `<div class="item">${esc(explanation.summary)}</div>${more}`, i);
}

function linesPlan(start) {
  const { plain } = state.paper;
  const told = (kind, n) => plain?.[kind]?.find((entry) => entry.index === n) ?? null;
  const slots = { morning: [], noon: [], evening: [], night: [] };
  const other = [];
  kept('medicines').forEach((entry, n) => {
    const m = entry.data;
    const plainLine = told('medicines', n);
    const kind = plainLine?.kind ? `<span class="gen">${esc(plainLine.kind)}</span>` : '';
    const read = readSlots(m.schedule);
    if (read) {
      const how = plainLine ? esc(plainLine.how) : `<span class="quote" dir="auto">${esc([read.rest, m.duration].filter(Boolean).join(' · '))}</span>`;
      for (const slot of Object.keys(slots)) {
        const count = read[slot];
        if (count === null || /^0([.,]0+)?$/.test(count)) continue;
        slots[slot].push(item(`<b>${esc(m.name)}</b><b class="r">${esc(m.strength)}</b>`, [kind, how].filter(Boolean).join(' · '), entry, '', count));
      }
    } else {
      const printed = [m.schedule, m.duration].filter(Boolean).join(' · ');
      const how = plainLine?.how ? esc(plainLine.how) : printed ? `<span class="quote" dir="auto">${esc(printed)}</span>` : '';
      other.push(item(`<b>${esc(m.name)}</b><b class="r">${esc(m.strength)}</b>`, [kind, how].filter(Boolean).join(' · '), entry));
    }
  });
  const list = (kind, printed) =>
    kept(kind)
      .map((entry, n) => item(`<span>${esc(told(kind, n)?.plain || printed(entry.data))}</span>`, '', entry))
      .join('');
  let i = start;
  return [
    ...Object.entries(slots).map(([slot, rows]) => plate(p(slot), rows.join(''), i++)),
    plate(p('other_times'), other.join(''), i++),
    plate(p('followups'), list('follow_ups', (d) => [d.what, d.when].filter(Boolean).join(', ')), i++),
    plate(p('cautions'), list('cautions', (d) => d.text), i++),
  ].join('');
}

function resultsPlan(start) {
  const { explanation, placements } = state.paper;
  const rows = kept('row').map((entry, n) => ({ entry, place: placements[n], told: explanation?.rows.find((r) => r.index === n) ?? null }));
  if (rows.length === 0) return '';
  const tally = (place) => rows.filter((r) => r.place === place).length;
  const group = (label, places, i) =>
    plate(
      label,
      rows
        .filter((r) => places.includes(r.place))
        .map(({ entry, place, told }) => {
          const d = entry.data;
          const name = told?.plain_name ? `<b>${esc(told.plain_name)}</b><small dir="auto">${esc(d.name)}</small>` : `<b>${esc(d.name)}</b>`;
          // Inside the range the row stays short; what the test measures opens with the line from the paper.
          const outside = place === 'above' || place === 'below' || place === 'edge';
          const what = told?.what_it_is ? `<span class="gen">${esc(told.what_it_is)}</span>` : '';
          const sub = [d.range ? `${p('range')}: <span dir="ltr">${esc(d.range)} ${esc(d.unit)}</span>` : '', outside ? what : '', told?.note ? `<span class="gen">${esc(told.note)}</span>` : ''].filter(Boolean).join('<br>');
          return item(`<span>${name}</span><span class="r"><b dir="ltr">${esc(d.value)} ${esc(d.unit)}</b><br><span class="chip ${place === 'in' ? 'wait' : ''}">${p(`p_${place}`)}</span></span>`, sub, entry, outside ? '' : what);
        })
        .join(''),
      i,
    );
  const count = `<p class="foot" dir="${RTL.has(state.lang) ? 'rtl' : 'ltr'}" style="margin-top:14px">${t('count', { n: rows.length, in: tally('in'), above: tally('above'), below: tally('below'), edge: tally('edge'), unknown: tally('unknown') })}</p>`;
  return `${count}${group(p('g_out'), ['above', 'below', 'edge'], start)}${group(p('g_in'), ['in'], start + 1)}${group(p('g_unknown'), ['unknown'], start + 2)}`;
}

/** One sentence on how many models read the paper and what the person had to settle. */
function readersLine(paper) {
  const r = paper.readers;
  if (!r || r.pages === 0) return '';
  if (r.alone === r.pages) return t('two_note_alone');
  const some = r.alone ? ` ${t('two_note_some', { n: r.alone })}` : '';
  return t(r.apart ? 'two_note_apart' : 'two_note_same', { n: r.apart }) + some;
}

function planScreen() {
  const { paper } = state;
  const lines = hasLines();
  const results = kept('row').length > 0;
  const ask = questions();
  const notes = [
    kept().length === 0 ? t('no_plan') : '',
    (lines && paper.plain === null) || paper.explanation === null ? t('no_plain') : '',
    results ? t('by_code') : '',
    readersLine(paper),
    t('legend'),
  ].filter(Boolean);
  return {
    back: ['home', 'home'],
    view: `
      <h1 class="land">${t(lines ? 'plan_h' : results ? 'lab_h' : 'paper_h')}</h1>
      ${unreadablePlate()}
      <div class="plan" lang="${paper.planLang}" dir="${RTL.has(paper.planLang) ? 'rtl' : 'ltr'}">
        ${saysPlate(0)}
        ${lines ? linesPlan(1) : ''}
        ${resultsPlan(5)}
        ${plate(p('ask'), ask.map((q) => `<div class="item">${esc(q)}</div>`).join(''), 8)}
      </div>
      ${notes.map((n) => `<p class="foot" style="margin-top:14px">${n}</p>`).join('')}
      <div class="links left" style="margin-top:8px">
        <button class="link" data-act="doctor">${t('doctor')}</button>
        <button class="link" data-act="text">${t('copied')}</button>
        ${state.photos.length ? `<button class="link" data-act="photo">${t('photo')}</button>` : ''}
      </div>
      <label class="pick"><span class="lbl">${t('rewrite')}</span>
        <select data-rewrite>${Object.keys(LANGUAGES).map((l) => `<option value="${l}" ${l === paper.planLang ? 'selected' : ''}>${LANGUAGE_NAMES[l]}</option>`).join('')}</select></label>`,
    dock: `<button class="btn" data-act="proof">${t('proof')}</button>`,
  };
}

/* ---------- sheet for the doctor ---------- */

function doctorParts() {
  const { paper } = state;
  const meds = kept('medicines').map((e) => ({ line: [e.data.name, e.data.strength, e.data.schedule, e.data.duration].filter(Boolean).join(' · '), source: e.paper }));
  const follow = [...kept('follow_ups'), ...kept('cautions')].map((e) => e.paper);
  const results = kept('row')
    .map((e, n) => ({ e, place: paper.placements[n] }))
    .filter((r) => ['above', 'below', 'edge'].includes(r.place))
    .map(({ e, place }) => `${e.data.name}: ${e.data.value} ${e.data.unit} (${p('range')}: ${e.data.range}) · ${p(`p_${place}`)}`);
  return { date: new Date(paper.at).toLocaleDateString(paper.planLang, { day: 'numeric', month: 'long', year: 'numeric' }), ask: questions(), meds, follow, results };
}

function doctorHtml() {
  const d = doctorParts();
  const block = (title, body) => (body ? `<h3>${title}</h3>${body}` : '');
  return `<article class="doc" lang="${state.paper.planLang}" dir="${RTL.has(state.paper.planLang) ? 'rtl' : 'ltr'}">
    <h2>${p('d_title')}</h2><p class="when">${esc(d.date)}${state.paper.title ? ` · <span dir="auto">${esc(state.paper.title)}</span>` : ''}</p>
    ${block(p('d_q'), d.ask.length ? `<ol>${d.ask.map((q) => `<li>${esc(q)}</li>`).join('')}</ol>` : '')}
    ${block(p('d_meds'), d.meds.length ? `<ul>${d.meds.map((m) => `<li><b dir="auto">${esc(m.line)}</b><br><code dir="auto">${esc(m.source)}</code></li>`).join('')}</ul>` : '')}
    ${block(p('d_follow'), d.follow.length ? `<ul>${d.follow.map((f) => `<li><code dir="auto">${esc(f)}</code></li>`).join('')}</ul>` : '')}
    ${block(p('d_results'), d.results.length ? `<ul>${d.results.map((r) => `<li dir="auto">${esc(r)}</li>`).join('')}</ul>` : '')}
    <p class="note">${p('d_note')}</p></article>`;
}

function doctorText() {
  const d = doctorParts();
  const part = (title, lines) => (lines.length ? `\n${title}\n${lines.map((l) => `- ${l}`).join('\n')}\n` : '');
  return `${p('d_title')} · ${d.date}\n${part(p('d_q'), d.ask)}${part(p('d_meds'), d.meds.map((m) => m.source))}${part(p('d_follow'), d.follow)}${part(p('d_results'), d.results)}\n${p('d_note')}`;
}

async function shareDoctor() {
  const text = doctorText();
  if (navigator.share) {
    try {
      await navigator.share({ title: p('d_title'), text });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  await navigator.clipboard?.writeText(text);
  const note = document.getElementById('docnote');
  if (note) note.textContent = t('doc_copied');
}

/* ---------- overlays ---------- */

function howHtml() {
  const list = (key, n) => Array.from({ length: n }, (_, i) => `<div class="item">${t(`${key}_${i + 1}`)}</div>`).join('');
  return `<h1 class="small">${t('how_h')}</h1>
    <div class="plate"><span class="lbl">${t('how_does')}</span><div class="item">${t('how_does_t')}</div></div>
    <div class="plate"><span class="lbl">${t('how_not')}</span><div class="item">${t('how_not_t')}</div></div>
    <div class="plate"><span class="lbl">${t('how_privacy')}</span>${list('how_privacy', 4)}</div>
    <div class="plate"><span class="lbl">${t('how_code')}</span>${list('how_code', 5)}</div>
    <div class="plate"><span class="lbl">${t('how_limits')}</span>${list('how_limits', 4)}</div>`;
}

function overlay() {
  const close = `<button class="textbtn" data-act="close">${t('close')}</button>`;
  if (state.over === 'how') return `<div class="over dark"><div class="headrow"><span></span>${close}</div><div class="body">${howHtml()}</div></div>`;
  if (state.over === 'doctor') {
    return `<div class="over"><div class="headrow"><span><button class="textbtn" data-act="print">${t('doc_print')}</button><button class="textbtn" data-act="share">${t('doc_share')}</button></span>${close}</div><div class="body">${doctorHtml()}</div><p class="foot c" id="docnote" style="margin-top:8px"></p></div>`;
  }
  const many = manyPages();
  const body =
    state.over === 'photo'
      ? state.photos.map((url) => `<img src="${url}" alt="">`).join('')
      : state.paper.pages.map((page, n) => `${many ? `<p class="pagehead">${t('page_of', { n: n + 1, total: state.paper.pages.length })}</p>` : ''}<pre dir="auto">${esc(page.paperText)}</pre>`).join('');
  return `<div class="over"><div class="headrow"><span></span>${close}</div><div class="body">${body}</div></div>`;
}

/* ---------- 5 · proof ---------- */

const stepName = (x) => t(`st_${x.step}`, { n: (x.page ?? 0) + 1 });

function recordLine(i) {
  const record = state.paper.records[i] ?? { status: 'recording' };
  if (record.status === 'recorded') return `<a class="code" href="${EXPLORER}${record.hash}" target="_blank" rel="noopener">${record.hash.slice(0, 10)}…${record.hash.slice(-8)}</a>`;
  if (record.status === 'failed') return `<code>${esc(record.error ?? '')}</code><button class="more" data-act="retry" data-i="${i}">${t('retry')}</button>`;
  return '';
}
const recordWord = (i) => ({ recorded: 'recorded', recording: 'recording', already: 'already', failed: 'not_recorded' })[state.paper.records[i]?.status ?? 'recording'];

function chainRows() {
  return state.paper.exchanges
    .map((x, i) => `<div class="rowp"><span><b>${stepName(x)}</b>${recordLine(i)}</span><span class="chip ${state.paper.records[i]?.status === 'recording' ? 'running' : ''} ${state.paper.records[i]?.status === 'failed' ? 'bad' : ''}">${t(recordWord(i))}</span></div>`)
    .join('');
}

function paintRecords() {
  const box = document.getElementById('chain');
  if (box) box.innerHTML = chainRows();
}

function proofScreen() {
  const { exchanges } = state.paper;
  // One block per model that answered: its hardware evidence, its name, the key that signed its answers.
  const modelOf = (x) => x.model ?? x.receipt.model;
  const firstModel = modelOf(exchanges.find((x) => x.step === 'read') ?? exchanges[0]);
  const models = [...new Set([firstModel, ...exchanges.map(modelOf)])].map((model) => exchanges.find((x) => modelOf(x) === model));
  const modelPlate = (x, n) => `<div class="plate clear arr" style="--i:0">${models.length > 1 ? `<span class="lbl">${t(n === 0 ? 'reader1' : 'reader2')}</span>` : ''}
        <div class="rowp"><span><b>${t('pr_hw')}</b><code>Intel TDX: ${esc(x.hardware.tcbStatus)} · NVIDIA: ${t(x.hardware.gpuEvidence === 'verified' ? 'verified' : 'not_given')}</code></span><span class="chip">${t('passed')}</span></div>
        <div class="rowp"><span><b>${t('pr_model')}</b><code>${esc(x.receipt.model)}</code></span><span class="chip">${t('verified')}</span></div>
        <div class="rowp"><span><b>${t('pr_key')}</b><code>${short(x.receipt.signer)}</code></span></div>
      </div>`;
  return {
    back: ['plan', 'back'],
    view: `
      <h1 class="land">${t('proof_h')}</h1>
      <div class="obj small" style="background-image:url(${frostUrl})"></div>
      ${models.map(modelPlate).join('')}
      <div class="plate clear arr" style="--i:1"><span class="lbl">${t('pr_answers')}</span>
        ${exchanges.map((x) => `<div class="rowp"><span><b>${stepName(x)}</b><code>${short(x.receipt.response_hash)}${x.wire ? ` · ${t('sent_as', { size: size(x.wire.bytes) })}` : ''}</code></span><span class="chip">${t('signed')}</span></div>`).join('')}
      </div>
      <div class="plate clear arr" style="--i:2"><span class="lbl">${t('pr_chain')}</span><div id="chain">${chainRows()}</div></div>
      <div class="two"><div class="plate arr" style="--i:3"><b>${t('protects')}</b>${t('protects_t')}</div><div class="plate arr" style="--i:4"><b>${t('not_protects')}</b>${t('not_protects_t')}</div></div>
      <p class="foot" style="margin-top:14px">${state.paper.hidden ? `${t('hidden_total', { n: state.paper.hidden })} ` : ''}${t('stored')}</p>`,
    dock: `<button class="btn" data-act="home">${t('again')}</button><div class="links"><button class="link" data-act="delete">${t('delete')}</button></div>`,
  };
}

function errorScreen() {
  return {
    view: `
      <h1 class="land">${t('err_h')}</h1>
      <div class="plate arr"><div class="item">${t(state.error.key)}</div>${state.error.key === 'err_other' || state.error.key === 'err_hw' ? `<code>${esc(state.error.detail)}</code>` : ''}</div>`,
    dock: `<button class="btn" data-act="home">${t('again')}</button>`,
  };
}

const SCREENS = { start: startScreen, prepare: prepareScreen, sending: sendingScreen, compare: compareScreen, working: workingScreen, plan: planScreen, proof: proofScreen, error: errorScreen };

/* ---------- actions ---------- */

async function sample(url, name) {
  const blob = await (await fetch(url)).blob();
  addShots([new File([blob], name, { type: blob.type })]);
}

function home() {
  Object.assign(state, { shots: [], shot: 0, photos: [], paper: null, engine: null, synced: 0, error: null });
  go('start');
}

function removePaper(id) {
  localStorage.setItem(STORE, JSON.stringify(loadPapers().filter((saved) => saved.id !== id)));
  state.note = t('deleted');
}

const shot = () => state.shots[state.shot];
const ACTIONS = {
  'sample-letter': () => sample(letterUrl, 'sample-letter.png'),
  'sample-lab': () => sample(labUrl, 'sample-lab.png'),
  how: () => { state.over = 'how'; render(); },
  open: (el) => {
    const saved = loadPapers().find((paper) => paper.id === el.dataset.id);
    if (!saved) return;
    Object.assign(state, { paper: saved, photos: [], engine: null, synced: 0, note: null });
    go('plan');
    if (saved.records.some((r) => r.status === 'recording')) recordAll();
  },
  'delete-one': (el) => { removePaper(el.dataset.id); render(); },
  'delete-all': () => { localStorage.removeItem(STORE); state.note = t('deleted'); render(); },
  home,
  shot: (el) => { state.shot = Number(el.dataset.i); render(); },
  'top-strip': () => { shot().boxes.push({ x: 0, y: 0, w: 1, h: 0.17 }); render(); },
  'clear-boxes': () => { shot().boxes = []; render(); },
  'remove-shot': () => { state.shots.splice(state.shot, 1); state.shot = Math.max(0, state.shot - 1); render(); },
  send,
  close: () => { state.over = null; render(); },
  photo: () => { state.over = 'photo'; render(); },
  text: () => { state.over = 'text'; render(); },
  doctor: () => { state.over = 'doctor'; render(); },
  print: () => { document.getElementById('print').innerHTML = doctorHtml(); window.print(); },
  share: shareDoctor,
  same: () => decide('same'),
  'pick-1': () => pick(1),
  'pick-2': () => pick(2),
  leave: () => decide('left'),
  edit: () => { state.editing = true; paintCompare(); },
  cancel: () => { state.editing = false; paintCompare(); },
  save: saveEdit,
  prev: () => { state.active = Math.max(0, Math.min(state.active, entries().length) - 1); state.editing = false; paintCompare(); },
  'all-same': () => { for (const e of entries()) if (e.status === 'pending' && e.kind === 'row' && agreed(e)) e.status = 'same'; const next = entries().findIndex((e) => e.status === 'pending'); state.active = next === -1 ? entries().length : next; paintCompare(); },
  finish,
  plan: () => go('plan'),
  proof: () => go('proof'),
  retry: (el) => recordAll(Number(el.dataset.i)),
  delete: () => { removePaper(state.paper.id); home(); },
};

app.addEventListener('click', (event) => {
  const lang = event.target.closest('[data-lang]');
  if (lang) {
    state.lang = lang.dataset.lang;
    localStorage.setItem('lang', state.lang);
    render();
    return;
  }
  const box = event.target.closest('[data-box]');
  if (box) {
    // Reached by keyboard, or by a click that follows a tap already handled on the stage.
    if (performance.now() - (state.boxRemovedAt ?? -1e9) > 500) {
      shot().boxes.splice(Number(box.dataset.box), 1);
      render();
    }
    return;
  }
  const el = event.target.closest('[data-act]');
  if (el) ACTIONS[el.dataset.act]?.(el);
});
app.addEventListener('change', (event) => {
  const input = event.target.closest('[data-file]');
  if (input?.files?.length) addShots(input.files);
  const planLang = event.target.closest('[data-planlang]');
  if (planLang) {
    state.planLang = planLang.value;
    localStorage.setItem('planLang', state.planLang);
  }
  const rewrite = event.target.closest('[data-rewrite]');
  if (rewrite && rewrite.value !== state.paper.planLang) {
    state.paper.planLang = rewrite.value;
    finish();
  }
});
addEventListener('resize', () => { if (state.screen === 'compare') moveLens(entries()[state.active]); });

addEventListener('online', () => { if (state.screen === 'start') render(); });
addEventListener('offline', () => { if (state.screen === 'start') render(); });

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/sw.js');
      // The files of this first visit were fetched before the worker existed. Hand it their
      // addresses so the app opens without a connection from the next visit on.
      const { active } = await navigator.serviceWorker.ready;
      const mine = performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.startsWith(`${location.origin}/assets/`));
      active?.postMessage({ keep: mine });
    } catch {
      // The app works without the worker; it only cannot open offline.
    }
  });
}

render();
