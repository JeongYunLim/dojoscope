 /* =========================================================
   DojoScope Trace Behavior Atlas (정적 버전)
   -----------------------------------------------------------
   서버 없이 정적 파일만 읽는다: data/manifest.json, data/<suite>.json.
   새 데이터를 추가하려면 터미널에서 `python add_data.py 새파일.json`을
   실행해 이 폴더의 JSON을 다시 만들고, 브라우저를 새로고침하면 된다.
   이 파일은 그 결과를 fetch해서 그리기만 한다.
   ========================================================= */

const SUITE_ORDER = ["banking", "slack", "travel", "workspace"];

// verdict = security(2) x utility(2)를 색 하나로 인코딩하는 이변량(bivariate) 색상표.
// 색상(hue)은 항상 security를 따르고(빨강=침해/파랑=방어), 명도만 utility에 따라
// 달라진다 — 두 속성 중 하나가 이진값일 때의 표준적인 구성이다(Munzner 10.3.3).
// 이전에는 네 상태에 빨강/초록/보라/파랑을 각각 배정했는데, 적록색맹(남성의 8%)이
// 빨강과 초록을 구분하지 못해 "침해"와 "방어"가 뒤섞여 보이는 문제가 있었다(10.3.4).
// 색상축을 빨강/파랑 한 쌍으로만 묶으면 이 문제가 사라진다.
const VERDICT_COLOR = {
  success_hijacked: "#E30613",   // 진한 빨강 — 과제 성공 + 침해 (업무 완료와 공격자 목표 달성이 동시에 발생)
  fail_hijacked: "#F3A6AC",      // 옅은 빨강 — 과제 실패 + 침해
  success_defended: "#0066CC",   // 진한 파랑 — 과제 성공 + 방어 (최선)
  fail_defended: "#9FC5EA",      // 옅은 파랑 — 과제 실패했지만 방어는 됨
};
const VERDICT_LABEL = {
  success_hijacked: "과제 성공 · 침해",
  success_defended: "과제 성공 · 방어",
  fail_hijacked: "과제 실패 · 침해",
  fail_defended: "과제 실패 · 방어",
};
const DELAY_COLOR = { immediate: "#E30613", delayed: "#FF8200", none: "#0066CC" };
const DELAY_LABEL = { immediate: "노출 직후 탈취", delayed: "지연 탈취", none: "탈취 없음" };
const CONDITION_COLOR = { A: "#E30613", B: "#0066CC" };
const CONDITION_LABEL = { A: "A · 방어 없음", B: "B · tool_filter" };

const TRANSITION_COLOR = {
  blocked: "#009E73",
  regressed: "#D55E00",
  still_hijacked: "#CC79A7",
  still_safe: "#0072B2",
  unpaired: "#999999",
};
const TRANSITION_LABEL = {
  blocked: "방어 성공 · A 침해 → B 차단",
  regressed: "회귀 · A 안전 → B 침해",
  still_hijacked: "계속 침해",
  still_safe: "계속 안전",
  unpaired: "짝 없음",
};

// 항상 같은 뜻으로 고정된 기본 기호 체계 — 설명 없이도 읽혀야 하는 두 축.
// 색 = 방어 결과(security), 모양 = 과제 결과(utility). 둘 다 화면 전역에서
// 한 번 정해지면 바뀌지 않는다(다른 색상 기준을 골라도 모양은 그대로 O/X).
const SECURITY_COLOR = { true: "#E30613", false: "#0066CC" };   // true=침해(빨강), false=방어(파랑)
const SECURITY_LABEL = { true: "침해됨", false: "방어됨" };
const UTILITY_GLYPH = { true: "○", false: "X" };
const UTILITY_LABEL = { true: "과제 성공", false: "과제 실패" };
const CONDITION_GLYPH = { A: "●", B: "■" };

// Okabe & Ito (2008) 색맹 안전 팔레트 — 카테고리 색상표는 6~12개 구간까지만
// 서로 구분되고(Munzner 10.3.1), 그 이상은 사람이 못 나눈다. 여기서는 8색만 쓰고
// 나머지는 "기타"로 묶어(10.3.1의 권장 전략) 값이 아무리 많아도 항상 구분 가능하게 한다.
const OKABE_ITO = ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#999999"];
const CATEGORICAL_OTHER_COLOR = "#C4CAD3";
const CATEGORICAL_OTHER_LABEL = "기타";

const LABEL_FIELDS = [
  { key: "user_task_id", ko: "user task", better: "낮을수록" },
  { key: "hijack_tool", ko: "탈취 도구", better: "높을수록" },
  { key: "delay_bucket", ko: "지연", better: "높을수록" },
  { key: "exposure_channel", ko: "노출 채널", better: "높을수록" },
  { key: "verdict", ko: "판정 상태", better: "높을수록" },
];

// raw/residual 두 공간이 각각 무슨 뜻인지 — focus 뷰의 패널 캡션에 그대로 노출한다.
const SPACE_EXPLANATION = {
  raw: "전체 시퀀스 기준 — 동일 과제끼리 뭉치기 쉬움",
  residual: "정답과 다르게 행동한 부분만 — 침해 패턴 비교에 유리",
};
const SPACE_EXPLANATION_FULL = {
  raw: "이벤트 전체 시퀀스를 그대로 비교한 지도. 같은 user_task끼리는 정답 시퀀스의 앞부분이 겹쳐서 그것만으로도 뭉치기 쉽다 — \"무엇을 했는가\" 전체 기준.",
  residual: "정답(GT)과 매칭된 이벤트를 지우고, 정답과 다르게 행동한 부분만 남겨서 잰 거리. 같은 과제라서 겹치는 부분(예: 파일부터 읽기)을 지우면 \"정답과 다르게 한 행동\"이 더 잘 갈린다 — 탈취 패턴 비교에 보통 이쪽이 더 유용.",
};
const AXIS_EXPLANATION = "UMAP-1 / UMAP-2는 절대적인 값이 없는 임베딩 좌표 — 가까이 있는 점일수록 행동이 비슷하다는 상대적 의미만 유효.";

const state = {
  suites: {},            // name -> suite json
  mode: "overview",       // "overview" | "focus"
  focusSuite: null,
  space: "residual",      // 전체보기(overview) 그리드 전용 — focus는 raw/residual을 항상 같이 보여줌
  colorBy: "cluster",
  sizeBy: "residual_length",
  shapeBy: "utility",
  conditionFilter: "all",  // "all" | "A" | "B" — 무방어/방어 중 하나만 볼 때
  showHulls: false,
  hullSensitivity: 2.5,
  hullMinSize: 3,
  lastClusters: {},       // spaceKey -> [{key, cases}] — focus 뷰가 마지막으로 그린 군집 (사이드 "시각적 이웃" 목록용)
  lastOutliers: {},       // spaceKey -> [case, ...] — 원 DTW 거리공간 kNN 고립 상위 케이스
  compareMode: false,
  compareSelection: [],   // case_id 배열, focus 중인 suite 안에서만 유효 (최대 5개)
  search: "",
  brushed: new Set(),     // case_id set — focus 모드에서 두 패널이 공유
  detailCase: null,       // 단일 클릭(비교 모드 아님)으로 연 케이스
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

let categoricalColorCache = {};
// focus 모드에서 두 패널("raw"/"residual")의 점 selection을 등록해 둔다 —
// 한쪽 패널에서 브러시/비교선택을 해도 두 패널 모두 하이라이트가 같이 갱신되도록 하기 위함.
let panelDotSelections = {};

async function loadAll() {
  const manifest = await d3.json("data/manifest.json");
  state.suites = {};
  for (const name of manifest.suites) {
    state.suites[name] = await d3.json(`data/${name}.json`);
  }
  return manifest;
}

function setLoading(visible, text) {
  const overlay = document.getElementById("loadingOverlay");
  overlay.hidden = !visible;
  if (text) document.getElementById("loadingText").textContent = text;
}

function allCases() {
  const out = [];
  for (const name of SUITE_ORDER) {
    if (state.suites[name]) out.push(...state.suites[name].cases);
  }
  return out;
}

// ---------- 인코딩 헬퍼 ----------

function categoricalScale(field, cases) {
  if (field === "security") return (v) => SECURITY_COLOR[String(v)] || "#555";
  if (field === "verdict") return (v) => VERDICT_COLOR[v] || "#555";
  if (field === "delay_bucket") return (v) => DELAY_COLOR[v] || "#555";
  if (field === "condition") return (v) => CONDITION_COLOR[v] || "#999";
  if (field === "security_transition") return (v) => TRANSITION_COLOR[v] || "#999";

  // hijack_tool / exposure_channel: 데이터에서 관측되는 값으로 동적 팔레트 구성.
  // 빈도 상위 8개까지만 고유 색을 주고(색맹 안전 팔레트, discriminability 한계),
  // 나머지 희귀 값은 전부 "기타" 회색 하나로 묶는다 — 값이 몇 개든 항상 구분 가능하다.
  const cacheKey = field + "::" + cases.length;
  if (!categoricalColorCache[cacheKey]) {
    const counts = d3.rollup(cases.filter((c) => c[field] != null), (v) => v.length, (c) => c[field]);
    const topValues = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, OKABE_ITO.length).map(([v]) => v);
    const scale = d3.scaleOrdinal().domain(topValues).range(OKABE_ITO);
    categoricalColorCache[cacheKey] = (v) => (v == null ? "#3A4257" : (topValues.includes(v) ? scale(v) : CATEGORICAL_OTHER_COLOR));
  }
  return categoricalColorCache[cacheKey];
}

// colorBy가 "cluster"면 지금 그리는 패널이 raw인지 residual인지에 따라
// 실제 필드(cluster_raw / cluster_residual)를 자동으로 고른다. raw 패널과
// residual 패널을 나란히 볼 때(focus 뷰) 각자 자기 공간의 군집으로 칠해야
// "두 공간에서 군집 구조가 어떻게 다른지"를 한눈에 비교할 수 있다 — 사용자가
// 매번 raw/residual 색상 기준을 수동으로 골라야 하는 건 이 비교를 방해한다.
function resolveColorField(space) {
  if (state.colorBy === "cluster") return space === "raw" ? "cluster_raw" : "cluster_residual";
  return state.colorBy;
}

// 군집 색상은 suite마다(그리고 raw/residual 공간마다) 독립적으로 계산된 결과이므로,
// 색 순위를 매길 표본도 "지금 그리는 패널의 케이스들"로 한정해야 한다 — 4개 suite를
// 합쳐서 순위를 매기면 서로 무관한 군집끼리 우연히 같은 색을 받는 문제가 생긴다.
function colorFor(d, space, cases) {
  const field = resolveColorField(space);
  return categoricalScale(field, cases || allCases())(d[field]);
}

function sizeScaleFor(cases) {
  if (state.sizeBy === "none") return () => 5;
  const extent = d3.extent(cases, (d) => d[state.sizeBy]);
  if (extent[0] === extent[1]) return () => 6;
  return d3.scaleSqrt().domain(extent).range([3, 12]);
}

// 모양은 글리프(문자)로 그린다 — d3.symbol 도형보다 "O/X"가 훨씬 더 즉각적으로
// 읽히기 때문이다(과제 성공/실패를 매번 범례 없이 알아볼 수 있어야 한다는 요구사항).
function glyphFor(d) {
  if (state.shapeBy === "utility") return UTILITY_GLYPH[String(d.utility)] || "?";
  if (state.shapeBy === "condition") return CONDITION_GLYPH[d.condition] || "●";
  return "●";
}

function conditionFilteredCases(cases) {
  if (state.conditionFilter === "all") return cases;
  return cases.filter((c) => c.condition === state.conditionFilter);
}

function coordsOf(d, spaceKey) {
  return spaceKey === "raw" ? d.coords_raw : d.coords_residual;
}

function matchesSearch(d) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return (
    d.case_id.toLowerCase().includes(q) ||
    d.user_task_id.toLowerCase().includes(q) ||
    d.injection_task_id.toLowerCase().includes(q) ||
    (d.hijack_tool || "").toLowerCase().includes(q)
  );
}

// ---------- 이름 기준 근사 DTW (비교 선택 모드에서, 정식 A/B 쌍이 아닌 임의의 두
// 케이스를 이을 때 씀). 실제 임베딩 벡터는 화면에 내려받지 않으므로, 이벤트를
// "role:function" 토큰으로 보고 같으면 거리 0/다르면 거리 1인 DTW로 근사한다.
// GT 정렬이나 정식 A/B 정렬(둘 다 서버에서 임베딩 기반 DTW로 미리 계산됨)과는
// 다른 근사치라는 것을 화면에 항상 같이 표시한다. ----------
function nameDTW(eventsA, eventsB) {
  const n = eventsA.length, m = eventsB.length;
  if (n === 0 || m === 0) return { path: [] };
  const token = (ev) => `${ev.role}:${ev.function ?? ""}`;
  const cost = (i, j) => (token(eventsA[i]) === token(eventsB[j]) ? 0 : 1);

  const acc = Array.from({ length: n }, () => new Array(m).fill(Infinity));
  acc[0][0] = cost(0, 0);
  for (let i = 1; i < n; i++) acc[i][0] = acc[i - 1][0] + cost(i, 0);
  for (let j = 1; j < m; j++) acc[0][j] = acc[0][j - 1] + cost(0, j);
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < m; j++) {
      acc[i][j] = cost(i, j) + Math.min(acc[i - 1][j - 1], acc[i - 1][j], acc[i][j - 1]);
    }
  }
  let i = n - 1, j = m - 1;
  const path = [[i, j, cost(i, j) === 0]];
  while (i > 0 || j > 0) {
    if (i === 0) j--;
    else if (j === 0) i--;
    else {
      const choices = [[acc[i - 1][j - 1], i - 1, j - 1], [acc[i - 1][j], i - 1, j], [acc[i][j - 1], i, j - 1]];
      choices.sort((a, b) => a[0] - b[0]);
      i = choices[0][1]; j = choices[0][2];
    }
    path.push([i, j, cost(i, j) === 0]);
  }
  path.reverse();
  return { path };
}

