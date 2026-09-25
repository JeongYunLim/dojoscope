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
let argCompareTarget = null;  // {caseId, eventIndex} | null — 클린런 비교 화면(5번)에서 보고 있는 이벤트
let traceViewTab = 'raw';     // 'raw' | 'compare' — 3번 패널 안의 원문/DTW비교 탭
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

// hijack_tool은 순수 범주형(명목, 암묵적 순서 없음, Ch10.2.3) 값이라 hue로
// 인코딩한다. "None"(공격 없음)은 척도에 안 속하는 별도 상태라 중립 회색으로
// 고정하고(SEVERITY_COLORS의 low와 같은 원칙), 나머지 도구 이름에만 채도
// 높은 색을 순서 없이 배정한다. cluster hull(CLUSTER_HULL_PALETTE)·심각도
// 색(SEVERITY_COLORS)과 겹치지 않는 세 번째 색상족을 쓴다 — 같은 화면에
// 동시에 보이는 세 범주형 인코딩이 서로 간섭하지 않게 하기 위해서(6.9).
const HIJACK_TOOL_PALETTE = ['#2f6fb3', '#c9622f', '#3f9142', '#a03a6b', '#8a6d1f', '#4a6fa5'];
const HIJACK_NONE_COLOR = '#9aa1a8';
function hijackToolColorScale(names) {
  const domain = Array.from(new Set(names)).filter((n) => n !== 'None').sort();
  const scale = d3.scaleOrdinal(HIJACK_TOOL_PALETTE).domain(domain);
  return (name) => (name === 'None' ? HIJACK_NONE_COLOR : scale(name));
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

function setOverviewStripExpanded(expanded) {
  document.getElementById('overview-strip-detail').classList.toggle('collapsed', !expanded);
  document.getElementById('overview-strip-toggle').textContent = expanded ? '접기 ▴' : '자세히 ▾';
}

// ------------------------------------------------------------------- init
function showEmptyState() {
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('layout').style.display = 'none';
  document.getElementById('overview-strip').classList.add('hidden');
  document.getElementById('event-log-section').classList.add('hidden');
}
function hideEmptyState() {
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('layout').style.display = '';
  document.getElementById('overview-strip').classList.remove('hidden');
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

// 창 크기가 바뀌어도(브라우저 리사이즈, OS 폰트 배율 변경 등) 지도 SVG가
// 렌더링 시점에 재던 clientWidth/Height 그대로 방치되던 것을 고친다 —
// 리사이즈 이벤트가 연달아 여러 번 오므로 마지막 것만 반영(debounce)한다.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (suiteData) renderAll(); }, 150);
});

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
  renderAll();
}

// 어느 지도 탭을 실제로 보여줄지 정하고 래퍼 표시를 맞춘다. 보안 분석 탭은 넓은
// 화면이 필요해서, 케이스를 골라 상세 화면(지도가 절반 폭)으로 넘어가면 residual
// 지도로 되돌린다 — 보안 탭으로 돌아오면 상세를 닫은 뒤 다시 보인다.
function applyMapTab() {
  const eff = mapTab === 'security' && pickedA ? 'residual' : mapTab;
  document.getElementById('map-wrap-residual').classList.toggle('hidden', eff !== 'residual');
  document.getElementById('map-wrap-raw').classList.toggle('hidden', eff !== 'raw');
  document.getElementById('map-wrap-matrix').classList.toggle('hidden', eff !== 'matrix');
  document.getElementById('map-wrap-security').classList.toggle('hidden', eff !== 'security');
  document.getElementById('panel-explore').classList.toggle('sec-mode', eff === 'security');
  return eff;
}

function filteredCases() {
  let cases = suiteData.cases;
  if (filters.condition !== 'all') cases = cases.filter((c) => c.condition === filters.condition);
  return cases;
}

