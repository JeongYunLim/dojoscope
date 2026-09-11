# DojoScope Security Developer Review

## Review stance

이 리뷰는 DojoScope를 **prompt-injection 연구 결과를 단순히 예쁘게 보여주는 화면이 아니라, 보안 개발자가 방어 효과와 회귀를 판단하고 실패 trace로 드릴다운하는 분석 도구**로 본다.

근거로 사용한 핵심 자료는 다음 두 자료다.

- Debenedetti et al., *AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents* (NeurIPS 2024). AgentDojo는 Benign Utility, Utility Under Attack, Targeted Attack Success Rate(ASR)를 핵심 결과 지표로 정의하고, 방어 비교에서 utility/security trade-off와 confidence interval을 보고한다.
- Tamara Munzner, *Visualization Analysis & Design*. 사용자 task와 data abstraction을 먼저 정하고, 비교가 필요한 정량값에는 정확한 위치/길이 채널을 우선하며, overview/detail 및 coordinated multiple views를 통해 탐색과 세부 확인을 연결하고, 시각화 주장의 수준에 맞는 validation을 요구한다.

## Overall assessment

원본 프로젝트의 강점은 분명하다. raw trace와 GT residual을 분리하고, DTW 기반 행동 거리와 UMAP을 이용해 **성공/실패 결과만으로는 보이지 않는 실행 경로**를 탐색할 수 있다. 특히 raw/residual linked view, GT alignment, brush/compare, 반복 residual tool motif는 forensic-style trace inspection에 적합하다.

다만 보안 개발자의 첫 질문은 “점들이 어디에 뭉치는가?”보다 다음 네 가지다.

1. 방어 전후 Targeted ASR이 실제로 얼마나 바뀌었나?
2. 같은 security case에서 막힌 건과 새로 깨진 regression은 각각 몇 건인가?
3. 방어 후에도 남아 있는 실패는 어떤 tool / exposure path / execution chain에 집중되는가?
4. 이상해 보이는 trace가 UMAP 투영 때문에 그렇게 보이는지, 원래 DTW 행동 거리에서도 고립돼 있는가?

따라서 이번 버전은 **Outcome → Paired defense effect → Failure mode → Distance-space triage → UMAP/DTW drill-down** 순서로 분석 계층을 재정렬했다.

## Changes implemented

### 1. AgentDojo-aligned outcome layer

`pipeline/security_analysis.py`를 추가했다.

- condition별 Targeted ASR
- Wilson 95% confidence interval
- 공격 조건에서의 task utility
- `utility && !security` 기반 safe-completion proxy
- A/B 동일 pair의 `blocked / regressed / still_hijacked / still_safe`
- exact McNemar test
- defense 이후 residual hijack tool / exposure channel hotspot
- injection exposure → first deviation → hijack의 event-distance 요약

중요: 현재 합성 데이터에는 no-attack control이 없다. 따라서 화면은 공격 조건의 task utility를 **Benign Utility라고 부르지 않는다.** 또한 safe-completion은 AgentDojo 공식 Utility Under Attack와 동일하다고 가정하지 않고 schema-level proxy라고 명시한다.

### 2. Mixed-condition “breach rate” 제거

A와 B를 동시에 표시할 때 두 조건을 합친 단일 침해율은 실험 조건을 섞으므로 제거했다. 대신 A/B Targeted ASR을 각각 동일한 0–100% 축에서 표시하고 95% CI를 함께 보여준다.

### 3. Paired defense evaluation

동일 `(user_task, injection_task)` case를 A/B로 직접 매칭한다.

- **blocked**: A compromised → B safe
- **regressed**: A safe → B compromised
- **still_hijacked**: both compromised
- **still_safe**: both safe

평균 ASR이 개선되어도 regression이 생길 수 있으므로 회귀를 별도 first-class signal로 노출했다. McNemar p-value는 효과 크기를 대체하지 않으며 blocked/regressed count와 함께 해석하도록 UI에 설명을 넣었다.

### 4. UMAP “cluster/outlier” 과해석 완화

UMAP 좌표는 탐색용 2D 투영이다. 2D에서 가까운 점을 통계적 군집이나 실제 원거리 구조의 증거처럼 표현하면 위험하다.

- UI의 “군집”을 **시각적 이웃(2D neighborhood)**으로 변경했다.
- hull은 UMAP 탐색 보조 수단으로만 표현한다.
- 별도로 `pipeline/diagnostics.py`에서 **원래 DTW pairwise distance matrix의 k-nearest-neighbor 평균거리**를 계산한다.
- 각 case에 raw/residual isolation percentile을 저장하고 상위 10%를 review candidate로 표시한다.

