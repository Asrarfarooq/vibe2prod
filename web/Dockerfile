FROM node:22-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    STATIC_DIR=/app/static
WORKDIR /app
COPY api/requirements.txt .
RUN pip install -r requirements.txt
COPY api/ ./
COPY --from=frontend /frontend/dist ./static
RUN useradd --system --uid 10001 web
USER web
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --timeout-keep-alive 75"]