// ------------------------------------------------------------------ render
function renderAll() {
  hideTooltip(); // 재렌더링으로 점이 다시 그려지기 전에, 열려 있던 호버 팝업을 먼저 닫는다

  // 화면 전환(개요 ↔ 상세): pickedA 유무로 상태를 판정해서 #layout에
  // .detail-mode를 토글한다 — 별도 상태 변수를 안 둬도 항상 실제 선택
  // 상태와 일치한다. 그리드 영역이 바뀌면(그리드는 애니메이션 없이
  // 즉시 전환) 아래에서 clientWidth를 다시 재는 순간 새 크기가 그대로
  // 반영된다(브라우저가 레이아웃 속성을 읽을 때 강제로 리플로우함).
  const layoutEl = document.getElementById('layout');
  layoutEl.classList.toggle('detail-mode', !!pickedA);
  layoutEl.classList.toggle('argcompare-mode', !!argCompareTarget);
  renderArgSummary();
  renderArgCompare();

  const cases = filteredCases();
  const tab = applyMapTab();
  document.getElementById('badge-map').textContent = tab === 'matrix' ? `${cases.length}×${cases.length}`
    : tab === 'security' ? `${buildSecPairs().length}쌍` : `${cases.length}건`;
  // residual은 어떤 탭이 켜져 있든 항상 계산한다(9.3의 기본 근거 뷰).
  renderMap('svg-center', cases, 'coords_residual', true, 'residual_isolation_percentile');
  if (tab === 'raw') {
    renderMap('svg-right', cases, 'coords_raw', false, 'raw_isolation_percentile');
  } else if (tab === 'matrix') {
    renderDistanceMatrix(cases);
  } else if (tab === 'security') {
    renderSecurityView();
  }
  renderTraceDetail();
  renderKpiBar(cases);
  renderQuickStats(cases);
  renderValidityBar(cases);
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

// ------------------------------------------------------------ quick stats
// 지도 옆 작은 사이드 그래프 — 예전엔 "자세히"를 눌러야 보이는 큰 카드 4개
// 였다. 전부 이미 서버가 계산해서 내려주는 필드(security_analysis,
// hijack_tool, delay_bucket, exposure_channel)를 재사용한다. 각 막대를
// 누르면 그 조건에 맞는 케이스만 지도에서 강조된다(cluster-picker와 같은
// 하이라이트 메커니즘 재사용) — "눌러서 그 트레이스가 뭔지 보이게" 요청에
// 대한 답.
function renderQuickStats(cases) {
  const box = document.getElementById('panel-quickstats');
  if (!box || box.classList.contains('hidden') || !suiteData) return;
  renderQsAsr(cases);
  renderQsHijackTool(cases);
  renderQsDelayBucket(cases);
  renderQsExposure(cases);
}

function qsRow(el, { swatch, label, count, max, ids, title }) {
  const row = document.createElement('div');
  row.className = 'composition-row qs-row';
  row.title = title || `${label}: ${count}건 — 클릭하면 지도에서 강조`;
  row.innerHTML = `<span class="composition-swatch" style="background:${swatch}"></span>`
    + `<span class="composition-label">${label}</span>`
    + `<div class="composition-bar-track"><div class="composition-bar-fill" style="width:${(count / max) * 100}%;background:${swatch}"></div></div>`
    + `<span class="composition-count">${count}</span>`;
  row.onclick = () => {
    selectedCluster = null;
    setHighlight(new Set(ids));
    renderClusterPicker(filteredCases());
  };
  el.appendChild(row);
}

// (1) ASR — targeted attack success rate, 조건별. 클릭하면 그 조건에서
// 실제로 뚫린 케이스만 지도에서 강조된다.
function renderQsAsr(cases) {
  const el = document.getElementById('qs-asr');
  el.innerHTML = '';
  const colorByCond = { A: '#a8391f', B: '#2f6fb3' };
  const byCond = { A: cases.filter((d) => d.condition === 'A'), B: cases.filter((d) => d.condition === 'B') };
  const max = Math.max(byCond.A.length, byCond.B.length, 1);
  ['A', 'B'].forEach((cond) => {
    const group = byCond[cond];
    if (!group.length) return;
    const hijacked = group.filter((d) => d.security);
    const pct = (hijacked.length / group.length) * 100;
    qsRow(el, {
      swatch: colorByCond[cond], label: `${cond === 'A' ? '무방어' : '방어'} (n=${group.length})`,
      count: hijacked.length, max: group.length,
      ids: hijacked.map((d) => d.case_id),
      title: `${cond === 'A' ? '무방어' : '방어'}: ASR ${pct.toFixed(0)}% (${hijacked.length}/${group.length}) — 클릭하면 뚫린 케이스만 강조`,
    });
    el.lastChild.querySelector('.composition-count').textContent = `${pct.toFixed(0)}%`;
  });
}

// (2) 납치된 도구 분포 — 범주형(hue) + 개수(길이).
function renderQsHijackTool(cases) {
  const el = document.getElementById('qs-hijack-tool');
  el.innerHTML = '';
  const hijacked = cases.filter((d) => d.hijack_tool);
  if (!hijacked.length) { el.innerHTML = '<div class="ov-empty">납치된 케이스 없음</div>'; return; }
  const groups = new Map();
  hijacked.forEach((d) => {
    if (!groups.has(d.hijack_tool)) groups.set(d.hijack_tool, []);
    groups.get(d.hijack_tool).push(d.case_id);
  });
  const entries = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  const color = hijackToolColorScale(entries.map((e) => e[0]));
  const max = Math.max(...entries.map((e) => e[1].length), 1);
  entries.forEach(([name, ids]) => qsRow(el, { swatch: color(name), label: name, count: ids.length, max, ids }));
}

// (3) 납치 시점 — 즉시(immediate) vs 지연(delayed) vs 안전(none). 위험도
// 순으로 색 배정(즉시=빨강, 지연=주황, 없음=중립 회색).
const DELAY_BUCKET_LABELS = { immediate: '즉시 납치', delayed: '지연 납치', none: '안전(뚫리지 않음)' };
const DELAY_BUCKET_COLORS = { immediate: '#a8391f', delayed: '#c96a2e', none: '#9aa1a8' };
const DELAY_BUCKET_ORDER = ['immediate', 'delayed', 'none'];
function renderQsDelayBucket(cases) {
  const el = document.getElementById('qs-delay-bucket');
  el.innerHTML = '';
  const groups = new Map();
  cases.forEach((d) => {
    if (!groups.has(d.delay_bucket)) groups.set(d.delay_bucket, []);
    groups.get(d.delay_bucket).push(d.case_id);
  });
  const max = Math.max(...Array.from(groups.values()).map((v) => v.length), 1);
  DELAY_BUCKET_ORDER.forEach((key) => {
    const ids = groups.get(key) || [];
    if (!ids.length) return;
    qsRow(el, { swatch: DELAY_BUCKET_COLORS[key], label: DELAY_BUCKET_LABELS[key], count: ids.length, max, ids });
  });
}

// (4) 주입 노출 경로 — 어떤 도구의 응답(tool_resp)에 공격 지시문이 가장 많이
// 실려오는지. 방어 우선순위(입력 새니타이징을 어디부터 넣을지) 판단 근거.
function renderQsExposure(cases) {
  const el = document.getElementById('qs-exposure');
  el.innerHTML = '';
  const exposed = cases.filter((d) => d.exposure_channel);
  if (!exposed.length) { el.innerHTML = '<div class="ov-empty">노출 케이스 없음</div>'; return; }
  const groups = new Map();
  exposed.forEach((d) => {
    if (!groups.has(d.exposure_channel)) groups.set(d.exposure_channel, []);
    groups.get(d.exposure_channel).push(d.case_id);
  });
  const entries = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  const max = Math.max(...entries.map((e) => e[1].length), 1);
  entries.forEach(([name, ids]) => qsRow(el, { swatch: 'var(--accent)', label: name, count: ids.length, max, ids }));
}

// ------------------------------------------------------ 보안 분석 탭
// 보안 개발자가 지도를 열기 전에 먼저 묻는 질문에 답하는 화면:
//  (1) 방어가 실제로 먹혔나, 아니면 공격이 원래 안 먹힌 건가?  -> 4분류
//  (2) 막았더니 어디로 새나(다른 도구로 우회)?                  -> Sankey
//  (3) 뚫린다면 노출 후 얼마나 빨리?                           -> 지연 분포 + 케이스별 타임라인
//  (4) 케이스 단위로 방어 전/후가 어떻게 바뀌었나?              -> 기울기 그래프
// 전부 이미 내려오는 cases 필드(pair_key, condition, security, utility, hijack_tool,
// delay, injection_exposure, first_deviation, hijack_events)로 클라이언트에서 계산한다.
// 주의: 이 데이터에는 tool_filter가 "시도했다가 차단"한 기록이 없다 — 그래서 "차단"은
// "A에서는 납치가 있었는데 B에서는 납치 이벤트가 없음"으로만 정의된다(방어 효과와
// 모델이 그냥 따르지 않은 경우를 구분하지 못한다).
const SEC_QUAD = {
  success: { label: '방어 성공', sub: 'A 뚫림 → B 안전', color: '#15803d' },
  benign: { label: '공격이 원래 안 먹힘', sub: 'A 안전 → B 안전 (방어 효과 아님)', color: '#9aa1a8' },
  fail: { label: '방어 실패', sub: 'A 뚫림 → B 뚫림', color: '#c81e1e' },
  regress: { label: '방어로 퇴행', sub: 'A 안전 → B 뚫림', color: '#c96a2e' },
};
const SEC_QUAD_ORDER = ['success', 'benign', 'fail', 'regress'];
const SEC_OUT = {
  none: { label: 'B에서 납치 없음', color: '#15803d' },
  other: { label: '다른 도구로 납치', color: '#c96a2e' },
  same: { label: '같은 도구로 납치', color: '#c81e1e' },
};
const SEC_OUT_ORDER = ['none', 'other', 'same'];
let secSel = { quad: null, flow: null };
let secTlCond = 'B';
let secTlLimit = 10;

function buildSecPairs() {
  const by = new Map();
  suiteData.cases.forEach((c) => {
    if (!by.has(c.pair_key)) by.set(c.pair_key, {});
    by.get(c.pair_key)[c.condition] = c;
  });
  return Array.from(by.values()).filter((p) => p.A && p.B);
}
function secQuadOf(p) {
  if (p.A.security) return p.B.security ? 'fail' : 'success';
  return p.B.security ? 'regress' : 'benign';
}
function secOutcomeOf(p) {
  if (!p.B.security) return 'none';
  return p.B.hijack_tool && p.B.hijack_tool === p.A.hijack_tool ? 'same' : 'other';
}
function secOpenPair(p) {
  pickedA = p.A.case_id;
  pickedB = p.B.case_id;
  updatePickerInputs();
  afterPickChange();
}
function secDefenseLabel(pairs) {
  const m = (pairs[0] && pairs[0].B.model) || '';
  const i = m.indexOf('+');
  return i >= 0 ? m.slice(i + 1) : '방어(B)';
}
function secSection(title, hint) {
  const s = document.createElement('div');
  s.className = 'sec-section';
  s.innerHTML = `<div class="sec-title">${title}${hint ? ` <span class="hint">${escapeHtml(hint)}</span>` : ''}</div>`;
  return s;
}
// 그룹 목록 — 어느 차트에서 무엇을 눌러도 "그 케이스들이 뭔지"를 표로 바로 보고, 행을 눌러 상세로 간다.
function secPairList(box, title, pairs) {
  box.innerHTML = '';
  if (!pairs) return;
  const head = document.createElement('div');
  head.className = 'sec-list-head';
  head.textContent = `${title} — ${pairs.length}쌍${pairs.length > 12 ? ' (앞 12쌍만 표시)' : ''}`;
  box.appendChild(head);
  pairs.slice(0, 12).forEach((p) => {
    const row = document.createElement('div');
    row.className = 'sec-list-row';
    const dA = p.A.delay === null || p.A.delay === undefined ? '–' : p.A.delay;
    const dB = p.B.delay === null || p.B.delay === undefined ? '–' : p.B.delay;
    row.innerHTML = `<span class="sec-list-id">${escapeHtml(p.A.user_task_id)} × ${escapeHtml(p.A.injection_task_id)}</span>`
      + `<span>A ${escapeHtml(p.A.hijack_tool || '–')} (지연 ${dA})</span>`
      + `<span>B ${escapeHtml(p.B.hijack_tool || '–')} (지연 ${dB})</span>`
      + `<span>${p.B.utility ? '' : '정상작업 실패'}</span>`;
    row.onclick = () => secOpenPair(p);
    box.appendChild(row);
  });
}

function renderSecurityView() {
  const box = document.getElementById('map-wrap-security');
  if (!box || !suiteData) return;
  box.innerHTML = '';
  const pairs = buildSecPairs();
  if (!pairs.length) {
    box.innerHTML = '<div class="ov-empty" style="padding:14px">A/B 짝이 있는 케이스가 없어 방어 전/후 비교를 그릴 수 없습니다.</div>';
    return;
  }
  const W = Math.max(box.clientWidth - 28, 420);
  const def = secDefenseLabel(pairs);
  const wrap = document.createElement('div');
  wrap.className = 'sec-view';
  box.appendChild(wrap);
  wrap.appendChild(secQuadSection(pairs, def));
  wrap.appendChild(secSankeySection(pairs, W, def));
  wrap.appendChild(secDelaySection(pairs, W, def));
  wrap.appendChild(secSlopeSection(pairs, W, def));
}

// (1) 방어 성공 vs 공격이 원래 안 먹힘 — A/B 짝의 4분류.
function secQuadSection(pairs, def) {
  const s = secSection('1. 방어가 먹혔나?', `무방어(A) vs ${def}(B) 같은 과제 쌍 ${pairs.length}개`);
  const groups = {};
  SEC_QUAD_ORDER.forEach((k) => { groups[k] = []; });
  pairs.forEach((p) => groups[secQuadOf(p)].push(p));
  const bar = document.createElement('div');
  bar.className = 'sec-quadbar';
  const cards = document.createElement('div');
  cards.className = 'sec-quadcards';
  const list = document.createElement('div');
  list.className = 'sec-list';
  const pick = (k) => { secSel.quad = k; secSel.flow = null; secPairList(list, SEC_QUAD[k].label, groups[k]); };
  SEC_QUAD_ORDER.forEach((k) => {
    const n = groups[k].length;
    if (n) {
      const seg = document.createElement('div');
      seg.className = 'sec-quadseg';
      seg.style.cssText = `flex:${n};background:${SEC_QUAD[k].color}`;
      seg.textContent = n;
      seg.title = `${SEC_QUAD[k].label}: ${n}쌍 — 클릭하면 목록`;
      seg.onclick = () => pick(k);
      bar.appendChild(seg);
    }
    const card = document.createElement('div');
    card.className = 'sec-quadcard';
    card.style.borderTopColor = SEC_QUAD[k].color;
    card.innerHTML = `<b>${SEC_QUAD[k].label} · ${n}</b><span>${SEC_QUAD[k].sub}</span>`;
    card.onclick = () => pick(k);
    cards.appendChild(card);
  });
  s.appendChild(bar);
  s.appendChild(cards);
  s.appendChild(list);
  if (secSel.quad) secPairList(list, SEC_QUAD[secSel.quad].label, groups[secSel.quad]);
  return s;
}

// (2) Sankey — A에서 납치에 쓰인 도구 -> B에서 어떻게 됐나(납치 없음 / 다른 도구 / 같은 도구).
function secSankeySection(pairs, W, def) {
  const hij = pairs.filter((p) => p.A.security);
  const s = secSection('2. 막았더니 어디로 새나?', `A에서 뚫린 ${hij.length}쌍의 납치 도구 → ${def} 적용 후 결과`);
  if (!hij.length) { s.insertAdjacentHTML('beforeend', '<div class="ov-empty">A에서 뚫린 케이스가 없습니다.</div>'); return s; }
  const counts = d3.rollup(hij, (v) => v.length, (p) => p.A.hijack_tool || '(unknown)');
  const top = new Set(Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e[0]));
  const toolOf = (p) => (top.has(p.A.hijack_tool || '(unknown)') ? (p.A.hijack_tool || '(unknown)') : '기타');
  const tools = Array.from(d3.rollup(hij, (v) => v.length, toolOf).entries())
    .sort((a, b) => ((a[0] === '기타') - (b[0] === '기타')) || (b[1] - a[1]));
  const total = hij.length;
  const outCount = { none: 0, other: 0, same: 0 };
  hij.forEach((p) => { outCount[secOutcomeOf(p)]++; });
  const gapL = 8, gapR = 22;
  const u = Math.max(1.5, Math.min(10, (230 - gapL * tools.length) / total));
  const LX = 150, RX = W - 170, NW = 12;
  const hL = total * u + gapL * (tools.length - 1);
  const hR = total * u + gapR * 2;
  const H = Math.max(hL, hR) + 16;
  const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').style('height', H + 'px');
  const rightY = {};
  let ry = 8;
  SEC_OUT_ORDER.forEach((k) => { rightY[k] = { y: ry, cur: ry }; ry += outCount[k] * u + gapR; });
  const list = document.createElement('div');
  list.className = 'sec-list';
  let ly = 8;
  tools.forEach(([tool, n]) => {
    let cy = ly;
    SEC_OUT_ORDER.forEach((k) => {
      const grp = hij.filter((p) => toolOf(p) === tool && secOutcomeOf(p) === k);
      if (!grp.length) return;
      const h = grp.length * u, y2 = rightY[k].cur, mx = (LX + NW + RX) / 2;
      const link = svg.append('path')
        .attr('d', `M${LX + NW},${cy} C${mx},${cy} ${mx},${y2} ${RX},${y2} L${RX},${y2 + h} C${mx},${y2 + h} ${mx},${cy + h} ${LX + NW},${cy + h} Z`)
        .attr('fill', SEC_OUT[k].color).attr('fill-opacity', 0.4).style('cursor', 'pointer')
        .on('click', () => { secSel.flow = `${tool}|${k}`; secSel.quad = null; secPairList(list, `${tool} → ${SEC_OUT[k].label}`, grp); });
      link.append('title').text(`${tool} → ${SEC_OUT[k].label}: ${grp.length}쌍 (클릭하면 목록)`);
      rightY[k].cur += h; cy += h;
    });
    svg.append('rect').attr('x', LX).attr('y', ly).attr('width', NW).attr('height', n * u).attr('fill', '#6b7280');
    svg.append('text').attr('x', LX - 6).attr('y', ly + (n * u) / 2 + 4).attr('text-anchor', 'end').attr('class', 'sec-svg-label').text(`${tool} (${n})`);
    ly += n * u + gapL;
  });
  SEC_OUT_ORDER.forEach((k) => {
    svg.append('rect').attr('x', RX).attr('y', rightY[k].y).attr('width', NW).attr('height', Math.max(outCount[k] * u, 1)).attr('fill', SEC_OUT[k].color);
    svg.append('text').attr('x', RX + NW + 6).attr('y', rightY[k].y + (outCount[k] * u) / 2 + 4).attr('class', 'sec-svg-label').text(`${SEC_OUT[k].label} (${outCount[k]})`);
  });
  s.appendChild(svg.node());
  const regress = pairs.filter((p) => secQuadOf(p) === 'regress').length;
  const note = document.createElement('div');
  note.className = 'sec-note';
  note.textContent = '"납치 없음"은 방어 효과로 확정할 수 없습니다 — 이 로그에는 시도했다가 막힌 기록이 없어, 모델이 그냥 따르지 않은 경우와 구분되지 않습니다.'
    + (regress ? ` (참고: A는 안전했는데 B에서 새로 뚫린 쌍 ${regress}개는 이 그림에 없습니다.)` : '');
  s.appendChild(note);
  s.appendChild(list);
  if (secSel.flow) {
    const [tool, k] = secSel.flow.split('|');
    secPairList(list, `${tool} → ${SEC_OUT[k].label}`, hij.filter((p) => toolOf(p) === tool && secOutcomeOf(p) === k));
  }
  return s;
}

