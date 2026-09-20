/* DojoScope frontend — vanilla JS + D3 v7.
 *
 * 설계 근거 (Munzner, Visualization Analysis & Design):
 * - 점 인코딩은 두 채널로 고정: 모양(O=방어 성공/X=뚫림)과 색(초록/빨강)이
 *   같은 방어 성공/실패를 중복 인코딩(redundant encoding, 5장)한다 — 둘 다
 *   같은 속성을 가리키므로 서로 간섭하지 않고 오히려 식별을 더 빠르게
 *   만든다. 군집 윤곽선은 완전히 다른 채널(Dark2 팔레트)이라 점 색과
 *   헷갈리지 않는다(6.9 Get It Right in Black and White). 지도에는 UMAP
 *   산점도 자체만 남기고 그 아래 설명/범례/미니차트를 전부 없앴다(사용자 요청).
 * - 공간(위치) 채널이 가장 효과적인 채널이므로(5장) residual UMAP을 기본
 *   탭으로 둔다 — hijack_tool을 가장 잘 구분하는 공간이라서.
 * - 투명도(transparency)는 그 자체로 데이터를 encode하는 채널이 아니다(10.2.4) —
 *   "선택/비선택"이라는 이진 상태(하이라이트 vs 흐림)에만 투명도를 쓴다.
 * - 케이스 간 DTW 거리를 한눈에 보여주는 표준 idiom은 정렬된 거리 행렬(클러스터
 *   히트맵, 7.5.2)이다 — 계층적 군집화의 병합 순서로 행/열을 재정렬해서 그린다.
 * - 거리 행렬을 node-link 그래프가 아니라 matrix로 그리는 이유(9.4의 costs/benefits
 *   분석 그대로): 케이스 쌍 전체(n×(n-1)/2)에 거리값이 존재하는 "완전 그래프"라
 *   node-link로 그리면 edge 수가 node 수의 4배를 훌쩍 넘어(가독성 한계) 곧바로
 *   hairball이 된다. matrix는 밀집 그래프에서도 occlusion 없이 선형적으로
 *   확장되고, 레이아웃이 안정적(항목 추가 시 국소적으로만 바뀜)이라 반복 비교에도
 *   적합하다 — 대신 위상 추적(경로 찾기) 과제는 약하므로, 그 과제는 TRACE VIEW의
 *   compare-picker(직접 A/B 지정)로 보완한다.
 */

// 방어 성공(O)=초록, 뚫림(X)=빨강 — 모양과 중복 인코딩(위 설계 근거).
// --safe/--danger와 같은 값(흰 배경 대비 각각 5.02:1, 5.74:1).
const POINT_SAFE = '#15803d';
const POINT_DANGER = '#c81e1e';

// 심각도(Critical~Low)는 순서형(ordinal) 속성이므로 임의의 질적 색이 아니라
// Ch10.3.2 sequential colormap 규칙대로 만들었다: critical→high→medium은
// 단일 색조(red) 안에서 휘도가 단조 감소하는 순차형 램프(10.33 → 6.42 →
// 3.76:1, 흰 배경 대비 직접 계산). low는 "위험도가 낮다"가 아니라 "위험
// 척도 자체에 해당하지 않는다"는 별도 범주라 같은 색조를 계속 옅게 쓰지
// 않고 중립 회청으로 분리했다(README §27).
// - critical: 방어(B조건)가 있었는데도 뚫림 — 방어 자체가 실패
// - high: 무방어(A조건)에서 뚫림 — 예상된 취약점
// - medium: 뚫리진 않았지만 과제 실패 — 가용성 저하
// - low: 뚫리지 않고 과제도 성공 — 정상
const SEVERITY_COLORS = { critical: '#7a1f14', high: '#a8391f', medium: '#c96a2e', low: '#5b6472' };
const SEVERITY_LABELS = { critical: 'critical', high: 'high', medium: 'medium', low: 'low' };
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
function severityOf(d) {
  if (d.security) return d.condition === 'B' ? 'critical' : 'high';
  return d.utility ? 'low' : 'medium';
}

let manifest = null;
let suiteData = null;
let currentSuite = null;
let filters = { condition: 'all', sizeBy: 'residual_length' };
let pickedA = null;
let pickedB = null;
let compareResult = null;
let scrubIndex = 0;
let playTimer = null;
let highlightSet = null;       // Set<case_id> | null — 브러시/군집 선택으로 생긴 하이라이트
let selectedCluster = null;    // 군집 선택 칩에서 고른 군집 라벨(숫자) | null(전체)
let showOutliersOnly = false;
let mapTab = 'residual';       // 'residual' | 'raw' | 'matrix'
let tooltipEl = null;
let detailWhich = 'a';         // 트레이스 원문 패널이 A/B 중 어느 쪽을 보여주는지
let clusterK = 6;              // 계층적 군집화를 몇 개로 자를지 — 덴드로그램(merge_log)을
                                // 클라이언트에서 직접 잘라서 즉시 재계산한다(서버 왕복 없음)
let clusterLabelCache = {};    // `${suite}_${space}_${k}` -> Map(case_id -> label)

// ------------------------------------------------------------------ utils
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text);
  }
  return res.json();
}

// 계층적 군집화 병합 기록(merge_log, scipy linkage 포맷과 동일)을 원하는 k에서
// 잘라 "점 -> 군집 번호" 배열을 만든다. pipeline/cluster.py::cut_into_k_clusters와
// 동일한 알고리즘(처음 n-k번의 병합만 재생)을 그대로 옮긴 것 — 서버가 이미 계산해
// 보내준 merge_log 하나로 어떤 k든 클라이언트에서 즉시 재계산할 수 있다.
function dendrogramCut(mergeLog, n, k) {
  k = Math.max(1, Math.min(k, n));
  const members = new Map();
  for (let i = 0; i < n; i++) members.set(i, [i]);
  let nextId = n;
  const nMerges = n - k;
  for (let step = 0; step < nMerges && step < mergeLog.length; step++) {
    const a = Math.round(mergeLog[step][0]), b = Math.round(mergeLog[step][1]);
    const merged = members.get(a).concat(members.get(b));
    members.delete(a);
    members.delete(b);
    members.set(nextId, merged);
    nextId++;
  }
  const labels = new Array(n).fill(0);
  let clusterIdx = 0;
  for (const leaves of members.values()) {
    leaves.forEach((leaf) => { labels[leaf] = clusterIdx; });
    clusterIdx++;
  }
  return labels;
}

function getClusterLabelMap(space) {
  const key = `${currentSuite}_${space}_${clusterK}`;
  if (clusterLabelCache[key]) return clusterLabelCache[key];
  const dm = suiteData.distance_matrix;
  const mergeLog = space === 'raw' ? dm.raw_merge_log : dm.residual_merge_log;
  const order = dm.case_order;
  const labels = dendrogramCut(mergeLog, order.length, clusterK);
  const map = new Map();
  order.forEach((cid, i) => map.set(cid, labels[i]));
  clusterLabelCache[key] = map;
  return map;
}

// ColorBrewer "Dark2"(Harrower & Brewer 2003) — 점 색상(Okabe-Ito)과 겹치지
// 않는 별도 색상족으로 군집 윤곽선 전용. 흰 배경에서 전부 4:1 이상이 되도록
// 15% 어둡게 일괄 조정(README §27).
const CLUSTER_HULL_PALETTE = ['#168665', '#b85001', '#635f98', '#c42275', '#568d19', '#755a1a', '#8d6418', '#565656'];
function clusterHullColorScale(labels) {
  const domain = Array.from(new Set(labels)).sort((a, b) => a - b).map(String);
  return d3.scaleOrdinal(CLUSTER_HULL_PALETTE).domain(domain);
}

