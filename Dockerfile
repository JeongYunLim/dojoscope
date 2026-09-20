# syntax=docker/dockerfile:1
#
# 참고로 받은 설정 파일(docker-setting-file.zip)은 프론트엔드가 Vite/React라
# node 빌더 단계가 있었지만, DojoScope의 frontend/는 번들러 없는 순수
# HTML/CSS/JS라 그 단계가 필요 없다 — nginx 이미지에 정적 파일을 그대로 복사.

FROM nginx:alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/ /usr/share/nginx/html/

# 참고 파일의 8080이 아니라 다른 포트 — docker-compose.yml이 호스트 포트로
# 매핑한다.
EXPOSE 7680