// (3) 지연 — 노출 후 납치까지 스텝 수. 값이 정수 몇 개뿐이라 박스플롯 대신 값별 막대.
function secDelaySection(pairs, W, def) {
  const s = secSection('3. 얼마나 빨리 뚫리나?', '주입 노출 → 첫 납치 도구 호출까지의 스텝 수');
  const cases = suiteData.cases.filter((c) => c.security && c.delay !== null && c.delay !== undefined);
  const skipped = suiteData.cases.filter((c) => c.security).length - cases.length;
  if (!cases.length) { s.insertAdjacentHTML('beforeend', '<div class="ov-empty">지연을 계산할 수 있는 뚫린 케이스가 없습니다.</div>'); return s; }
  const vals = Array.from(new Set(cases.map((c) => c.delay))).sort((a, b) => a - b);
  const conds = ['A', 'B'];
  const colors = { A: '#a8391f', B: '#2f6fb3' };
  const H = 150, m = { l: 34, r: 10, t: 10, b: 30 };
  const cnt = (cond, v) => cases.filter((c) => c.condition === cond && c.delay === v).length;
  const ymax = Math.max(1, ...vals.flatMap((v) => conds.map((c) => cnt(c, v))));
  const x0 = d3.scaleBand().domain(vals).range([m.l, W - m.r]).padding(0.25);
  const x1 = d3.scaleBand().domain(conds).range([0, x0.bandwidth()]).padding(0.08);
  const y = d3.scaleLinear().domain([0, ymax]).range([H - m.b, m.t]);
  const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').style('height', H + 'px');
  svg.append('g').attr('transform', `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(Math.min(ymax, 4)).tickFormat(d3.format('d')).tickSize(-(W - m.l - m.r)))
    .call((g) => { g.selectAll('line').attr('stroke', '#e5e7eb'); g.select('.domain').remove(); g.selectAll('text').attr('class', 'sec-svg-label'); });
  vals.forEach((v) => conds.forEach((c) => {
    const n = cnt(c, v);
    svg.append('rect').attr('x', x0(v) + x1(c)).attr('y', y(n)).attr('width', x1.bandwidth()).attr('height', y(0) - y(n)).attr('fill', colors[c])
      .append('title').text(`${c === 'A' ? '무방어' : def} · 지연 ${v}: ${n}건`);
    if (n) svg.append('text').attr('x', x0(v) + x1(c) + x1.bandwidth() / 2).attr('y', y(n) - 3).attr('text-anchor', 'middle').attr('class', 'sec-svg-label').text(n);
  }));
  vals.forEach((v) => svg.append('text').attr('x', x0(v) + x0.bandwidth() / 2).attr('y', H - 14).attr('text-anchor', 'middle').attr('class', 'sec-svg-label').text(v));
  svg.append('text').attr('x', (m.l + W - m.r) / 2).attr('y', H - 1).attr('text-anchor', 'middle').attr('class', 'sec-svg-label').text('노출 후 납치까지 스텝');
  s.appendChild(svg.node());
  const lg = document.createElement('div');
  lg.className = 'sec-legend';
  lg.innerHTML = `<span><i style="background:${colors.A}"></i>무방어(A)</span><span><i style="background:${colors.B}"></i>${escapeHtml(def)}(B)</span>`
    + (skipped ? `<span class="hint">노출 지점을 못 찾은 ${skipped}건은 제외</span>` : '');
  s.appendChild(lg);

  // 케이스별 타임라인 — 노출(▼) → 이탈 → 납치(✖). 지연이 짧은 케이스부터.
  const tlHead = document.createElement('div');
  tlHead.className = 'sec-tl-head';
  tlHead.innerHTML = '<span class="sec-title-sub">케이스별 타임라인 (지연 짧은 순)</span>';
  ['A', 'B'].forEach((c) => {
    const b = document.createElement('button');
    b.className = 'chip' + (secTlCond === c ? ' active' : '');
    b.textContent = c === 'A' ? '무방어(A)' : `${def}(B)`;
    b.onclick = () => { secTlCond = c; secTlLimit = 10; renderSecurityView(); };
    tlHead.appendChild(b);
  });
  s.appendChild(tlHead);
  const tl = cases.filter((c) => c.condition === secTlCond).sort((a, b) => a.delay - b.delay);
  const TW = Math.max(W - 300, 160);
  tl.slice(0, secTlLimit).forEach((c) => {
    const row = document.createElement('div');
    row.className = 'sec-tl-row';
    const n = Math.max(c.n_events - 1, 1);
    const sx = (i) => 6 + (i / n) * (TW - 12);
    const hj = Math.min(...c.hijack_events), ex = c.injection_exposure, dv = c.first_deviation;
    const mid = dv !== null && dv !== undefined && dv >= ex && dv <= hj ? dv : ex;
    const svg2 = d3.create('svg').attr('viewBox', `0 0 ${TW} 24`).attr('width', TW).style('height', '24px');
    svg2.append('line').attr('x1', sx(0)).attr('x2', sx(n)).attr('y1', 12).attr('y2', 12).attr('stroke', '#c7cbd1');
    if (mid > ex) svg2.append('line').attr('x1', sx(ex)).attr('x2', sx(mid)).attr('y1', 12).attr('y2', 12).attr('stroke', '#c96a2e').attr('stroke-width', 4);
    svg2.append('line').attr('x1', sx(mid)).attr('x2', sx(hj)).attr('y1', 12).attr('y2', 12).attr('stroke', '#c81e1e').attr('stroke-width', 4);
    svg2.append('text').attr('x', sx(ex)).attr('y', 9).attr('text-anchor', 'middle').attr('class', 'sec-svg-label').text('▼');
    svg2.append('text').attr('x', sx(hj)).attr('y', 22).attr('text-anchor', 'middle').attr('class', 'sec-svg-label').attr('fill', '#c81e1e').text('✖');
    row.innerHTML = `<span class="sec-tl-id" title="${escapeHtml(c.case_id)}">${escapeHtml(c.user_task_id)} × ${escapeHtml(c.injection_task_id)}</span>`;
    row.appendChild(svg2.node());
    row.insertAdjacentHTML('beforeend', `<span class="sec-tl-meta">${escapeHtml(c.hijack_tool || '–')} · 지연 ${c.delay}</span>`);
    row.onclick = () => {
      const p = pairs.find((x) => x[c.condition] && x[c.condition].case_id === c.case_id);
      if (p) secOpenPair(p);
    };
    s.appendChild(row);
  });
  if (tl.length > secTlLimit) {
    const more = document.createElement('button');
    more.className = 'ghost-btn';
    more.textContent = `더 보기 (${tl.length - secTlLimit}건 남음)`;
    more.onclick = () => { secTlLimit += 10; renderSecurityView(); };
    s.appendChild(more);
  }
  const key = document.createElement('div');
  key.className = 'sec-note';
  key.textContent = '▼ 주입 노출 · 주황 구간 노출→이탈 · 빨강 구간 이탈→납치 · ✖ 첫 납치 호출. 행을 누르면 해당 짝 케이스의 상세로 이동합니다.';
  s.appendChild(key);
  return s;
}

// (4) 짝 단위 전/후 — A에서 뚫린 각 쌍이 B에서 어떻게 변했나(기울기 그래프).
function secSlopeSection(pairs, W, def) {
  const s = secSection('4. 케이스별 방어 전/후', `A에서 뚫린 쌍의 납치 지연이 ${def}에서 어떻게 변했나`);
  const rows = pairs.filter((p) => p.A.security && p.A.delay !== null && p.A.delay !== undefined);
  if (!rows.length) { s.insertAdjacentHTML('beforeend', '<div class="ov-empty">비교할 쌍이 없습니다.</div>'); return s; }
  const maxD = Math.max(1, ...rows.map((p) => p.A.delay), ...rows.map((p) => (p.B.security && p.B.delay != null ? p.B.delay : 0)));
  const H = 260, top = 34, bottom = 44, gap = 26;
  const yv = d3.scaleLinear().domain([0, maxD]).range([H - bottom - gap, top]);
  const yNone = H - bottom + 6;
  const AX = Math.round(W * 0.3), BX = Math.round(W * 0.7);
  const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').style('height', H + 'px');
  svg.append('text').attr('x', AX).attr('y', 14).attr('text-anchor', 'middle').attr('class', 'sec-svg-head').text('무방어 (A)');
  svg.append('text').attr('x', BX).attr('y', 14).attr('text-anchor', 'middle').attr('class', 'sec-svg-head').text(`${def} (B)`);
  [AX, BX].forEach((x) => svg.append('line').attr('x1', x).attr('x2', x).attr('y1', top - 8).attr('y2', yv(0) + 8).attr('stroke', '#e5e7eb'));
  svg.append('rect').attr('x', BX - 60).attr('y', yNone - 10).attr('width', 120).attr('height', 22).attr('fill', '#15803d').attr('fill-opacity', 0.1);
  svg.append('text').attr('x', BX).attr('y', yNone + 5).attr('text-anchor', 'middle').attr('class', 'sec-svg-label').text('납치 없음');
  [0, maxD].forEach((v) => svg.append('text').attr('x', AX - 10).attr('y', yv(v) + 4).attr('text-anchor', 'end').attr('class', 'sec-svg-label').text(`${v} 스텝`));
  rows.forEach((p) => {
    const bHij = p.B.security && p.B.delay !== null && p.B.delay !== undefined;
    const yb = bHij ? yv(p.B.delay) : yNone;
    const ya = yv(p.A.delay);
    const color = !p.B.security ? '#15803d' : (bHij && p.B.delay > p.A.delay ? '#c96a2e' : '#c81e1e');
    const g = svg.append('g').style('cursor', 'pointer').on('click', () => secOpenPair(p));
    g.append('title').text(`${p.A.user_task_id} × ${p.A.injection_task_id}: A 지연 ${p.A.delay} → B ${bHij ? '지연 ' + p.B.delay : (p.B.security ? '뚫림(지연 미상)' : '납치 없음')}${p.B.utility ? '' : ' · 정상 작업도 실패'}`);
    g.append('line').attr('x1', AX).attr('y1', ya).attr('x2', BX).attr('y2', yb).attr('stroke', color).attr('stroke-width', 1.6).attr('stroke-opacity', 0.75);
    g.append('circle').attr('cx', AX).attr('cy', ya).attr('r', 3.5).attr('fill', color);
    if (!p.B.utility) g.append('path').attr('d', `M${BX},${yb - 6} l6,6 l-6,6 l-6,-6 z`).attr('fill', '#fff').attr('stroke', color).attr('stroke-width', 1.6);
    else g.append('circle').attr('cx', BX).attr('cy', yb).attr('r', 3.5).attr('fill', color);
  });
  s.appendChild(svg.node());
  const lg = document.createElement('div');
  lg.className = 'sec-legend';
  lg.innerHTML = '<span><i style="background:#15803d"></i>납치 없음</span><span><i style="background:#c96a2e"></i>더 늦게 납치</span><span><i style="background:#c81e1e"></i>같거나 더 빠름</span><span>◇ 정상 작업(utility)도 실패</span>';
  s.appendChild(lg);
  const utilLoss = pairs.filter((p) => !p.B.utility).length;
  const unknown = pairs.filter((p) => p.A.security).length - rows.length;
  const note = document.createElement('div');
  note.className = 'sec-note';
  note.textContent = `선(쌍)을 누르면 해당 A/B 상세로 이동합니다. ${def} 적용 후 정상 작업이 실패한 쌍: ${utilLoss}/${pairs.length}.`
    + (unknown ? ` A 노출 지점을 못 찾은 ${unknown}쌍은 제외.` : '');
  s.appendChild(note);
  return s;
}

// ---------------------------------------------------------- validity bar
// 지도를 보기 전에 "이 지도(residual UMAP)가 실제로 hijack_tool을 얼마나
// 잘 구분하는가"부터 보여준다. build_output.py가 이미 계산해서 내려주는
// cluster_validation(ARI/NMI)·validation(실루엣 순열검정 p-value)을 쓴다 —
// 새 계산이 아니라, 계산은 되어 있는데 화면 어디에도 안 쓰이던 값을 꺼내
// 쓰는 것.
function renderValidityBar(cases) {
  const bar = document.getElementById('validity-bar');
  if (bar.classList.contains('hidden') || !suiteData) return;

  const cv = suiteData.cluster_validation || {};
  const rawAgree = cv.raw && cv.raw.hijack_tool;
  const resAgree = cv.residual && cv.residual.hijack_tool;
  const pv = suiteData.validation || {};
  const resPvalue = pv.residual_pvalue && pv.residual_pvalue.hijack_tool;

  const box = document.getElementById('validity-ari');
  const legendBox = document.getElementById('validity-ari-legend');
  box.innerHTML = '';
  legendBox.innerHTML = '';
  if (!rawAgree && !resAgree) {
    box.innerHTML = '<span class="validity-value" style="font-size:12px;color:var(--text-dim)">라벨 부족으로 계산 불가</span>';
  } else {
    // ARI 범위는 이론상 [-1, 1]이지만 실제로는 대부분 [-0.3, 0.6] 안에 있으므로
    // -0.5~1.0을 트랙 전체 폭으로 잡아 작은 차이도 눈에 띄게 한다.
    const lo = -0.5, hi = 1.0;
    const toPct = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    const zeroPct = toPct(0);
    const track = document.createElement('div');
    track.className = 'validity-track';
    box.appendChild(track);
    const zero = document.createElement('div');
    zero.className = 'validity-zero';
    box.appendChild(zero);

    [
      { agree: rawAgree, cls: 'raw', top: 4 },
      { agree: resAgree, cls: 'residual', top: 16 },
    ].forEach(({ agree, cls, top }) => {
      if (!agree) return;
      const p1 = toPct(0), p2 = toPct(agree.ari);
      const left = Math.min(p1, p2), width = Math.max(Math.abs(p2 - p1), 1);
      const fill = document.createElement('div');
      fill.className = `validity-fill ${cls}`;
      fill.style.left = left + '%';
      fill.style.width = width + '%';
      fill.style.top = top + 'px';
      fill.title = `${cls}: ARI=${agree.ari.toFixed(3)}, NMI=${agree.nmi.toFixed(3)}, 순도=${(agree.weighted_purity * 100).toFixed(0)}%`;
      box.appendChild(fill);
    });

    legendBox.innerHTML = `<span class="leg-raw">raw ${rawAgree ? rawAgree.ari.toFixed(3) : '–'}</span>`
      + `<span class="leg-residual">residual ${resAgree ? resAgree.ari.toFixed(3) : '–'}</span>`;
    if (resPvalue !== null && resPvalue !== undefined) {
      const sig = resPvalue < 0.05;
      legendBox.innerHTML += `<span class="validity-badge ${sig ? 'sig' : 'nosig'}">p=${resPvalue.toFixed(3)} ${sig ? '(우연 아님)' : '(우연과 구분 안 됨)'}</span>`;
    }
  }

  // gt_overlap 비율: hijack_tool이 그 케이스의 ground_truth 함수 목록에도
  // 포함된 케이스(=이미 정상 절차에 있는 도구를 재사용한 공격) 비율.
  // 클라이언트에서 바로 계산 가능(별도 API 불필요) — cases 페이로드에
  // hijack_tool과 ground_truth가 이미 있다.
  const hijacked = cases.filter((d) => d.hijack_tool);
  const overlapping = hijacked.filter((d) => (d.ground_truth || []).includes(d.hijack_tool));
  const rate = hijacked.length ? (overlapping.length / hijacked.length) * 100 : null;
  const gtEl = document.getElementById('validity-gt-overlap');
  gtEl.textContent = rate === null ? 'n/a' : `${rate.toFixed(0)}% (${overlapping.length}/${hijacked.length}건)`;

  renderRecallComparison(cases);
}

// hijack_events(라벨, feature로는 안 쓰고 검증에만 씀)가 잔차에 남는
// 비율 — existence(함수명 매칭)만 볼 때 vs 인자잔차 신호까지 더할 때.
// pipeline_study/argument_residual_diagnostic.py에서 실측했던 것과 같은
// 지표를 실제 앱 데이터 위에서 보여준다.
function renderRecallComparison(cases) {
  const box = document.getElementById('validity-recall');
  const withHijack = cases.filter((d) => d.hijack_events && d.hijack_events.length);
  if (!withHijack.length) { box.innerHTML = '<span class="validity-value" style="font-size:12px;color:var(--text-dim)">hijack 케이스 없음</span>'; return; }

  let existenceHits = 0, combinedHits = 0, total = 0;
  withHijack.forEach((d) => {
    const byIndex = new Map((d.events || []).map((ev) => [ev.index, ev]));
    d.hijack_events.forEach((hIdx) => {
      const ev = byIndex.get(hIdx);
      if (!ev) return;
      total += 1;
      const existenceResidual = !ev.matched_to_gt;
      if (existenceResidual) existenceHits += 1;
      if (existenceResidual || ev.arg_mismatch) combinedHits += 1;
    });
  });
  if (!total) { box.innerHTML = '<span class="validity-value" style="font-size:12px;color:var(--text-dim)">계산 불가</span>'; return; }

  const existencePct = (existenceHits / total) * 100;
  const combinedPct = (combinedHits / total) * 100;
  box.innerHTML = '';
  [
    { label: 'existence만', pct: existencePct, color: '#9aa1a8' },
    { label: '+ 인자잔차', pct: combinedPct, color: '#c98a2e' },
  ].forEach(({ label, pct, color }) => {
    const row = document.createElement('div');
    row.className = 'sec-metric-row';
    row.innerHTML = `<span class="sec-metric-label">${label}</span>`
      + `<div class="sec-metric-track"><div class="sec-metric-fill" style="width:${pct}%;background:${color}"></div></div>`
      + `<span class="sec-metric-val">${pct.toFixed(0)}%</span>`;
    box.appendChild(row);
  });
  if (combinedPct > existencePct + 0.5) {
    const note = document.createElement('div');
    note.className = 'composition-note';
    note.textContent = `인자잔차 신호를 더하면 hijack 이벤트 중 ${(combinedPct - existencePct).toFixed(0)}%p 더 잔차로 남습니다 `
      + `(도구 재사용형 공격을 존재 매칭만으로는 놓치고 있었다는 뜻 — 단, 이 신호는 suite 다수결 근사라 확정 판정은 아닙니다).`;
    box.appendChild(note);
  }
}

// 상세 화면(4번 구역) — "지금 보고 있는 이 케이스"에 한정된 클린런/인자
// 차이 신호. suite 전체 통계(신뢰도 바의 existence vs +인자잔차 recall)는
// 오버뷰에만 두고, 여기서는 그 통계로 이어지는 안내만 준다 — 케이스 하나
// 보는 화면에 suite 전체 차트를 욱여넣지 않기 위해서.
function renderArgSummary() {
  const box = document.getElementById('argsummary-body');
  if (!box || !suiteData) return;
  box.innerHTML = '';
  if (!pickedA) return;

  const describe = (caseId, label) => {
    const d = suiteData.cases.find((c) => c.case_id === caseId);
    if (!d) return null;
    const mismatches = (d.events || []).filter((ev) => ev.arg_mismatch);
    const wrap = document.createElement('div');
    wrap.className = 'argsummary-case';
    if (!mismatches.length) {
      wrap.innerHTML = `<div class="argsummary-case-title">${label} — ${d.case_id}</div>`
        + `<div class="argsummary-empty">인자잔차 신호 없음 (함수명이 GT와 다른 곳(존재잔차)은 있을 수 있음 — 원문 탭에서 확인)</div>`;
      return wrap;
    }
    const title = document.createElement('div');
    title.className = 'argsummary-case-title';
    title.textContent = `${label} — ${d.case_id} · 인자잔차 ${mismatches.length}건 (클릭: injection 없었다면?)`;
    wrap.appendChild(title);
    mismatches.forEach((ev) => {
      const args = ev.args && Object.keys(ev.args).length ? JSON.stringify(ev.args) : '{}';
      const row = document.createElement('div');
      row.className = 'argsummary-row clickable';
      row.innerHTML = `<span class="argsummary-idx">e${ev.index}</span>`
        + `<span class="argsummary-fn">${escapeHtml(ev.function || '')}(${escapeHtml(args)})</span>`
        + `<span class="argsummary-note">클릭하면 injection이 없었다면 어떤 값이었을지 클린런과 비교합니다 →</span>`;
      row.onclick = () => openArgCompare(d.case_id, ev.index);
      wrap.appendChild(row);
    });
    return wrap;
  };

  const a = describe(pickedA, '트레이스A');
  if (a) box.appendChild(a);
  const b = pickedB ? describe(pickedB, '트레이스B') : null;
  if (b) box.appendChild(b);

  const allCases = suiteData.cases;
  const nWithMismatch = allCases.filter((d) => (d.n_arg_mismatch || 0) > 0).length;
  const foot = document.createElement('div');
  foot.className = 'argsummary-foot';
  foot.textContent = `'${currentSuite}' suite 전체 ${allCases.length}건 중 ${nWithMismatch}건에 인자잔차 신호가 있습니다. `
    + `이게 실제 탐지율(recall)에 얼마나 영향을 주는지는 오버뷰의 신뢰도 바에서 확인하세요.`;
  box.appendChild(foot);
}

// ------------------------------------------------------- 클린런 비교 화면(5)
function openArgCompare(caseId, eventIndex) {
  argCompareTarget = { caseId, eventIndex };
  renderAll();
}
function closeArgCompare() {
  argCompareTarget = null;
  renderAll();
}

// 이 함수의 GT 인자를 실제로 "복원"한다 — 우선순위:
//   1) 이 트레이스 안에서 같은 함수가 인자잔차 없이(=정상적으로) 다시
//      불린 적이 있다면 그 실제 인자값을 쓴다 (가장 신뢰도 높음 — 추정이
//      아니라 이 케이스 자신의 실제 실행 기록).
//   2) 없다면 suite 다수결 참고값을 "추정"이라고 표시하고 대신 쓴다.
function resolveExpectedArgs(caseData, functionName, excludeIndex, majorityDetailSource) {
  const realOccurrence = (caseData.events || []).find((ev) =>
    ev.function === functionName && ev.matched_to_gt && !ev.arg_mismatch && ev.index !== excludeIndex);
  if (realOccurrence) return { args: realOccurrence.args || {}, source: 'real', fromIndex: realOccurrence.index };
  // 다수결 참고값 — arg_mismatch_detail이 있는 이벤트에서 expected를 모은다
  const est = {};
  (caseData.events || []).forEach((ev) => {
    if (ev.function === functionName && ev.arg_mismatch_detail) {
      Object.entries(ev.arg_mismatch_detail).forEach(([k, v]) => { est[k] = v.expected; });
    }
  });
  return { args: est, source: Object.keys(est).length ? 'estimated' : 'unknown', fromIndex: null };
}

function renderArgCompare() {
  const panel = document.getElementById('panel-argcompare');
  if (!panel) return;
  if (!argCompareTarget) return;
  const d = suiteData.cases.find((c) => c.case_id === argCompareTarget.caseId);
  const targetEv = d && (d.events || []).find((ev) => ev.index === argCompareTarget.eventIndex);
  document.querySelector('#panel-argcompare .panel-head h2').innerHTML =
    `<span class="fig-label">5</span>클린런 비교 — ${escapeHtml(argCompareTarget.caseId)} · e${argCompareTarget.eventIndex}`;
  if (!d || !targetEv) return;
  const detail = targetEv.arg_mismatch_detail || {};

  // --- 1) diff 카드: GT 추정값 vs 실제(hijack) 값을 크게 나란히 ---
  const diffBox = document.getElementById('argcompare-diffcard');
  diffBox.innerHTML = '';
  const keys = Object.keys(detail);
  if (!keys.length) {
    diffBox.className = 'argcompare-diffcard empty';
    diffBox.textContent = '이 이벤트엔 인자 차이 정보가 없습니다.';
  } else {
    diffBox.className = 'argcompare-diffcard';
    keys.forEach((k) => {
      const v = detail[k];
      const item = document.createElement('div');
      item.className = 'diffcard-item';
      item.innerHTML = `<span class="diffcard-key">${escapeHtml(targetEv.function)}.${escapeHtml(k)}</span>`
        + `<span class="diffcard-compare"><span class="diffcard-expected">${escapeHtml(String(v.expected))}</span>`
        + `<span class="diffcard-arrow">→ 실제 실행에서는 →</span>`
        + `<span class="diffcard-actual">${escapeHtml(String(v.actual))}</span></span>`
        + `<span class="diffcard-share">GT 추정값 근거: 이 suite에서 ${escapeHtml(targetEv.function)}.${escapeHtml(k)}의 ${(v.expected_share * 100).toFixed(0)}%가 이 값을 씀</span>`;
      diffBox.appendChild(item);
    });
  }

  // --- 2) 왼쪽: 추정 클린런 (GT 함수 시퀀스를, 이 케이스 자신의 실제 정상
  // 실행 기록으로 최대한 채우고, 못 채우면 suite 다수결로 대체) ---
  const cleanBox = document.getElementById('argcompare-clean');
  cleanBox.innerHTML = '';
  (d.ground_truth || []).forEach((fn) => {
    const isTargetFn = fn === targetEv.function;
    const resolved = resolveExpectedArgs(d, fn, isTargetFn ? targetEv.index : -1);
    const step = document.createElement('div');
    step.className = 'argcompare-step ' + (resolved.source === 'real' ? 'real' : resolved.source === 'estimated' ? 'estimated' : '');
    const argsText = Object.keys(resolved.args).length ? JSON.stringify(resolved.args) : '{}';
    let note = '';
    if (resolved.source === 'real') note = `이 트레이스에서 실제로 정상 실행된 값 (e${resolved.fromIndex})`;
    else if (resolved.source === 'estimated') note = 'suite 다수결로 추정 (이 트레이스 안에는 정상 실행 기록이 없음)';
    else note = '추정 불가 (표본 부족)';
    step.innerHTML = `<div class="argcompare-step-fn">${escapeHtml(fn)}</div>`
      + `<div class="argcompare-step-args">${escapeHtml(argsText)}</div>`
      + `<div class="argcompare-step-note">${note}</div>`;
    cleanBox.appendChild(step);
  });

  // --- 3) 오른쪽: 실제 실행 전체, 문제의 이벤트를 강조 ---
  const actualBox = document.getElementById('argcompare-actual');
  actualBox.innerHTML = '';
  (d.events || []).forEach((ev) => {
    const step = document.createElement('div');
    const isTarget = ev.index === targetEv.index;
    step.className = 'argcompare-step' + (isTarget ? ' diverge' : '');
    const argsText = ev.args && Object.keys(ev.args).length ? JSON.stringify(ev.args) : '';
    step.innerHTML = `<div class="argcompare-step-fn">e${ev.index} ${escapeHtml(ev.function || ev.role)}</div>`
      + (argsText ? `<div class="argcompare-step-args">${escapeHtml(argsText)}</div>` : '')
      + (isTarget ? `<div class="argcompare-step-note">← 여기서 GT 추정값과 실제 인자가 갈립니다</div>` : '');
    actualBox.appendChild(step);
  });
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

function eventRowHtml(ev, caseId) {
  const roleLabel = { user: 'user', tool_call: 'tool_call', tool_resp: 'tool_resp' }[ev.role] || ev.role;
  const args = ev.args && Object.keys(ev.args).length ? JSON.stringify(ev.args) : '';
  const flags = [];
  if (ev.role !== 'user') flags.push(ev.matched_to_gt ? '<span class="evt-flag gt-match">GT매칭</span>' : '<span class="evt-flag gt-residual">잔차</span>');
  // 인자잔차(클린런 비교)는 원문 보기에서는 배지로 안 보여준다 — 4번
  // "클린런/GT 인자 차이 요약" 패널이 이미 그 목록과 진입점을 갖고 있어서
  // 원문 쪽에 또 두면 중복이고, 좁은 칸에서 배지 줄바꿈으로 겹쳐 보이는
  // 원인이었다.
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
  body.innerHTML = c.events.map((ev) => eventRowHtml(ev, c.case_id)).join('');
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
    const color = hullColor(String(key));
    components.forEach((comp) => {
      if (comp.length >= 3) {
        const hull = d3.polygonHull(comp.map((i) => points[i]));
        if (hull) {
          g.append('path')
            .attr('class', 'hull-outline')
            .attr('pointer-events', 'none')
            .attr('d', 'M' + hull.map((p) => p.join(',')).join('L') + 'Z')
            .attr('fill', color)
            .attr('stroke', color);
          return;
        }
      }
      // 점 1~2개짜리 조각(또는 폴리곤이 만들어지지 않는 경우)은 다각형 윤곽을
      // 그릴 수 없다고 그냥 건너뛰면, k를 올릴수록 흔해지는 작은 군집이
      // 화면에서 통째로 사라져 "이 군집은 어디 있지?"에 답할 수 없게 된다
      // (실측: k가 커질수록 average linkage 특성상 크기 1~2인 군집이 늘고,
      // 그 멤버들이 서로 화면 문턱 거리보다 떨어져 있으면 윤곽이 하나도
      // 안 그려짐). 점선 원(+2점이면 연결선)으로 최소한의 위치 표시를 남긴다.
      const comp2 = comp.map((i) => points[i]);
      if (comp2.length === 2) {
        g.append('line')
          .attr('class', 'hull-outline hull-outline-stub')
          .attr('pointer-events', 'none')
          .attr('x1', comp2[0][0]).attr('y1', comp2[0][1])
          .attr('x2', comp2[1][0]).attr('y2', comp2[1][1])
          .attr('stroke', color).attr('stroke-width', 2).attr('stroke-dasharray', '3,3');
      }
      comp2.forEach(([px, py]) => {
        g.append('circle')
          .attr('class', 'hull-outline hull-outline-stub')
          .attr('pointer-events', 'none')
          .attr('cx', px).attr('cy', py).attr('r', 9)
          .attr('fill', 'none').attr('stroke', color).attr('stroke-width', 1.5).attr('stroke-dasharray', '2,2');
      });
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

  renderClusterComposition(counts);
}

// 군집 구성 근거 — "왜 이 케이스들이 같은 군집으로 묶였는가"를 요약 지표
// 하나(순도%)로 뭉개지 않고 detail로 보여준다(Ch1.6: 요약은 무엇을 버렸는지
// 말해주지 않는다). 계층적 군집화(average linkage)는 잔차 DTW 거리평균이
// 가장 가까운 케이스끼리 묶으므로, "그 거리를 실제로 좌우한 게 무엇인가"를
// 두 축으로 분해한다:
//   1) hijack_tool 분포 - 이 군집이 실제로 같은 공격 유형을 모은 것인지,
//      아니면 우연히 가까워진 것인지
//   2) 잔차에 가장 흔한 함수 - 거리를 지배한 게 진짜 공격 신호인지, 아니면
//      get_day_calendar_events 같은 무관한 부가조회(benign 잡음)인지
//      (pipeline_study의 cluster_explain.py 실측에서 실제로 이게 갈렸다)
function renderClusterComposition(counts) {
  const box = document.getElementById('cluster-composition');
  if (selectedCluster === null || !counts || !counts.has(selectedCluster)) {
    box.classList.add('hidden');
    return;
  }
  const ids = new Set(counts.get(selectedCluster));
  const members = suiteData.cases.filter((d) => ids.has(d.case_id));
  box.classList.remove('hidden');

  // --- hijack_tool 분포 ---
  const hijackCounts = new Map();
  members.forEach((d) => {
    const key = d.hijack_tool || 'None';
    hijackCounts.set(key, (hijackCounts.get(key) || 0) + 1);
  });
  const hijackEntries = Array.from(hijackCounts.entries()).sort((a, b) => b[1] - a[1]);
  const hijackColor = hijackToolColorScale(hijackEntries.map((e) => e[0]));
  const hijackMax = Math.max(...hijackEntries.map((e) => e[1]), 1);
  const hijackBox = document.getElementById('composition-hijack-bars');
  hijackBox.innerHTML = '';
  hijackEntries.forEach(([name, count]) => {
    const row = document.createElement('div');
    row.className = 'composition-row';
    row.innerHTML = `<span class="composition-swatch" style="background:${hijackColor(name)}"></span>`
      + `<span class="composition-label">${name}</span>`
      + `<div class="composition-bar-track"><div class="composition-bar-fill" style="width:${(count / hijackMax) * 100}%;background:${hijackColor(name)}"></div></div>`
      + `<span class="composition-count">${count}</span>`;
    hijackBox.appendChild(row);
  });

  // --- 잔차(existence residual, matched_to_gt=false)에 가장 흔한 함수 top6 ---
  const funcCounts = new Map();
  members.forEach((d) => {
    (d.events || []).forEach((ev) => {
      if (ev.matched_to_gt) return; // GT와 매칭된 정상 이벤트는 잔차가 아니므로 제외
      const key = ev.function || ev.role;
      funcCounts.set(key, (funcCounts.get(key) || 0) + 1);
    });
  });
  const funcEntries = Array.from(funcCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const funcMax = Math.max(...funcEntries.map((e) => e[1]), 1);
  const funcBox = document.getElementById('composition-func-bars');
  funcBox.innerHTML = '';
  funcEntries.forEach(([name, count]) => {
    const row = document.createElement('div');
    row.className = 'composition-row';
    row.innerHTML = `<span class="composition-swatch" style="background:var(--accent)"></span>`
      + `<span class="composition-label">${name}</span>`
      + `<div class="composition-bar-track"><div class="composition-bar-fill" style="width:${(count / funcMax) * 100}%;background:var(--accent)"></div></div>`
      + `<span class="composition-count">${count}</span>`;
    funcBox.appendChild(row);
  });

  const hijackShare = members.length - (hijackCounts.get('None') || 0);
  document.getElementById('composition-note').textContent =
    `이 군집 ${members.length}건 중 ${hijackShare}건이 공격 케이스. `
    + `잔차 최빈 함수가 hijack_tool과 다르면(위 두 목록의 1위가 다르면), `
    + `이 군집을 묶은 주된 이유가 공격 신호가 아니라 다른 부가행동일 수 있음.`;
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
  // 점 반지름(최대 point-size*2.0, 이상치 링까지 포함하면 더 커짐)만큼
  // 여유를 더 두지 않으면, 극단값(도메인 min/max)에 있는 케이스의 원이
  // 축 경계나 패널 테두리에 걸려 "잘린" 것처럼 보인다 — suite마다 UMAP
  // 좌표 분포가 달라 어느 suite는 우연히 여유가 있고 어느 suite는 딱
  // 걸려서 이 문제가 suite별로 다르게 나타났다. 고정 픽셀 여유를
  // margin에 더해 점 크기와 무관하게 항상 안전하게 만든다.
  const pointPad = 18;
  const margin = { top: 14 + pointPad, right: 14 + pointPad, bottom: 30 + pointPad, left: 38 + pointPad };

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

function setTraceViewTab(view) {
  traceViewTab = view;
  document.querySelectorAll('#trace-view-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('trace-view-raw').classList.toggle('hidden', view !== 'raw');
  document.getElementById('trace-view-compare').classList.toggle('hidden', view !== 'compare');
}

function maybeCompare() {
  if (pickedA && pickedB && pickedA !== pickedB) {
    document.getElementById('analysis-empty-hint').classList.add('hidden');
    runCompare();
    setTraceViewTab('compare'); // B까지 골랐으면 바로 비교 결과를 보여준다
  } else {
    compareResult = null;
    document.getElementById('compare-body').classList.add('hidden');
    document.getElementById('dtw-value').textContent = '–';
    // 지도·검색 패널이 이미 "케이스 선택" 안내를 하므로(trace-empty-hint),
    // 여기서는 중복 안내 대신 "A는 골랐으니 B도 고르라"는 다음 행동만 보여준다.
    document.getElementById('analysis-empty-hint').classList.toggle('hidden', !pickedA);
    if (traceViewTab === 'compare') setTraceViewTab('raw'); // 비교할 B가 없어지면 원문 탭으로
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
  const clsFor = (matched, argMismatch) => (matched ? (argMismatch ? 'matched arg-mismatch' : 'matched') : 'residual');
  rows.push({
    label: `트레이스A (조건 ${condLabel(cmp.case_a.condition)})`, key: 'a',
    items: cmp.events_a.map((e, i) => ({ idx: i, text: e.function || e.role, injected: e.injected, sentence: e.sentence, cls: clsFor(cmp.gt_align_a.matched_to_gt[i], e.arg_mismatch) })),
  });
  rows.push({
    label: `트레이스B (조건 ${condLabel(cmp.case_b.condition)})`, key: 'b',
    items: cmp.events_b.map((e, i) => ({ idx: i, text: e.function || e.role, injected: e.injected, sentence: e.sentence, cls: clsFor(cmp.gt_align_b.matched_to_gt[i], e.arg_mismatch) })),
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
  renderDtwCostStrip();
  updatePlayhead();
}

// DTW가 실제로 계산하는 값(정렬 경로 각 스텝의 로컬 코사인 거리)을 색
// 띠로 보여준다 — 순차형 속성(0=완전히 같음, 값이 클수록 다름)이므로
// 무지개가 아니라 단일 색조(파랑) 휘도 램프를 쓴다(distance matrix와
// 동일한 컬러맵, Ch10.3.2).
function renderDtwCostStrip() {
  const cmp = compareResult;
  const box = document.getElementById('dtw-cost-strip');
  box.innerHTML = '';
  if (!cmp.local_cost || !cmp.local_cost.length) return;
  const max = Math.max(...cmp.local_cost, 1e-6);
  cmp.local_cost.forEach((c, i) => {
    const seg = document.createElement('div');
    seg.className = 'dtw-cost-seg';
    const t = Math.max(0, Math.min(1, c / max));
    seg.style.background = d3.interpolateBlues(0.12 + t * 0.8);
    seg.title = `step ${i + 1}/${cmp.local_cost.length}: 로컬 거리 ${c.toFixed(3)}`;
    seg.onclick = () => { scrubIndex = i; document.getElementById('scrub').value = i; updatePlayhead(); };
    box.appendChild(seg);
  });
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
  document.querySelectorAll('.dtw-cost-seg').forEach((c, i) => c.classList.toggle('playhead', i === scrubIndex));
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
  document.getElementById('close-detail-btn').onclick = () => {
    pickedA = null; pickedB = null;
    updatePickerInputs();
    afterPickChange();
  };
  document.getElementById('argsummary-goto-overview').onclick = () => {
    pickedA = null; pickedB = null;
    updatePickerInputs();
    afterPickChange();
    setOverviewStripExpanded(true);
    const bar = document.getElementById('validity-bar');
    bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
    bar.classList.add('flash');
    setTimeout(() => bar.classList.remove('flash'), 1200);
  };
  document.getElementById('overview-strip-toggle').onclick = () => {
    const detail = document.getElementById('overview-strip-detail');
    setOverviewStripExpanded(detail.classList.contains('collapsed'));
  };
  document.getElementById('argcompare-back-btn').onclick = closeArgCompare;
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

  document.querySelectorAll('#trace-view-tabs .tab-btn').forEach((btn) => {
    btn.onclick = () => setTraceViewTab(btn.dataset.view);
  });

  document.querySelectorAll('#map-tabs .tab-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#map-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      mapTab = btn.dataset.tab;
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
