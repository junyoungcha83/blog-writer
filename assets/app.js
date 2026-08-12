// 블로그작성 — 브라우저에서 Claude API(Messages)를 직접 호출한다.
// 기사 링크·원문·주제 하나를 입력하면 Researcher → Fact Checker → Writer → SEO 4단계가
// 순서대로 돌아 블로그 원고와 SEO 세트를 만든다. 단계별 결과는 이 기기에만 저장된다.
// API 키도 이 기기(localStorage)에만 저장되고, 요청은 브라우저 → api.anthropic.com 으로 바로 나간다.

const API_URL = 'https://api.anthropic.com/v1/messages';

const K_KEY = 'bw-api-key';
const K_MODEL = 'bw-model';
const K_OPUSW = 'bw-opus-writer';   // 본문 작성만 Opus 5 로
const K_BUDGET = 'bw-budget';       // 이번 달 비용 한도 (USD)
const K_NOTICE = 'bw-ai-notice';    // AI 작성 고지 넣기
const K_NOEFFORT = 'bw-no-effort';    // effort 를 거부한 모델 기록 — 다음부터 안 보냄
const K_BASICTOOLS = 'bw-basic-tools'; // 최신 웹검색 도구를 거부한 모델 기록
const K_USAGE = 'bw-usage';         // 사용량 기록 [{at, stage, model, cost, in, out, searches}]
const K_DRAFT = 'bw-draft';         // 작성 중인 초안 1개
const K_HIST = 'bw-history';        // 완료된 글 이력
const MAX_HIST = 20;

const STAGES = window.BW.STAGES;
const { FIELDS, PURPOSES, LENGTHS, RANGES, SOURCE_TYPES, STYLES } = window.BW;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function loadJSON(k, dflt) {
  try { return JSON.parse(localStorage.getItem(k) || '') ?? dflt; } catch (_) { return dflt; }
}
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

const getKey = () => localStorage.getItem(K_KEY) || '';
const getModel = () => localStorage.getItem(K_MODEL) || 'claude-sonnet-5';
const opusWriter = () => localStorage.getItem(K_OPUSW) === '1';
const aiNotice = () => localStorage.getItem(K_NOTICE) !== '0';   // 기본 켬
const budget = () => parseFloat(localStorage.getItem(K_BUDGET) || '') || 0;

// ── 모델별 지원 차이 ─────────────────────────────────────────
// effort(응답 깊이)와 최신 웹검색 도구는 상위 모델에서만 돈다. Haiku 4.5 는 effort 를
// 아예 거부한다. 400 이 오면 그 모델을 기억해 두고 옵션을 빼고 재시도한다.
const EFFORT_MODELS = { 'claude-opus-5': 1, 'claude-sonnet-5': 1 };
const effortBlocked = m => (loadJSON(K_NOEFFORT, {})[m] === true);
function blockEffort(m) { const o = loadJSON(K_NOEFFORT, {}); o[m] = true; saveJSON(K_NOEFFORT, o); }
const useEffort = m => !!EFFORT_MODELS[m] && !effortBlocked(m);

const MODERN_TOOL_MODELS = { 'claude-opus-5': 1, 'claude-sonnet-5': 1 };
const useModernTools = m => !!MODERN_TOOL_MODELS[m] && loadJSON(K_BASICTOOLS, {})[m] !== true;
function blockModernTools(m) { const o = loadJSON(K_BASICTOOLS, {}); o[m] = true; saveJSON(K_BASICTOOLS, o); }

function toolsFor(mode, model) {
  if (mode === 'none') return null;
  const modern = useModernTools(model);
  const search = modern
    ? { type: 'web_search_20260209', name: 'web_search', max_uses: 6 }
    : { type: 'web_search_20250305', name: 'web_search', max_uses: 6 };
  if (mode === 'search') return [search];
  const fetchTool = modern
    ? { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 }
    : { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3 };
  return [fetchTool, search];
}

// ── 요금 (공식 단가, 100만 토큰당 USD) ────────
// 캐시 읽기는 입력가의 0.1배, 캐시 쓰기는 1.25배. 웹검색은 1,000회당 $10.
const MODEL_INFO = {
  'claude-opus-5':    { label: 'Claude Opus 5',   note: '가장 똑똑함 · 가장 비쌈', in: 5, out: 25 },
  'claude-sonnet-5':  { label: 'Claude Sonnet 5', note: '속도·품질·가격 균형 (기본)', in: 3, out: 15,
                        introIn: 2, introOut: 10, introUntil: '2026-08-31' },
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5', note: '가장 저렴 · 자료수집·분석 품질 낮음', in: 1, out: 5 },
};
const WEB_SEARCH_USD = 0.01;
const KRW_PER_USD = 1400;      // 표시용 어림값 — 실제 환율과 다를 수 있음

function rateOf(model) {
  const m = MODEL_INFO[model] || MODEL_INFO['claude-sonnet-5'];
  const onIntro = m.introUntil && new Date().toISOString().slice(0, 10) <= m.introUntil;
  return { in: onIntro ? m.introIn : m.in, out: onIntro ? m.introOut : m.out, onIntro: !!onIntro };
}
function costOf(model, u) {
  const r = rateOf(model);
  return (u.in / 1e6) * r.in
       + (u.cacheRead / 1e6) * r.in * 0.1
       + (u.cacheWrite / 1e6) * r.in * 1.25
       + (u.out / 1e6) * r.out
       + (u.searches || 0) * WEB_SEARCH_USD;
}
const usd = n => '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(3));
const krw = n => '약 ' + Math.round(n * KRW_PER_USD).toLocaleString('ko-KR') + '원';

