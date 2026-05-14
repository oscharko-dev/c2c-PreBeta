FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN if [ -s requirements.txt ]; then pip install --no-cache-dir --disable-pip-version-check -r requirements.txt; fi

COPY src ./src
COPY openapi.yaml ./openapi.yaml

ENV PYTHONPATH=/app/src

EXPOSE 8084

CMD ["python", "-m", "orchestrator_service.main"]
