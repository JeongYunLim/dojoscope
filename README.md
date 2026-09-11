# DojoScope Trace Behavior Atlas

`trace_embedding_plan.pdf`(DOJOSCOPE 방법 설계 노트)가 설계한 파이프라인 —
**이벤트 → 벡터 → DTW 시퀀스 거리 → GT 정렬 잔차 → 계층적 군집화 → UMAP 2D 지도 → 라벨/군집 검증** —
을 구현한 **완전 정적** 프로젝트다. 화면(`viz/`)은 서버 없이 JSON 파일만 읽고,
새 데이터는 터미널 스크립트 한 줄로 추가해서 반영한다. 논문에 바로 실을 수
있는 정적 벡터 그림(`figures/`)도 함께 생성할 수 있다.

> **이번 버전에서 새로 추가된 것.** 거리행렬까지만 계산하고 "라벨 없이 거리만
> 보고 그룹을 나누는" 단계가 비어 있던 걸 채웠다 — `pipeline/cluster.py`가
> numpy만으로 처음부터 구현한 **계층적 군집화(agglomerative, average linkage)**다.
> UMAP은 시각화용 차원 축소일 뿐 군집을 나눠주지 않고, 실루엣 검증은 이미 아는
> 라벨을 검증할 뿐 새 군집을 만들지 않는다는 점에서 이 둘과는 역할이 다르다.
> 자세한 설계 배경과, 표본 크기(suite당 48건)에서 이 결과를 부트스트랩으로
> 검증했을 때 나온 정직한 결론은 §1.6 참고.

> **왜 서버 없이 정적으로 만들었나.** 이전 버전은 Flask 라이브 서버로 브라우저
> 업로드 시 즉시 재계산하는 구조였지만, 환경에 따라 접속 자체가 안 되는
> 문제가 반복됐다(방화벽, 포트, 서버 프로세스 관련 이슈). **파이썬 내장
> `http.server`는 이런 문제가 생길 여지가 구조적으로 없으므로**, "화면 접속의
> 안정성"을 최우선으로 두고 서버를 완전히 걷어냈다. 대신 데이터 추가는
> 브라우저 버튼이 아니라 터미널 명령 한 줄(`add_data.py`)로 처리한다 — 계산
> 자체는 똑같이 일어나지만, 그 계산과 "화면 접속 가능 여부"가 완전히
> 분리되어 있어서 계산이 오래 걸리거나 실패해도 화면 자체는 항상 그대로 뜬다.

## 결론부터

1. **정적 화면**(`viz/`) — `index.html`/`style.css`/`app.js` + `viz/data/*.json`.
   서버 없이 아무 정적 파일 서버로 열면 된다. 보안 모니터링 대시보드 스타일의
   **다크 네이비 + 시안(cyan) 강조색** 테마, 그래프·게이지·막대 위주로 지표를
   보여주고 문장형 설명은 최소화했다.
2. **계층적 군집화**(`pipeline/cluster.py`) — raw/residual 거리행렬 각각에
   독립적으로 agglomerative 군집화를 적용해 라벨 없이 케이스를 그룹으로 나눈다.
   결과는 화면에서 색상 기준 "계층적 군집" 하나로 자동 반영되고(패널이 raw면
   raw 군집, residual이면 residual 군집), `cluster_validation`(ARI/NMI)으로
   기존 라벨(탈취 도구 등)과 얼마나 일치하는지 검증한다.
3. **데이터 추가**(`add_data.py`) — 새 trace JSON 파일 하나를 인자로 주면,
   기존 데이터와 병합하고 파이프라인(임베딩→DTW→GT정렬/잔차→군집화→UMAP→검증)을
   다시 돌려서 `viz/data/`를 갱신한다. 끝나면 브라우저에서 새로고침(F5)만
   하면 된다.
4. **파이프라인**(`pipeline/`) — 이벤트 벡터화, GT 대비 DTW 정렬/잔차 추출,
   suite별 거리 행렬, 계층적 군집화, UMAP 2D 투영, 라벨/군집 검증(실루엣 +
   순열 검정, ARI/NMI)을 계산한다. `add_data.py`와 `run_pipeline.py`(전체
   재계산용) 둘 다 이 파이프라인을 그대로 재사용한다.
5. **정적 그림**(`scripts/generate_figures.py`) — `viz/data/`의 JSON을 읽어
   논문용 벡터 PDF/PNG 3종(잔차 UMAP 그리드, A→B 화살표 지도, raw/residual
   실루엣 비교)을 생성한다.
