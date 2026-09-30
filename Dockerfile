# One image, one process, one port (F-9.7). Default: SpatiaLite file in /data,
# no database service (F-2.12). PostGIS is selected via GEOTANDEM_DATABASE_URL (P.4).

FROM node:24-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.14-slim AS app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libsqlite3-mod-spatialite \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.12.10 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app

# Dependencies first, for layer caching.
COPY pyproject.toml uv.lock ./
COPY packages/query/pyproject.toml packages/query/
COPY backend/pyproject.toml backend/
RUN uv sync --frozen --no-dev --package geotandem --no-install-workspace

COPY packages packages
COPY backend backend
RUN uv sync --frozen --no-dev --package geotandem --no-editable \
    && python -c "import sqlite3; c = sqlite3.connect(':memory:'); c.enable_load_extension(True); c.load_extension('mod_spatialite')"

COPY --from=frontend /app/frontend/dist /app/frontend/dist

RUN useradd --uid 10001 --home-dir /data geotandem \
    && mkdir /data && chown geotandem /data
USER geotandem
ENV PATH=/opt/venv/bin:$PATH \
    GEOTANDEM_DATA_DIR=/data \
    GEOTANDEM_FRONTEND_DIR=/app/frontend/dist \
    GEOTANDEM_LOAD_SAMPLE_DATA=true
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["geotandem", "serve", "--host", "0.0.0.0", "--port", "8000"]
