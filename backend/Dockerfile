# syntax=docker/dockerfile:1

FROM python:3.10-slim-bookworm

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