function logUsage(stage, model, u) {
  const log = loadJSON(K_USAGE, []);
  log.unshift({ at: Date.now(), stage, model, cost: costOf(model, u), in: u.in, out: u.out, searches: u.searches });
  saveJSON(K_USAGE, log.slice(0, 300));
}
// 이번 달(현지 기준) 누적 비용
function monthCost() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return loadJSON(K_USAGE, []).filter(e => e.at >= from).reduce((s, e) => s + e.cost, 0);
}
// 글 1편 평균 비용 (완료된 글 기준)
function avgPerPost() {
  const log = loadJSON(K_USAGE, []).filter(e => e.stage === 'seo');
  if (!log.length) return null;
  // seo 단계 시각을 글 1편의 끝으로 보고, 그 직전 4개 단계 비용을 묶는다
  const all = loadJSON(K_USAGE, []);
  let total = 0, n = 0;
  for (const end of log.slice(0, 10)) {
    const i = all.findIndex(e => e.at === end.at && e.stage === 'seo');
    if (i < 0) continue;
    total += all.slice(i, i + 4).reduce((s, e) => s + e.cost, 0);
    n++;
  }
  return n ? total / n : null;
}

// ── API 호출 ─────────────────────────────────────────────────

class AppError extends Error {
  constructor(title, detail) { super(title); this.title = title; this.detail = detail || ''; }
}

async function callClaude({ system, userText, toolMode, maxTokens, model, stage, effort, maxContinuations = 4 }) {
  const key = getKey();
  if (!key) throw new AppError('API 키가 없어요', '오른쪽 위 ⚙︎ 에서 Anthropic API 키를 넣어 주세요.');

  let messages = [{ role: 'user', content: userText }];
  let out = [];
  const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, searches: 0 };

  for (let i = 0; i <= maxContinuations; i++) {
    let res;
    // 모델이 지원하지 않는 옵션이 있으면 400 이 온다. 그 옵션을 한 단계씩 내려가며 다시 보낸다.
    for (let attempt = 0; ; attempt++) {
      const body = { model, max_tokens: maxTokens, system, messages };
      const tools = toolsFor(toolMode, model);
      if (tools) body.tools = tools;
      if (useEffort(model)) body.output_config = { effort };

      res = await postJSON(key, body);
      if (res.status !== 400 || attempt >= 2) break;

      const msg = await peekError(res);
      if (/effort|output_config/i.test(msg) && body.output_config) { blockEffort(model); continue; }
      if (/programmatic tool calling|allowed_callers|web_search|web_fetch/i.test(msg) && useModernTools(model)) {
        blockModernTools(model); continue;
      }
      throw errorFor(400, msg);
    }
    if (!res.ok) throw await httpError(res);
    const data = await res.json();

    const u = data.usage || {};
    usage.in += u.input_tokens || 0;
    usage.out += u.output_tokens || 0;
    usage.cacheRead += u.cache_read_input_tokens || 0;
    usage.cacheWrite += u.cache_creation_input_tokens || 0;
    usage.searches += (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;

    for (const b of data.content || []) {
      if (b.type === 'text' && b.text) out.push(b.text);
    }

    if (data.stop_reason === 'refusal') {
      logUsage(stage, model, usage);
      throw new AppError('답변이 거절됐어요',
        '이 주제는 안전 정책상 답할 수 없다고 나왔어요. 다른 주제나 표현으로 시도해 보세요.');
    }
    if (data.stop_reason === 'pause_turn') {          // 서버 도구가 아직 도는 중 — 그대로 이어붙여 재요청
      messages = [{ role: 'user', content: userText }, { role: 'assistant', content: data.content }];
      continue;
    }
    if (data.stop_reason === 'max_tokens') {
      logUsage(stage, model, usage);
      throw new AppError('응답이 길어 잘렸어요',
        '분량을 한 단계 줄이거나 이 단계만 다시 실행해 보세요.');
    }
    break;
  }
  logUsage(stage, model, usage);
  return { text: out.join('\n') };
}

function postJSON(key, body) {
  return fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  }).catch(e => { throw new AppError('네트워크 오류', '인터넷 연결을 확인해 주세요. (' + e.message + ')'); });
}
async function peekError(res) {
  try { const j = await res.json(); return (j.error && j.error.message) || ''; } catch (_) { return ''; }
}
function errorFor(status, msg) {
  if (status === 401) return new AppError('API 키가 올바르지 않아요', '⚙︎ 설정에서 키를 다시 확인해 주세요.');
  if (status === 403) return new AppError('권한이 없어요', msg || '이 키로는 이 모델을 쓸 수 없어요.');
  if (status === 404) return new AppError('모델을 찾을 수 없어요', '⚙︎ 설정에서 다른 모델을 골라 보세요. ' + msg);
  if (status === 429) return new AppError('요청이 너무 많아요', '잠시 뒤에 이 단계만 다시 실행해 주세요.');
  if (status >= 500) return new AppError('서버가 바빠요', '잠시 뒤에 이 단계만 다시 실행해 주세요. (' + status + ')');
  if (status === 400 && /does not support|not supported/i.test(msg)) {
    return new AppError('이 모델로는 안 되는 기능이에요',
      '⚙︎ 설정에서 Sonnet 5 나 Opus 5 로 바꾸면 됩니다. (' + msg + ')');
  }
  return new AppError('요청 실패 (' + status + ')', msg);
}
async function httpError(res) { return errorFor(res.status, await peekError(res)); }