function setStatus(msg, ok) {
  document.getElementById('footer-msg').textContent = msg;
  const dot = document.getElementById('status-dot');
  dot.className = 'status-dot ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
  const conn = document.getElementById('footer-conn');
  if (ok === true) { conn.textContent = 'connected'; conn.className = 'conn-ok'; }
  else if (ok === false) { conn.textContent = 'disconnected'; conn.className = 'conn-err'; }
}

function showBanner(msg, ok) {
  const b = document.getElementById('banner');
  b.textContent = msg;
  b.classList.remove('hidden');
  b.style.background = ok === false ? '#ece0da' : ok === true ? '#e6ebe0' : '#f2ead6';
}
function hideBanner() { document.getElementById('banner').classList.add('hidden'); }

function showTooltip(event, html) {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'tooltip';
    document.body.appendChild(tooltipEl);
  }
  tooltipEl.style.left = event.clientX + 14 + 'px';
  tooltipEl.style.top = event.clientY + 14 + 'px';
  tooltipEl.innerHTML = html;
  tooltipEl.style.display = 'block';
}
function hideTooltip() { if (tooltipEl) tooltipEl.style.display = 'none'; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --------------------------------------------------------------- TRACE/ANALYSIS VIEW
// 팝업·모달 없이 TRACE VIEW·ANALYSIS VIEW가 지도 옆에 항상 떠 있고, 지도에서
// 점을 고르면 즉시 갱신된다(DRTLens류 다중 뷰 대시보드). 대신 지금까지 살펴본
// A/B 조합은 방문 기록으로 남겨 ◀/▶로 오가며 비교할 수 있다.
let history = [];          // [{a, b}, ...] — 지금까지 열어본 A/B 조합
let historyPos = -1;
let navigatingHistory = false;

function resetHistory() {
  history = [];
  historyPos = -1;
  updateNavButtons();
}

function pushHistory() {
  if (navigatingHistory) return;
  const last = history[historyPos];
  if (last && last.a === pickedA && last.b === pickedB) return;
  if (!pickedA && !pickedB) return;
  history = history.slice(0, historyPos + 1);
  history.push({ a: pickedA, b: pickedB });
  historyPos = history.length - 1;
  updateNavButtons();
}

function updateNavButtons() {
  const back = document.getElementById('nav-back');
  const fwd = document.getElementById('nav-forward');
  if (!back || !fwd) return;
  back.disabled = historyPos <= 0;
  fwd.disabled = historyPos >= history.length - 1;
  document.getElementById('nav-pos').textContent = history.length ? `${historyPos + 1} / ${history.length}` : '–';
}

function navHistory(delta) {
  const newPos = historyPos + delta;
  if (newPos < 0 || newPos >= history.length) return;
  historyPos = newPos;
  navigatingHistory = true;
  const st = history[historyPos];
  pickedA = st.a;
  pickedB = st.b;
  updatePickerInputs();
  renderAll();
  maybeCompare();
  navigatingHistory = false;
  updateNavButtons();
}

// pickedA/B가 바뀐 뒤 공통으로 호출: 방문 기록에 남기고 TRACE/ANALYSIS VIEW를 다시 그린다.
function afterPickChange() {
  pushHistory();
  renderAll();
  maybeCompare();
}

function caseTooltipHtml(d) {
  return `<b>${d.case_id}</b><br/>조건: ${d.condition === 'A' ? '무방어' : '방어'} · 방어결과: ${d.security ? 'X 뚫림' : 'O 방어'} · 과제: ${d.utility ? '성공' : '실패'}`
    + `<br/>납치 도구: ${d.hijack_tool || '-'} · 잔차 길이: ${d.residual_length}`
    + `<br/>클릭: A/B 비교에 추가`;
}

// ------------------------------------------------------------------- init
function showEmptyState() {
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('layout').style.display = 'none';
  document.getElementById('kpi-bar').classList.add('hidden');
  document.getElementById('event-log-section').classList.add('hidden');
}
function hideEmptyState() {
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('layout').style.display = '';
  document.getElementById('kpi-bar').classList.remove('hidden');
  document.getElementById('event-log-section').classList.remove('hidden');
}

async function init() {
  setStatus('서버 연결 중…');
  try {
    manifest = await api('/api/manifest');
  } catch (e) {
    setStatus('서버 연결 실패: ' + e.message, false);
    return;
  }
  setStatus('연결됨', true);
  wireControls();
  if (!manifest.suites.length) {
    // 업로드 전이라 데이터가 전혀 없는 상태 — 지도를 그리려 하지 않고 빈 화면 안내만 띄운다.
    showEmptyState();
    return;
  }
  hideEmptyState();
  renderSuiteTabs();
  await loadSuite(manifest.suites[0]);
}

function renderSuiteTabs() {
  const nav = document.getElementById('suite-tabs');
  nav.innerHTML = '';
  manifest.suites.forEach((s) => {
    const btn = document.createElement('button');
    btn.textContent = s;
    btn.dataset.suite = s;
    if (s === currentSuite) btn.classList.add('active');
    btn.onclick = () => loadSuite(s);
    nav.appendChild(btn);
  });
}

async function loadSuite(name) {
  currentSuite = name;
  setStatus(`'${name}' 불러오는 중…`);
  suiteData = await api(`/api/suite/${name}`);
  setStatus(`'${name}': ${suiteData.case_ids.length}건 로드됨`, true);
  renderSuiteTabs();
  mapZoomTransform['svg-center'] = d3.zoomIdentity;
  mapZoomTransform['svg-right'] = d3.zoomIdentity;
  eventLogPage = 0;
  clearHighlight();
  pickedA = null;
  pickedB = null;
  resetHistory();
  renderSecurityOutcomes();
  renderAll();
}

function filteredCases() {
  let cases = suiteData.cases;
  if (filters.condition !== 'all') cases = cases.filter((c) => c.condition === filters.condition);
  return cases;
}

// ------------------------------------------------------------------ render
function renderAll() {
  hideTooltip(); // 재렌더링으로 점이 다시 그려지기 전에, 열려 있던 호버 팝업을 먼저 닫는다
  const cases = filteredCases();
  document.getElementById('badge-map').textContent = mapTab === 'matrix' ? `${cases.length}×${cases.length}` : `${cases.length}건`;
  // residual은 어떤 탭이 켜져 있든 항상 계산한다(9.3의 기본 근거 뷰).
  renderMap('svg-center', cases, 'coords_residual', true, 'residual_isolation_percentile');
  if (mapTab === 'raw') {
    renderMap('svg-right', cases, 'coords_raw', false, 'raw_isolation_percentile');
  } else if (mapTab === 'matrix') {
    renderDistanceMatrix(cases);
  }
  renderTraceDetail();
  renderKpiBar(cases);
  renderEventLog(cases);
  renderClusterPicker(cases);
}

// --------------------------------------------------------------- KPI bar
// shadcn-admin/Tremor/Tabler류 SOC 대시보드의 상단 KPI 카드 패턴을 이
// 프로젝트의 실제 지표로 옮긴 것(README §23). "실시간" 수치가 아니라 현재
// 필터에 걸린 케이스 집합에 대한 정적 요약이므로, 실시간 텔레메트리인 것처럼
// 보이게 하지 않고(6.9 — 데이터 성격을 왜곡하지 않기) 있는 그대로 "현재
// 필터 기준" 스냅샷으로 라벨링했다.
function renderKpiBar(cases) {
  const bar = document.getElementById('kpi-bar');
  if (bar.classList.contains('hidden')) return;
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  cases.forEach((d) => { counts[severityOf(d)]++; });
  document.querySelector('#kpi-total .kpi-value').textContent = cases.length;
  document.querySelector('#kpi-critical .kpi-value').textContent = counts.critical;
  document.querySelector('#kpi-high .kpi-value').textContent = counts.high;
  document.querySelector('#kpi-medium .kpi-value').textContent = counts.medium;
  document.querySelector('#kpi-low .kpi-value').textContent = counts.low;
  const condB = cases.filter((d) => d.condition === 'B');
  const defenseRate = condB.length ? (condB.filter((d) => !d.security).length / condB.length) * 100 : null;
  document.querySelector('#kpi-defense-rate .kpi-value').textContent = defenseRate === null ? 'n/a' : `${defenseRate.toFixed(0)}%`;
}

// --------------------------------------------------------------- event log
let eventLogPage = 0;
let eventLogSeverityFilter = 'all';
let eventLogSearch = '';
const EVENT_LOG_PAGE_SIZE = 20;

function renderEventLog(cases) {
  const section = document.getElementById('event-log-section');
  if (section.classList.contains('hidden')) return;
  let rows = cases;
  if (eventLogSeverityFilter !== 'all') rows = rows.filter((d) => severityOf(d) === eventLogSeverityFilter);
  if (eventLogSearch) rows = rows.filter((d) => d.case_id.toLowerCase().includes(eventLogSearch));
  rows = rows.slice().sort((a, b) => SEVERITY_ORDER.indexOf(severityOf(a)) - SEVERITY_ORDER.indexOf(severityOf(b)));

  const totalPages = Math.max(1, Math.ceil(rows.length / EVENT_LOG_PAGE_SIZE));
  eventLogPage = Math.min(eventLogPage, totalPages - 1);
  const pageRows = rows.slice(eventLogPage * EVENT_LOG_PAGE_SIZE, (eventLogPage + 1) * EVENT_LOG_PAGE_SIZE);

  document.getElementById('badge-eventlog').textContent = `${rows.length}건`;
  document.getElementById('event-log-count').textContent = `${rows.length}건 중 ${pageRows.length}건 표시`;
  document.getElementById('event-log-page-readout').textContent = `${eventLogPage + 1} / ${totalPages}`;
  document.getElementById('event-log-prev').disabled = eventLogPage === 0;
  document.getElementById('event-log-next').disabled = eventLogPage >= totalPages - 1;

  const tbody = document.getElementById('event-log-tbody');
  tbody.innerHTML = '';
  pageRows.forEach((d) => {
    const sev = severityOf(d);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="severity-badge" title="${SEVERITY_LABELS[sev]}" style="background:${SEVERITY_COLORS[sev]}"></span></td>`
      + `<td>${d.case_id}</td>`
      + `<td>${currentSuite}</td>`
      + `<td>${d.condition}</td>`
      + `<td>${d.security ? '뚫림' : '방어'} · ${d.utility ? '성공' : '실패'}</td>`
      + `<td>${d.hijack_tool || '없음'}</td>`
      + `<td>${(d.residual_length ?? 0).toFixed ? d.residual_length.toFixed(1) : d.residual_length}</td>`
      + `<td><button class="ghost-btn ev-view-btn">보기</button></td>`;
    tr.querySelector('.ev-view-btn').onclick = (e) => { e.stopPropagation(); pickedA = d.case_id; pickedB = null; updatePickerInputs(); afterPickChange(); };
    tr.onclick = () => { pickedA = d.case_id; pickedB = null; updatePickerInputs(); afterPickChange(); };
    tbody.appendChild(tr);
  });
}

function renderSecurityOutcomes() {
  const sa = suiteData.security_analysis;
  const body = document.getElementById('security-body');
  const summaryLine = document.getElementById('security-summary-line');
  body.innerHTML = '';
  if (!sa) { summaryLine.textContent = ''; return; }
  const a = sa.conditions.A, b = sa.conditions.B;
  summaryLine.textContent = a && b
    ? `— ASR A ${(a.targeted_asr * 100).toFixed(0)}% → B ${(b.targeted_asr * 100).toFixed(0)}% (펼쳐서 상세)`
    : '';
  const metricRow = (label, val, ci, color) => {
    const pct = val * 100;
    const ciHtml = ci ? `<div style="font-size:9.5px;color:#8a8578;margin:-4px 0 6px 98px;">95% CI [${(ci[0] * 100).toFixed(0)}–${(ci[1] * 100).toFixed(0)}%]</div>` : '';
    return `<div class="sec-metric-row"><span class="sec-metric-label">${label}</span>`
      + `<div class="sec-metric-track"><div class="sec-metric-fill" style="width:${pct}%;background:${color}"></div></div>`
      + `<span class="sec-metric-val">${pct.toFixed(0)}%</span></div>${ciHtml}`;
  };
  ['A', 'B'].forEach((cond) => {
    const c = sa.conditions[cond];
    if (!c) return;
    const card = document.createElement('div');
    card.className = 'sec-card';
    card.innerHTML = `<div class="sec-card-title">조건 ${cond} (${cond === 'A' ? '무방어' : '방어'}) · n=${c.n}</div>`
      + metricRow('Targeted ASR', c.targeted_asr, c.targeted_asr_ci95, '#7a2a20')
      + metricRow('과제 성공률', c.task_utility_rate, c.task_utility_ci95, '#4d9c76')
      + metricRow('안전 완료율', c.safe_completion_rate, c.safe_completion_ci95, '#1f3a5f');
    body.appendChild(card);
  });
  const pd = sa.paired_defense;
  if (pd) {
    const t = pd.security_transitions;
    const card = document.createElement('div');
    card.className = 'sec-card';
    card.innerHTML = `<div class="sec-card-title">A→B 짝 비교 (n=${pd.n_pairs}쌍)</div>`
      + `<div class="sec-transition-grid">`
      + `<div class="sec-transition-cell" style="background:#e6ebe0;"><span class="n">${t.blocked}</span>차단됨 (뚫림→방어)</div>`
      + `<div class="sec-transition-cell" style="background:#ece0da;"><span class="n">${t.regressed}</span>퇴행 (방어→뚫림)</div>`
      + `<div class="sec-transition-cell" style="background:#f2ead6;"><span class="n">${t.still_hijacked}</span>여전히 뚫림</div>`
      + `<div class="sec-transition-cell" style="background:#e9e6dd;"><span class="n">${t.still_safe}</span>여전히 안전</div>`
      + `</div>`
      + `<div class="sec-note">McNemar 양측 exact p=${pd.mcnemar_exact_pvalue.toFixed(4)} · 차단율(기준 뚫림 대비) ${(pd.blocked_rate_given_baseline_hijack * 100).toFixed(0)}% · `
      + `퇴행율(기준 안전 대비) ${(pd.regression_rate_given_baseline_safe * 100).toFixed(0)}%</div>`;
    body.appendChild(card);
  }
  if (sa.metric_scope && sa.metric_scope.note) {
    const note = document.createElement('div');
    note.className = 'sec-note';
    note.style.cssText = 'flex-basis:100%;';
    note.textContent = sa.metric_scope.note;
    body.appendChild(note);
  }
}

// --------------------------------------------------------------- trace detail (원문)
function renderTraceDetail() {
  const box = document.getElementById('trace-detail');
  const hint = document.getElementById('trace-empty-hint');
  if (!pickedA && !pickedB) { box.classList.add('hidden'); hint.classList.remove('hidden'); return; }
  box.classList.remove('hidden');
  hint.classList.add('hidden');
  const bTab = document.querySelector('#detail-tabs .tab-btn[data-which="b"]');
  bTab.disabled = !pickedB;
  bTab.style.opacity = pickedB ? 1 : 0.4;
  if (detailWhich === 'b' && !pickedB) detailWhich = 'a';
  document.querySelectorAll('#detail-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.which === detailWhich));
  renderDetailBody(detailWhich);
}

function eventRowHtml(ev) {
  const roleLabel = { user: 'user', tool_call: 'tool_call', tool_resp: 'tool_resp' }[ev.role] || ev.role;
  const args = ev.args && Object.keys(ev.args).length ? JSON.stringify(ev.args) : '';
  const flags = [];
  if (ev.role !== 'user') flags.push(ev.matched_to_gt ? '<span class="evt-flag gt-match">GT매칭</span>' : '<span class="evt-flag gt-residual">잔차</span>');
  if (ev.injected) flags.push('<span class="evt-flag injected">주입됨</span>');
  return `<div class="evt-row ${ev.injected ? 'evt-injected' : ''}">`
    + `<div class="evt-idx">e${ev.index}</div>`
    + `<div class="evt-role role-${ev.role}">${roleLabel}</div>`
    + `<div class="evt-body">`
    + (ev.function ? `<div class="evt-fn">${escapeHtml(ev.function)}${args ? '(' + escapeHtml(args) + ')' : ''}</div>` : '')
    + (ev.text ? `<div class="evt-text">${escapeHtml(ev.text)}</div>` : '')
    + `</div><div class="evt-flags">${flags.join('')}</div></div>`;
}

function renderDetailBody(which) {
  const caseId = which === 'a' ? pickedA : pickedB;
  const body = document.getElementById('trace-detail-body');
  const pairBtn = document.getElementById('pair-defense-btn');
  if (!caseId) {
    body.innerHTML = '<div style="padding:10px;color:#6b6558;font-size:11.5px;">트레이스B가 아직 선택되지 않았습니다.</div>';
    pairBtn.classList.add('hidden');
    return;
  }
  const c = suiteData.cases.find((x) => x.case_id === caseId);
  if (!c) { body.innerHTML = ''; pairBtn.classList.add('hidden'); return; }
  body.innerHTML = c.events.map(eventRowHtml).join('');
  const pair = suiteData.cases.find((x) => x.pair_key === c.pair_key && x.condition !== c.condition);
  if (pair) {
    pairBtn.classList.remove('hidden');
    pairBtn.textContent = `방어 ${pair.condition === 'A' ? '전(A)' : '후(B)'} 짝 케이스 불러오기 (${pair.case_id})`;
    pairBtn.onclick = () => {
      pickedA = c.condition === 'A' ? c.case_id : pair.case_id;
      pickedB = c.condition === 'A' ? pair.case_id : c.case_id;
      updatePickerInputs();
      afterPickChange();
    };
  } else {
    pairBtn.classList.add('hidden');
  }
}

function sizeScaleFor(cases) {
  const baseSize = +document.getElementById('point-size').value;
  if (filters.sizeBy === 'constant') return () => baseSize;
  const vals = cases.map((d) => d[filters.sizeBy] || 0);
  let ext = d3.extent(vals);
  if (ext[0] === ext[1]) ext = [0, ext[1] || 1];
  const scale = d3.scaleSqrt().domain(ext).range([baseSize * 0.55, baseSize * 2.0]).clamp(true);
  return (d) => scale(d[filters.sizeBy] || 0);
}

// 군집 윤곽은 점 색상(색상 기준 드롭다운)과 무관하게 항상 계층적 군집화
// 결과(clusterK로 자른 덴드로그램)로 그린다 — 점 색은 과제 성공/실패 등 원하는
// 속성 그대로 두고, 어떤 케이스들이 같은 군집인지는 윤곽선 색으로만 겹쳐 보여준다.
// 계층적 군집화(average linkage)는 잔차 DTW 거리행렬 위에서 계산되고,
// UMAP은 그 거리를 "국소 이웃"만 최대한 보존하며 2D로 눌러 담는 별개의
// 투영이다 — 그래서 한 군집의 구성원이 2D에서 여러 덩어리로 흩어져
// 떨어져 있을 수 있다. 이때 d3.polygonHull()로 볼록 껍질(convex hull)
// 하나만 그리면, 그 군집과 무관한 사이 공간의 점들까지 껍질 안에 걸려서
// "군집이 멀리 있는 걸 다 붙잡는" 것처럼 보인다(사용자가 실제로 겪은 문제,
// UMAP 좌표로 직접 검증함 — 인접한 두 군집의 중심 거리가 군집 내부 평균
// 반경과 비슷할 만큼 가까운 경우가 실제로 있었다).
// 해결: 군집 전체에 하나의 볼록 껍질을 씌우는 대신, 화면 픽셀 거리 기준으로
// "실제로 서로 붙어 있는" 부분집합(연결 요소)별로 각각 작은 볼록 껍질을
// 그린다 — 비어 있는 공간을 건너뛰어 가짜로 다른 군집의 점을 감싸는 일이
// 구조적으로 불가능해진다.
function connectedComponents(points, threshold) {
  const n = points.length;
  const visited = new Array(n).fill(false);
  const components = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const stack = [i];
    visited[i] = true;
    const comp = [];
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (let j = 0; j < n; j++) {
        if (visited[j]) continue;
        const dx = points[cur][0] - points[j][0], dy = points[cur][1] - points[j][1];
        if (Math.sqrt(dx * dx + dy * dy) <= threshold) { visited[j] = true; stack.push(j); }
      }
    }
    components.push(comp);
  }
  return components;
}

function drawHulls(g, cases, coordField, space, x, y) {
  const labelMap = getClusterLabelMap(space);
  const groups = d3.group(cases, (d) => labelMap.get(d.case_id));
  const hullColor = clusterHullColorScale(Array.from(labelMap.values()));

  // "가깝다"의 기준 — 지금 화면(줌 레벨 포함)에 실제로 보이는 모든 점의
  // 최근접 이웃 거리 중앙값의 2.5배. 점이 빽빽하면 문턱값도 자동으로
  // 줄어들고, 흩어져 있으면 늘어난다(고정 픽셀값이 아니라 데이터에 맞춰
  // 적응한다).
  const allPts = cases.map((d) => [x(d[coordField][0]), y(d[coordField][1])]);
  const nnDists = allPts.map((p, i) => {
    let best = Infinity;
    for (let j = 0; j < allPts.length; j++) {
      if (i === j) continue;
      const dx = p[0] - allPts[j][0], dy = p[1] - allPts[j][1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < best) best = dist;
    }
    return best;
  }).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const median = nnDists.length ? nnDists[Math.floor(nnDists.length / 2)] : 20;
  const threshold = Math.max(median * 2.5, 12);

  groups.forEach((pts, key) => {
    const points = pts.map((d) => [x(d[coordField][0]), y(d[coordField][1])]);
    const components = connectedComponents(points, threshold);
    components.forEach((comp) => {
      if (comp.length < 3) return;
      const hull = d3.polygonHull(comp.map((i) => points[i]));
      if (!hull) return;
      g.append('path')
        .attr('class', 'hull-outline')
        .attr('pointer-events', 'none')
        .attr('d', 'M' + hull.map((p) => p.join(',')).join('L') + 'Z')
        .attr('fill', hullColor(String(key)))
        .attr('stroke', hullColor(String(key)));
    });
  });
}

// 군집별 선택 UI — 지도 위 윤곽선(색)과 같은 팔레트로 칩을 그려서 "이 칩 =
// 저 색 군집"이 바로 매칭되게 하고, 클릭하면 그 군집만 남기고 나머지를
// 흐리게 한다(기존 브러시 하이라이트 메커니즘 재사용, README §25 원칙대로
// 점이 사라지지 않고 옅어지기만 함).
function renderClusterPicker(cases) {
  const box = document.getElementById('cluster-picker');
  if (!suiteData || !suiteData.distance_matrix) { box.innerHTML = ''; return; }
  const labelMap = getClusterLabelMap('residual');
  const counts = new Map();
  cases.forEach((d) => {
    const lab = labelMap.get(d.case_id);
    if (lab === undefined) return;
    if (!counts.has(lab)) counts.set(lab, []);
    counts.get(lab).push(d.case_id);
  });
  const labels = Array.from(counts.keys()).sort((a, b) => a - b);
  const color = clusterHullColorScale(labels);

  box.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.className = 'chip cluster-chip' + (selectedCluster === null ? ' active' : '');
  allBtn.textContent = '전체';
  allBtn.onclick = () => { selectedCluster = null; clearHighlight(); renderClusterPicker(filteredCases()); };
  box.appendChild(allBtn);

  labels.forEach((lab) => {
    const ids = counts.get(lab);
    const btn = document.createElement('button');
    btn.className = 'chip cluster-chip' + (selectedCluster === lab ? ' active' : '');
    btn.innerHTML = `<span class="cluster-chip-swatch" style="background:${color(String(lab))}"></span>군집 ${lab} (${ids.length})`;
    btn.onclick = () => {
      if (selectedCluster === lab) { selectedCluster = null; clearHighlight(); }
      else { selectedCluster = lab; setHighlight(new Set(ids)); }
      renderClusterPicker(filteredCases());
    };
    box.appendChild(btn);
  });
}

function highlightIds(ids) {
  ['svg-center', 'svg-right'].forEach((id) => {
    d3.select('#' + id).selectAll('g.pt-group').classed('dim', (d) => ids && !ids.has(d.case_id));
  });
}

function setHighlight(ids) {
  highlightSet = ids && ids.size ? ids : null;
  highlightIds(highlightSet);
}

function clearHighlight() {
  selectedCluster = null;
  setHighlight(null, null);
}

// 브러시로 지도 위 영역을 드래그 선택하면 선택된 점만 남기고 나머지를
// 흐리게 만든다(하이라이트) — 설명 텍스트 패널 없이 지도 자체의 시각적
// 피드백만으로 충분하다(사용자 요청: 지도 아래 설명 없이 UMAP만).
function applyBrushSelection(ids) {
  selectedCluster = null; // 브러시는 군집 선택과 다른 하이라이트 출처라 칩 활성 표시를 지운다
  if (!ids || !ids.size) { clearHighlight(); return; }
  setHighlight(ids, 'brush');
}

function outlierSet(cases, isolationField) {
  return new Set(cases.filter((d) => d[isolationField] >= 0.9).map((d) => d.case_id));
}

function renderMap(svgId, cases, coordField, withBrush, isolationField) {
  const svgEl = document.getElementById(svgId);
  const svg = d3.select(svgEl);
  svg.selectAll('*').remove();
  const width = svgEl.clientWidth || 400;
  const height = svgEl.clientHeight || 300;
  const margin = { top: 14, right: 14, bottom: 30, left: 38 };

  if (!cases.length) return;

  const xs = cases.map((d) => d[coordField][0]);
  const ys = cases.map((d) => d[coordField][1]);
  const xBase = d3.scaleLinear().domain(d3.extent(xs)).nice().range([margin.left, width - margin.right]);
  const yBase = d3.scaleLinear().domain(d3.extent(ys)).nice().range([height - margin.bottom, margin.top]);
  const zt = mapZoomTransform[svgId] || d3.zoomIdentity;
  const x = zt.rescaleX(xBase);
  const y = zt.rescaleY(yBase);
  const sizeScale = sizeScaleFor(cases);

  const g = svg.append('g');
  g.append('g').attr('transform', `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(5).tickSize(3)).call((s) => s.selectAll('text').attr('font-size', 9).attr('fill', '#6b6558'))
    .call((s) => s.selectAll('line,path').attr('stroke', '#c9c4b8'));
  g.append('g').attr('transform', `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(3)).call((s) => s.selectAll('text').attr('font-size', 9).attr('fill', '#6b6558'))
    .call((s) => s.selectAll('line,path').attr('stroke', '#c9c4b8'));
  g.append('text').attr('x', width / 2).attr('y', height - 4).attr('text-anchor', 'middle')
    .attr('font-size', 9).attr('fill', '#6b6558').text('UMAP-1 (상대 거리, 절대값 없음)');
  g.append('text').attr('transform', `translate(11,${height / 2}) rotate(-90)`)
    .attr('text-anchor', 'middle').attr('font-size', 9).attr('fill', '#6b6558').text('UMAP-2');

  // 확대(줌) 시 점이 축 바깥으로 새어나가지 않게 플롯 영역만 clip한다.
  const clipId = `plot-clip-${svgId}`;
  svg.append('clipPath').attr('id', clipId).append('rect')
    .attr('x', margin.left).attr('y', margin.top)
    .attr('width', Math.max(0, width - margin.left - margin.right))
    .attr('height', Math.max(0, height - margin.top - margin.bottom));
  const plot = g.append('g').attr('clip-path', `url(#${clipId})`);

  if (withBrush) {
    const brush = d3.brush()
      .extent([[margin.left, margin.top], [width - margin.right, height - margin.bottom]])
      .on('end', (event) => {
        if (!event.selection) { applyBrushSelection(null); return; }
        const [[x0, y0], [x1, y1]] = event.selection;
        const ids = new Set(cases.filter((d) => {
          const px = x(d[coordField][0]), py = y(d[coordField][1]);
          return px >= x0 && px <= x1 && py >= y0 && py <= y1;
        }).map((d) => d.case_id));
        applyBrushSelection(ids);
      });
    plot.append('g').attr('class', 'brush-layer').call(brush);
  }

  if (document.getElementById('toggle-hull').checked) {
    drawHulls(plot, cases, coordField, coordField === 'coords_raw' ? 'raw' : 'residual', x, y);
  }

  const dimIds = highlightSet || (showOutliersOnly ? outlierSet(cases, isolationField) : null);

  const ptG = plot.selectAll('g.pt-group').data(cases, (d) => d.case_id).join('g')
    .attr('class', 'pt-group')
    .classed('dim', (d) => dimIds && !dimIds.has(d.case_id))
    .attr('transform', (d) => `translate(${x(d[coordField][0])},${y(d[coordField][1])})`)
    .style('cursor', 'pointer')
    .on('mouseenter', (event, d) => { showTooltip(event, caseTooltipHtml(d)); if (!highlightSet) highlightIds(new Set([d.case_id])); })
    .on('mousemove', (event) => { if (tooltipEl) { tooltipEl.style.left = event.clientX + 14 + 'px'; tooltipEl.style.top = event.clientY + 14 + 'px'; } })
    .on('mouseleave', () => { hideTooltip(); if (!highlightSet) highlightIds(null); })
    .on('click', (event, d) => handlePointClick(d));

  ptG.each(function (d) {
    const s = d3.select(this);
    const r = sizeScale(d);
    const fill = d.security ? POINT_DANGER : POINT_SAFE;
    if (d.security) {
      // 방어 결과 = 모양(고정 인코딩): 뚫림(security=true) -> X
      const k = r * 0.62;
      s.append('line').attr('x1', -k).attr('y1', -k).attr('x2', k).attr('y2', k).attr('stroke', fill).attr('stroke-width', Math.max(1.6, r * 0.34)).attr('stroke-linecap', 'round');
      s.append('line').attr('x1', -k).attr('y1', k).attr('x2', k).attr('y2', -k).attr('stroke', fill).attr('stroke-width', Math.max(1.6, r * 0.34)).attr('stroke-linecap', 'round');
    } else {
      // 방어 성공(security=false) -> O
      s.append('circle').attr('r', r).attr('fill', 'none').attr('stroke', fill).attr('stroke-width', Math.max(1.6, r * 0.34));
    }
    if (pickedA === d.case_id) s.append('circle').attr('r', r + 4).attr('fill', 'none').attr('stroke', '#1f3a5f').attr('stroke-width', 2.2);
    if (pickedB === d.case_id) s.append('circle').attr('r', r + 4).attr('fill', 'none').attr('stroke', '#7a2a20').attr('stroke-width', 2.2);
  });

  attachZoom(svgId);
}

// --------------------------------------------------------------- distance matrix (클러스터 히트맵)
function leafOrder(mergeLog, n) {
  if (!mergeLog || !mergeLog.length) return d3.range(n);
  const expand = (id) => {
    if (id < n) return [id];
    const row = mergeLog[id - n];
    if (!row) return [id];
    return [...expand(row[0]), ...expand(row[1])];
  };
  return expand(n + mergeLog.length - 1);
}

function renderDistanceMatrix(cases) {
  const svgEl = document.getElementById('svg-matrix');
  const svg = d3.select(svgEl);
  svg.selectAll('*').remove();
  const dm = suiteData.distance_matrix;
  if (!dm) return;
  const width = svgEl.clientWidth || 400;
  const height = svgEl.clientHeight || 300;
  const margin = { top: 10, right: 10, bottom: 10, left: 10 };

  const idSet = new Set(cases.map((d) => d.case_id));
  const allIds = dm.case_order;
  const order = leafOrder(dm.residual_merge_log, allIds.length).filter((i) => idSet.has(allIds[i]));
  const n = order.length;
  if (n < 2) { svg.append('text').attr('x', 10).attr('y', 20).attr('font-size', 11).text('케이스가 너무 적습니다.'); return; }

  const size = Math.min((width - margin.left - margin.right) / n, (height - margin.top - margin.bottom) / n, 16);
  const matrix = dm.residual;
  const byId = new Map(cases.map((d) => [d.case_id, d]));
  const maxD = d3.max(order, (i) => d3.max(order, (j) => matrix[i][j])) || 1;
  const color = d3.scaleSequential((t) => d3.interpolateBlues(1 - t)).domain([0, maxD]);

  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
  const cells = [];
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const i = order[a], j = order[b];
      cells.push({ a, b, i, j, dist: matrix[i][j], idA: allIds[i], idB: allIds[j] });
    }
  }
  g.selectAll('rect').data(cells).join('rect')
    .attr('x', (d) => d.b * size).attr('y', (d) => d.a * size)
    .attr('width', size - 0.5).attr('height', size - 0.5)
    .attr('fill', (d) => (d.a === d.b ? '#e4e0d5' : color(d.dist)))
    .style('cursor', 'pointer')
    .on('mouseenter', (event, d) => {
      showTooltip(event, `<b>${d.idA}</b><br/>vs<br/><b>${d.idB}</b><br/>residual DTW 거리 = ${d.dist.toFixed(3)}`);
      highlightIds(new Set([d.idA, d.idB]));
    })
    .on('mousemove', (event) => { if (tooltipEl) { tooltipEl.style.left = event.clientX + 14 + 'px'; tooltipEl.style.top = event.clientY + 14 + 'px'; } })
    .on('mouseleave', () => { hideTooltip(); highlightIds(highlightSet); })
    .on('click', (d3event, d) => {
      if (d.idA === d.idB) return;
      pickedA = d.idA; pickedB = d.idB;
      updatePickerInputs();
      afterPickChange();
    });

  svg.append('text').attr('x', margin.left).attr('y', height - 2).attr('font-size', 9).attr('fill', '#6b6558')
    .text(`n=${n} · 계층적 군집 병합 순서로 정렬 · 진할수록 가까움(잔차 DTW) · 셀 클릭 = 아래 비교 도구에 A/B로 채우기`);
}

// --------------------------------------------------------------- picking
function handlePointClick(d) {
  if (!pickedA || (pickedA && pickedB)) { pickedA = d.case_id; pickedB = null; }
  else if (!pickedB && d.case_id !== pickedA) { pickedB = d.case_id; }
  else if (d.case_id === pickedA) { pickedA = null; }
  updatePickerInputs();
  afterPickChange();
}

function updatePickerInputs() {
  document.getElementById('pick-a').value = pickedA || '';
  document.getElementById('pick-b').value = pickedB || '';
}

function maybeCompare() {
  if (pickedA && pickedB && pickedA !== pickedB) {
    document.getElementById('analysis-empty-hint').classList.add('hidden');
    runCompare();
  } else {
    compareResult = null;
    document.getElementById('compare-body').classList.add('hidden');
    document.getElementById('dtw-value').textContent = '–';
    document.getElementById('analysis-empty-hint').classList.toggle('hidden', !!pickedA);
  }
  renderNeighborEvidence();
}

// --------------------------------------------------------------- 설명가능성(XAI)
// UMAP/군집화가 "왜 이 케이스들을 가깝다고 판단했는지"를 문장으로 설명하는 대신,
// 실제로 계산에 쓰인 거리값 자체(residual DTW distance matrix)를 최근접 이웃
// 몇 개로 압축해 보여준다 — 판단 근거가 검증 가능한 숫자로 남는다(블랙박스가
// 아니라 재현 가능한 계산이라는 것을 직접 보여주는 것).
function computeNearestNeighbors(caseId, k) {
  const dm = suiteData && suiteData.distance_matrix;
  if (!dm) return [];
  const order = dm.case_order;
  const i = order.indexOf(caseId);
  if (i < 0) return [];
  const row = dm.residual[i];
  const byId = new Map(suiteData.cases.map((c) => [c.case_id, c]));
  return order
    .map((cid, j) => ({ case_id: cid, dist: row[j], case: byId.get(cid) }))
    .filter((d) => d.case_id !== caseId && d.case)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, k);
}

function renderNeighborEvidence() {
  const box = document.getElementById('neighbor-evidence');
  if (!pickedA || !suiteData || !suiteData.distance_matrix) { box.classList.add('hidden'); return; }
  const neighbors = computeNearestNeighbors(pickedA, 4);
  if (!neighbors.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const maxDist = Math.max(...neighbors.map((n) => n.dist), 1e-6);
  const bars = document.getElementById('neighbor-bars');
  bars.innerHTML = '';
  neighbors.forEach((n) => {
    const sev = severityOf(n.case);
    const row = document.createElement('div');
    row.className = 'neighbor-row';
    row.dataset.caseId = n.case_id;
    row.innerHTML = `<span class="severity-dot" style="background:${SEVERITY_COLORS[sev]}"></span>`
      + `<span class="neighbor-id">${n.case_id.length > 26 ? n.case_id.slice(0, 25) + '…' : n.case_id}</span>`
      + `<div class="neighbor-bar-track"><div class="neighbor-bar-fill" style="width:${(1 - n.dist / maxDist / 1.05) * 100}%"></div></div>`
      + `<span class="neighbor-dist">${n.dist.toFixed(2)}</span>`;
    row.onclick = () => { pickedB = n.case_id; updatePickerInputs(); afterPickChange(); };
    bars.appendChild(row);
  });
}

async function runCompare() {
  setStatus('비교 계산 중…');
  try {
    const res = await api('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_id_a: pickedA, case_id_b: pickedB }),
    });
    compareResult = res;
    document.getElementById('dtw-value').textContent = res.distance.toFixed(3);
    document.getElementById('compare-body').classList.remove('hidden');
    scrubIndex = 0;
    const scrub = document.getElementById('scrub');
    scrub.max = Math.max(0, res.path.length - 1);
    scrub.value = 0;
    renderAlignRows();
    setStatus('비교 완료', true);
  } catch (e) {
    setStatus('비교 실패: ' + e.message, false);
  }
}

function buildDiagnosis(cmp) {
  const firstResidual = (events, gtAlign) => {
    for (let i = 0; i < events.length; i++) if (!gtAlign.matched_to_gt[i]) return events[i];
    return null;
  };
  const fa = firstResidual(cmp.events_a, cmp.gt_align_a);
  const fb = firstResidual(cmp.events_b, cmp.gt_align_b);
  const condLabel = (c) => (c === 'A' ? '무방어' : c === 'B' ? '방어' : c);
  const secLabel = (c) => (c.security ? 'X 뚫림' : 'O 방어 성공');
  const lines = [];
  lines.push(`DTW 거리 <b>${cmp.distance.toFixed(3)}</b> · 트레이스A(조건=${condLabel(cmp.case_a.condition)}, ${secLabel(cmp.case_a)}) · `
    + `트레이스B(조건=${condLabel(cmp.case_b.condition)}, ${secLabel(cmp.case_b)})`);
  lines.push(fa ? `트레이스A: e${fa.index}에서 <b>${fa.function || fa.role}</b>(으)로 정답 시퀀스에서 처음 이탈`
    : '트레이스A: 정답 시퀀스에서 이탈한 이벤트 없음 (전부 GT와 매칭됨)');
  lines.push(fb ? `트레이스B: e${fb.index}에서 <b>${fb.function || fb.role}</b>(으)로 정답 시퀀스에서 처음 이탈`
    : '트레이스B: 정답 시퀀스에서 이탈한 이벤트 없음 (전부 GT와 매칭됨)');
  return lines.join('<br/>');
}

function renderAlignRows() {
  const cmp = compareResult;
  const container = document.getElementById('align-rows');
  container.innerHTML = '';
  const sameGT = JSON.stringify(cmp.case_a.ground_truth) === JSON.stringify(cmp.case_b.ground_truth);
  const condLabel = (c) => (c === 'A' ? '무방어' : c === 'B' ? '방어' : c);

  const rows = [];
  rows.push({ label: '정답 (GT)' + (sameGT ? '' : ' · 트레이스A기준'), key: 'gtA', items: cmp.case_a.ground_truth.map((fn, i) => ({ idx: i, cls: 'gt', text: fn })) });
  rows.push({
    label: `트레이스A (조건 ${condLabel(cmp.case_a.condition)})`, key: 'a',
    items: cmp.events_a.map((e, i) => ({ idx: i, text: e.function || e.role, injected: e.injected, sentence: e.sentence, cls: cmp.gt_align_a.matched_to_gt[i] ? 'matched' : 'residual' })),
  });
  rows.push({
    label: `트레이스B (조건 ${condLabel(cmp.case_b.condition)})`, key: 'b',
    items: cmp.events_b.map((e, i) => ({ idx: i, text: e.function || e.role, injected: e.injected, sentence: e.sentence, cls: cmp.gt_align_b.matched_to_gt[i] ? 'matched' : 'residual' })),
  });
  if (!sameGT) rows.push({ label: '정답 (GT) · 트레이스B기준', key: 'gtB', items: cmp.case_b.ground_truth.map((fn, i) => ({ idx: i, cls: 'gt', text: fn })) });

  rows.forEach((row) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'align-row';
    rowEl.innerHTML = `<div class="align-row-label">${row.label}</div>`;
    const track = document.createElement('div');
    track.className = 'align-row-track';
    track.dataset.key = row.key;
    row.items.forEach((it) => {
      const cell = document.createElement('div');
      cell.className = 'align-cell ' + it.cls + (it.injected ? ' injected' : '');
      cell.textContent = 'e' + it.idx;
      cell.title = it.sentence || it.text;
      track.appendChild(cell);
    });
    rowEl.appendChild(track);
    container.appendChild(rowEl);
  });

  document.getElementById('diagnosis').innerHTML = buildDiagnosis(cmp);
  updatePlayhead();
}