6. **샘플 데이터**(`scripts/generate_sample_data.py`) — 실 AgentDojo 로그 없이도
   바로 체험할 수 있도록 4 suite × 조건 A(무방어)/B(tool_filter), 192케이스 합성.
7. **단위 테스트**(`tests/`, pytest, 39개) — DTW·GT 정렬·τ 자동 보정·임베더·
   실루엣 고속화의 핵심 성질을 검증한다.

### 빠른 시작

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt

cd viz
python -m http.server 8000
```

브라우저에서 `http://localhost:8000` (또는 `http://127.0.0.1:8000`) 접속.
이 저장소는 `viz/data/`에 샘플 데이터의 계산 결과를 이미 포함해서 배포하므로
받은 그대로 바로 보인다 — 아무것도 미리 계산할 필요 없다.

화면 기본 기호는 항상 같은 뜻으로 고정되어 있어 범례를 몰라도 읽힌다: 모양은
**과제 결과**(O=성공, X=실패), 색은 상단 "색상 기준"에서 **계층적 군집**(기본값
— 패널이 raw면 raw 군집, residual이면 residual 군집으로 자동 전환) 또는
**방어 결과**(파랑=방어 성공, 빨강=뚫림) 중 고를 수 있다. 상단의 "조건 필터"로
무방어/방어(tool_filter)를 각각 켜 보면 같은 지도에서 점 분포가 어떻게 바뀌는지
비교할 수 있다 — "A→B 화살표" 오버레이는 지도를 복잡하게 만든다는 판단하에
지도에서는 빼고(케이스 상세 뷰의 GT/A/B 3줄 정렬에는 그대로 남아 있다), 대신
이 필터로 대체했다. 데이터 추가(`add_data.py`)는 지금 단계에서 화면에 노출할
필요가 없다고 판단해 UI에서는 뺐다 — 사용법은 아래를 참고.

### 새 데이터 추가하기

```bash
python add_data.py 새파일.json
```

`새파일.json`은 `data/sample/traces.json`과 같은 형식(trace 배열)이면 된다.
기존 데이터와 `(suite, user_task_id, injection_task_id, condition)` 기준으로
병합(같은 키는 덮어쓰기, 새 키는 추가)한 뒤 전체를 재계산해서 `viz/data/`에
쓴다. 끝나면 브라우저를 새로고침(F5)하면 된다 — 서버를 껐다 켤 필요가 없다
(애초에 서버가 없다).

```bash
python add_data.py --reset      # 샘플 데이터(192건)로 초기화
python add_data.py --rebuild    # 병합 없이 지금 데이터로 재계산만 다시
```

단위 테스트: `pip install -r requirements-dev.txt && pytest tests/ -v`

---

## 1. 방법론 (Methods)

### 1.1 이벤트 벡터화

이벤트를 `"assistant calls send_money with recipient=..., amount=..."` 형태의
문장으로 직렬화한 뒤 임베딩하고, 여기에 역할(role) 원-핫 3차원, `injected` 여부,
노출 이후 상대 위치, 정답 이탈 여부 총 6차원의 구조 플래그를 이어붙여 **390차원**
벡터를 만든다(PDF 그림 3). 플래그 가중치는 PDF 8장 실험값인 0.5를 기본으로 쓴다.

### 1.2 임베딩 백엔드 — 두 가지를 모두 지원

| 백엔드 | 조건 | 비고 |
|---|---|---|
| `sentence-transformers` (bge-small-en-v1.5, 384차원) | 인터넷 + 모델 캐시 필요 | `pip install -r requirements-embedding.txt` 후 사용 가능. PDF 원문이 지정한 모델 |
| **LSA (TF-IDF + Truncated SVD)** | 항상 사용 가능, 완전 오프라인 | **기본 폴백.** Deerwester et al. (1990)의 잠재 의미 분석. 코퍼스(현재 실행에 포함된 모든 이벤트 문장) 전체에 대해 1회 fit 후 각 이벤트를 transform |

두 백엔드는 `encode(texts) -> (n, 384)` 인터페이스가 동일하므로 하위 파이프라인
(DTW/UMAP/검증)은 코드 변경 없이 그대로 동작한다.

### 1.3 GT 매칭 임계값(τ)의 자동 보정