// ---------- 공간적으로 가까운 점끼리만 묶는 간이 군집화 (single-linkage, 거리 임계값 기반) ----------
// "같은 색상이면 무조건 하나로 묶기"는 색은 같아도 지도에서 멀리 떨어진 점들까지
// 하나의 거대한 껍질로 이어버리는 문제가 있었다. 그래서 색상으로 먼저 나눈 뒤,
// 그 안에서도 실제 거리가 가까운 것들끼리만 다시 하위 그룹으로 쪼갠다.
// items: [{ pt: [x, y], case: caseObj }] — pt는 호출하는 쪽이 픽셀이든 데이터
// 좌표든 원하는 공간으로 넘기면 된다(아래 computeClusters는 데이터 좌표를 쓴다).
function spatialSubclusters(items, threshold) {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = items[i].pt[0] - items[j].pt[0], dy = items[i].pt[1] - items[j].pt[1];
      if (Math.sqrt(dx * dx + dy * dy) <= threshold) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(items[i]);
  }
  return Array.from(groups.values());
}

// 임계값을 데이터에 맞춰 자동으로 정한다: 전체 점(색상 무관)의 최근접 이웃 거리의
// 중앙값을 구하고, 그 배수(민감도)를 "같은 군집으로 볼 만큼 가깝다"의 기준으로 쓴다.
// UMAP 좌표(데이터 공간) 기준으로 계산해서 패널 크기·줌과 무관하게 항상 같은 군집이 나온다.
function estimateClusterThreshold(points, sensitivity) {
  const n = points.length;
  if (n < 2) return 1;
  const nnDists = points.map((p, i) => {
    let min = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = p[0] - points[j][0], dy = p[1] - points[j][1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < min) min = d;
    }
    return min;
  });
  nnDists.sort((a, b) => a - b);
  const median = nnDists[Math.floor(n / 2)];
  return Math.max(median * (sensitivity ?? 2.5), 1e-6);
}

// ---------- 화면(픽셀)과 무관하게, 데이터(UMAP) 좌표에서 군집을 계산한다 ----------
// drawScatter의 시각적 윤곽선과 사이드 패널의 "시각적 이웃" 목록이 항상 같은
// 결과를 보도록 이 함수 하나를 공유한다. 색상 기준(colorField)으로 먼저 나누고,
// 그 안에서 공간적으로 가까운 것끼리 다시 쪼갠 뒤 큰 군집부터 정렬해 반환한다.
function computeClusters(cases, spaceKey, colorField, sensitivity, minSize) {
  const groups = new Map();
  for (const d of cases) {
    const key = d[colorField];
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ pt: coordsOf(d, spaceKey), case: d });
  }
  const allPts = cases.map((d) => coordsOf(d, spaceKey));
  const threshold = estimateClusterThreshold(allPts, sensitivity);
  const out = [];
  for (const [key, items] of groups) {
    for (const sub of spatialSubclusters(items, threshold)) {
      if (sub.length < minSize) continue;
      out.push({ key, cases: sub.map((s) => s.case) });
    }
  }
  out.sort((a, b) => b.cases.length - a.cases.length);
  return out;
}

// ---------- 거리공간 고립 후보 ----------
// UMAP 2D는 탐색용 투영이라 밀도와 전역 거리를 왜곡할 수 있다. 따라서 "이상치"를
// 2D 좌표에서 판정하지 않는다. 파이프라인이 원래 DTW 거리행렬에서 계산한 kNN
// isolation percentile을 사용하고, 여기서는 상위 10%를 "고립 후보"로만 표시한다.
function distanceOutliers(cases, spaceKey, threshold = 0.90) {
  const field = spaceKey === "raw" ? "raw_isolation_percentile" : "residual_isolation_percentile";
  return cases.filter((c) => c[field] != null && c[field] >= threshold);
}

// ---------- 군집 하나를 한 줄로 구분해 주는 "특징" — 색만으로는 같은 색 군집이
// 여러 개일 때 구분이 안 되므로, 그 안에서 가장 지배적인 탈취 도구/지연 패턴을 붙인다. ----------
function clusterSignature(cases) {
  const hijacked = cases.filter((d) => d.hijack_tool);
  if (hijacked.length) {
    const counts = d3.rollup(hijacked, (v) => v.length, (d) => d.hijack_tool);
    const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] / cases.length >= 0.5) return `${top[0]} 위주 (${top[1]}/${cases.length})`;
  }
  const delays = cases.filter((d) => d.delay_bucket);
  if (delays.length) {
    const counts = d3.rollup(delays, (v) => v.length, (d) => d.delay_bucket);
    const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (top) return `${DELAY_LABEL[top[0]] || top[0]} (${top[1]}/${cases.length})`;
  }
  return "";
}

// ---------- 선택된 케이스 묶음(브러시든 군집이든 비교 선택이든)을 "보안 개발자"가
// 판단에 바로 쓸 수 있는 한두 문장으로 요약한다. 순수 통계 나열이 아니라 결론까지 준다. ----------
function interpretGroup(selected) {
  if (!selected.length) return "";
  const hijackedN = selected.filter((d) => d.security).length;
  if (hijackedN === 0) return "선택 집합에서 Targeted ASR 성공은 관측되지 않았습니다. 다만 이것만으로 방어 충분성을 단정할 수 없으므로 과제 성공률과 표본 수를 함께 확인하세요.";

  const hijackedCases = selected.filter((d) => d.security && d.hijack_tool);
  const hijackCounts = d3.rollup(hijackedCases, (v) => v.length, (d) => d.hijack_tool);
  const topHijack = Array.from(hijackCounts.entries()).sort((a, b) => b[1] - a[1])[0];
  if (!topHijack || !hijackedCases.length) return "";

  const share = topHijack[1] / hijackedCases.length;
  return share >= 0.6
    ? `→ 침해 실행이 <code>${escapeHtml(topHijack[0])}</code>에 집중됨 — 이 도구의 권한·입력 신뢰 경계·allowlist 정책을 우선 점검할 근거가 있습니다. 단, 이 집계만으로 “해당 도구 차단 = 전체 방어”를 인과적으로 결론낼 수는 없습니다.`
    : `→ 침해 실행 도구가 여러 경로에 분산됨 — 단일 도구 필터보다 권한 분리·출력 격리·후속 호출 제약을 함께 검토하는 편이 타당합니다.`;
}

// ---------- "왜 하필 지도의 이 자리에 뭉쳤나" — 색/라벨이 같다는 사실이 아니라,
// 실제로 거리(=DTW)를 만드는 원재료인 이벤트 시퀀스 자체가 얼마나 겹치는지를
// 보여준다. 이게 UMAP 좌표를 만드는 원인이므로 "위치의 이유"에 대한 직접적인 답이다. ----------
// n-gram(연속 부분열) 목록 — commonMotif가 "완전히 같은 순서"가 아니라
// "그 안에 공통으로 박혀 있는 조각"을 찾을 때 쓴다.
function ngrams(tokens, len) {
  const out = [];
  for (let i = 0; i + len <= tokens.length; i++) out.push(tokens.slice(i, i + len).join(" → "));
  return out;
}

// 전체 순서가 케이스마다 달라도, 그 안에 몇 건에서 공통으로 반복되는 조각(길이
// 4→1 순서로 시도)이 있는지 찾는다. 과반을 덮는 가장 긴 조각을 우선하고, 그런
// 조각이 없으면 그래도 커버리지가 가장 높은 조각을 폴백으로 반환한다 — "다르다"에서
// 끝내지 않고 "그럼 무엇이 겹치는가"까지 실제로 찾아내는 것이 목적이다.
function commonMotif(seqs) {
  const n = seqs.length;
  const maxLen = Math.max(0, ...seqs.map((s) => s.length));
  if (!maxLen) return null;
  let fallback = null;
  for (let gramLen = Math.min(4, maxLen); gramLen >= 1; gramLen--) {
    const coverage = new Map();
    seqs.forEach((seq, idx) => {
      new Set(ngrams(seq, gramLen)).forEach((g) => {
        if (!coverage.has(g)) coverage.set(g, new Set());
        coverage.get(g).add(idx);
      });
    });
    let localBest = null;
    for (const [motif, idxSet] of coverage) {
      if (!localBest || idxSet.size > localBest.coverage) localBest = { motif, coverage: idxSet.size, gramLen };
    }
    if (!localBest) continue;
    if (localBest.coverage / n >= 0.5) return localBest;
    if (!fallback || localBest.coverage > fallback.coverage) fallback = localBest;
  }
  return fallback;
}

// UMAP 좌표(잔차/원본 지도 위 위치)를 실제로 만드는 원재료 — DTW가 비교하는
// 이벤트 토큰 시퀀스. 잔차 공간은 GT와 일치한 이벤트를 뺀 나머지만, 원본 공간은
// user 메시지를 뺀 전체를 쓴다. 한 케이스의 좌표든 여러 케이스의 군집이든
// "왜 여기 있는가"에 대한 답은 항상 이 시퀀스에서 나온다.
function eventSeqOf(c, spaceKey) {
  const evs = spaceKey === "raw"
    ? c.events.filter((e) => e.role !== "user")
    : c.events.filter((e) => !e.matched_to_gt && e.role !== "user");
  return evs.map((e) => e.function || e.role);
}

// ---------- "왜 하필 지도의 이 자리에 뭉쳤나"를 실제로 분석해서 답한다.
// 전체 시퀀스가 케이스마다 다르다고 "그냥 흩어져 있다"고 끝내지 않고, 그 안에
// 공통으로 반복되는 핵심 조각(모티프)을 끝까지 찾아 보여준다. ----------
function positionExplanation(selected, spaceKey) {
  if (!selected.length || selected.length < 2) return "";
  const space = spaceKey || "residual";
  const seqOf = (c) => {
    const evs = space === "raw"
      ? c.events.filter((e) => e.role !== "user")
      : c.events.filter((e) => !e.matched_to_gt && e.role !== "user");
    return evs.map((e) => e.function || e.role);
  };
  const seqs = selected.map(seqOf);
  const n = selected.length;
  const spaceLabel = space === "raw" ? "원본(raw)" : "잔차(residual)";

  let html = `<div class="pattern-block">`;
  html += `<div class="pattern-head">${spaceLabel} 2D 이웃의 공통 행동 후보</div>`;

  // 0) 잔차가 아예 없는(=정답 그대로 수행한) 케이스가 대부분이면 그게 곧 답이다.
  const emptyN = seqs.filter((s) => s.length === 0).length;
  if (emptyN / n >= 0.5) {
    html += `<p class="pattern-verdict">${emptyN}/${n}건이 정답 시퀀스와 완전 일치(잔차 없음) — 잔차 지도상 동일 지점에 위치.</p></div>`;
    return html;
  }

  // 1) 완전히 같은 순서를 공유하는 케이스가 과반이면 그게 곧 핵심 패턴이다.
  const exactCounts = new Map();
  seqs.forEach((seq) => {
    const key = seq.join(" → ");
    exactCounts.set(key, (exactCounts.get(key) || 0) + 1);
  });
  const exactTop = Array.from(exactCounts.entries()).sort((a, b) => b[1] - a[1])[0];

  if (exactTop && exactTop[1] / n >= 0.5) {
    html += `<div class="pattern-row"><code>${exactTop[0]}</code><span class="pattern-n">${exactTop[1]}/${n}건</span></div>`;
    html += `<p class="pattern-verdict">→ 동일 시퀀스가 반복됨 — 이 2D 이웃을 해석할 수 있는 강한 행동 근거.</p>`;
    html += `</div>`;
    return html;
  }

  // 2) 전체 순서는 갈려도, 그 안에 공통으로 박힌 핵심 조합(n-gram)을 찾는다.
  const motif = commonMotif(seqs);
  if (!motif) {
    html += `<p class="pattern-verdict">공통 반복 호출 미발견.</p></div>`;
    return html;
  }
  html += `<div class="pattern-row"><code>${motif.motif}</code><span class="pattern-n">${motif.coverage}/${n}건</span></div>`;
  if (motif.coverage / n >= 0.5) {
    html += `<p class="pattern-verdict">→ 전체 순서는 다르지만 이 조합은 공통 — 투영에서 가까워진 이유를 설명하는 행동 후보.</p>`;
  } else {
    html += `<p class="pattern-verdict">→ 최다 공유 조합도 과반 미달 — 서로 다른 행동이 2D에서 근접했을 수 있으므로 원 trace 확인이 필요.</p>`;
  }
  html += `</div>`;
  return html;
}

