# syntax=docker/dockerfile:1

# 로컬 개발 환경(Python 3.14)에서 확인한 것과 서버 UMAP/군집 결과가 완전히
# 똑같이 나오도록, requirements.txt에 고정한 numpy 2.4.4 등이 실제로 설치되는
# Python 버전(3.14)으로 맞췄다 — 3.10으로는 그 버전들의 wheel이 없다(직접 확인).
FROM python:3.14-slim-bookworm

WORKDIR /app

# numpy/scipy/scikit-learn/umap-learn(numba) 빌드·런타임에 필요.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 18080/8080/5001 등 흔히 쓰는 포트, 그리고 같이 받은 참고 설정 파일의 포트와도
# 겹치지 않는 값 — docker-compose.yml에서 nginx가 이 포트로 프록시한다.
EXPOSE 7601

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7601"]