PDF 원문은 τ=0.35(고정값)를 bge-small 임베딩 기준으로 실험을 통해 정했다.
**임베딩 백엔드를 LSA로 바꾸면 같은 함수를 부른 이벤트조차 GT와의 코사인
거리가 0.4~0.5로 나와 τ=0.35를 그대로 쓰면 사실상 아무것도 매칭되지 않는
현상을 실측으로 확인했다** — 서로 다른 임베딩 방식은 코사인 거리의 절대적인
스케일 자체가 다르므로, 한 임베딩에서 찾은 임계값을 다른 임베딩에 그대로
가져다 쓰는 것은 근거가 없다.

이를 해결하기 위해 `calibrate_tau()`(`pipeline/gt_align.py`)가 suite·임베딩
백엔드마다 τ를 자동으로 보정한다: suite 안에 실제로 등장하는 함수마다 "그
함수를 부른 이벤트"와 "같은 함수의 GT 벡터" 사이 거리(same-class)와, "다른
함수의 GT 벡터"와의 거리(different-class) 분포를 모아 두 그룹 평균의 중간값을
τ로 삼는다(이분 임계값 선택의 표준적인 방법). `--tau` 옵션으로 고정값을 강제할
수도 있다(예: bge-small을 쓸 때 PDF 원문 값을 그대로 재현하려면 `--tau 0.35`).

### 1.4 시퀀스 거리 (DTW) 및 GT 정렬·잔차

코사인 거리 위에서 DTW(Sakoe & Chiba, 1978)로 두 trace를 정렬하고, 경로 길이로
정규화한 값을 거리로 쓴다. trace를 GT와 DTW로 정렬한 뒤, τ 이하로 매칭된
이벤트를 "정답대로 한 행동"으로 간주해 제외하고 남은 이벤트가 잔차다.

### 1.5 차원 축소 및 통계적 검증

거리 행렬(raw/residual)을 **UMAP**(McInnes et al., 2018, `metric="precomputed"`)으로
2D 투영한다. 검증은 실루엣 계수(Rousseeuw, 1987)에 더해 **순열 검정**(200회,
`pipeline/validate.py`)을 수행해 "관측된 실루엣이 우연히 나올 수 있는 수준인가"를
p-value로 답한다 — 라벨을 무작위로 섞은 영귀무분포에서 관측값 이상이 나온
비율로 계산한다(North et al., 2002의 몬테카를로 p-value 편향 보정 포함).

> **p-value 해석 시 주의.** 이 순열 검정의 귀무가설은 "같은 크기의 무작위
> 라벨 배정"이다. 즉 p<0.05는 "실제 라벨이 같은 카디널리티의 무작위 배정보다
> 유의하게 낫다"는 뜻이지, "실루엣 값 자체가 절대적으로 크다"는 뜻이 아니다.
> 두 수치(점수, p-value)를 항상 같이 보고해야 하는 이유다.

### 1.6 계층적 군집화 (Hierarchical Clustering)

거리행렬(raw/residual)까지는 계산했지만, "라벨 없이 거리만 보고 케이스를
그룹으로 나누는" 단계가 파이프라인에 없었다. UMAP은 차원 축소일 뿐 군집 경계를
정해주지 않고, 실루엣 검증은 이미 아는 라벨(`hijack_tool` 등)을 검증할 뿐 새
군집을 만들어주지 않는다 — 이 둘 사이에 빠져 있던 단계를 `pipeline/cluster.py`가
채운다.

**알고리즘.** Agglomerative clustering, average linkage. 거리행렬만 있고 원래
좌표(coordinate)가 없으므로 "군집 중심 = 벡터 평균"이 필요한 KMeans 계열은 쓸
수 없다 — 두 군집 사이의 거리만 정의하면 되는 계층적 군집화가 precomputed
distance matrix 위에서 바로 동작하는 자연스러운 선택이다. numpy만으로 처음부터
구현했으며, 병합 기록(Z)은 scipy linkage와 같은 포맷(`[군집id1, 군집id2, 병합거리,
원소수]`)으로 맞춰 scipy의 덴드로그램 등 표준 도구와도 호환된다. 군집 개수(k,
기본 6)는 `--n-clusters`로 조정 가능하다.