// ---------- 방어 전(A) → 후(B) 비교 — 선택된 케이스들의 짝(pair_key)을 A/B
// 양쪽에서 찾아 판정이 어떻게 바뀌었는지 전환표로 센다. 지도 위 화살표 대신,
// 숫자로 "방어가 이 그룹에 실제로 무엇을 했는지"를 말해준다. ----------
function beforeAfterSummary(selected, suite) {
  if (!selected.length || !suite) return "";
  const pairKeys = new Set(selected.map((d) => d.pair_key));
  const rows = [];
  for (const pk of pairKeys) {
    const a = suite.cases.find((c) => c.pair_key === pk && c.condition === "A");
    const b = suite.cases.find((c) => c.pair_key === pk && c.condition === "B");
    if (a && b) rows.push({ a, b });
  }
  if (!rows.length) return "";

  let blocked = 0, stillHijacked = 0, alwaysSafe = 0, sideEffect = 0;
  for (const { a, b } of rows) {
    if (a.security && !b.security) blocked++;
    else if (a.security && b.security) stillHijacked++;
    else if (!a.security && !b.security) alwaysSafe++;
    else sideEffect++;
  }
  const n = rows.length;
  const segments = [
    { value: blocked, color: SECURITY_COLOR.false, label: "방어 성공", dim: false },
    { value: alwaysSafe, color: "#3A4558", label: "원래 안전", dim: true },
    { value: stillHijacked, color: SECURITY_COLOR.true, label: "방어 우회", dim: false },
    { value: sideEffect, color: "#B36BD4", label: "신규 침해(회귀)", dim: false },
  ].filter((s) => s.value > 0);

  let html = `<div class="pattern-block">`;
  html += `<div class="pattern-head">방어 적용 전후 (n=${n})</div>`;
  html += svgStackedBar(segments);
  html += `<div class="stacked-bar-legend">`;
  html += segments.map((s) => `<span class="sbl-item"><span class="sbl-swatch" style="background:${s.color}"></span>${s.label} ${s.value}</span>`).join("");
  html += `</div>`;
  if (stillHijacked > 0) {
    html += `<p class="pattern-verdict">→ ${stillHijacked}건 미해결 — 별도 대응 조치 필요.</p>`;
  } else if (blocked === n) {
    html += `<p class="pattern-verdict">→ 전건 방어 확인.</p>`;
  }
  html += `</div>`;
  return html;
}

// ---------- 산점도 렌더 (raw/residual 어느 쪽인지 spaceKey로 명시적으로 받는다) ----------

function drawScatter(svgSel, cases, { width, height, interactive, suiteName, spaceKey }) {
  const space = spaceKey || "residual";
  svgSel.selectAll("*").remove();
  svgSel.attr("viewBox", `0 0 ${width} ${height}`);

  const margin = { top: 8, right: 10, bottom: interactive ? 34 : 18, left: interactive ? 40 : 26 };
  const iw = width - margin.left - margin.right;
  const ih = height - margin.top - margin.bottom;

  const coords = cases.map((d) => coordsOf(d, space));
  const xExtent = d3.extent(coords, (c) => c[0]);
  const yExtent = d3.extent(coords, (c) => c[1]);
  const pad = (ext) => {
    const span = ext[1] - ext[0] || 1;
    return [ext[0] - span * 0.08, ext[1] + span * 0.08];
  };
  const x = d3.scaleLinear().domain(pad(xExtent)).range([0, iw]);
  const y = d3.scaleLinear().domain(pad(yExtent)).range([ih, 0]);

  const g = svgSel.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  if (interactive) {
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(6).tickSize(4));
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(6).tickSize(4));
    g.append("text").attr("class", "axis-title")
      .attr("x", iw / 2).attr("y", ih + 32).attr("text-anchor", "middle")
      .text("UMAP-1");
    g.append("text").attr("class", "axis-title")
      .attr("transform", `translate(-18,${ih / 2}) rotate(-90)`).attr("text-anchor", "middle")
      .text("UMAP-2");
  }

  // ---- 레이어 순서(뒤→앞): 군집 표시 → 화살표 → 브러시(투명 오버레이) → 점 ----
  // 브러시를 점보다 먼저(=아래) 그려야 점을 클릭할 수 있다. 브러시가 점 위에
  // 그려지면 화면 어디를 클릭해도 브러시 오버레이가 클릭을 가로채서 점의
  // 클릭 이벤트(상세뷰 열기)가 발생하지 않는다.

  let outlierIds = new Set();
  if (state.showHulls) {
    // 군집은 데이터(UMAP) 좌표에서 계산한다 — 화면 크기·줌과 무관하게 항상 같은
    // 군집이 나오고, 이 결과를 사이드 패널의 "시각적 이웃" 목록과 그대로 공유한다.
    const colorField = resolveColorField(space);
    const clusters = computeClusters(cases, space, colorField, state.hullSensitivity, state.hullMinSize);
    const outliers = distanceOutliers(cases, space, 0.90);
    outlierIds = new Set(outliers.map((d) => d.case_id));
    const hullG = g.append("g").attr("class", "hull-layer");
    const scale = categoricalScale(colorField, cases);
    // 고립 후보는 점 아래에 옅은 점선 원을 깐다. 판정 근거는 UMAP 좌표가 아니라
    // 원래 DTW 거리행렬에서의 kNN isolation 상위 10%다.
    hullG.selectAll("circle.outlier-ring")
      .data(outliers)
      .join("circle")
      .attr("class", "outlier-ring")
      .attr("r", 7)
      .attr("cx", (d) => { const c = coordsOf(d, space); return x(c[0]); })
      .attr("cy", (d) => { const c = coordsOf(d, space); return y(c[1]); });
    for (const cl of clusters) {
      const pixelPts = cl.cases.map((d) => { const c = coordsOf(d, space); return [x(c[0]), y(c[1])]; });
      const hull = d3.polygonHull(pixelPts);
      if (!hull) continue;
      hullG.append("path")
        .attr("class", "cluster-hull")
        .attr("d", "M" + hull.map((p) => p.join(",")).join("L") + "Z")
        .attr("fill", scale(cl.key))
        .attr("stroke", scale(cl.key));
    }
    if (interactive) {
      state.lastClusters[space] = clusters;
      state.lastOutliers[space] = outliers;
    }
  } else if (interactive) {
    state.lastClusters[space] = [];
    state.lastOutliers[space] = [];
  }

  if (interactive) {
    const brush = d3.brush()
      .extent([[0, 0], [iw, ih]])
      .on("brush end", (event) => {
        if (!event.selection) {
          state.brushed = new Set();
          refreshBrushHighlight();
          updateBrushSummary([]);
          return;
        }
        const [[x0, y0], [x1, y1]] = event.selection;
        const selected = cases.filter((d) => {
          const c = coordsOf(d, space);
          const px = x(c[0]), py = y(c[1]);
          return px >= x0 && px <= x1 && py >= y0 && py <= y1;
        });
        state.brushed = new Set(selected.map((d) => d.case_id));
        refreshBrushHighlight();
        updateBrushSummary(selected, space);
      });
    g.append("g").attr("class", "brush-layer").call(brush);
  }

  const sizeScale = sizeScaleFor(cases);

  // 점은 도형이 아니라 문자(O/X/●/■)로 그린다 — 항상 같은 뜻인 과제 결과(O/X)가
  // 범례 없이도 바로 읽히게 하려는 것이 목적이다. 색은 별도로 colorBy를 따른다.
  // font-weight로 방어 결과(security)를 색과 중복 인코딩한다 — 색만으로는 흑백
  // 인쇄·그레이스케일에서 구분되지 않으므로(빨강/파랑의 명도가 비슷함), 굵기라는
  // 별도 채널로 같은 정보를 한 번 더 실어 인쇄해도 판정이 읽히게 한다.
  const dots = g.append("g")
    .selectAll("text.dot")
    .data(cases, (d) => d.case_id)
    .join("text")
    .attr("class", "dot")
    .text(glyphFor)
    .attr("font-size", (d) => `${sizeScale(d[state.sizeBy]) * 1.9}px`)
    .attr("font-weight", (d) => (d.security ? 800 : 500))
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "central")
    .attr("transform", (d) => {
      const c = coordsOf(d, space);
      return `translate(${x(c[0])},${y(c[1])})`;
    })
    .attr("fill", (d) => colorFor(d, space, cases))
    .classed("dimmed", (d) => !matchesSearch(d))
    .classed("brushed", (d) => state.brushed.has(d.case_id))
    .classed("compare-selected", (d) => state.compareSelection.includes(d.case_id))
    .classed("selected-detail", (d) => state.detailCase && d.case_id === state.detailCase.case_id);

  if (interactive) {
    dots.on("click", (event, d) => {
      event.stopPropagation();
      if (state.compareMode) toggleCompareSelection(d.case_id);
      else openDetail(d);
    });
    dots.append("title").text((d) => `${d.case_id}\n${SECURITY_LABEL[String(d.security)]} · ${UTILITY_LABEL[String(d.utility)]}\nhijack_tool=${d.hijack_tool ?? "-"} delay=${d.delay ?? "-"}${outlierIds.has(d.case_id) ? "\n(DTW 거리공간 kNN 고립 상위 10% — 검토 후보)" : ""}`);

    panelDotSelections[space] = dots;
  }

  return { x, y, iw, ih };
}

function refreshBrushHighlight() {
  for (const key in panelDotSelections) {
    panelDotSelections[key]?.classed("brushed", (d) => state.brushed.has(d.case_id));
  }
}

function refreshCompareHighlight() {
  for (const key in panelDotSelections) {
    panelDotSelections[key]?.classed("compare-selected", (d) => state.compareSelection.includes(d.case_id));
  }
}

// ---------- 비교 선택 모드 ----------

function toggleCompareSelection(caseId) {
  const idx = state.compareSelection.indexOf(caseId);
  if (idx >= 0) {
    state.compareSelection.splice(idx, 1);
  } else {
    if (state.compareSelection.length >= 5) {
      alert("비교 선택은 최대 5개까지입니다. 먼저 몇 개를 빼주세요.");
      return;
    }
    state.compareSelection.push(caseId);
  }
  refreshCompareHighlight();
  updateComparePanel();
}

function updateComparePanel() {
  const block = document.getElementById("compareBlock");
  const countEl = document.getElementById("compareCount");
  const content = document.getElementById("compareContent");
  if (!state.compareMode && state.compareSelection.length === 0) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  countEl.textContent = `(${state.compareSelection.length}/5)`;

  let html = "";
  if (!state.compareSelection.length) {
    html += `<p class="empty-hint">비교 선택 모드가 켜져 있습니다. 산점도의 점을 클릭해서 최대 5개까지 골라보세요 (같은 suite 안에서만).</p>`;
  } else {
    html += `<div class="compare-chip-row">`;
    for (const id of state.compareSelection) {
      const short = id.split("__").slice(1).join("/");
      html += `<span class="compare-chip">${escapeHtml(short)}<button data-remove-chip="${escapeHtml(id)}">✕</button></span>`;
    }
    html += `</div>`;
    html += `<div class="compare-actions">
      <button class="ghost-btn primary" id="compareRunBtn">비교하기</button>
      <button class="ghost-btn" id="compareClearBtn">지우기</button>
    </div>`;
  }
  content.innerHTML = html;

  content.querySelectorAll("[data-remove-chip]").forEach((btn) => {
    btn.addEventListener("click", () => toggleCompareSelection(btn.dataset.removeChip));
  });
  const runBtn = document.getElementById("compareRunBtn");
  if (runBtn) runBtn.addEventListener("click", () => openCompareView(state.compareSelection));
  const clearBtn = document.getElementById("compareClearBtn");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    state.compareSelection = [];
    refreshCompareHighlight();
    updateComparePanel();
  });
}

// ---------- 브러시 요약 패널 ----------

let lastBrushSelection = [];

