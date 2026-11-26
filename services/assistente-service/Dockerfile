# Etapa 1: builder
FROM python:3.12-slim AS builder
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 HF_HOME=/opt/hf
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /build

# PyTorch somente CPU
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu
COPY services/assistente-service/requirements.txt .
RUN pip install -r requirements.txt

# Baixa o modelo de embeddings no build
RUN python -c "from sentence_transformers import SentenceTransformer as S; S('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')"

# Etapa 2: runtime
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH" HF_HOME=/opt/hf HF_HUB_OFFLINE=1
RUN useradd --create-home --uid 10001 app
WORKDIR /app
RUN chown app:app /app
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder --chown=app:app /opt/hf /opt/hf
COPY --chown=app:app services/assistente-service/src ./src
COPY --chown=app:app services/assistente-service/scripts ./scripts
COPY --chown=app:app services/assistente-service/base_conhecimento ./base_conhecimento
USER app
EXPOSE 5006
CMD ["sh", "-c", "uvicorn src.main:app --host 0.0.0.0 --port ${PORT_ASSISTENTE:-5006}"]