**검증 — ARI/NMI, 순도(purity)를 쓰지 않은 이유.** 처음에는 "군집별 최다 라벨
비율의 평균"(순도)으로 검증했는데, 크기가 1인 군집이 무조건 순도 1.0을 받아
평균을 왜곡하는 문제를 실제로 겪었다(작은 군집 여러 개가 있으면 실제로는
뒤섞인 큰 군집의 낮은 순도를 가려버림). 그래서 최종적으로는 **ARI(Adjusted Rand
Index)**와 **NMI(Normalized Mutual Information)**만 쓴다(`cluster_agreement()`,
scikit-learn 구현 재사용) — 둘 다 "우연히 맞아떨어질 확률"을 보정하므로 군집
크기 분포가 어떻든 공정하게 비교된다. 결과는 `cluster_validation.{raw,residual}`
에 라벨별 `{ari, nmi}`로 담기고, 화면에서는 0을 기준으로 갈라지는 발산 막대
그래프로 표시한다(초록=우연보다 나음, 빨강=우연보다 못함).

> **raw vs residual, 어느 쪽이 더 나은지에 대한 정직한 결론.** 점추정치만
> 보면 4개 suite 중 3개에서 residual 거리행렬의 ARI가 raw보다 높게 나온다 —
> "공통 템플릿을 걷어낸 잔차가 공격 유형을 더 잘 구분한다"는 가설과 일치하는
> 방향이다. 하지만 **부트스트랩(복원추출 300회)으로 그 차이의 95% 구간을
> 구해보면, 4개 suite 전부에서 0을 포함한다** — 가장 차이가 커 보였던 suite도
> 예외가 아니었다. 즉 이 표본 크기(suite당 48건)로는 "residual이 raw보다
> 통계적으로 유의하게 낫다"고 주장할 근거가 없다. 알고리즘(거리 계산, 군집화,
> 검증 지표)은 정상 작동하지만, 이 비교 결론의 실증에는 데이터가 더 필요하다
> — §5 한계에도 같은 내용을 정리해 뒀다.

---

## 2. 재현성 (Reproducibility)

| 항목 | 값 |
|---|---|
| UMAP 시드 | `--seed 42` (기본) |
| SVD(LSA) 시드 | 42 (Embedder 내부 고정) |
| τ 자동 보정의 표본 시드 | 42 (`calibrate_tau` 내부 고정) |
| 순열 검정 시드 | 42, 200회 (`pipeline/validate.py`의 `N_PERMUTATIONS`) |
| 구조 플래그 가중치 | 0.5 (PDF 8장 실험값, `--flag-weight`로 재정의 가능) |
| 샘플 데이터 생성 시드 | 7 (`scripts/generate_sample_data.py`) |
| 계층적 군집화 linkage | average (고정, `pipeline/cluster.py`) |
| 군집 개수 k | 6 (기본, `--n-clusters`로 재정의 가능) |

모든 난수는 위처럼 고정 시드를 쓰므로, 같은 입력 JSON에 대해 같은 결과가
재현된다. 단, `umap-learn`/`scikit-learn`의 **메이저 버전이 다르면** 내부 알고리즘
구현이 바뀌어 완전히 동일한 부동소수 결과가 나오지 않을 수 있다 — 이는 UMAP
라이브러리 자체의 알려진 한계이며, 정확한 재현이 중요하다면 `requirements.txt`에
버전을 상한까지 고정하는 것을 권장한다.

**속도.** `add_data.py`/`run_pipeline.py` 모두 192케이스 기준 계산 시간은
약 10초(순열 검정이 그중 대부분)다. 다만 `umap-learn`은 내부적으로 numba로
JIT 컴파일되므로, **한 프로세스에서 첫 계산**은 그 컴파일 비용(환경에 따라
15초~수십 초)이 추가로 붙는다 — 스크립트를 실행할 때마다(매번 새 파이썬
프로세스이므로) 나타나는 지연이며 버그가 아니다. **이 지연은 계산 스크립트를
실행하는 동안에만 존재하고, 화면 접속(`http.server`)과는 완전히 무관하다** —
화면은 이미 계산이 끝난 `viz/data/`의 JSON만 읽으므로 계산 시간과 무관하게
항상 즉시 뜬다.

---

## 2.5 보안 개발자 분석 계층 (이번 강화 버전)