// 응답에서 JSON 블록만 뽑아낸다 (```json … ``` 또는 첫 { … 마지막 })
function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ── 물어보기 팝업 ────────────────────────────
function askDialog({ icon, title, lines, yes, no }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'sheet';
    ov.innerHTML = `<div class="sheet-box ask-box">
      <h2 class="ask-title">${icon} ${esc(title)}</h2>
      ${lines.map(l => `<p class="ask-line">${l}</p>`).join('')}
      <div class="sheet-btns ask-btns">
        <button class="go" type="button" data-a="1">${esc(yes)}</button>
        <button class="ghost" type="button" data-a="0">${esc(no)}</button>
      </div></div>`;
    document.body.appendChild(ov);
    const done = v => { ov.remove(); resolve(v); };
    ov.querySelector('[data-a="1"]').onclick = () => done(true);
    ov.querySelector('[data-a="0"]').onclick = () => done(false);
    ov.onclick = e => { if (e.target === ov) done(false); };   // 바깥을 누르면 '아니요'
  });
}

// ── 마크다운 → HTML / 평문 ───────────────────────────────────
// 외부 라이브러리 없이 필요한 만큼만: 제목·목록·인용·표·구분선·굵게·링크·인라인코드.

function inlineMd(s) {
  // ** 를 먼저 자리표시자(U+0001/0002)로 바꿔 둔다. 그래야 뒤이은 * 처리가 굵게를
  // 갈라먹지 않는다. lookbehind 를 안 쓰는 이유는 구형 iOS Safari 미지원.
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '\u0001$1\u0002')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\u0001/g, '<strong>').replace(/\u0002/g, '</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
}