function markCell(key, idx) {
  const track = document.querySelector(`.align-row-track[data-key="${key}"]`);
  if (!track || idx === null || idx === undefined) return;
  const cell = track.children[idx];
  if (cell) cell.classList.add('playhead');
}

function updatePlayhead() {
  const cmp = compareResult;
  if (!cmp) return;
  document.querySelectorAll('.align-cell').forEach((c) => c.classList.remove('playhead'));
  const step = cmp.path[scrubIndex];
  if (!step) return;
  const [aIdx, bIdx] = step;
  markCell('a', aIdx);
  markCell('b', bIdx);
  markCell('gtA', cmp.gt_align_a.gt_index_of_event[aIdx]);
  markCell('gtB', cmp.gt_align_b.gt_index_of_event[bIdx]);
  document.getElementById('scrub-readout').textContent = `${scrubIndex + 1} / ${cmp.path.length}`;
}

function togglePlay() {
  const btn = document.getElementById('scrub-play');
  if (playTimer) { clearInterval(playTimer); playTimer = null; btn.textContent = '재생'; return; }
  btn.textContent = '정지';
  playTimer = setInterval(() => {
    if (!compareResult) return;
    const max = +document.getElementById('scrub').max;
    scrubIndex = scrubIndex >= max ? 0 : scrubIndex + 1;
    document.getElementById('scrub').value = scrubIndex;
    updatePlayhead();
  }, 450);
}

