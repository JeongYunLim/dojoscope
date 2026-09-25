"""
DojoScope 서버 — 업로드된 AgentDojo trace 데이터를 파이프라인(임베딩→DTW→GT정렬
→UMAP→군집→통계검증)으로 계산하고, 정적 프론트엔드(frontend/)와 계산 결과
JSON을 함께 서빙하는 FastAPI 앱.

실행:
    uvicorn app:app --host 0.0.0.0 --port 8000

외부에서 링크로 접속하려면 --host 0.0.0.0 로 띄운 뒤, 서버의 공인 IP/도메인
또는 SSH 리버스 터널·리버스 프록시(nginx)·클라우드 인스턴스 등으로 8000번
포트를 외부에 노출하면 된다.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

# Windows 콘솔의 기본 코드페이지(cp949 등)는 이모지·em-dash 같은 일부 유니코드
# 문자를 인코딩하지 못해 print()가 그대로 서버를 죽인다 — 표준출력을 UTF-8로
# 강제해 어떤 로그 메시지를 찍어도 죽지 않게 한다.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - reconfigure가 없는 아주 오래된 환경이면 그냥 무시
    pass

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from pipeline.dtw import dtw_distance
from pipeline.gt_align import DEFAULT_TAU, align_to_ground_truth, build_argument_majority_reference, compute_arg_mismatch
from pipeline.vectorize import serialize_event, vectorize_ground_truth, vectorize_trace
from store import store

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"

app = FastAPI(title="DojoScope API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    store.startup()


# ---------------------------------------------------------------- manifest
@app.get("/api/manifest")
def get_manifest():
    return store.get_manifest()


# UMAP/군집 결과가 "환경마다 다르게 나온다"는 문제를 반복해서 겪은 뒤 만든
# 진단 엔드포인트 — requirements.txt에 고정해둔 버전(EXPECTED_VERSIONS, 이
# 프로젝트가 실제로 검증한 유일한 조합)과 지금 이 프로세스에 실제로 깔려서
# 도는 버전을 나란히 보여줘서, "서버가 공식 파이프라인을 쓰고 있는지"를
# 추측하지 않고 바로 확인할 수 있게 한다.
EXPECTED_VERSIONS = {
    "python": "3.14",
    "numpy": "2.4.4",
    "scipy": "1.18.1",
    "scikit-learn": "1.9.0",
    "umap-learn": "0.5.12",
}


@app.get("/api/pipeline-version")
def pipeline_version():
    import numpy
    import scipy
    import sklearn
    import umap

    actual = {
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
        "numpy": numpy.__version__,
        "scipy": scipy.__version__,
        "scikit-learn": sklearn.__version__,
        "umap-learn": umap.__version__,
    }
    mismatches = {k: {"expected": v, "actual": actual[k]} for k, v in EXPECTED_VERSIONS.items() if v != actual[k]}
    return {
        "expected": EXPECTED_VERSIONS,
        "actual": actual,
        "matches_canonical_pipeline": not mismatches,
        "mismatches": mismatches,
    }


@app.get("/api/suite/{name}")
def get_suite(name: str):
    data = store.get_suite(name)
    if data is None:
        raise HTTPException(404, f"suite '{name}' 없음. /api/manifest에서 사용 가능한 suite 확인")
    return JSONResponse(data)


# ---------------------------------------------------------------- data 관리
@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"JSON 파싱 실패: {e}") from e

    new_cases = payload.get("cases") if isinstance(payload, dict) else payload
    if not isinstance(new_cases, list) or not new_cases:
        raise HTTPException(400, "파일 내용이 trace 배열(JSON list, 최소 1건)이 아닙니다.")

    try:
        result = store.merge_and_recompute(new_cases)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"trace 형식 오류 또는 계산 실패: {e}") from e
    return result


@app.post("/api/reset")
def reset():
    return store.reset_to_sample()


# ---------------------------------------------------------------- 직접 비교
class CompareRequest(BaseModel):
    case_id_a: str
    case_id_b: str


def _summarize(trace) -> dict:
    return {
        "case_id": trace.case_id,
        "suite": trace.suite,
        "condition": trace.condition,
        "user_task_id": trace.user_task_id,
        "injection_task_id": trace.injection_task_id,
        "verdict": trace.verdict,
        "utility": trace.utility,
        "security": trace.security,
        "hijack_tool": trace.hijack_tool,
        "exposure_channel": trace.exposure_channel,
        "delay_bucket": trace.delay_bucket,
        "n_events": len(trace.events),
        "ground_truth": trace.ground_truth,
    }


def _events_payload(trace, arg_mismatch: list[bool] | None = None) -> list[dict]:
    return [
        {
            "index": ev.index,
            "role": ev.role,
            "function": ev.function,
            "args": ev.args,
            "text": ev.text,
            "injected": ev.injected,
            "sentence": serialize_event(ev),
            "arg_mismatch": bool(arg_mismatch[i]) if arg_mismatch else False,
        }
        for i, ev in enumerate(trace.events)
    ]


@app.post("/api/compare")
def compare(req: CompareRequest):
    """임의의 두 케이스(같은 suite가 아니어도 됨)를 즉석에서 DTW로 직접 비교한다.

    - A↔B 직접 정렬(dtw_distance)과 거리값
    - 각 trace를 자신이 속한 suite의 GT와 정렬한 결과(3자 정렬 뷰: GT/A/B)
    """
    trace_a = store.get_trace(req.case_id_a)
    trace_b = store.get_trace(req.case_id_b)
    if trace_a is None:
        raise HTTPException(404, f"case_id_a '{req.case_id_a}' 없음")
    if trace_b is None:
        raise HTTPException(404, f"case_id_b '{req.case_id_b}' 없음")

    embedder = store.get_embedder()
    if embedder is None:
        raise HTTPException(503, "임베더가 아직 준비되지 않았습니다.")

    va = vectorize_trace(trace_a, embedder)
    vb = vectorize_trace(trace_b, embedder)
    ab = dtw_distance(va.vectors, vb.vectors)
    # 정렬 경로를 따라간 로컬 코사인 거리 — dtw.py의 cost_matrix는 원래
    # "디버깅/시각화용"이라고 적혀 있었는데 지금까지 어느 화면에도 노출된
    # 적이 없었다. 스크러버가 "몇 번째로 짝지어졌다"만 보여주고 "그 짝이
    # 실제로 얼마나 가까운/먼 짝인지"는 안 보여주고 있었던 것.
    local_cost = [float(ab.cost_matrix[i, j]) for i, j in ab.path] if ab.cost_matrix.size else []

    def _gt_alignment(trace, vtrace):
        suite_out = store.get_suite(trace.suite)
        tau = suite_out["params"]["tau"] if suite_out else DEFAULT_TAU
        gt_vec = vectorize_ground_truth(trace.ground_truth, embedder)
        align = align_to_ground_truth(vtrace.vectors, gt_vec, tau=tau)
        suite_traces = [t for t in store.traces if t.suite == trace.suite]
        majority_ref = build_argument_majority_reference(suite_traces)
        arg_mismatch = compute_arg_mismatch(trace, align.matched_to_gt, majority_ref)
        return {
            "tau": tau,
            "matched_to_gt": align.matched_to_gt,
            "gt_index_of_event": align.gt_index_of_event,
            "arg_mismatch": arg_mismatch,
        }

    gt_align_a = _gt_alignment(trace_a, va)
    gt_align_b = _gt_alignment(trace_b, vb)
    return {
        "distance": ab.distance,
        "path": ab.path,
        "local_cost": local_cost,
        "case_a": _summarize(trace_a),
        "case_b": _summarize(trace_b),
        "events_a": _events_payload(trace_a, gt_align_a["arg_mismatch"]),
        "events_b": _events_payload(trace_b, gt_align_b["arg_mismatch"]),
        "gt_align_a": gt_align_a,
        "gt_align_b": gt_align_b,
    }


@app.get("/api/search")
def search(q: str = "", suite: Optional[str] = None, limit: int = 30):
    """case_id / user_task_id 부분일치 검색 (비교 도구의 트레이스 선택용)."""
    manifest = store.get_manifest()
    suites = [suite] if suite else manifest.get("suites", [])
    q_lower = q.lower().strip()
    out = []
    for s in suites:
        data = store.get_suite(s)
        if not data:
            continue
        for cid in data["case_ids"]:
            if q_lower and q_lower not in cid.lower():
                continue
            out.append(cid)
            if len(out) >= limit:
                return out
    return out


# ---------------------------------------------------------------- 정적 프론트엔드
# 컨테이너 배포 시 frontend/를 nginx가 따로 서빙하고 백엔드는 /api/*만 맡을 수
# 있어서(docker-compose.yml 참고), frontend 디렉터리가 없어도 StaticFiles가
# 죽지 않게 존재 여부를 먼저 확인한다.
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