UMAP/DTW 지도는 **원인 탐색용**으로 두고, 보안 결과 자체는 별도의 outcome layer에서 먼저 읽는다.
AgentDojo의 보고 체계를 따라 조건별 **Targeted ASR**을 분리해서 표시하고 Wilson 95% CI를 함께 제공한다.
동일 `pair_key`의 A/B는 `blocked / regressed / still_hijacked / still_safe`로 직접 비교하며 exact McNemar
검정을 제공한다. 현재 샘플에는 no-attack control이 없으므로 공격 조건의 task utility를 **Benign Utility라고 부르지 않는다.**

또한 UMAP 2D에서 떨어져 보인다는 이유만으로 anomaly라고 판단하지 않는다. `pipeline/diagnostics.py`가
원래 DTW distance matrix에서 k-nearest-neighbor 평균거리를 계산해 raw/residual isolation percentile을 만들고,
UI는 상위 10%를 검토 후보로 표시한다. 이는 descriptive triage score이며 통계적 이상탐지 판정은 아니다.

보안 관점의 설계 판단과 남은 한계는 `SECURITY_DEVELOPER_REVIEW.md`에 정리했다.

## 3. 데이터 포맷

### suite가 무엇인가 (banking / slack / travel / workspace)

지표가 아니라 **AgentDojo 벤치마크의 4개 시뮬레이션 환경**이다. 같은 프롬프트
인젝션 공격이라도 에이전트가 쓸 수 있는 도구 구성이 환경마다 다르므로, 거리·
UMAP 지도·군집화는 항상 같은 suite 안에서만 계산한다(§1.4, §1.6).

| suite | 시뮬레이션하는 상황 | 대표 도구 예시 |
|---|---|---|
| `banking` | 은행 업무 (계좌 조회, 송금) | `read_file`, `send_money`, `get_iban` |
| `slack` | 사내 메신저(Slack) 사용 | `read_channel_messages`, `send_direct_message` |
| `travel` | 여행 예약 | `get_flight_information`, `reserve_hotel` |
| `workspace` | 이메일·캘린더 등 업무용 워크스페이스 | `search_calendar_events`, `send_email` |

### 입력 (trace 하나 = 케이스 하나)

| 필드 | 의미 |
|---|---|
| `suite`, `user_task_id`, `injection_task_id`, `condition` | 케이스 식별자 |
| `events[]` | `{index, role, function, args, text, injected}`. `role` ∈ {`user`, `tool_call`, `tool_resp`} |
| `ground_truth` | 공격이 없었다면 호출했어야 할 도구 이름 순서 |
| `utility`, `security` | AgentDojo의 두 판정 (`security=true`가 "뚫림") |
| `injection_exposure`, `hijack_events`, `first_deviation` | 이미 계산되어 있는 결정론적 필드 |

`data/sample/traces.json`이 이 형식의 예시다(합성 데이터, §5 참고). 실제
AgentDojo 로그를 쓰려면 `pipeline/schema.py`의 `Trace`/`Event` 형식에 맞춰
변환하는 어댑터만 작성하면 된다 (`trace_from_dict`가 파싱 진입점).

### 출력 (`viz/data/<suite>.json`, `viz/data/manifest.json`)

케이스별 `coords_raw`/`coords_residual`, `verdict`/`hijack_tool`/`delay_bucket`/
`exposure_channel`, `events[].matched_to_gt`/`gt_index`(3단 정렬 뷰용),
`arrows[]`(A→B 이동 + `a_to_b_alignment`), `validation`(라벨별 실루엣 + p-value)을
담는다. `viz/app.js`가 이 파일들을 fetch로 읽어 그리기만 한다.

---

## 4. 시각화 기능 → 요구사항 대응표

