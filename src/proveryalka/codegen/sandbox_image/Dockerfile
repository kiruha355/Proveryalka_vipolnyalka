# Песочница тестов сгенерированных проектов Проверялки.
# Сеть нужна только при сборке (зависимости по хэшам); тесты запускаются с --network none,
# read-only rootfs, без root и capabilities (см. proveryalka/codegen/sandbox.py).
FROM python:3.11-slim@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce
ENV PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
COPY requirements.lock /opt/runner/requirements.lock
RUN python -m pip install --no-deps --require-hashes --only-binary=:all: -r /opt/runner/requirements.lock \
 && python -m pip uninstall -y pip setuptools wheel
COPY runner.py /opt/runner/runner.py
LABEL org.opencontainers.image.title="proveryalka-codegen-sandbox"
USER 10001:10001
WORKDIR /job
ENTRYPOINT ["python", "-I", "-B", "/opt/runner/runner.py"]