// --------------------------------------------------------------- search
function attachSearch(inputEl, resultsEl, onSelect) {
  let timer;
  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    if (!q) { resultsEl.classList.add('hidden'); return; }
    timer = setTimeout(async () => {
      let ids = [];
      try { ids = await api(`/api/search?q=${encodeURIComponent(q)}&limit=20`); } catch (e) { return; }
      resultsEl.innerHTML = '';
      ids.forEach((id) => {
        const div = document.createElement('div');
        div.className = 'result-item';
        div.textContent = id;
        div.onclick = () => { onSelect(id); resultsEl.classList.add('hidden'); inputEl.value = id; };
        resultsEl.appendChild(div);
      });
      resultsEl.classList.toggle('hidden', ids.length === 0);
    }, 180);
  });
  document.addEventListener('click', (e) => {
    if (e.target !== inputEl && !resultsEl.contains(e.target)) resultsEl.classList.add('hidden');
  });
}

function exportSvg(svgId, filename) {
  const svgEl = document.getElementById(svgId);
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', svgEl.clientWidth);
  clone.setAttribute('height', svgEl.clientHeight);
  const source = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([source], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// --------------------------------------------------------------- drag (Control Panel)
// 지도 확대/이동(11.5 Navigate: Changing Viewpoint) — residual 지도는 대부분의
// 점이 거의 동일한 잔차 거리(0에 가까움)에 몰려 있고 소수의 이상치만 멀리
// 떨어져 있어서, 전체를 다 보여주는 overview만으로는 밀집된 군집 내부의 hull이
// 몇 픽셀로 짜부라져 "군집이 1개로 뭉쳐 보이는" 문제가 생긴다. 좌표값 자체를
// 임의로 잘라내거나 왜곡하면 데이터를 오도하게 되므로(6.9), 대신 11.5.3
// "constrained navigation"대로 스크롤 확대(줌 범위를 1~40배로 제한)와
// 리셋 버튼("화면 맞춤")을 제공해 사용자가 밀집 영역으로 파고들 수 있게 한다.
const mapZoomTransform = { 'svg-center': d3.zoomIdentity, 'svg-right': d3.zoomIdentity };
const mapZoomBehavior = {};

function attachZoom(svgId) {
  if (mapZoomBehavior[svgId]) return; // svg는 renderMap마다 innerHTML이 지워지지만 엘리먼트 자체는 유지되므로 한 번만 부착
  const svg = d3.select(document.getElementById(svgId));
  const zoom = d3.zoom()
    .scaleExtent([1, 40])
    .filter((event) => event.type === 'wheel')
    .on('zoom', (event) => {
      mapZoomTransform[svgId] = event.transform;
      renderAll();
    });
  svg.call(zoom);
  mapZoomBehavior[svgId] = zoom;
}

function resetZoom(svgId) {
  mapZoomTransform[svgId] = d3.zoomIdentity;
  const zoom = mapZoomBehavior[svgId];
  if (zoom) d3.select(document.getElementById(svgId)).call(zoom.transform, d3.zoomIdentity);
  renderAll();
}

// --------------------------------------------------------------- wiring
function wireControls() {
  document.querySelectorAll('#condition-filter .chip').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#condition-filter .chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      filters.condition = btn.dataset.cond;
      clearHighlight();
      renderAll();
    };
  });
  document.getElementById('cluster-k').oninput = (e) => {
    clusterK = +e.target.value;
    document.getElementById('cluster-k-val').textContent = clusterK;
    clearHighlight(); // k가 바뀌면 군집 번호 의미가 달라지므로 기존 선택은 무효
    renderAll();
  };
  document.getElementById('size-by').onchange = (e) => { filters.sizeBy = e.target.value; renderAll(); };
  document.getElementById('point-size').oninput = () => renderAll();
  document.getElementById('toggle-hull').onchange = () => renderAll();
  document.getElementById('toggle-outliers').onchange = (e) => { showOutliersOnly = e.target.checked; renderAll(); };
  document.getElementById('map-fit-view').onclick = () => resetZoom(mapTab === 'raw' ? 'svg-right' : 'svg-center');
  document.getElementById('map-settings-toggle').onclick = () => document.getElementById('map-settings').classList.toggle('hidden');

  document.querySelectorAll('#event-log-severity-filter .chip').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#event-log-severity-filter .chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      eventLogSeverityFilter = btn.dataset.sev;
      eventLogPage = 0;
      renderEventLog(filteredCases());
    };
  });
  document.getElementById('event-log-search').oninput = (e) => {
    eventLogSearch = e.target.value.toLowerCase().trim();
    eventLogPage = 0;
    renderEventLog(filteredCases());
  };
  document.getElementById('event-log-prev').onclick = () => { eventLogPage = Math.max(0, eventLogPage - 1); renderEventLog(filteredCases()); };
  document.getElementById('event-log-next').onclick = () => { eventLogPage += 1; renderEventLog(filteredCases()); };

  document.querySelectorAll('#detail-tabs .tab-btn').forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.which === 'b' && !pickedB) return;
      detailWhich = btn.dataset.which;
      renderTraceDetail();
    };
  });

  document.querySelectorAll('#map-tabs .tab-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#map-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      mapTab = btn.dataset.tab;
      document.getElementById('map-wrap-residual').classList.toggle('hidden', mapTab !== 'residual');
      document.getElementById('map-wrap-raw').classList.toggle('hidden', mapTab !== 'raw');
      document.getElementById('map-wrap-matrix').classList.toggle('hidden', mapTab !== 'matrix');
      renderAll();
    };
  });

  document.getElementById('scrub').oninput = (e) => { scrubIndex = +e.target.value; updatePlayhead(); };
  document.getElementById('scrub-play').onclick = togglePlay;
  document.getElementById('swap-btn').onclick = () => {
    [pickedA, pickedB] = [pickedB, pickedA];
    updatePickerInputs();
    afterPickChange();
  };

  attachSearch(document.getElementById('pick-a'), document.getElementById('pick-a-results'), (id) => { pickedA = id; afterPickChange(); });
  attachSearch(document.getElementById('pick-b'), document.getElementById('pick-b-results'), (id) => { pickedB = id; afterPickChange(); });

  document.getElementById('nav-back').onclick = () => navHistory(-1);
  document.getElementById('nav-forward').onclick = () => navHistory(1);
  updateNavButtons();

  document.getElementById('map-svg-export').onclick = () => {
    const svgId = mapTab === 'raw' ? 'svg-right' : mapTab === 'matrix' ? 'svg-matrix' : 'svg-center';
    exportSvg(svgId, `dojoscope-${currentSuite}-${mapTab}.svg`);
  };

  document.getElementById('upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    showBanner('업로드 처리 중. 파이프라인 재계산에는 데이터 크기에 따라 수 초에서 수십 초 걸릴 수 있습니다.');
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      manifest = await api('/api/manifest');
      const merge = result.merge || {};
      showBanner(`업로드 완료. 총 ${manifest.case_count}건 (신규 ${merge.added || 0}, 갱신 ${merge.replaced || 0}).`, true);
      hideEmptyState();
      renderSuiteTabs();
      pickedA = null; pickedB = null; compareResult = null;
      await loadSuite(manifest.suites[0]);
      setTimeout(hideBanner, 6000);
    } catch (err) {
      showBanner('업로드 실패: ' + err.message, false);
    }
    e.target.value = '';
  });

  document.getElementById('empty-upload-btn').onclick = () => document.getElementById('upload-input').click();
}

window.addEventListener('DOMContentLoaded', init);