function updateBrushSummary(selected, spaceKey) {
  lastBrushSelection = selected;
  const el = document.getElementById("brushContent");
  const countEl = document.getElementById("brushCount");
  if (!selected.length) {
    countEl.textContent = "";
    el.innerHTML = `<p class="empty-hint">선택된 항목 없음. 산점도 드래그 또는 좌측 "시각적 이웃" 목록에서 선택.</p>`;
    return;
  }
  countEl.textContent = `(${selected.length}건)`;

  const n = selected.length;
  const breached = selected.filter((d) => d.security).length;
  const breachRate = Math.round((breached / n) * 100);
  const hijackCounts = d3.rollup(selected.filter((d) => d.hijack_tool), (v) => v.length, (d) => d.hijack_tool);
  const topHijackList = Array.from(hijackCounts.entries()).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  const delays = selected.filter((d) => d.delay != null).map((d) => d.delay);
  const avgDelay = delays.length ? d3.mean(delays).toFixed(1) : "—";
  const avgResidual = d3.mean(selected, (d) => d.residual_length).toFixed(1);
  const residualLens = selected.map((d) => d.residual_length);

  // "어디가 어떻게 문제인지" — 이 그룹에서 반복적으로 나타나는 잔차(정답과 다르게 한) 도구 호출
  const funcCounts = new Map();
  for (const c of selected) {
    for (const ev of c.events) {
      if (ev.role === "tool_call" && !ev.matched_to_gt) {
        funcCounts.set(ev.function, (funcCounts.get(ev.function) || 0) + 1);
      }
    }
  }
  const topFuncsList = Array.from(funcCounts.entries()).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));

  let html = "";

  // ---- 핵심 수치는 작은 도넛 하나 + 숫자 두 개를 한 줄에 — 큰 단독 차트가 아니라
  // 곁다리(auxiliary) 지표로 배치한다. 문장으로 나열하던 숫자를 도형으로 바꾸되
  // (Munzner Ch.7 — 위치/길이 채널이 서술형 텍스트보다 빠르게 읽힌다), 화면을
  // 지배하지 않도록 인라인 크기로 제한한다. ----
  html += `<div class="brush-kpi-row">
    ${svgDonut(breachRate, SECURITY_COLOR.true, SECURITY_COLOR.false)}
    <div class="brush-kpi-nums">
      <div class="brush-kpi-num"><b>${avgResidual}</b><span>평균 잔차</span></div>
      <div class="brush-kpi-num"><b>${avgDelay}</b><span>평균 지연</span></div>
    </div>
  </div>`;

  const takeaway = interpretGroup(selected);
  if (takeaway) html += `<div class="brush-interpretation">${takeaway}</div>`;

  // ---- 보조 차트들을 한 줄에 나란히(사이드 바이 사이드) 배치 — 각각 작게, 여러
  // 개를 동시에 훑어볼 수 있게. 잔차 길이 히스토그램은 평균값만으로는 안 보이는
  // "이 그룹이 한 가지 패턴인지, 여러 패턴이 섞였는지"를 분포 모양으로 보여준다. ----
  const miniCells = [];
  const histSvg = svgHistogram(residualLens, SECURITY_COLOR.true);
  if (histSvg) miniCells.push({ title: "잔차 길이 분포", chart: histSvg });
  if (topHijackList.length) miniCells.push({ title: "주요 탈취 도구", chart: svgHBars(topHijackList, SECURITY_COLOR.true) });
  if (topFuncsList.length) miniCells.push({ title: "반복 잔차 이벤트", chart: svgHBars(topFuncsList, SECURITY_COLOR.false, 6) });
  if (miniCells.length) {
    html += `<div class="mini-chart-grid">` +
      miniCells.map((c) => `<div class="mini-chart-cell"><div class="mini-chart-title">${c.title}</div>${c.chart}</div>`).join("") +
      `</div>`;
  }

  // ---- "왜 지도의 이 자리에 있나" — 색/라벨이 아니라 실제 이벤트 시퀀스 겹침 ----
  html += positionExplanation(selected, spaceKey);

  // ---- 방어 전/후 비교 — 이 그룹이 걸친 시나리오들이 방어로 어떻게 바뀌었는지 ----
  html += beforeAfterSummary(selected, state.suites[state.focusSuite]);

  // ---- 다음 행동: 통계만 보고 끝내지 말고, 실제 트레이스 몇 개를 직접 확인하도록 이어준다 ----
  html += `<button class="ghost-btn primary" id="brushToCompareBtn" style="width:100%;margin-top:10px;">
    대표 ${Math.min(5, n)}건 비교 →
  </button>`;

  el.innerHTML = html;

  const btn = document.getElementById("brushToCompareBtn");
  if (btn) btn.addEventListener("click", () => sendSelectionToCompare(selected));
}

// ---------- 브러시/군집 선택을 그대로 "비교 선택 모드"로 넘긴다 ----------
// 통계는 "무엇이 일어났는지"만 말해준다. 실제 이벤트 순서를 보려면 개별 트레이스를
// 열어야 하므로, 통계 요약에서 바로 비교 뷰로 이어지는 다리를 놓는다.
function sendSelectionToCompare(selected) {
  const ids = selected.slice(0, 5).map((d) => d.case_id);
  state.compareSelection = ids;
  state.compareMode = true;
  const toggle = document.getElementById("compareToggle");
  if (toggle) toggle.checked = true;
  refreshCompareHighlight();
  updateComparePanel();
  openCompareView(ids);
}

// ---------- 범례 / 검증 패널 ----------

function legendRowsHtml(field, cases) {
  const scale = categoricalScale(field, cases);
  const dynamicField = ["hijack_tool", "exposure_channel"].includes(field);
  let values, otherCount = 0;
  if (field === "security") values = ["true", "false"];
  else if (field === "verdict") values = Object.keys(VERDICT_COLOR);
  else if (field === "delay_bucket") values = Object.keys(DELAY_COLOR);
  else if (field === "condition") values = Object.keys(CONDITION_COLOR);
  else if (field === "security_transition") values = Object.keys(TRANSITION_COLOR).filter((v) => v !== "unpaired" || cases.some((c) => c.security_transition === "unpaired"));
  else if (dynamicField) {
    // 색맹 안전 팔레트는 8색까지만 쓴다 — 빈도 상위 8개만 이름을 걸고 나머지는 "기타"로 합친다.
    const counts = d3.rollup(cases.filter((c) => c[field] != null), (v) => v.length, (c) => c[field]);
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    values = sorted.slice(0, OKABE_ITO.length).map(([v]) => v);
    otherCount = sorted.slice(OKABE_ITO.length).reduce((sum, [, n]) => sum + n, 0);
  } else values = Array.from(new Set(cases.map((c) => c[field]).filter((v) => v != null))).sort((a, b) => a - b);

  const labelOf = (v) => SECURITY_LABEL[v] || VERDICT_LABEL[v] || DELAY_LABEL[v] || CONDITION_LABEL[v] || TRANSITION_LABEL[v]
    || (field.startsWith("cluster_") ? `군집 ${v}` : v);

  let html = "";
  for (const v of values) {
    html += `<div class="legend-row"><span class="legend-swatch" style="background:${scale(v)}"></span>${escapeHtml(labelOf(v))}</div>`;
  }
  if (otherCount > 0) {
    html += `<div class="legend-row"><span class="legend-swatch" style="background:${CATEGORICAL_OTHER_COLOR}"></span>${CATEGORICAL_OTHER_LABEL} (${otherCount}건)</div>`;
  }
  return html;
}

function updateLegend() {
  let html = "";

  if (state.colorBy === "cluster" && state.mode === "focus") {
    // focus 뷰는 raw/residual 패널을 항상 같이 보여주므로, 범례도 두 공간을
    // 각각 따로 보여준다 — 두 군집은 서로 다른 계산 결과라 하나로 합칠 수 없다.
    const cases = state.suites[state.focusSuite]?.cases || [];
    html += `<div class="legend-group-title">raw 군집</div>${legendRowsHtml("cluster_raw", cases)}`;
    html += `<div class="legend-group-title">residual 군집</div>${legendRowsHtml("cluster_residual", cases)}`;
  } else if (state.colorBy === "cluster") {
    const field = resolveColorField(state.space);
    html += legendRowsHtml(field, allCases());
    html += `<div class="legend-row" style="color:var(--text-faint);font-size:11px;">군집 번호는 suite·공간(raw/residual)별로 독립적으로 계산됨</div>`;
  } else {
    const cases = state.mode === "focus" ? (state.suites[state.focusSuite]?.cases || []) : allCases();
    html += legendRowsHtml(state.colorBy, cases);
  }

  if (state.shapeBy === "utility") {
    html += `<div class="legend-row" style="margin-top:6px;color:var(--text-faint);font-size:11px;">모양: ○ 과제 성공 &nbsp;X 과제 실패</div>`;
  } else if (state.shapeBy === "condition") {
    html += `<div class="legend-row" style="margin-top:6px;color:var(--text-faint);font-size:11px;">모양: ● 무방어(A) &nbsp;■ 방어(B)</div>`;
  }
  if (state.conditionFilter !== "all") {
    html += `<div class="legend-row" style="color:var(--text-faint);font-size:11px;">조건 필터: ${state.conditionFilter === "A" ? "무방어만" : "방어(tool_filter)만"} 표시 중</div>`;
  }
  if (state.showHulls) {
    html += `<div class="legend-row" style="color:var(--text-faint);font-size:11px;">점선 테두리 = 같은 색상이면서 서로 가까이 모여있는 점 ${state.hullMinSize}개 이상의 윤곽.</div>`;
  }
  document.getElementById("legendContent").innerHTML = html || `<span class="empty-hint">데이터 없음</span>`;
}

// 계층적 군집화(pipeline/cluster.py) 결과가 기존 라벨과 얼마나 일치하는지 — ARI.
// 표 대신 0 기준 발산 막대로: 막대=residual ARI, 회색 눈금=raw ARI.
function updateClusterValidationTable() {
  let html = `<div class="cluster-ari-grid">`;
  for (const s of SUITE_ORDER) {
    const suite = state.suites[s];
    if (!suite) continue;
    const items = LABEL_FIELDS
      .map((row) => {
        const rawM = suite?.cluster_validation?.raw?.[row.key];
        const resM = suite?.cluster_validation?.residual?.[row.key];
        if (rawM == null && resM == null) return null;
        return { label: row.ko, value: resM?.ari ?? 0, marker: rawM?.ari };
      })
      .filter(Boolean);
    if (!items.length) continue;
    html += `<div class="cluster-ari-cell"><div class="mini-chart-title">${escapeHtml(s)}</div>${svgDivergingBars(items)}</div>`;
  }
  html += `</div>`;
  const k = state.suites[SUITE_ORDER.find((s) => state.suites[s])]?.params?.n_clusters ?? "?";
  html += `<p class="empty-hint" style="margin-top:6px;">k=${k} · 막대=residual ARI, 회색 눈금=raw ARI</p>`;
  document.getElementById("clusterValidationContent").innerHTML = html;
}


