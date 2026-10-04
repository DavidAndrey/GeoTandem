.PHONY: install dev test lint gen sample-update docker docker-run e2e gate doc-screenshots \
        instance instance-stop instance-logs instance-reset

install:
	uv python install 3.14
	uv sync
	cd frontend && npm ci
	cd e2e && npm ci && npx playwright install chromium

dev:
	GEOTANDEM_DATA_DIR=./data GEOTANDEM_LOAD_SAMPLE_DATA=true GEOTANDEM_BASEMAP=swisstopo-grau uv run geotandem serve --reload

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

# Only on request: downloads the sources of the sample dataset (network, ~100 MB)
# and rebuilds the committed files. Re-pin the golden results afterwards.
sample-update:
	uv run geotandem sample update

docker:
	docker build -t geotandem .

e2e:
	cd e2e && npx playwright test

docker-run:
	docker run --rm -p 8000:8000 -v geotandem-data:/data geotandem

# lint + test + image + first start, Playwright and restart against the container.
gate:
	scripts/gate.sh

# Screenshots of the examples in docs/filters.md, from the working tree on a
# throwaway instance. Rerun when the editor or the examples change.
doc-screenshots:
	scripts/doc-screenshots.sh

# A personal instance for manual testing, kept apart from agents and other apps:
# built from a committed ref (never the working tree others may be editing), its
# own image tag, container and volume, bound to localhost only. Data survives
# rebuilds; `make instance-reset` drops it.
INSTANCE_REF     ?= HEAD
INSTANCE_PORT    ?= 8060
INSTANCE_BASEMAP ?= swisstopo-grau
INSTANCE         := geotandem-instance

instance:
	git archive --format=tar $(INSTANCE_REF) | docker build -t geotandem:instance -
	docker rm -f $(INSTANCE) >/dev/null 2>&1 || true
	docker run -d --name $(INSTANCE) --restart unless-stopped \
		-p 127.0.0.1:$(INSTANCE_PORT):8000 -v $(INSTANCE)-data:/data \
		-e GEOTANDEM_BASEMAP=$(INSTANCE_BASEMAP) geotandem:instance >/dev/null
	@echo "$(INSTANCE) ($$(git rev-parse --short $(INSTANCE_REF))) on http://127.0.0.1:$(INSTANCE_PORT)"

instance-stop:
	docker rm -f $(INSTANCE)

instance-logs:
	docker logs -f $(INSTANCE)

instance-reset: instance-stop
	docker volume rm $(INSTANCE)-data