이 percentile은 anomaly hypothesis test가 아니라 descriptive triage score다.

### 5. Percentage comparison scale corrected

기존 mini A/B bar는 선택된 두 값 중 최대값을 100% 높이로 정규화해 작은 차이도 과장될 수 있었다. percentage 비교는 항상 **고정 0–100 baseline**을 사용하도록 수정했다.

### 6. Epistemic language tightened

빈도 기반 결과에서 “이 도구만 차단하면 전체 방어 가능” 같은 인과 문장을 제거했다. 현재 UI는 다음 수준까지만 주장한다.

- 특정 hijack tool에 실패가 집중된다 → 권한/신뢰경계/allowlist를 우선 검토할 근거
- 여러 경로에 분산된다 → layered control을 검토할 근거

또한 `utility=true && security=true`를 “은밀한 침해”라고 부르지 않고 **업무 완료 동반 침해**로 표현한다. stealth는 별도 관측값 없이 추론할 수 없기 때문이다.

### 7. Security hardening of the visualization itself

DojoScope가 향후 외부 trace를 읽는다는 전제에서 UI 자체의 공격면도 점검했다.

- 동적 text interpolation에 HTML escaping을 확대 적용
- Google Fonts 원격 의존성 제거
- D3 CDN에 SRI / crossorigin / referrerpolicy 추가
- CSP meta 추가
- system monospace fonts 사용

정적 분석 도구가 untrusted trace metadata를 그대로 `innerHTML`에 넣는 것은 DOM XSS 위험이 있으므로, 향후에는 가능한 모든 단순 텍스트 렌더링을 `textContent` 기반으로 옮기는 것이 최종 목표다.

### 8. Publication figure added

`scripts/generate_figures.py`가 `fig_security_outcomes.{pdf,png}`를 추가 생성한다.

- 왼쪽: suite별 A/B Targeted ASR + Wilson 95% CI, 고정 0–100% 축
- 오른쪽: same-case A→B paired transition stacked bars

UMAP figure보다 먼저 배치하기 적합한 “결과 → 원인 탐색” 구조다.

## Validation

- `pytest tests -q`: **39 passed**
- `node --check viz/app.js`: pass
- 네 suite JSON 모두 `security_analysis`, `distance_diagnostics`, `security_transition`, raw/residual isolation score 포함 확인
- synthetic sample로 `fig_security_outcomes.pdf/png` 생성 확인

현재 검증 환경에는 `umap-learn`이 설치되어 있지 않아 전체 UMAP을 처음부터 재계산하지 않았다. 기존 ZIP의 UMAP 좌표/validation은 보존하고, 동일 trace와 동일 LSA/DTW 경로로 security layer와 original-distance kNN diagnostics를 재계산해 JSON에 병합했다. 사용자의 정상 환경에서 `pip install -r requirements.txt` 후 `python run_pipeline.py`를 실행하면 새 필드도 정식 pipeline에서 함께 생성된다.

## Remaining limitations / next priorities

### P0 — real AgentDojo adapter + benign control

실제 AgentDojo run을 연결하고 no-attack control을 함께 수집해야 한다. 그래야 Benign Utility와 AgentDojo 정의에 맞춘 Utility Under Attack를 직접 표시할 수 있다.

### P1 — stratified paired analysis

전체 ASR만 보지 말고 injection task, tool privilege class(read/write), exposure channel, user-task complexity별 paired effect를 분석한다. 소표본에서는 CI와 raw counts를 항상 함께 보여야 한다.

### P1 — trace risk semantics

`hijack_tool`을 단순 이름이 아니라 read / write / transfer / exfiltration 등의 capability class로 태깅하면 보안 개발자가 위험도를 훨씬 빠르게 판단할 수 있다.

### P2 — robustness/stability diagnostics

UMAP seed 또는 embedding backend가 바뀌었을 때 2D neighborhood가 얼마나 안정적인지 측정한다. 시각적 이웃이 seed 하나에만 의존하면 연구 결론으로 사용하지 않는다.

### P2 — usability validation

보안 개발자가 실제로 다음 task를 더 빠르고 정확하게 수행하는지 측정한다.

- regression case 찾기
- defense residual failure mode 찾기
- 특정 failure에서 GT divergence point 찾기
- suspicious novel trace를 원 distance 기준으로 triage하기

시각화의 가치는 “화면이 복잡하고 풍부하다”가 아니라 이 task를 더 효과적으로 수행하는지로 검증해야 한다.