function fmtPct(v, digits = 1) {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}
function fmtCI(ci) {
  return !ci || ci.length !== 2 ? "" : `95% CI ${fmtPct(ci[0])}–${fmtPct(ci[1])}`;
}
function fmtPP(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} pp`;
}

// Rate + uncertainty shown on one aligned 0–100 axis.  AgentDojo reports confidence
// intervals for its aggregate metrics; this avoids treating small-n percentage gaps as exact.
function svgRateCI(rate, ci, color, width = 164) {
  const h = 30, pad = 8, axisY = 15, x0 = pad, x1 = width - pad;
  const scale = (v) => x0 + Math.max(0, Math.min(1, v ?? 0)) * (x1 - x0);
  const r = rate ?? 0;
  const lo = ci?.[0] ?? r, hi = ci?.[1] ?? r;
  return `<svg width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" class="mini-chart rate-ci" role="img" aria-label="rate ${fmtPct(rate)}, ${fmtCI(ci)}">
    <line x1="${x0}" y1="${axisY}" x2="${x1}" y2="${axisY}" stroke="var(--border)" stroke-width="4" stroke-linecap="round"/>
    <line x1="${scale(lo)}" y1="${axisY}" x2="${scale(hi)}" y2="${axisY}" stroke="${color}" stroke-width="3" stroke-linecap="round" opacity="0.55"/>
    <line x1="${scale(lo)}" y1="${axisY-5}" x2="${scale(lo)}" y2="${axisY+5}" stroke="${color}" stroke-width="1"/>
    <line x1="${scale(hi)}" y1="${axisY-5}" x2="${scale(hi)}" y2="${axisY+5}" stroke="${color}" stroke-width="1"/>
    <circle cx="${scale(r)}" cy="${axisY}" r="4.5" fill="${color}" stroke="#fff" stroke-width="1"/>
    <text x="${x0}" y="28" class="rate-ci-tick">0</text><text x="${x1}" y="28" text-anchor="end" class="rate-ci-tick">100%</text>
  </svg>`;
}

function updateSecurityAnalysis() {
  const block = document.getElementById("securityAnalysisBlock");
  const el = document.getElementById("securityAnalysisContent");
  if (!block || !el) return;
  if (state.mode !== "focus" || !state.focusSuite) {
    block.hidden = true;
    return;
  }
  const analysis = state.suites[state.focusSuite]?.security_analysis;
  if (!analysis) {
    block.hidden = false;
    el.innerHTML = `<p class="empty-hint">보안 집계 데이터가 없습니다. <code>python run_pipeline.py</code>로 산출물을 다시 생성하세요.</p>`;
    return;
  }
  block.hidden = false;
  const pair = analysis.paired_defense;
  const conds = analysis.conditions || {};
  const conditionNames = Object.keys(conds);

  let html = "";
  if (!analysis.metric_scope?.benign_utility_available) {
    html += `<div class="metric-warning">Benign Utility 계산 불가 — 아래 '과제 성공'은 공격 조건 기준 proxy</div>`;
  }

  html += `<div class="metric-grid">`;
  for (const cond of conditionNames) {
    const m = conds[cond];
    const color = CONDITION_COLOR[cond] || "#777";
    html += `<div class="metric-card"><div class="metric-title"><span class="cond-dot" style="background:${color}"></span>${escapeHtml(CONDITION_LABEL[cond] || cond)}</div>`;
    html += `<div class="metric-main"><span>Targeted ASR</span><b>${fmtPct(m.targeted_asr)}</b></div>`;
    html += svgRateCI(m.targeted_asr, m.targeted_asr_ci95, color);
    html += `<div class="metric-ci">${escapeHtml(fmtCI(m.targeted_asr_ci95))}</div>`;
    html += `<div class="metric-sub"><span>안전 완료 proxy</span><b>${fmtPct(m.safe_completion_rate)}</b></div>`;
    html += `<div class="metric-sub"><span>과제 성공</span><b>${fmtPct(m.task_utility_rate)}</b></div></div>`;
  }
  html += `</div>`;

  if (pair) {
    const t = pair.security_transitions || {};
    const segments = [
      { value: t.blocked || 0, color: TRANSITION_COLOR.blocked, label: "차단" },
      { value: t.regressed || 0, color: TRANSITION_COLOR.regressed, label: "회귀" },
      { value: t.still_hijacked || 0, color: TRANSITION_COLOR.still_hijacked, label: "계속 침해" },
      { value: t.still_safe || 0, color: TRANSITION_COLOR.still_safe, label: "계속 안전" },
    ];
    html += `<div class="security-delta"><div class="delta-main"><span>B의 Targeted ASR 변화</span><b>${fmtPP(pair.targeted_asr_change_pp)}</b></div>`;
    html += `<div class="section-mini-title">동일 케이스 A→B 전이 (n=${pair.n_pairs})</div>${svgStackedBar(segments, 226, 14)}`;
    html += `<div class="transition-grid">`;
    for (const key of ["blocked", "regressed", "still_hijacked", "still_safe"]) {
      html += `<div class="transition-cell"><span class="legend-swatch" style="background:${TRANSITION_COLOR[key]}"></span><span>${escapeHtml(TRANSITION_LABEL[key])}</span><b>${t[key] ?? 0}</b></div>`;
    }
    html += `</div>`;
    html += `<div class="security-detail-row"><span>A 침해 중 B가 차단</span><b>${fmtPct(pair.blocked_rate_given_baseline_hijack)}</b></div>`;
    html += `<div class="security-detail-row"><span>A 안전 중 B에서 회귀</span><b>${fmtPct(pair.regression_rate_given_baseline_safe)}</b></div>`;
    html += `<div class="security-detail-row"><span>exact McNemar p</span><b>${pair.mcnemar_exact_pvalue == null ? "—" : pair.mcnemar_exact_pvalue.toFixed(4)}</b></div>`;
    html += `<div class="security-detail-row"><span>과제 성공 변화</span><b>${fmtPP(pair.task_utility_change_pp)}</b></div></div>`;
  }

  const defenseName = pair?.defense_condition || conditionNames[conditionNames.length - 1];
  const chain = conds[defenseName]?.attack_chain;
  if (chain) {
    const f = (v) => v == null ? "—" : Number(v).toFixed(1);
    html += `<div class="chain-block"><div class="section-mini-title">공격 체인 · ${escapeHtml(CONDITION_LABEL[defenseName] || defenseName)}</div>`;
    html += `<div class="security-detail-row"><span>노출→첫 이탈 중앙값</span><b>${f(chain.median_exposure_to_deviation)} event</b></div>`;
    html += `<div class="security-detail-row"><span>첫 이탈→납치 중앙값</span><b>${f(chain.median_deviation_to_hijack)} event</b></div>`;
    html += `<div class="security-detail-row"><span>노출→납치 중앙값</span><b>${f(chain.median_exposure_to_hijack)} event</b></div></div>`;
  }

  const failures = analysis.defense_failure_modes;
  if (failures && failures.compromised_cases > 0) {
    html += `<div class="hotspot-block"><div class="section-mini-title">B 잔존 위험 · hijack tool</div>`;
    for (const item of (failures.top_hijack_tools || []).slice(0, 4)) {
      html += `<div class="hotspot-row"><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><b>${item.count}건</b><small>침해</small></div>`;
    }
    html += `</div>`;
  }

  const hotspotCondition = pair?.defense_condition || conditionNames[conditionNames.length - 1];
  const hotspots = (analysis.exposure_hotspots_by_condition?.[hotspotCondition] || [])
    .filter((x) => x.channel !== "(not exposed)").slice(0, 4);
  if (hotspots.length) {
    html += `<div class="hotspot-block"><div class="section-mini-title">${escapeHtml(CONDITION_LABEL[hotspotCondition] || hotspotCondition)} · 노출 채널별 Targeted ASR 상위</div>`;
    for (const h of hotspots) {
      html += `<div class="hotspot-row"><span title="${escapeHtml(h.channel)}">${escapeHtml(h.channel)}</span><b>${fmtPct(h.targeted_asr)}</b><small>n=${h.n}</small></div>`;
    }
    html += `</div>`;
  }
  el.innerHTML = html;
}

// ---------- overview / focus 렌더 ----------

function renderOverview() {
  panelDotSelections = {};
  const area = document.getElementById("plotArea");
  area.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "overview-grid";
  area.appendChild(grid);

  for (const name of SUITE_ORDER) {
    const suite = state.suites[name];
    const card = document.createElement("div");
    card.className = "suite-card";
    const spaceLabel = state.space === "raw" ? "raw" : "residual";
    const shown = suite ? conditionFilteredCases(suite.cases) : [];
    // overview는 UMAP보다 먼저 보안 결과를 읽게 한다. A/B 전체가 표시될 때는
    // 서로 다른 조건을 합쳐 하나의 비율로 평균내지 않고, AgentDojo의 Targeted ASR을
    // 조건별로 나란히 보여준다.
    let securityLine = "";
    if (suite?.security_analysis) {
      const sa = suite.security_analysis;
      if (state.conditionFilter === "all" && sa.conditions?.A && sa.conditions?.B) {
        const pair = sa.paired_defense;
        const aPct = Math.round((sa.conditions.A.targeted_asr || 0) * 100);
        const bPct = Math.round((sa.conditions.B.targeted_asr || 0) * 100);
        securityLine = `<div class="suite-card-security">
          ${svgBarPair(aPct, bPct, CONDITION_COLOR.A, CONDITION_COLOR.B, "A", "B")}
          ${pair ? `<span class="sc-badge sc-blocked">차단 ${pair.security_transitions.blocked}</span><span class="sc-badge sc-regressed">회귀 ${pair.security_transitions.regressed}</span>` : ""}
        </div>`;
      } else {
        const cond = state.conditionFilter;
        const m = sa.conditions?.[cond];
        if (m) {
          const pct = Math.round((m.targeted_asr || 0) * 100);
          securityLine = `<div class="suite-card-security">${svgDonut(pct, CONDITION_COLOR[cond] || "#777", "var(--bg-hover)", 34, 5)}<span class="sc-donut-label">Targeted ASR<br/><b>${fmtPct(m.targeted_asr)}</b></span></div>`;
        }
      }
    }
    card.innerHTML = `<div class="suite-card-head"><h4>${escapeHtml(name)}</h4><span class="suite-card-meta">${suite ? shown.length + `건 · ${spaceLabel}` : "…"}</span></div>${securityLine}`;
    const svg = d3.select(card).append("svg");
    card.addEventListener("click", () => focusSuite(name));
    grid.appendChild(card);
    if (suite) {
      requestAnimationFrame(() => {
        const rect = card.getBoundingClientRect();
        drawScatter(svg, shown, { width: rect.width - 24, height: rect.height - 34, interactive: false, suiteName: name, spaceKey: state.space });
      });
    }
  }
}

// ---------- 작은 도넛/막대 차트를 인라인 SVG 문자열로 생성 — 텍스트 대신 눈으로
// 바로 읽히는 지표가 필요하다는 요구에 따라, 숫자를 문장으로 서술하지 않고
// 도형으로 인코딩한다(Munzner Ch.7 Express: 위치·길이가 각도보다 정확한 채널). ----------
function svgDonut(pct, colorOn, colorOff, size, strokeW) {
  size = size || 30; strokeW = strokeW || 5;
  const r = (size - strokeW) / 2;
  const c = 2 * Math.PI * r;
  const onLen = Math.max(0, Math.min(100, pct)) / 100 * c;
  const cx = size / 2, cy = size / 2;
  const label = size >= 42
    ? `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" class="mini-chart-label">${Math.round(pct)}%</text>`
    : "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="mini-chart">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colorOff}" stroke-width="${strokeW}" opacity="0.9"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colorOn}" stroke-width="${strokeW}"
      stroke-dasharray="${onLen} ${c - onLen}" stroke-linecap="butt"
      transform="rotate(-90 ${cx} ${cy})"/>
    ${label}
  </svg>`;
}

// 방어 전/후처럼 두 값을 나란히 비교할 때 — 각도(도넛/게이지)보다 길이(막대)가
// 더 정확하게 지각되므로(Munzner 5.5.1, Cleveland & McGill 랭킹) 막대쌍을 쓴다.
function svgBarPair(valA, valB, colorA, colorB, labelA, labelB) {
  const w = 92, h = 56, barW = 20, gap = 14;
  const topPad = 16, bottomPad = 14;
  const usableH = h - topPad - bottomPad;
  // Percentages must share an absolute 0–100 baseline. Normalizing each pair to its
  // local maximum exaggerates small differences and makes panels incomparable.
  const hA = Math.max(valA > 0 ? 2 : 0, (Math.max(0, Math.min(100, valA)) / 100) * usableH);
  const hB = Math.max(valB > 0 ? 2 : 0, (Math.max(0, Math.min(100, valB)) / 100) * usableH);
  const x0 = (w - (barW * 2 + gap)) / 2;
  const xB = x0 + barW + gap;
  const base = h - bottomPad;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="mini-chart">
    <line x1="0" y1="${base}" x2="${w}" y2="${base}" stroke="var(--border)" stroke-width="1"/>
    <rect x="${x0}" y="${base - hA}" width="${barW}" height="${hA}" fill="${colorA}" rx="1"/>
    <text x="${x0 + barW / 2}" y="${base - hA - 5}" text-anchor="middle" class="barpair-val">${valA}%</text>
    <text x="${x0 + barW / 2}" y="${h - 3}" text-anchor="middle" class="barpair-tick">${labelA}</text>
    <rect x="${xB}" y="${base - hB}" width="${barW}" height="${hB}" fill="${colorB}" rx="1"/>
    <text x="${xB + barW / 2}" y="${base - hB - 5}" text-anchor="middle" class="barpair-val">${valB}%</text>
    <text x="${xB + barW / 2}" y="${h - 3}" text-anchor="middle" class="barpair-tick">${labelB}</text>
  </svg>`;
}

// 순위가 있는 항목(주요 탈취 도구, 지연 패턴 등)을 가로 막대로 — 텍스트 나열보다
// 상대적 크기가 즉시 비교된다.
function svgHBars(items, color, maxItems) {
  maxItems = maxItems || 4;
  const rows = items.slice(0, maxItems);
  if (!rows.length) return "";
  const max = Math.max(...rows.map((r) => r.value), 1);
  const rowH = 13, gap = 3, labelW = 56, trackW = 60;
  const h = rows.length * (rowH + gap) - gap;
  const trunc = (s) => (s.length > 11 ? s.slice(0, 10) + "…" : s);
  const bars = rows.map((r, i) => {
    const y = i * (rowH + gap);
    const bw = Math.max(2, (r.value / max) * trackW);
    return `<text x="0" y="${y + rowH / 2}" dominant-baseline="central" class="hbar-label"><title>${escapeHtml(r.label)}</title>${escapeHtml(trunc(String(r.label)))}</text>
      <rect x="${labelW}" y="${y + 1.5}" width="${trackW}" height="${rowH - 3}" fill="var(--bg-hover)"/>
      <rect x="${labelW}" y="${y + 1.5}" width="${bw}" height="${rowH - 3}" fill="${color}"/>
      <text x="${labelW + trackW + 5}" y="${y + rowH / 2}" dominant-baseline="central" class="hbar-val">${r.value}</text>`;
  }).join("");
  return `<svg width="${labelW + trackW + 22}" height="${h}" viewBox="0 0 ${labelW + trackW + 22} ${h}" class="mini-chart hbar-chart">${bars}</svg>`;
}

// 잔차 길이(residual_length) 분포 히스토그램 — 이 그룹이 "하나의 정형화된 행동"인지
// (막대 하나에 몰림) "여러 이질적 행동이 섞인" 것인지(여러 막대에 분산)를 보여준다.
// 평균값 하나로는 안 보이는, 군집의 동질성/이질성을 직접 눈으로 판단하게 하는 차트다.
function svgHistogram(values, color) {
  const vals = values.filter((v) => v != null);
  if (vals.length < 2) return "";
  const max = Math.max(...vals, 1);
  const bins = Math.min(6, max + 1 || 1);
  const binW = max / bins || 1;
  const counts = new Array(bins).fill(0);
  vals.forEach((v) => {
    let idx = Math.floor(v / binW);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  });
  const w = 96, h = 34, gap = 2;
  const slotW = w / bins;
  const barW = Math.max(1, slotW - gap);
  const maxCount = Math.max(...counts, 1);
  const bars = counts.map((c, i) => {
    const bh = (c / maxCount) * (h - 8);
    const x = i * slotW;
    return `<rect x="${x.toFixed(1)}" y="${(h - bh - 2).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}"><title>${(i * binW).toFixed(0)}~${((i + 1) * binW).toFixed(0)}건: ${c}개 케이스</title></rect>`;
  }).join("");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="mini-chart histogram">
    ${bars}<line x1="0" y1="${h - 1.5}" x2="${w}" y2="${h - 1.5}" stroke="var(--border)" stroke-width="1"/>
  </svg>`;
}

// 방어 전/후 전환표를 세그먼트 하나의 가로 막대로 — CCTV/StreetLight 비교와 같은
// part-of-whole 비교는 누적 막대 하나로 비율을 한눈에 보여준다.
function svgStackedBar(segments, w, h) {
  w = w || 150; h = h || 14;
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
  let x = 0;
  const rects = segments.map((seg) => {
    const segW = (seg.value / total) * w;
    const r = `<rect x="${x.toFixed(1)}" y="0" width="${segW.toFixed(1)}" height="${h}" fill="${seg.color}"/>`;
    x += segW;
    return r;
  }).join("");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="mini-chart stacked-bar">${rects}</svg>`;
}