| 화면 기능 | 근거 |
|---|---|
| **완전 정적 서빙** — 서버 없이 어떤 정적 파일 서버로 열어도 동작 | 접속 안정성 최우선 |
| **`add_data.py` 한 줄로 새 데이터 반영** | 실시간 데이터 갱신 요구사항(서버 없이) |
| 다크 네이비 + 시안(cyan) 강조색 — 보안 모니터링 대시보드 스타일 | 보안 개발자가 익숙한 SOC/NOC 대시보드 관례 |
| 계층적 군집 결과를 표/문장 대신 색상 칩·발산 막대·게이지로 표시 | "그래프·시각적 지표 위주로" (§1.6) |
| suite별 2×2 개요 → 클릭 시 단일 suite 확대(brush 가능) | PDF 그림 9 |
| **focus 뷰에서 raw · residual을 항상 나란히 2패널로 동시 표시**, 각 패널 캡션에 그 공간이 무슨 뜻인지 설명 | "잔차와 raw를 각각 보여줘야" + "잔차가 무슨 의미인지" |
| 축 제목(UMAP-1/2) + "이 좌표엔 절대값이 없다"는 설명 문구 상시 표시 | "축에 뭐가 있는지" |
| 두 패널이 브러시·비교선택 하이라이트를 공유(linked highlighting) | 같은 케이스를 raw/residual 양쪽에서 동시에 추적 |
| **군집 표시(볼록 껍질 윤곽)** — 같은 색상 값 점 3개 이상을 감싸는 점선 윤곽 | "군집을 이루면 군집 표시" |
| **비교 선택 모드** — 점을 여러 개 골라(최대 5개) 한 번에 비교, GT 기준 정렬 + 각 행마다 자연어 진단 요약 | "이벤트를 각각 선택해서 비교" + "어디가 어떻게 문제인지" |
| 정식 A/B 쌍은 임베딩 기반 DTW, 그 외 임의 쌍은 **이름 기준 근사 DTW**(브라우저에서 즉석 계산)로 연결선 표시, 두 방식을 화면에 명시적으로 구분 | "dtw 한 거를 눈으로 차트처럼" + 투명한 정보 전달 |
| 색상: 계층적 군집(기본, raw/residual 패널별 자동 전환) / 방어 결과 | 다중 시각 인코딩, §1.6 |
| 크기: 잔차 길이 / 전체 이벤트 수, 모양: 조건 A(●)/B(■) | 다중 시각 인코딩 |
| 브러시 → 공통 특징 요약 + **반복되는 잔차 이벤트(도구별 카운트) 목록** | "요약만이 아니라 어디가 어떻게 문제인지" |
| **A→B 화살표: 기본은 "신규 뚫림/신규 차단"만 표시**, "변화없음도 표시" 체크박스로 나머지는 옅게 추가, 점에 마우스를 올리면 그 점과 관련된 화살표만 강조(나머지는 흐려짐) | "화살표 선이 너무 많아서 안 보임" 개선 |
| 점 클릭 → GT 대비 정렬 뷰 + DTW 연결선 + 진단 요약 문장 | PDF 그림 5 |
| 우측 "군집 검증" 패널 — 라벨별 raw→residual ARI를 발산 막대 그래프로 표시 | PDF 8장 검증표 + §1.6 통계적 근거 |
| **SVG로 내보내기 버튼**(패널별로 각각) | 대시보드에서 바로 논문/슬라이드용 벡터 그림 추출 |

### 4.1 A→B 화살표가 너무 빽빽했던 문제, 어떻게 풀었나

기존에는 suite 안의 모든 케이스 쌍(banking 기준 24쌍)의 화살표를 전부 그려서 선이
겹쳐 알아보기 어려웠다. 세 가지를 같이 적용해서 정리했다:

1. **기본값을 "의미 있는 변화만"으로 바꿈.** `newly_hijacked`(방어를 넣었는데도
   새로 뚫림) / `newly_blocked`(방어가 실제로 막음) 두 종류만 기본으로 그리고,
   "변화없음"(A와 B가 사실상 같은 위치)은 체크박스를 켜야만 옅은 회색으로 추가된다
   — 대부분의 화살표는 변화없음 쪽이라 기본만으로도 잡음이 크게 줄어든다.
2. **호버 강조.** 점 위에 마우스를 올리면 그 점과 연결된 화살표만 진하게 남고
   나머지는 흐려진다 — 특정 케이스의 이동만 추적하고 싶을 때 유용하다.
3. **raw/residual 두 패널이 항상 같이 보이므로**, 화살표가 어느 공간에서 더
   깔끔하게 갈리는지(보통 residual 쪽이 더 정리되어 보인다) 바로 비교할 수 있다.

## 5. 한계 및 타당성 위협 (Limitations & Threats to Validity)

- **색상 접근성 트레이드오프.** 방어 결과(빨강=침해/파랑=방어)는 적록색맹
  (deuteranopia) 사용자에게도 구분되도록 빨강·파랑 한 쌍만 쓰지만, 군집
  색상(Okabe & Ito 2008 팔레트, 8색까지)은 다크 테마 위에서도 서로 구분되게
  골랐을 뿐 색각 이상 전수 검증까지 마친 건 아니다 — 색상만으로 판단하지
  않도록 모양(과제 성공/실패)과 툴팁(정확한 군집 번호)을 항상 함께 제공한다.
  (`viz/app.js`/`style.css`/`scripts/generate_figures.py` 세 곳의 색상
  상수만 바꾸면 팔레트를 조정할 수 있다).