function mdToHtml(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [], list = null, quote = [];

  const flushPara = () => { if (para.length) { out.push(`<p>${inlineMd(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inlineMd(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${inlineMd(quote.join(' '))}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) { flushAll(); continue; }

    // 표: |...| 다음 줄이 |---| 형태
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) {
      flushAll();
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(cells(lines[i])); i++; }
      i--;
      out.push(`<div class="md-table"><table><thead><tr>${head.map(c => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    // 본문의 ## 은 h2 로. 카드 안이라 h1 은 쓰지 않고, 실수로 # 이 오면 h2 로 끌어올린다.
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushAll(); const n = Math.min(Math.max(h[1].length, 2), 4); out.push(`<h${n}>${inlineMd(h[2])}</h${n}>`); continue; }

    if (/^([-*_])\1{2,}$/.test(line)) { flushAll(); out.push('<hr />'); continue; }

    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) { flushPara(); flushQuote(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(ul[1]); continue; }

    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) { flushPara(); flushQuote(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(ol[1]); continue; }

    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { flushPara(); flushList(); quote.push(bq[1]); continue; }

    flushList(); flushQuote();
    para.push(line);
  }
  flushAll();
  return out.join('\n');
}

// 네이버·티스토리 에디터에 붙여넣기 좋은 평문
function mdToPlain(md) {
  return String(md || '').replace(/\r\n?/g, '\n')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '· ')
    .replace(/^>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/^([-*_])\1{2,}$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 초안 상태 ────────────────────────────────────────────────

const blankOpts = () => ({
  field: 'realestate', fieldEtc: '', purpose: 'info', length: '3000',
  range: '7d', sourceTypes: ['press', 'gov', 'public'], style: 'easy',
});

let draft = loadJSON(K_DRAFT, null) || newDraft();

function newDraft() {
  return {
    id: 'd' + Date.now(), at: Date.now(),
    input: { mode: 'url', value: '' },
    opts: blankOpts(),
    stages: {}, status: {}, err: {}, titleIdx: 0,
  };
}
const saveDraft = () => saveJSON(K_DRAFT, draft);

// ── 옵션 UI ──────────────────────────────────────────────────

function renderOpts() {
  const o = draft.opts;
  const row = (key, label, help, entries, cur, multi) => `
    <div class="opt" data-opt="${key}">
      <div class="opt-h"><b>${label}</b><span>${help}</span></div>
      <div class="chips">${entries.map(([v, t]) =>
        `<button class="chip${(multi ? cur.includes(v) : cur === v) ? ' on' : ''}" type="button" data-v="${v}">${esc(t)}</button>`
      ).join('')}</div>
      ${key === 'field' ? `<input class="tf etc${o.field === 'etc' ? '' : ' hidden'}" id="fieldEtc"
        placeholder="분야를 직접 입력 (예: 자동차)" value="${esc(o.fieldEtc)}" />` : ''}
    </div>`;

  $('opts').innerHTML = [
    row('field', '분야', '신뢰 출처 목록이 달라져요',
      Object.entries(FIELDS).map(([k, v]) => [k, v.label]), o.field, false),
    row('purpose', '글의 목적', '구성과 어조가 달라져요',
      Object.entries(PURPOSES).map(([k, v]) => [k, v.label]), o.purpose, false),
    row('length', '분량', '본문 글자 수 기준',
      Object.entries(LENGTHS).map(([k, v]) => [k, v.label]), o.length, false),
    row('range', '검색 범위', '범위 밖 자료는 ②에서 걸러요',
      Object.entries(RANGES).map(([k, v]) => [k, v.label]), o.range, false),
    row('sourceTypes', '출처', '여러 개 선택 · 우선순위로만 반영돼요',
      Object.entries(SOURCE_TYPES), o.sourceTypes, true),
    row('style', '문체', '',
      Object.entries(STYLES).map(([k, v]) => [k, v.label]), o.style, false),
  ].join('');

  $('opts').querySelectorAll('.opt').forEach(box => {
    const key = box.dataset.opt;
    box.querySelectorAll('.chip').forEach(btn => {
      btn.onclick = () => {
        const v = btn.dataset.v;
        if (key === 'sourceTypes') {
          const cur = draft.opts.sourceTypes;
          const i = cur.indexOf(v);
          if (i >= 0) { if (cur.length > 1) cur.splice(i, 1); }   // 최소 1개는 남긴다
          else cur.push(v);
        } else {
          draft.opts[key] = v;
        }
        saveDraft(); renderOpts();
      };
    });
  });
  const etc = $('fieldEtc');
  if (etc) etc.oninput = () => { draft.opts.fieldEtc = etc.value; saveDraft(); };
}

function renderInput() {
  ['url', 'text', 'topic'].forEach(m => {
    $('inp-' + m).classList.toggle('hidden', draft.input.mode !== m);
    document.querySelector(`.mtab[data-mode="${m}"]`).classList.toggle('active', draft.input.mode === m);
  });
  $('inUrl').value = draft.input.mode === 'url' ? draft.input.value : $('inUrl').value;
  $('inText').value = draft.input.mode === 'text' ? draft.input.value : $('inText').value;
  $('inTopic').value = draft.input.mode === 'topic' ? draft.input.value : $('inTopic').value;
}

function currentInputValue() {
  const el = { url: 'inUrl', text: 'inText', topic: 'inTopic' }[draft.input.mode];
  return $(el).value.trim();
}

// ── 진행 체크리스트 ──────────────────────────────────────────

let running = false;

function renderStages() {
  const box = $('stages');
  if (!Object.keys(draft.status).length) { box.innerHTML = ''; box.className = ''; return; }
  box.className = 'stages';
  box.innerHTML = STAGES.map(st => {
    const s = draft.status[st.key] || 'wait';
    const label = { wait: '대기', run: '진행 중', done: '완료', fail: '실패', stop: '중단' }[s];
    const data = draft.stages[st.key];
    return `<div class="stage ${s}" data-k="${st.key}">
      <div class="stage-h">
        <div class="stage-no">${st.no}</div>
        <div class="stage-t"><b>${st.label}</b><span>${st.desc}</span></div>
        <div class="stage-s">${s === 'run' ? '<span class="spin-sm"></span> ' : ''}${label}</div>
      </div>
      ${s === 'fail' ? `<div class="stage-body"><b>${esc(draft.err[st.key]?.title || '오류')}</b>
        <div class="tiny">${esc(draft.err[st.key]?.detail || '')}</div>
        <div style="margin-top:9px"><button class="mini" data-re="${st.key}">이 단계부터 다시</button></div></div>` : ''}
      ${s === 'done' && data ? `<div class="stage-body">
        <button class="mini" data-re="${st.key}">이 단계부터 다시</button>
        <button class="mini" data-json="${st.key}">원문 JSON</button>
        <div class="stage-json hidden" data-jbox="${st.key}">${esc(JSON.stringify(data, null, 2))}</div>
      </div>` : ''}
    </div>`;
  }).join('');

  box.querySelectorAll('[data-re]').forEach(b => {
    b.disabled = running;
    b.onclick = () => runFrom(b.dataset.re);
  });
  box.querySelectorAll('[data-json]').forEach(b => {
    b.onclick = () => {
      const j = box.querySelector(`[data-jbox="${b.dataset.json}"]`);
      j.classList.toggle('hidden');
      b.textContent = j.classList.contains('hidden') ? '원문 JSON' : 'JSON 닫기';
    };
  });
}

// ── 파이프라인 ───────────────────────────────────────────────

async function startRun() {
  const value = currentInputValue();
  if (!value) {
    return askDialog({ icon: '✍️', title: '입력이 비어 있어요',
      lines: ['기사 링크, 원문, 또는 주제 중 하나를 넣어 주세요.'], yes: '알겠어요', no: '닫기' });
  }
  if (draft.input.mode === 'url' && !/^https?:\/\//i.test(value)) {
    return askDialog({ icon: '🔗', title: '링크 형태가 아니에요',
      lines: ['<b>https://</b> 로 시작하는 기사 링크를 넣어 주세요.',
              '원문을 그대로 붙여넣으려면 <b>원문 붙여넣기</b> 탭을 쓰세요.'], yes: '알겠어요', no: '닫기' });
  }
  if (!getKey()) {
    openSheet();
    return;
  }
  // 비용 한도 확인
  const lim = budget();
  if (lim > 0) {
    const used = monthCost();
    if (used >= lim) {
      const go = await askDialog({
        icon: '💰', title: '이번 달 한도를 넘었어요',
        lines: [`이번 달 누적 <b>${usd(used)}</b> (${krw(used)}) — 한도 ${usd(lim)}`,
                '계속하면 요금이 더 나갑니다. 한도는 ⚙︎ 설정에서 바꿀 수 있어요.'],
        yes: '알아요, 계속', no: '그만두기',
      });
      if (!go) return;
    }
  }

  draft.id = 'd' + Date.now();
  draft.at = Date.now();
  draft.input.value = value;
  draft.stages = {}; draft.status = {}; draft.err = {}; draft.titleIdx = 0;
  saveDraft();
  runFrom('research');
}

async function runFrom(startKey) {
  if (running) return;
  const from = STAGES.findIndex(s => s.key === startKey);
  if (from < 0) return;

  // 이 단계와 이후 단계 결과를 버린다
  STAGES.slice(from).forEach(st => {
    delete draft.stages[st.key]; delete draft.err[st.key];
    draft.status[st.key] = 'wait';
  });
  STAGES.slice(0, from).forEach(st => { if (!draft.stages[st.key]) draft.status[st.key] = 'wait'; });
  // 앞 단계 결과가 없으면 처음부터 해야 한다
  for (let i = 0; i < from; i++) {
    if (!draft.stages[STAGES[i].key]) return runFrom(STAGES[i].key);
  }

  running = true;
  $('runBtn').disabled = true;
  $('runNote').textContent = '진행 중에는 앱을 닫지 마세요. 단계마다 결과가 저장됩니다.';
  saveDraft(); renderStages();

  for (let i = from; i < STAGES.length; i++) {
    const st = STAGES[i];
    draft.status[st.key] = 'run';
    renderStages();

    const ctx = { input: draft.input, opts: draft.opts, stages: draft.stages };
    const maxTokens = typeof st.maxTokens === 'function' ? st.maxTokens(ctx) : st.maxTokens;
    const model = (st.key === 'write' && opusWriter()) ? 'claude-opus-5' : getModel();

    try {
      const { text } = await callClaude({
        system: st.system(ctx), userText: st.user(ctx),
        toolMode: st.tools(draft.input), maxTokens, model, stage: st.key, effort: st.effort,
      });
      const data = extractJSON(text);
      if (!data) {
        throw new AppError('결과를 읽지 못했어요',
          '모델이 JSON 형식을 벗어났어요. 이 단계만 다시 실행하면 대개 해결됩니다.');
      }
      draft.stages[st.key] = data;
      draft.status[st.key] = 'done';
      saveDraft(); renderStages();

      // ② 자료 부족 확인 — 억지로 채우지 않는다
      if (st.key === 'factcheck' && data.enough === false) {
        const nFacts = (data.facts || []).length;
        const go = await askDialog({
          icon: '🔍', title: '자료가 부족해요',
          lines: [`검색 범위 안에서 확인된 사실이 <b>${nFacts}개</b>뿐이에요.`,
                  '이대로 쓰면 내용이 얇거나 근거가 약한 글이 됩니다.',
                  '검색 범위를 넓히거나 주제를 좁혀서 다시 하는 편이 낫습니다.'],
          yes: '이대로 계속 쓰기', no: '여기서 멈추기',
        });
        if (!go) {
          STAGES.slice(i + 1).forEach(s => { draft.status[s.key] = 'stop'; });
          break;
        }
      }
    } catch (e) {
      const err = (e instanceof AppError) ? e : new AppError('문제가 생겼어요', e.message || '');
      draft.err[st.key] = { title: err.title, detail: err.detail };
      draft.status[st.key] = 'fail';
      STAGES.slice(i + 1).forEach(s => { draft.status[s.key] = 'stop'; });
      saveDraft(); renderStages();
      break;
    }
  }

  running = false;
  $('runBtn').disabled = false;
  saveDraft(); renderStages();

  if (draft.stages.write) {
    if (draft.stages.seo) pushHistory();
    renderResult();
    $('runNote').textContent = '완성됐어요. 위 📄 결과 탭에서 확인하세요.';
    switchView('result');
  } else {
    $('runNote').textContent = '중단됐어요. 실패한 단계의 “이 단계부터 다시”를 눌러 보세요.';
  }
}

// ── 결과 ─────────────────────────────────────────────────────

function chosenTitle() {
  const w = draft.stages.write || {};
  return (w.titles || [])[draft.titleIdx] || (w.titles || [])[0] || '(제목 없음)';
}

function buildMarkdown() {
  const w = draft.stages.write || {};
  const parts = [`# ${chosenTitle()}`, '', (w.body_md || '').trim()];
  if ((w.footnotes || []).length) {
    parts.push('', '## 출처', '');
    w.footnotes.forEach(f => parts.push(`[${f.n}] ${f.outlet ? f.outlet + ' — ' : ''}${f.title || ''} ${f.url || ''}`.trim()));
  }
  if (w.disclaimer) parts.push('', '---', '', `> ${w.disclaimer}`);
  if (aiNotice()) parts.push('', '> 이 글은 AI의 도움을 받아 작성했으며, 사람이 사실관계를 검토했습니다.');
  return parts.join('\n');
}

function copyText(text, btn) {
  const done = () => {
    const old = btn.textContent;
    btn.textContent = '복사됐어요'; btn.classList.add('on');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('on'); }, 1400);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback());
  } else fallback();

  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (_) {}
    ta.remove();
  }
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function sourceStatus() {
  const fc = draft.stages.factcheck || {};
  const found = fc.source_types_found || {};
  const want = (draft.opts.sourceTypes || []).map(k => SOURCE_TYPES[k]);
  return want.map(t => ({ type: t, n: Number(found[t]) || 0 }));
}

function renderResult() {
  const box = $('resultBody');
  const w = draft.stages.write;
  if (!w) {
    box.innerHTML = `<div class="hint-card"><b>아직 결과가 없어요.</b>
      ✍️ 새 글 탭에서 기사·주제를 넣고 옵션을 고른 뒤 <b>글 만들기</b>를 눌러 주세요.</div>`;
    return;
  }
  const fc = draft.stages.factcheck || {};
  const seo = draft.stages.seo;
  const md = buildMarkdown();
  const html = mdToHtml(w.body_md || '');

  const srcRow = sourceStatus();
  const oor = (fc.out_of_range || []).length;

  box.innerHTML = `
    <div class="sec">
      <h3>📝 제목 고르기</h3>
      <div class="titles">${(w.titles || []).map((t, i) => `
        <label class="title-pick${i === draft.titleIdx ? ' on' : ''}">
          <input type="radio" name="tpick" value="${i}"${i === draft.titleIdx ? ' checked' : ''} />
          <span>${esc(t)}</span>
        </label>`).join('')}</div>
    </div>

    <div class="sec">
      <h3>📄 본문 <span class="badge ${((w.char_count || 0) >= LENGTHS[draft.opts.length].chars * 0.7) ? 'ok' : 'warn'}">약 ${(w.char_count || 0).toLocaleString('ko-KR')}자</span></h3>
      <div class="btnrow">
        <button class="mini" data-copy="md">마크다운 복사</button>
        <button class="mini" data-copy="html">HTML 복사</button>
        <button class="mini" data-copy="plain">평문 복사</button>
        <button class="mini" data-dl="1">.md 저장</button>
      </div>
      <div class="md">${html}</div>
      ${w.disclaimer ? `<div class="disclaimer">${esc(w.disclaimer)}</div>` : ''}
      ${aiNotice() ? `<div class="disclaimer">이 글은 AI의 도움을 받아 작성했으며, 사람이 사실관계를 검토했습니다.</div>` : ''}
    </div>

    <div class="sec s-src">
      <h3>🔍 근거 현황</h3>
      <div class="kv"><span>확인된 사실</span><b>${(fc.facts || []).length}개
        <small>(교차확인 ${(fc.facts || []).filter(f => f.confidence === '교차확인').length}개)</small></b></div>
      <div class="kv"><span>엇갈리는 쟁점</span><b>${(fc.disputed || []).length}개</b></div>
      <div class="kv"><span>의견·전망</span><b>${(fc.opinions || []).length}개</b></div>
      <div class="kv"><span>미확인</span><b>${(fc.unverified || []).length}개</b></div>
      <div class="kv"><span>검색범위 밖(제외)</span><b>${oor}개</b></div>
      <div class="seo-g"><div class="lbl">요청한 출처 유형 충족</div>
        <div class="taglist">${srcRow.map(s =>
          `<span class="tag" style="color:${s.n ? 'var(--ok)' : 'var(--warn)'}">${esc(s.type)} ${s.n}건</span>`).join('')}</div>
        <p class="tiny">웹검색은 출처를 강제할 수 없어서 요청과 다를 수 있어요. 위 숫자가 실제 확보량입니다.</p>
      </div>
      ${(fc.unverified || []).length ? `<div class="seo-g"><div class="lbl">본문에 쓰지 않은 미확인 주장</div>
        <ul class="bul tiny" style="padding-left:18px">${fc.unverified.map(u => `<li>${esc(u)}</li>`).join('')}</ul></div>` : ''}
    </div>

    <div class="sec s-src">
      <h3>🔗 출처 ${(w.footnotes || []).length}건</h3>
      <div class="srcs">${(w.footnotes || []).map(f => `
        <a class="src" href="${esc(f.url || '#')}" target="_blank" rel="noopener noreferrer">
          <span class="t">[${f.n}] ${esc(f.title || f.url || '')}</span>
          <span class="m">${esc(f.outlet || '')} ↗</span>
        </a>`).join('') || '<div class="tiny">각주가 없습니다.</div>'}</div>
    </div>

    ${seo ? `<div class="sec s-seo">
      <h3>🔎 SEO · 썸네일</h3>
      <div class="seo-g"><div class="lbl">SEO 제목 5안 <button class="mini" data-copy="seotitles">전체 복사</button></div>
        <ol class="bul" style="padding-left:20px;font-size:.9rem">${(seo.seo_titles || []).map(t => `<li>${esc(t)}</li>`).join('')}</ol></div>
      <div class="seo-g"><div class="lbl">메타 설명 <button class="mini" data-copy="meta">복사</button></div>
        <p style="margin:0;font-size:.9rem">${esc(seo.meta_description || '')}</p>
        <p class="tiny">${(seo.meta_description || '').length}자</p></div>
      <div class="seo-g"><div class="lbl">핵심 키워드</div>
        <div class="taglist">${(seo.primary_keywords || []).map(k => `<span class="tag">${esc(k)}</span>`).join('')}</div></div>
      <div class="seo-g"><div class="lbl">연관 키워드</div>
        <div class="taglist">${(seo.related_keywords || []).map(k => `<span class="tag">${esc(k)}</span>`).join('')}</div></div>
      <div class="seo-g"><div class="lbl">태그 <button class="mini" data-copy="tags">복사</button></div>
        <div class="taglist">${(seo.tags || []).map(k => `<span class="tag">${esc(k)}</span>`).join('')}</div></div>
      <div class="seo-g"><div class="lbl">썸네일 문구</div>
        ${(seo.thumbnail_copy || []).map(t => `<div class="thumb">
          <div class="m">${esc(t.main || '')}</div><div class="s">${esc(t.sub || '')}</div></div>`).join('')}</div>
      <div class="seo-g"><div class="lbl">FAQ <button class="mini" data-copy="faq">복사</button></div>
        ${(seo.faq || []).map(f => `<div class="faq-q">Q. ${esc(f.q || '')}</div>
          <p class="faq-a">${esc(f.a || '')}</p>`).join('')}</div>
    </div>` : `<div class="sec s-seo"><h3>🔎 SEO</h3>
      <div class="tiny">SEO 단계가 아직 끝나지 않았어요. ✍️ 새 글 탭에서 ④단계를 다시 실행해 보세요.</div></div>`}
  `;

  box.querySelectorAll('input[name="tpick"]').forEach(r => {
    r.onchange = () => { draft.titleIdx = Number(r.value); saveDraft(); renderResult(); };
  });
  box.querySelectorAll('[data-copy]').forEach(b => {
    b.onclick = () => {
      const k = b.dataset.copy;
      const text =
        k === 'md' ? md :
        k === 'html' ? `<h1>${esc(chosenTitle())}</h1>\n` + mdToHtml(w.body_md || '') :
        k === 'plain' ? chosenTitle() + '\n\n' + mdToPlain(md.replace(/^# .*\n/, '')) :
        k === 'seotitles' ? (seo.seo_titles || []).join('\n') :
        k === 'meta' ? (seo.meta_description || '') :
        k === 'tags' ? (seo.tags || []).join(', ') :
        k === 'faq' ? (seo.faq || []).map(f => `Q. ${f.q}\nA. ${f.a}`).join('\n\n') : '';
      copyText(text, b);
    };
  });
  const dl = box.querySelector('[data-dl]');
  if (dl) dl.onclick = () => {
    const safe = chosenTitle().replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || 'post';
    download(`${new Date(draft.at).toISOString().slice(0, 10)}-${safe}.md`, md);
  };
}

// ── 이력 ─────────────────────────────────────────────────────

function pushHistory() {
  const list = loadJSON(K_HIST, []).filter(h => h.id !== draft.id);
  list.unshift({
    id: draft.id, at: draft.at, title: chosenTitle(),
    input: draft.input, opts: draft.opts, stages: draft.stages,
    status: draft.status, err: {}, titleIdx: draft.titleIdx,
  });
  saveJSON(K_HIST, list.slice(0, MAX_HIST));
}

function renderHistory() {
  const list = loadJSON(K_HIST, []);
  const box = $('historyBody');
  if (!list.length) {
    box.innerHTML = `<div class="hint-card"><b>아직 이력이 없어요.</b>
      글을 하나 완성하면 여기에 쌓입니다. 이 기기에만 저장되고 최대 ${MAX_HIST}건까지 남습니다.</div>`;
    return;
  }
  box.innerHTML = list.map(h => {
    const f = FIELDS[h.opts.field];
    return `<button class="hist" type="button" data-id="${h.id}">
      <div class="t"><b>${esc(h.title)}</b>
        <span>${new Date(h.at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })} ·
        ${esc(f ? f.label : '')} · ${esc(LENGTHS[h.opts.length]?.label || '')}</span></div>
      <span class="x" data-del="${h.id}">✕</span>
    </button>`;
  }).join('');

  box.querySelectorAll('.hist').forEach(b => {
    b.onclick = e => {
      if (e.target.dataset.del) {
        saveJSON(K_HIST, loadJSON(K_HIST, []).filter(h => h.id !== e.target.dataset.del));
        renderHistory();
        return;
      }
      const h = loadJSON(K_HIST, []).find(x => x.id === b.dataset.id);
      if (!h) return;
      draft = { ...h, err: {} };
      saveDraft();
      renderInput(); renderOpts(); renderStages(); renderResult();
      switchView('result');
    };
  });
}

// ── 정보 탭 ──────────────────────────────────────────────────

const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;

function renderInfo() {
  const m = getModel();
  const info = MODEL_INFO[m] || {};
  const r = rateOf(m);
  const log = loadJSON(K_USAGE, []);
  const avg = avgPerPost();
  const month = monthCost();
  const lim = budget();

  $('infoBody').innerHTML = `
    <div class="sec">
      <h3>🤖 지금 쓰는 모델</h3>
      <div class="model-now">${esc(info.label || m)}</div>
      <p class="tiny">${esc(info.note || '')}${opusWriter() ? ' · 본문 작성만 <b>Opus 5</b>' : ''}</p>
      ${kv('입력 단가', `$${r.in} <small>/ 100만 토큰${r.onIntro ? ' (프로모션)' : ''}</small>`)}
      ${kv('출력 단가', `$${r.out} <small>/ 100만 토큰</small>`)}
      ${kv('웹검색', `$${WEB_SEARCH_USD} <small>/ 1회</small>`)}
    </div>

    <div class="sec">
      <h3>💰 비용</h3>
      ${kv('글 1편 평균', avg != null ? `${usd(avg)} <small>(${krw(avg)})</small>` : '<small>아직 실측 없음 — 대략 $0.3~0.5</small>')}
      ${kv('이번 달 누적', `${usd(month)} <small>(${krw(month)})</small>`)}
      ${kv('이번 달 한도', lim > 0 ? `${usd(lim)}` : '<small>설정 안 함</small>')}
      ${kv('기록된 호출', `${log.length}회`)}
      <p class="tiny">이 값은 응답의 <code>usage</code> 를 공식 단가로 계산한 <b>실측</b>이에요.
        환율은 표시용 어림값(1달러=${KRW_PER_USD.toLocaleString('ko-KR')}원)입니다.</p>
      <button class="ghost wide" id="clearUsage" type="button">사용량 기록 지우기</button>
    </div>

    <div class="sec">
      <h3>📋 단계별 최근 비용</h3>
      ${STAGES.map(st => {
        const last = log.find(e => e.stage === st.key);
        return kv(`${st.no} ${st.label}`, last ? `${usd(last.cost)} <small>· 검색 ${last.searches || 0}회</small>` : '<small>기록 없음</small>');
      }).join('')}
    </div>

    <div class="sec">
      <h3>ℹ️ 사용법과 한계</h3>
      <ol class="bul howto" style="padding-left:20px;font-size:.9rem">
        <li>기사 링크 · 원문 · 주제 중 하나를 넣고 옵션 6가지를 고른 뒤 <b>글 만들기</b>를 누릅니다.</li>
        <li>4단계가 순서대로 돌아갑니다. 단계마다 결과가 저장되니, 마음에 안 드는 단계만
          <b>이 단계부터 다시</b>로 다시 돌릴 수 있어요(앞 단계 요금은 다시 안 나갑니다).</li>
        <li>완성되면 📄 결과 탭에서 제목을 고르고 마크다운·HTML·평문으로 복사합니다.</li>
      </ol>
      <p class="tiny"><b>알아 둘 한계</b> — 웹검색은 출처와 날짜를 강제하는 기능이 없습니다.
        출처·검색범위 옵션은 “우선순위 지시 + 결과 사후 검증”이라서 요청과 다를 수 있고,
        실제 확보량은 결과 탭의 <b>근거 현황</b>에 그대로 표시됩니다.
        수치와 출처는 게시 전에 사람이 꼭 확인하세요.</p>
      <p class="tiny">블로그 자동 게시는 넣지 않았습니다. 티스토리 Open API는 2024년 2월에 종료됐고,
        네이버는 공식 글쓰기 API를 제공하지 않습니다. 복사 버튼으로 에디터에 붙여넣는 방식이 가장 안전합니다.</p>
    </div>`;

  const cu = $('clearUsage');
  if (cu) cu.onclick = async () => {
    const ok = await askDialog({ icon: '🧹', title: '사용량 기록을 지울까요?',
      lines: ['비용 계산에 쓰는 기록만 지워집니다. 글과 이력은 그대로 남습니다.'],
      yes: '지우기', no: '취소' });
    if (ok) { localStorage.removeItem(K_USAGE); renderInfo(); }
  };
}

// ── 탭·설정 ──────────────────────────────────────────────────

function switchView(name) {
  document.querySelectorAll('.vtab').forEach(t => {
    const on = t.dataset.view === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  ['write', 'result', 'history', 'info'].forEach(v => {
    $('view-' + v).classList.toggle('hidden', v !== name);
  });
  if (name === 'result') renderResult();
  if (name === 'history') renderHistory();
  if (name === 'info') renderInfo();
  window.scrollTo(0, 0);
}

function openSheet() {
  $('apiKey').value = getKey();
  $('model').value = getModel();
  $('opusWriter').checked = opusWriter();
  $('budget').value = localStorage.getItem(K_BUDGET) || '';
  $('aiNotice').checked = aiNotice();
  $('sheet').classList.remove('hidden');
}

function bindSheet() {
  $('settingsBtn').onclick = openSheet;
  $('sheetClose').onclick = () => $('sheet').classList.add('hidden');
  $('sheet').onclick = e => { if (e.target === $('sheet')) $('sheet').classList.add('hidden'); };

  $('saveSet').onclick = () => {
    const k = $('apiKey').value.trim();
    if (k) localStorage.setItem(K_KEY, k); else localStorage.removeItem(K_KEY);
    localStorage.setItem(K_MODEL, $('model').value);
    localStorage.setItem(K_OPUSW, $('opusWriter').checked ? '1' : '0');
    localStorage.setItem(K_NOTICE, $('aiNotice').checked ? '1' : '0');
    const b = $('budget').value.trim();
    if (b) localStorage.setItem(K_BUDGET, b); else localStorage.removeItem(K_BUDGET);
    $('sheet').classList.add('hidden');
    renderResult();
  };

  $('clearAll').onclick = async () => {
    const ok = await askDialog({ icon: '🗑', title: '이력과 초안을 지울까요?',
      lines: ['이 기기에 저장된 <b>작성 중 초안과 완료 이력</b>이 모두 지워집니다.',
              'API 키와 설정, 사용량 기록은 그대로 남습니다.'],
      yes: '모두 지우기', no: '취소' });
    if (!ok) return;
    localStorage.removeItem(K_HIST);
    localStorage.removeItem(K_DRAFT);
    draft = newDraft();
    saveDraft();
    $('sheet').classList.add('hidden');
    renderInput(); renderOpts(); renderStages(); renderResult(); renderHistory();
    switchView('write');
  };
}

function bindTabs() {
  document.querySelectorAll('.vtab').forEach(t => { t.onclick = () => switchView(t.dataset.view); });
  document.querySelectorAll('.mtab').forEach(t => {
    t.onclick = () => {
      draft.input.mode = t.dataset.mode;
      draft.input.value = '';
      saveDraft(); renderInput();
    };
  });
  ['inUrl', 'inText', 'inTopic'].forEach(id => {
    $(id).oninput = () => { draft.input.value = $(id).value; saveDraft(); };
  });
  $('runBtn').onclick = startRun;
}

// ── 시작 ─────────────────────────────────────────────────────

(function init() {
  // 되돌아온 초안의 '진행 중' 상태는 실패로 본다 (새로고침으로 끊긴 경우)
  Object.keys(draft.status).forEach(k => {
    if (draft.status[k] === 'run') {
      draft.status[k] = 'fail';
      draft.err[k] = { title: '중간에 끊겼어요', detail: '앱을 다시 열었거나 새로고침한 것 같아요. 이 단계부터 다시 실행하세요.' };
    }
  });

  bindTabs();
  bindSheet();
  renderInput();
  renderOpts();
  renderStages();

  if (!getKey()) openSheet();
})();
