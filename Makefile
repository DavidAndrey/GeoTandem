.PHONY: install dev test lint gen docker docker-run e2e

install:
	uv python install 3.14
	uv sync
	cd frontend && npm ci
	cd e2e && npm ci && npx playwright install chromium

dev:
	GEOTANDEM_DATA_DIR=./data GEOTANDEM_LOAD_SAMPLE_DATA=true uv run geotandem serve --reload

lint:
	uv run ruff check .
	uv run ruff format --check .
	uv run mypy packages/query/src backend/src
	cd frontend && npm run lint && npm run typecheck

test:
	uv run pytest
	cd frontend && npm test && npm run check:api

# Regenerate every derived artefact from its single source.
gen:
	uv run geotandem schema export
	uv run geotandem openapi export > frontend/openapi.json
	cd frontend && npm run gen:api
	uv run geotandem sample generate

docker:
	docker build -t geotandem .

e2e:
	cd e2e && npx playwright test

docker-run:
	docker run --rm -p 8000:8000 -v geotandem-data:/data geotandem