- **데이터 추가가 "즉시"는 아니다.** 브라우저에서 클릭 한 번이 아니라
  터미널 명령 실행(수 초~수십 초) 후 새로고침이 필요하다. 접속 안정성과
  맞바꾼 트레이드오프다 — 완전한 실시간 반영이 꼭 필요하면 §6의 "다음
  확장 지점" 참고.
- **합성 데이터.** `data/sample/traces.json`은 실제 AgentDojo 로그가 아니라
  PDF 그림 1의 banking 예시를 뼈대로 만든 합성 데이터다. 이 README와 함께
  보고하는 모든 수치(실루엣, p-value, τ)는 **파이프라인이 올바르게 동작함을
  보이는 것이지, 실제 AgentDojo 결과에 대한 주장이 아니다.**
- **임베딩 품질.** 기본 LSA 백엔드는 순수 통계적 방법이라, 의미는 비슷하지만
  표현이 다른 두 호출(동의어, 재구성된 문장 등)을 transformer 임베딩만큼
  잘 묶지 못한다. §1.2에서 논의했듯 bge-small을 쓰면 이 한계가 완화되지만,
  본 저장소가 기본으로 만든 결과물은 LSA 경로로 생성됐다.
- **표본 크기.** suite당 48케이스(조건 A/B 합산)로, 순열 검정이 유의성을
  보여주더라도 효과 크기(실루엣 절대값)는 작다(0.05~0.25 수준).
- **군집화의 raw-vs-residual 비교는 통계적으로 미결정.** §1.6에서 다뤘듯
  residual이 raw보다 ARI가 높은 방향성은 4개 중 3개 suite에서 관찰되지만,
  부트스트랩 95% 구간은 4개 suite 전부에서 0을 포함한다 — 이 표본 크기로는
  "residual이 유의하게 낫다"고 결론 내릴 검정력이 부족하다는 뜻이다. 알고리즘
  구현 자체의 결함이 아니라 데이터 부족의 문제이며, suite당 케이스 수를 늘리는
  것이 다음으로 필요한 작업이다.
- **suite 간 비교 불가.** 거리는 의도적으로 같은 suite 안에서만 계산한다
  (도구 이름 체계가 달라 비교 자체가 무의미하기 때문). 설계 의도이지 결함이 아니다.
- **UMAP의 확률적 성질.** 시드를 고정해도 라이브러리 버전에 따라 좌표가
  미세하게 달라질 수 있다(§2 참고).
- **임의 케이스 쌍 비교 미지원.** 3단 정렬 뷰는 같은 (user_task, injection_task)
  쌍의 A/B만 지원한다.

---

## 6. 다음 확장 지점

1. **bge-small 실제 적용.** `pip install -r requirements-embedding.txt` 후
   재실행하고, §1.2의 LSA 결과와 비교하는 ablation을 추가하면 좋다.
2. **실 AgentDojo 로그 연결.** 어댑터 작성 후 §5의 "합성 데이터" 한계가 해소된다.
3. **잔차를 도구 호출만으로 좁히는 실험.** `--residual-mode tool_calls` 옵션이
   이미 구현되어 있다(PDF 8장 "다음 조정" 1번).
4. **최댓값 풀링 등 순서를 포기하는 대안.** PDF 8장 "다음 조정" 2번, 아직 미구현.
5. **표본을 늘려 raw-vs-residual 군집화 비교를 재검증.** §1.6/§5에서 확인했듯
   지금 표본(suite당 48건)으로는 부트스트랩 95% 구간이 0을 포함해 결론을 내릴
   검정력이 부족하다 — 실 AgentDojo 로그(위 2번)로 케이스 수를 늘린 뒤 같은
   부트스트랩 절차를 다시 돌려보는 게 다음으로 가장 가치 있는 실험이다.
6. **다른 linkage/거리 조합 비교.** 지금은 average linkage 하나만 구현했다 —
   complete/single linkage나 k를 다르게 자른 결과를 ARI로 비교하는 스윕을
   추가하면 어떤 설정이 이 데이터에 가장 잘 맞는지 답할 수 있다.