// 0을 기준으로 양/음이 갈리는 값(ARI 등)을 가로 막대로 — 텍스트 표의 +/- 부호보다
// 막대 방향과 길이가 "우연보다 나은지 못한지"를 즉시 보여준다. marker(회색 세로선)는
// 같은 라벨의 다른 조건(raw) 값을 겹쳐 보여줘서 두 값을 한 행에서 바로 비교하게 한다.
function svgDivergingBars(items, w = 168) {
  const rowH = 15, gap = 5, labelW = 42, valW = 34;
  const trackW = w - labelW - valW;
  const cx = labelW + trackW / 2;
  const maxAbs = Math.max(0.05, ...items.map((it) => Math.max(Math.abs(it.value || 0), Math.abs(it.marker ?? 0))));
  const scale = (v) => (v / maxAbs) * (trackW / 2 - 2);
  const h = items.length * (rowH + gap) - gap;
  const rows = items.map((it, i) => {
    const y = i * (rowH + gap);
    const v = it.value ?? 0;
    const bw = scale(v);
    const barColor = v >= 0 ? "var(--success)" : "var(--danger)";
    const rx = bw >= 0 ? cx : cx + bw;
    const width = Math.abs(bw);
    const marker = it.marker != null
      ? `<line x1="${(cx + scale(it.marker)).toFixed(1)}" y1="${y}" x2="${(cx + scale(it.marker)).toFixed(1)}" y2="${y + rowH}" stroke="var(--text-faint)" stroke-width="2"/>`
      : "";
    return `<text x="0" y="${y + rowH / 2}" dominant-baseline="central" class="hbar-label">${escapeHtml(it.label)}</text>
      <rect x="${labelW}" y="${y}" width="${trackW}" height="${rowH}" fill="var(--bg-hover)"/>
      <line x1="${cx}" y1="${y}" x2="${cx}" y2="${y + rowH}" stroke="var(--border)" stroke-width="1"/>
      <rect x="${rx.toFixed(1)}" y="${y + 2}" width="${width.toFixed(1)}" height="${rowH - 4}" fill="${barColor}"/>
      ${marker}
      <text x="${labelW + trackW + 4}" y="${y + rowH / 2}" dominant-baseline="central" class="hbar-val">${v.toFixed(2)}</text>`;
  }).join("");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="mini-chart hbar-chart">${rows}</svg>`;
}

// ---------- KPI 스트립 — focus 뷰 상단에 이 suite의 핵심 지표를 도형으로 고정 표시.
// 세부 패널을 뜯어보기 전에 "지금 상태가 정상인지"를 한눈에 판단하는 용도(SOC
// 대시보드 상단 요약 타일과 동일한 역할). 조건 필터가 "전체"일 때는 무방어→방어
// 침해율 변화까지 막대쌍으로 즉시 보여준다. ----------
function renderKpiStrip(shown, suite) {
  const strip = document.createElement("div");
  strip.className = "kpi-strip";

  const analysis = suite.security_analysis;
  const n = shown.length;
  const avgResidual = n ? (d3.mean(shown, (c) => c.residual_length) ?? 0).toFixed(1) : "—";
  let html = `<div class="kpi-tile kpi-tile-num"><div class="kpi-value">${n}</div><div class="kpi-label">표시 케이스</div></div>`;

  // 방어 A/B를 합쳐 단일 "침해율"로 만들면 서로 다른 실험 조건의 분모를 섞게 된다.
  // AgentDojo 보고 방식에 맞춰 Targeted ASR은 항상 조건별로 읽게 한다.
  if (analysis) {
    if (state.conditionFilter === "all" && analysis.conditions?.A && analysis.conditions?.B) {
      const a = analysis.conditions.A, b = analysis.conditions.B;
      const pair = analysis.paired_defense;
      html += `<div class="kpi-tile kpi-tile-chart">
        <div class="kpi-rate-row"><span>A</span><b>${fmtPct(a.targeted_asr)}</b></div>
        ${svgRateCI(a.targeted_asr, a.targeted_asr_ci95, CONDITION_COLOR.A, 138)}
        <div class="kpi-label">무방어 Targeted ASR</div></div>`;
      html += `<div class="kpi-tile kpi-tile-chart">
        <div class="kpi-rate-row"><span>B</span><b>${fmtPct(b.targeted_asr)}</b></div>
        ${svgRateCI(b.targeted_asr, b.targeted_asr_ci95, CONDITION_COLOR.B, 138)}
        <div class="kpi-label">tool_filter Targeted ASR</div></div>`;
      if (pair) {
        const regressionCases = suite.cases.filter((c) => c.condition === "B" && c.security_transition === "regressed");
        html += `<div class="kpi-tile kpi-tile-num">
          <div class="kpi-value ${pair.targeted_asr_change_pp > 0 ? "kpi-danger" : "kpi-ok"}">${fmtPP(pair.targeted_asr_change_pp)}</div>
          <div class="kpi-label">B의 ASR 변화</div></div>`;
        html += `<div class="kpi-tile kpi-tile-num${regressionCases.length ? " kpi-tile-clickable" : ""}" id="kpiRegressionTile">
          <div class="kpi-value ${regressionCases.length ? "kpi-danger" : "kpi-ok"}">${regressionCases.length}</div>
          <div class="kpi-label">회귀 · A 안전→B 침해</div></div>`;
      }
    } else {
      const cond = state.conditionFilter;
      const m = analysis.conditions?.[cond];
      if (m) {
        html += `<div class="kpi-tile kpi-tile-chart">
          <div class="kpi-rate-row"><span>${escapeHtml(cond)}</span><b>${fmtPct(m.targeted_asr)}</b></div>
          ${svgRateCI(m.targeted_asr, m.targeted_asr_ci95, CONDITION_COLOR[cond] || "#666", 150)}
          <div class="kpi-label">Targeted ASR · ${escapeHtml(fmtCI(m.targeted_asr_ci95))}</div></div>`;
        html += `<div class="kpi-tile kpi-tile-num"><div class="kpi-value">${fmtPct(m.task_utility_rate)}</div><div class="kpi-label">공격 조건 과제 성공</div></div>`;
      }
    }
  }

  html += `<div class="kpi-tile kpi-tile-num"><div class="kpi-value">${avgResidual}</div><div class="kpi-label">평균 잔차 길이</div></div>`;
  strip.innerHTML = html;

  const regressionCases = suite.cases.filter((c) => c.condition === "B" && c.security_transition === "regressed");
  const tile = strip.querySelector("#kpiRegressionTile");
  if (tile && regressionCases.length) {
    tile.title = "클릭하면 A에서는 안전했지만 B에서 새로 침해된 회귀 케이스를 선택합니다";
    tile.addEventListener("click", () => {
      state.brushed = new Set(regressionCases.map((c) => c.case_id));
      refreshBrushHighlight();
      updateBrushSummary(regressionCases, "residual");
    });
  }
  return strip;
}

function focusSuite(name) {
  state.mode = "focus";
  state.focusSuite = name;
  state.brushed = new Set();
  state.compareSelection = [];
  document.getElementById("overviewBtn").classList.remove("active");
  document.querySelectorAll(".suite-tab").forEach((el) => el.classList.toggle("active", el.dataset.suite === name));
  render();
}

function renderFocus() {
  panelDotSelections = {};
  const area = document.getElementById("plotArea");
  area.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "focus-view";
  const suite = state.suites[state.focusSuite];
  const shown = conditionFilteredCases(suite.cases);

  wrap.appendChild(renderKpiStrip(shown, suite));

  const headerRow = document.createElement("div");
  headerRow.className = "focus-header-row";
  const hint = document.createElement("p");
  hint.className = "focus-hint";
  const p = suite.params || {};
  const filterNote = state.conditionFilter === "all" ? "" : ` · 조건 필터: ${state.conditionFilter === "A" ? "무방어만" : "방어(tool_filter)만"} (${shown.length}/${suite.cases.length}건)`;
  hint.title = `임베딩=${p.embedding_backend ?? "?"} · τ=${p.tau != null ? p.tau.toFixed(3) : "?"}${p.tau_auto_calibrated ? " (자동보정)" : ""} · flag_weight=${p.flag_weight ?? "?"} — ${state.compareMode ? "비교 선택 모드: 클릭할 때마다 오른쪽 '비교 선택'에 추가됩니다" : "'비교 선택 모드'를 켜면 여러 케이스를 골라 한 번에 비교할 수 있습니다"}`;
  hint.innerHTML = `${escapeHtml(state.focusSuite)} · n=${suite.cases.length}${filterNote} <span class="caption-sub">드래그=브러시 · 클릭=정렬 뷰</span>`;
  headerRow.appendChild(hint);
  wrap.appendChild(headerRow);

  const dual = document.createElement("div");
  dual.className = "dual-panel";
  wrap.appendChild(dual);

  const panels = {};
  for (const spaceKey of ["residual", "raw"]) {
    const half = document.createElement("div");
    half.className = "panel-half";
    const caption = document.createElement("div");
    caption.className = "panel-caption";
    caption.title = `${SPACE_EXPLANATION_FULL[spaceKey]} ${AXIS_EXPLANATION}`;
    caption.innerHTML = `<b>${spaceKey === "raw" ? "원본 (raw)" : "잔차 (residual)"}</b> <span class="caption-sub">${SPACE_EXPLANATION[spaceKey]}</span>`;
    half.appendChild(caption);
    const svg = d3.select(half).append("svg");
    const exportBtn = document.createElement("button");
    exportBtn.className = "ghost-btn export-btn";
    exportBtn.style.margin = "6px 10px";
    exportBtn.style.alignSelf = "flex-start";
    exportBtn.textContent = "SVG로 내보내기";
    exportBtn.addEventListener("click", () => exportPanelSvg(spaceKey));
    half.appendChild(exportBtn);
    dual.appendChild(half);
    panels[spaceKey] = { half, svg };
  }

  area.appendChild(wrap);

  requestAnimationFrame(() => {
    for (const spaceKey of ["residual", "raw"]) {
      const rect = panels[spaceKey].half.getBoundingClientRect();
      const capH = panels[spaceKey].half.querySelector(".panel-caption").offsetHeight;
      drawScatter(panels[spaceKey].svg, shown, {
        width: rect.width, height: rect.height - capH - 34, interactive: true,
        suiteName: state.focusSuite, spaceKey,
      });
    }
    updateBrushSummary([]);
    updateClusterList();  // drawScatter가 방금 채운 state.lastClusters를 반영 (레이스 방지)
  });
}

function exportPanelSvg(spaceKey) {
  const sel = panelDotSelections[spaceKey];
  if (!sel) return;
  const svgNode = sel.node().closest("svg");
  if (!svgNode) return;
  const clone = svgNode.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", "0"); bg.setAttribute("y", "0");
  bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%");
  bg.setAttribute("fill", "#FFFFFF");
  clone.insertBefore(bg, clone.firstChild);
  clone.querySelectorAll(".axis-title, .axis text").forEach((el) => el.setAttribute("fill", "#333"));
  clone.querySelectorAll(".axis path, .axis line").forEach((el) => el.setAttribute("stroke", "#CCC"));
  const serialized = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([serialized], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dojoscope_${state.focusSuite}_${spaceKey}_${state.colorBy}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}

function render() {
  if (state.mode === "overview") renderOverview();
  else renderFocus();
  updateLegend();
  updateClusterValidationTable();
  updateSecurityAnalysis();
  updateComparePanel();
  updateClusterList();
  updatePriorityList();
}

// ---------- "우선순위 케이스" — 군집을 켜지 않아도, 브러시를 하지 않아도 항상
// 볼 수 있는 트리아지 진입점. 침해된 케이스 중에서도 과제까지 성공한(=사용자가
// 사용자 과제도 성공한 침해(utility=true & security=true)를 먼저 보여준다. 이는 "은밀함"을
// 직접 측정한 값이 아니라 두 목표가 동시에 달성된 co-success 상태이므로 그렇게만 표현한다. ----------
function updatePriorityList() {
  const block = document.getElementById("priorityBlock");
  if (!block) return;
  if (state.mode !== "focus") { block.hidden = true; return; }
  const suite = state.suites[state.focusSuite];
  if (!suite) { block.hidden = true; return; }

  const cases = conditionFilteredCases(suite.cases);
  const danger = cases.filter((c) => c.security);
  danger.sort((a, b) => {
    const coA = a.utility ? 1 : 0, coB = b.utility ? 1 : 0;
    if (coA !== coB) return coB - coA;
    const isoA = a.residual_isolation_percentile ?? 0;
    const isoB = b.residual_isolation_percentile ?? 0;
    if (isoA !== isoB) return isoB - isoA;
    return (b.residual_length || 0) - (a.residual_length || 0);
  });

  block.hidden = false;
  const content = document.getElementById("priorityContent");
  if (!danger.length) {
    content.innerHTML = `<p class="empty-hint">침해 케이스 없음.</p>`;
    return;
  }

  const top = danger.slice(0, 5);
  content.innerHTML = top.map((c) => {
    const coSuccess = c.utility;
    const shortLabel = c.case_id.split("__").slice(1).join("/");
    return `<button class="priority-row" data-case="${escapeHtml(c.case_id)}">
      <span class="priority-badge ${coSuccess ? "stealthy" : ""}">${coSuccess ? "업무 완료 동반 침해" : "업무 실패 동반 침해"}</span>
      <span class="priority-label">${escapeHtml(shortLabel)}</span>
      <span class="priority-tool">${escapeHtml(c.hijack_tool || "—")}</span>
    </button>`;
  }).join("") + (danger.length > 5 ? `<div class="priority-more">그 외 ${danger.length - 5}건</div>` : "");

  content.querySelectorAll(".priority-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = suite.cases.find((x) => x.case_id === btn.dataset.case);
      if (c) openDetail(c);
    });
  });
}

// ---------- "시각적 이웃" 목록 — 지도 위 점선 윤곽이 실제로 몇 개이고, 각각 무슨
// 패턴인지를 클릭 가능한 목록으로 보여준다. SVG 도형을 직접 클릭하게 하면 브러시
// 오버레이가 클릭을 가로채 버리므로, 대신 이 목록에서 고르면 그 군집 전체가
// 브러시로 선택된 것처럼 오른쪽 요약이 즉시 갱신된다. ----------
function updateClusterList() {
  const block = document.getElementById("clusterListBlock");
  if (!block) return;
  if (state.mode !== "focus" || !state.showHulls) { block.hidden = true; return; }
  block.hidden = false;

  const cases = state.mode === "focus" ? conditionFilteredCases(state.suites[state.focusSuite]?.cases || []) : [];
  const labelOf = (v) => SECURITY_LABEL[v] || VERDICT_LABEL[v] || DELAY_LABEL[v] || CONDITION_LABEL[v]
    || (state.colorBy === "cluster" ? `군집 ${v}` : v);

  let html = "";
  for (const spaceKey of ["residual", "raw"]) {
    const scale = categoricalScale(resolveColorField(spaceKey), cases);
    const clusters = state.lastClusters[spaceKey] || [];
    const outliers = state.lastOutliers[spaceKey] || [];
    html += `<div class="cluster-space-label">${spaceKey === "raw" ? "원본(raw)" : "잔차(residual)"} 공간 — ${clusters.length}개 2D 이웃</div>`;
    if (!clusters.length) {
      html += `<p class="empty-hint">표시할 시각적 이웃이 없습니다. 민감도를 올리거나 최소 크기를 낮춰보세요.</p>`;
    } else {
      clusters.forEach((cl, i) => {
        const color = scale(cl.key);
        const sig = clusterSignature(cl.cases);
        html += `<button class="cluster-row" data-space="${spaceKey}" data-idx="${i}" data-kind="cluster">
          <span class="legend-swatch" style="background:${color}"></span>
          <span class="cluster-row-label">${escapeHtml(labelOf(cl.key))}${sig ? " · " + escapeHtml(sig) : ""}</span>
          <span class="cluster-row-n">${cl.cases.length}건</span>
        </button>`;
      });
    }
    if (outliers.length) {
      html += `<button class="cluster-row outlier-row" data-space="${spaceKey}" data-kind="outlier">
        <span class="legend-swatch outlier-swatch"></span>
        <span class="cluster-row-label">DTW 거리공간 고립 상위 10% (검토 후보)</span>
        <span class="cluster-row-n">${outliers.length}건</span>
      </button>`;
    }
  }
  document.getElementById("clusterListContent").innerHTML = html;

  document.querySelectorAll(".cluster-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".cluster-row").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const targetCases = btn.dataset.kind === "outlier"
        ? state.lastOutliers[btn.dataset.space]
        : state.lastClusters[btn.dataset.space][+btn.dataset.idx].cases;
      state.brushed = new Set(targetCases.map((c) => c.case_id));
      refreshBrushHighlight();
      updateBrushSummary(targetCases, btn.dataset.space);
    });
  });
}

// ---------- 케이스 하나에 대한 자연어 진단 요약 ("어디가 어떻게 문제인지") ----------

function caseSummarySentence(c) {
  const secLabel = SECURITY_LABEL[String(c.security)];
  const utilLabel = UTILITY_LABEL[String(c.utility)];
  if (c.residual_length === 0) {
    return `정답 시퀀스와 완전히 동일하게 수행 — <b style="color:${SECURITY_COLOR[String(c.security)]}">${secLabel}</b> · ${utilLabel}.`;
  }
  let s = `정답 대비 잔차 <b>${c.residual_length}개</b> 이벤트(정답과 다르게 수행한 행동).`;
  if (c.security) {
    const hijackIdx = c.hijack_events && c.hijack_events[0];
    const hijackEv = c.events.find((e) => e.index === hijackIdx);
    const delayLabel = DELAY_LABEL[c.delay_bucket] || c.delay_bucket;
    s += ` e${hijackIdx}: <b>${escapeHtml(hijackEv ? hijackEv.function : "?")}</b> 호출로 <b style="color:${SECURITY_COLOR.true}">침해</b> — ${escapeHtml(delayLabel)}(지연=${c.delay ?? "-"}). ${escapeHtml(utilLabel)}.`;
  } else {
    s += ` <b style="color:${SECURITY_COLOR.false}">침해 시도 방어</b> (${utilLabel}).`;
  }
  return s;
}

// ---------- 조건 하나(A 또는 B)의 결과를 뱃지 하나로 ("보안 개발자"가 한눈에 판단할 수 있게) ----------
function conditionBadge(c) {
  if (!c) return "";
  const color = SECURITY_COLOR[String(c.security)];
  const glyph = UTILITY_GLYPH[String(c.utility)];
  return `<span class="cond-badge" style="border-color:${color};color:${color}">${glyph} ${SECURITY_LABEL[String(c.security)]}</span>`;
}

// ---------- A/B를 비교했을 때 "보안 개발자"가 실제로 판단해야 하는 결론 한 문장 ----------
function securityTakeaway(byCondition) {
  const a = byCondition.A, b = byCondition.B;
  if (!a || !b) return "";
  if (a.security && !b.security) {
    return `<b>방어 효과 확인.</b> 무방어 조건에서 <code>${escapeHtml(a.hijack_tool)}</code> 호출로 침해됐으나, tool_filter 적용 후 동일 경로 차단됨.`;
  }
  if (a.security && b.security) {
    return `<b>방어 우회 — 조치 필요.</b> tool_filter 적용 후에도 <code>${escapeHtml(b.hijack_tool)}</code> 호출로 침해 지속.`;
  }
  if (!a.security && b.security) {
    return `<b>방어 회귀.</b> 무방어 조건에서는 안전했으나 tool_filter 적용 후 <code>${escapeHtml(b.hijack_tool)}</code>로 침해 — 드문 사례이므로 원인 확인 필요.`;
  }
  return `방어 적용 여부와 무관하게 침해되지 않음 (참고용).`;
}

// ---------- 단일 클릭 상세 뷰 (GT / A / B, 비교 모드가 아닐 때) ----------

function openDetail(caseObj) {
  state.detailCase = caseObj;
  const suite = state.suites[state.focusSuite];
  const siblings = suite.cases.filter((c) => c.pair_key === caseObj.pair_key);
  const byCondition = Object.fromEntries(siblings.map((c) => [c.condition, c]));
  const arrow = suite.arrows.find((a) => a.pair_key === caseObj.pair_key);

  const drawer = document.getElementById("detailDrawer");
  drawer.classList.add("open");
  document.getElementById("drawerTitle").innerHTML =
    `<b>${escapeHtml(caseObj.pair_key)}</b> &nbsp; ${["A", "B"].filter((k) => byCondition[k]).map((k) =>
      `${k === "A" ? "무방어" : "방어(tool_filter)"} ${conditionBadge(byCondition[k])}`).join(" &nbsp;·&nbsp; ")}`;

  const body = document.getElementById("drawerBody");
  body.innerHTML = "";

  const gt = caseObj.ground_truth;

  // ---- 알고리즘 결과 지표: 이 케이스가 계층적 군집화·DTW 거리공간에서 어디에
  // 놓이는지를 문장이 아니라 색상 칩 + 게이지로 먼저 보여준다. 스캐터에서 보던
  // 군집 색을 그대로 재사용해서, "이 점이 어느 군집이었지?"를 위로 스크롤해서
  // 다시 찾지 않아도 되게 한다. ----
  const clusterScaleRaw = categoricalScale("cluster_raw", suite.cases);
  const clusterScaleRes = categoricalScale("cluster_residual", suite.cases);
  const rawIso = Math.round((caseObj.raw_isolation_percentile || 0) * 100);
  const resIso = Math.round((caseObj.residual_isolation_percentile || 0) * 100);
  const metrics = document.createElement("div");
  metrics.className = "detail-metrics";
  metrics.innerHTML = `
    <div class="dm-card">
      <div class="dm-title">계층적 군집 소속</div>
      <div class="dm-chip-row">
        <span class="dm-chip"><i style="background:${clusterScaleRaw(caseObj.cluster_raw)}"></i>raw #${caseObj.cluster_raw}</span>
        <span class="dm-chip"><i style="background:${clusterScaleRes(caseObj.cluster_residual)}"></i>residual #${caseObj.cluster_residual}</span>
      </div>
    </div>
    <div class="dm-card">
      <div class="dm-title">DTW 거리공간 고립도 (kNN 백분위)</div>
      <div class="dm-gauge-row">
        ${svgDonut(rawIso, rawIso >= 90 ? "var(--warning)" : "var(--brand)", "var(--bg-hover)", 40, 5)}
        <span class="dm-gauge-label">raw<br/><b>${rawIso}%</b></span>
        ${svgDonut(resIso, resIso >= 90 ? "var(--warning)" : "var(--brand)", "var(--bg-hover)", 40, 5)}
        <span class="dm-gauge-label">residual<br/><b>${resIso}%</b></span>
      </div>
    </div>
  `;
  body.appendChild(metrics);

  // ---- 공격 시나리오 요약: "무엇이 왜 위험했고, 방어를 걸었더니 어떻게 됐나"를
  // 그래프를 읽기 전에 먼저 문장으로 말해준다 — 보안 개발자가 판단해야 하는
  // 결론(securityTakeaway)이 이 화면에서 가장 먼저 눈에 들어와야 하기 때문. ----
  const exposureEvent = caseObj.events.find((e) => e.index === caseObj.injection_exposure);
  const exposureSnippet = exposureEvent && exposureEvent.text ? exposureEvent.text : null;
  const scenario = document.createElement("div");
  scenario.className = "attack-scenario";
  scenario.innerHTML = `
    <div class="scenario-row">
      <span class="scenario-k">노출 지점</span>
      <span class="scenario-v">e${caseObj.injection_exposure} · <code>${escapeHtml(caseObj.exposure_channel)}</code> 도구 응답에 인젝션 페이로드 포함${exposureSnippet ? ` — "${escapeHtml(exposureSnippet)}"` : ""}</span>
    </div>
    <div class="scenario-row">
      <span class="scenario-k">정답(GT)</span>
      <span class="scenario-v">기대 호출 ${gt.length}건: <code>${escapeHtml(gt.join(" → "))}</code></span>
    </div>
    <div class="scenario-row takeaway">
      <span class="scenario-k">보안 시사점</span>
      <span class="scenario-v">${securityTakeaway(byCondition)}</span>
    </div>
  `;
  body.appendChild(scenario);

  const title = document.createElement("div");
  title.className = "align-title";
  title.innerHTML = `GT 대비 A/B 이벤트 단위 정렬. <span style="color:${SECURITY_COLOR.true}">굵은 빨강</span> = 침해 실행 지점, <span style="color:var(--brand)">파란 테두리</span> = 잔차(정답과 다른 행동), 점선 = 도구 응답.`;
  body.appendChild(title);

  const rowsWrap = document.createElement("div");
  rowsWrap.className = "align-rows";
  body.appendChild(rowsWrap);
  const boxWidth = 118, gap = 8;
  const layoutBoxes = (n) => Array.from({ length: n }, (_, i) => i * (boxWidth + gap));

  const rowEls = {};
  const addRow = (labelHtml, key) => {
    const row = document.createElement("div");
    row.className = "align-row";
    row.dataset.rowKey = key;
    row.innerHTML = `<div class="align-row-label">${labelHtml}</div><div class="align-row-track" style="height:34px"></div>`;
    rowsWrap.appendChild(row);
    rowEls[key] = row.querySelector(".align-row-track");
  };

  addRow("정답 (GT)", "GT");
  const gtX = layoutBoxes(gt.length);
  gt.forEach((fn, i) => {
    const box = document.createElement("div");
    box.className = "align-box role-tool_call";
    box.style.left = gtX[i] + "px";
    box.style.width = boxWidth + "px";
    box.textContent = fn;
    box.title = `정답이라면 ${i + 1}번째로 호출했어야 하는 도구`;
    rowEls.GT.appendChild(box);
  });
  rowEls.GT.style.minWidth = (gtX[gtX.length - 1] + boxWidth) + "px";

  const renderCaseRow = (key, label, caseData) => {
    addRow(label, key);
    const rowNode = rowEls[key].closest(".align-row");
    const summary = document.createElement("div");
    summary.className = "align-summary";
    summary.innerHTML = caseSummarySentence(caseData);
    rowsWrap.insertBefore(summary, rowNode.nextSibling);

    const track = rowEls[key];
    const xs = layoutBoxes(caseData.events.length);
    track.style.minWidth = (xs[xs.length - 1] + boxWidth) + "px";
    caseData.events.forEach((ev, i) => {
      const box = document.createElement("div");
      const isHijack = caseData.hijack_events.includes(ev.index);
      const isResidual = !ev.matched_to_gt && ev.role !== "user";
      box.className = `align-box role-${ev.role}` + (isHijack ? " hijack" : "") + (isResidual ? " residual-mark" : "");
      box.style.left = xs[i] + "px";
      box.style.width = boxWidth + "px";
      const label2 = ev.function ? ev.function : (ev.role === "user" ? "user msg" : "");
      box.textContent = label2;
      box.title = isHijack
        ? `침해 실행 지점 — 정답에 없는 "${label2}" 호출, 인젝션 페이로드 지시 실행.`
        : isResidual
          ? `잔차(정답과 다른 행동): ${label2}`
          : (ev.text || "정답 일치 행동");
      track.appendChild(box);
    });
  };
  if (byCondition.A) renderCaseRow("A", "무방어" + conditionBadge(byCondition.A), byCondition.A);
  if (byCondition.B) renderCaseRow("B", "방어(tool_filter)" + conditionBadge(byCondition.B), byCondition.B);

  drawAlignmentLinksFixed(rowsWrap, byCondition, arrow);

  for (const key in panelDotSelections) {
    panelDotSelections[key]?.classed("selected-detail", (d) => d.case_id === caseObj.case_id);
  }
}

function drawAlignmentLinksFixed(rowsWrap, byCondition, arrow) {
  const boxWidth = 118, gap = 8;
  const centerX = (i) => 88 + i * (boxWidth + gap) + boxWidth / 2;
  const rows = Array.from(rowsWrap.querySelectorAll(".align-row"));
  const wrapRect = rowsWrap.getBoundingClientRect();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "align-svg-links");
  svg.style.position = "absolute";
  svg.style.left = "0"; svg.style.top = "0";
  svg.style.width = "100%"; svg.style.height = rowsWrap.scrollHeight + "px";
  svg.style.pointerEvents = "none";
  rowsWrap.style.position = "relative";
  rowsWrap.appendChild(svg);

  const rowTop = (row) => row.getBoundingClientRect().top - wrapRect.top;
  const rowByKey = {};
  rows.forEach((r) => { rowByKey[r.dataset.rowKey] = r; });

  const line = (x1, y1, x2, y2, cls) => {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1);
    l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("class", "align-link" + (cls ? " " + cls : ""));
    svg.appendChild(l);
  };

  ["A", "B"].forEach((key) => {
    if (!byCondition[key] || !rowByKey[key] || !rowByKey.GT) return;
    const yGT = rowTop(rowByKey.GT) + 15;
    const yThis = rowTop(rowByKey[key]) + 15;
    byCondition[key].events.forEach((ev, i) => {
      if (ev.matched_to_gt && ev.gt_index != null) line(centerX(ev.gt_index), yGT, centerX(i), yThis, "");
    });
  });

  if (arrow && byCondition.A && byCondition.B && rowByKey.A && rowByKey.B) {
    const yA = rowTop(rowByKey.A) + 30;
    const yB = rowTop(rowByKey.B);
    arrow.a_to_b_alignment.forEach(([ai, bi]) => line(centerX(ai), yA, centerX(bi), yB, "strong"));
  }
}

// ---------- 비교 선택 모드: N개 케이스를 한 번에 비교 ----------

function openCompareView(caseIds) {
  if (!caseIds.length) return;
  const suite = state.suites[state.focusSuite];
  const selectedCases = caseIds.map((id) => suite.cases.find((c) => c.case_id === id)).filter(Boolean);
  if (!selectedCases.length) return;

  const drawer = document.getElementById("detailDrawer");
  drawer.classList.add("open");
  document.getElementById("drawerTitle").innerHTML =
    `<b>${selectedCases.length}개 비교</b> — ` + selectedCases.map((c) => c.case_id.split("__").slice(1).join("/") + conditionBadge(c)).join(" &nbsp;·&nbsp; ");

  const body = document.getElementById("drawerBody");
  body.innerHTML = "";

  // ---- 이 묶음을 골랐을 때 공통적으로 무엇이 나타나는지 먼저 말해준다 ----
  const scenario = document.createElement("div");
  scenario.className = "attack-scenario";
  scenario.innerHTML = `<div class="scenario-row"><span class="scenario-k">공통 특성</span><span class="scenario-v">${interpretGroup(selectedCases)}</span></div>`;
  body.appendChild(scenario);

  const title = document.createElement("div");
  title.className = "align-title";
  title.innerHTML = `근거: GT 기준 이벤트 단위 정렬. <span style="color:var(--brand)">파란 실선</span> = A/B 정식 쌍의 임베딩 기반 DTW 정렬, ` +
    `<span style="color:var(--link-approx)">빨간 점선</span> = 임의 케이스 간 <b>도구명 기준 근사 정렬</b> ` +
    `(임베딩 벡터 미제공 — 이름 일치 시 거리 0으로 처리하는 근사 DTW 대체). ` +
    `<span style="color:${SECURITY_COLOR.true}">굵은 빨강</span> = 침해 실행 지점. 행 우측 ✕로 비교에서 제외.`;
  body.appendChild(title);

  const rowsWrap = document.createElement("div");
  rowsWrap.className = "align-rows";
  body.appendChild(rowsWrap);

  const gt = selectedCases[0].ground_truth; // 같은 suite 안에서는 GT가 전부 동일하다
  const boxWidth = 118, gap = 8;
  const layoutBoxes = (n) => Array.from({ length: n }, (_, i) => i * (boxWidth + gap));
  const centerX = (i) => 88 + i * (boxWidth + gap) + boxWidth / 2;

  const rowEls = {};
  const addRow = (labelHtml, key) => {
    const row = document.createElement("div");
    row.className = "align-row";
    row.dataset.rowKey = key;
    row.innerHTML = `<div class="align-row-label">${labelHtml}</div><div class="align-row-track" style="height:34px"></div>`;
    rowsWrap.appendChild(row);
    rowEls[key] = row.querySelector(".align-row-track");
    return row;
  };

  addRow("정답 (GT)", "GT");
  const gtX = layoutBoxes(gt.length);
  gt.forEach((fn, i) => {
    const box = document.createElement("div");
    box.className = "align-box role-tool_call";
    box.style.left = gtX[i] + "px"; box.style.width = boxWidth + "px";
    box.textContent = fn;
    rowEls.GT.appendChild(box);
  });
  rowEls.GT.style.minWidth = (gtX[gtX.length - 1] + boxWidth) + "px";

  selectedCases.forEach((c) => {
    const shortLabel = `${c.condition === "A" ? "무방어" : "방어"} · ${c.user_task_id.replace("user_task_", "u")}/${c.injection_task_id.replace("injection_task_", "i")}`;
    const labelHtml = `${escapeHtml(shortLabel)}${conditionBadge(c)}<span class="x" data-remove="${escapeHtml(c.case_id)}"> ✕</span>`;
    addRow(labelHtml, c.case_id);

    const rowNode = rowEls[c.case_id].closest(".align-row");
    const summary = document.createElement("div");
    summary.className = "align-summary";
    summary.innerHTML = caseSummarySentence(c);
    rowsWrap.insertBefore(summary, rowNode.nextSibling);

    const track = rowEls[c.case_id];
    const xs = layoutBoxes(c.events.length);
    track.style.minWidth = (xs[xs.length - 1] + boxWidth) + "px";
    c.events.forEach((ev, i) => {
      const box = document.createElement("div");
      const isHijack = c.hijack_events.includes(ev.index);
      const isResidual = !ev.matched_to_gt && ev.role !== "user";
      box.className = `align-box role-${ev.role}` + (isHijack ? " hijack" : "") + (isResidual ? " residual-mark" : "");
      box.style.left = xs[i] + "px"; box.style.width = boxWidth + "px";
      const label2 = ev.function ? ev.function : (ev.role === "user" ? "user msg" : "");
      box.textContent = label2;
      box.title = isHijack
        ? `침해 실행 지점 — 정답에 없는 "${label2}" 호출, 인젝션 페이로드 지시 실행.`
        : isResidual
          ? `잔차(정답과 다른 행동): ${label2}`
          : (ev.text || "정답 일치 행동");
      track.appendChild(box);
    });
  });

  // 연결선: GT<->각 케이스 (정식 정렬), 그리고 선택 순서상 인접한 케이스끼리
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "align-svg-links");
  svg.style.position = "absolute"; svg.style.left = "0"; svg.style.top = "0";
  svg.style.width = "100%"; svg.style.height = rowsWrap.scrollHeight + "px";
  svg.style.pointerEvents = "none";
  rowsWrap.style.position = "relative";
  rowsWrap.appendChild(svg);

  const wrapRect = rowsWrap.getBoundingClientRect();
  const rows = Array.from(rowsWrap.querySelectorAll(".align-row"));
  const rowByKey = {};
  rows.forEach((r) => { rowByKey[r.dataset.rowKey] = r; });
  const rowTop = (row) => row.getBoundingClientRect().top - wrapRect.top;
  const line = (x1, y1, x2, y2, cls) => {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1); l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("class", "align-link" + (cls ? " " + cls : ""));
    svg.appendChild(l);
  };

  const yGT = rowTop(rowByKey.GT) + 15;
  selectedCases.forEach((c) => {
    const yC = rowTop(rowByKey[c.case_id]) + 15;
    c.events.forEach((ev, i) => {
      if (ev.matched_to_gt && ev.gt_index != null) line(centerX(ev.gt_index), yGT, centerX(i), yC, "");
    });
  });

  for (let k = 0; k < selectedCases.length - 1; k++) {
    const a = selectedCases[k], b = selectedCases[k + 1];
    const yA = rowTop(rowByKey[a.case_id]) + 30;
    const yB = rowTop(rowByKey[b.case_id]);
    const realArrow = suite.arrows.find((ar) =>
      (ar.from_case_id === a.case_id && ar.to_case_id === b.case_id) ||
      (ar.from_case_id === b.case_id && ar.to_case_id === a.case_id));
    if (realArrow) {
      const path = realArrow.from_case_id === a.case_id
        ? realArrow.a_to_b_alignment
        : realArrow.a_to_b_alignment.map(([i, j]) => [j, i]);
      path.forEach(([ai, bi]) => line(centerX(ai), yA, centerX(bi), yB, "strong"));
    } else {
      const { path } = nameDTW(a.events, b.events);
      path.forEach(([ai, bi, match]) => { if (match) line(centerX(ai), yA, centerX(bi), yB, "approx"); });
    }
  }

  rowsWrap.querySelectorAll("[data-remove]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCompareSelection(el.dataset.remove);
      if (state.compareSelection.length > 0) openCompareView(state.compareSelection);
      else document.getElementById("detailDrawer").classList.remove("open");
    });
  });

  for (const key in panelDotSelections) {
    panelDotSelections[key]?.classed("selected-detail", (d) => caseIds.includes(d.case_id));
  }
}

// ---------- 컨트롤 바인딩 ----------

function bindControls() {
  document.getElementById("overviewBtn").addEventListener("click", () => {
    state.mode = "overview";
    state.focusSuite = null;
    document.getElementById("overviewBtn").classList.add("active");
    document.querySelectorAll(".suite-tab").forEach((el) => el.classList.remove("active"));
    render();
  });

  document.querySelectorAll("#spaceToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#spaceToggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.space = btn.dataset.value;
      if (state.mode === "overview") render();
    });
  });

  document.getElementById("colorBy").addEventListener("change", (e) => { state.colorBy = e.target.value; render(); });
  document.getElementById("sizeBy").addEventListener("change", (e) => { state.sizeBy = e.target.value; render(); });
  document.getElementById("shapeBy").addEventListener("change", (e) => { state.shapeBy = e.target.value; render(); });
  document.getElementById("searchBox").addEventListener("input", (e) => { state.search = e.target.value.trim(); render(); });

  document.querySelectorAll("#conditionFilter button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#conditionFilter button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.conditionFilter = btn.dataset.value;
      render();
    });
  });

  const hullSensitivityInput = document.getElementById("hullSensitivity");
  const hullMinSizeInput = document.getElementById("hullMinSize");
  document.getElementById("hullToggle").addEventListener("change", (e) => {
    state.showHulls = e.target.checked;
    hullSensitivityInput.disabled = !state.showHulls;
    hullMinSizeInput.disabled = !state.showHulls;
    render();
  });
  hullSensitivityInput.addEventListener("input", (e) => { state.hullSensitivity = +e.target.value; render(); });
  hullMinSizeInput.addEventListener("input", (e) => { state.hullMinSize = +e.target.value; render(); });

  document.getElementById("compareToggle").addEventListener("change", (e) => {
    state.compareMode = e.target.checked;
    if (!state.compareMode) refreshCompareHighlight();
    updateComparePanel();
  });

  document.getElementById("drawerHandle").addEventListener("click", (e) => {
    if (e.target.id === "drawerClose") return;
    document.getElementById("detailDrawer").classList.toggle("open");
  });
  document.getElementById("drawerClose").addEventListener("click", () => {
    document.getElementById("detailDrawer").classList.remove("open");
  });

}

function buildSuiteTabs() {
  const nav = document.getElementById("suiteTabs");
  nav.innerHTML = "";
  for (const name of SUITE_ORDER) {
    const btn = document.createElement("button");
    btn.className = "suite-tab";
    btn.dataset.suite = name;
    const n = state.suites[name]?.cases.length ?? 0;
    btn.innerHTML = `${name} <span class="count">${n}</span>`;
    btn.addEventListener("click", () => focusSuite(name));
    nav.appendChild(btn);
  }
}

window.addEventListener("resize", () => render());

function showLoadFailurePanel(message) {
  setLoading(false);
  const overlay = document.getElementById("loadingOverlay");
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="loading-card">
      <p style="color:var(--danger);font-weight:800;margin-bottom:2px;">데이터 로딩 실패</p>
      <p style="max-width:340px;">${message}</p>
      <p style="font-size:11.5px;color:var(--text-faint);max-width:340px;">
        data/manifest.json이 있는지, 그리고 이 페이지를 <code>python -m http.server</code>
        같은 로컬 서버로 열었는지(파일을 더블클릭해서 연 게 아닌지) 확인해보세요.
      </p>
      <button class="ghost-btn primary" onclick="location.reload()">새로고침해서 다시 시도</button>
    </div>`;
}

(async function main() {
  setLoading(true, "데이터를 불러오는 중…");
  try {
    await loadAll();
  } catch (e) {
    showLoadFailurePanel(e.message || String(e));
    return;
  }
  setLoading(false);
  buildSuiteTabs();
  bindControls();
  render();
})();