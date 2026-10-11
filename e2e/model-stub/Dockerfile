# The model stub of the acceptance tests (WP69). Built from the repository root,
# so the contract fixture is copied in; scripts/gate.sh sends only these files:
#   tar -c e2e/model-stub schema/model-cases | docker build -f e2e/model-stub/Dockerfile -
FROM python:3.14-slim
COPY e2e/model-stub/stub.py /stub/stub.py
COPY schema/model-cases/v1.json /cases/v1.json
USER nobody
EXPOSE 8080
CMD ["python", "-u", "/stub/stub.py", "--port", "8080", "--cases", "/cases/v1.json"]