7. **브라우저 완전 실시간 반영이 꼭 필요해지면**: (a) 파일 감시(watchdog) +
   자동 새로고침 정도로 절충하거나, (b) 서버를 다시 두되 "화면 보기"와
   "업로드 처리"를 완전히 분리된 두 프로세스로 두어(정적 서버는 절대 안
   죽고, 업로드 전용 서버만 재시작 가능하게) 이번에 겪은 접속 문제를
   구조적으로 차단하는 방식을 권장한다. 지금 코드는 이 방향으로 확장하기
   쉽게 `pipeline/orchestrate.compute_all_suites()` 한 함수에 계산 로직이
   전부 모여 있다.

---

## 7. 프로젝트 구조

```
dojoscope-trace-viz/
├── pipeline/
│   ├── schema.py          # Trace/Event 데이터 구조
│   ├── vectorize.py        # 이벤트 → 390차원 벡터 (sentence-transformers ↔ LSA)
│   ├── dtw.py              # DTW 거리 + 정렬 경로
│   ├── gt_align.py         # GT 정렬, 잔차 추출, τ 자동 보정(calibrate_tau)
│   ├── distances.py        # suite별 pairwise 거리 행렬 (raw / residual)
│   ├── reduce.py           # UMAP 2D 투영
│   ├── validate.py         # 실루엣 + 순열 검정
│   ├── cluster.py          # ★ 계층적 군집화(agglomerative, average linkage) + ARI/NMI 검증
│   ├── security_analysis.py # ASR/CI, paired 방어효과, failure mode
│   ├── diagnostics.py      # 원 DTW 거리공간 kNN isolation
│   ├── build_output.py     # 최종 suite별 JSON 조립 (+ A→B 화살표, A↔B 정렬 경로)
│   └── orchestrate.py      # add_data.py / run_pipeline.py가 공유하는 계산 함수
├── add_data.py                # ★ 새 데이터 추가 (병합 + 재계산 + viz/data 갱신)
├── run_pipeline.py             # 데이터셋 전체를 처음부터 재계산 (설정 바꿔 재실험할 때)
├── scripts/
│   ├── generate_sample_data.py
│   └── generate_figures.py  # 논문용 정적 벡터 그림(PDF/PNG) 생성
├── tests/                    # pytest 단위 테스트 39개
├── data/
│   ├── sample/traces.json    # 합성 샘플 데이터 원본 (--reset의 기준)
│   └── traces.json            # add_data.py가 실제로 읽고 쓰는 "현재 데이터"
├── viz/                       # index.html / style.css / app.js + data/*.json — 정적 프론트엔드 전체
├── figures/                    # generate_figures.py 산출물 (그림 3종 × pdf/png)
├── requirements.txt              # 핵심 의존성 (matplotlib 포함, LSA 폴백으로 전체 동작. 서버 불필요)
├── requirements-embedding.txt    # 진짜 임베딩 모델 사용 시 추가 설치
└── requirements-dev.txt          # 단위 테스트용
```

## 참고문헌 (인용 근거)

- Deerwester, S. et al. (1990). *Indexing by Latent Semantic Analysis.* JASIS.
- Sakoe, H. & Chiba, S. (1978). *Dynamic programming algorithm optimization for
  spoken word recognition.* IEEE TASSP.
- Rousseeuw, P. J. (1987). *Silhouettes: A graphical aid to the interpretation
  and validation of cluster analysis.* J. Comp. Appl. Math.
- McInnes, L., Healy, J., & Melville, J. (2018). *UMAP: Uniform Manifold
  Approximation and Projection.* arXiv:1802.03426.
- Okabe, M. & Ito, K. (2008). *Color Universal Design (CUD).* — 색맹 안전 팔레트.
- North, B. V., Curtis, D., & Sham, P. C. (2002). *A note on the calculation of
  empirical P values from Monte Carlo procedures.* Am. J. Hum. Genet.
- Sokal, R. R. & Michener, C. D. (1958). *A statistical method for evaluating
  systematic relationships.* Univ. Kansas Sci. Bull. — average linkage(UPGMA)의 근거.
- Hubert, L. & Arabie, P. (1985). *Comparing partitions.* J. Classification. —
  Adjusted Rand Index(ARI).
- Vinh, N. X., Epps, J., & Bailey, J. (2010). *Information theoretic measures
  for clusterings comparison.* JMLR. — Normalized Mutual Information(NMI).
