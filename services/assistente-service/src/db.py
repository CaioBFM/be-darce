import time
from contextlib import contextmanager
from functools import lru_cache
from threading import Lock

import psycopg
from psycopg.conninfo import make_conninfo
from psycopg_pool import ConnectionPool
from sqlalchemy import create_engine
from sqlalchemy.engine import URL

from src.config import settings

# IDs de advisory lock: evitam corrida quando várias réplicas sobem ao mesmo tempo
LOCK_SCHEMA = 7001
LOCK_INGESTAO = 7002

_pool: ConnectionPool | None = None
_pool_lock = Lock()


def _conninfo() -> str:
    return make_conninfo(
        host=settings.db_host,
        port=settings.db_port,
        user=settings.db_user,
        password=settings.db_password,
        dbname=settings.db_name,
    )


# Engine SQLAlchemy usado pelo PGVector (langchain-postgres)
@lru_cache(maxsize=1)
def obter_engine():
    url = URL.create(
        "postgresql+psycopg",
        username=settings.db_user,
        password=settings.db_password,
        host=settings.db_host,
        port=settings.db_port,
        database=settings.db_name,
    )
    return create_engine(url, pool_pre_ping=True)


# Pool de conexões psycopg (autocommit) para cache, histórico e métricas
def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = ConnectionPool(
                    conninfo=_conninfo(),
                    min_size=1,
                    max_size=10,
                    kwargs={"autocommit": True},
                    open=True,
                )
    return _pool


@contextmanager
def advisory_lock(lock_id: int):
    with get_pool().connection() as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (lock_id,))
        try:
            yield
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (lock_id,))


def aguardar_banco(tentativas: int = 30, intervalo_s: float = 2.0) -> None:
    ultimo_erro: Exception | None = None
    for _ in range(tentativas):
        try:
            with psycopg.connect(_conninfo(), connect_timeout=3) as conn:
                conn.execute("SELECT 1")
            return
        except Exception as erro:
            ultimo_erro = erro
            time.sleep(intervalo_s)
    raise RuntimeError(f"Banco do assistente indisponível: {ultimo_erro}")


def inicializar_schema() -> None:
    aguardar_banco()
    with get_pool().connection() as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (LOCK_SCHEMA,))
        try:
            conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            conn.execute(
                """CREATE TABLE IF NOT EXISTS historico_conversas (
                    id BIGSERIAL PRIMARY KEY,
                    usuario_id TEXT NOT NULL,
                    papel TEXT NOT NULL,
                    conteudo TEXT NOT NULL,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())"""
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_historico_usuario ON historico_conversas (usuario_id, id DESC)"
            )
            conn.execute(
                """CREATE TABLE IF NOT EXISTS cache_respostas (
                    chave TEXT PRIMARY KEY,
                    valor JSONB NOT NULL,
                    expira_em TIMESTAMPTZ NOT NULL)"""
            )
            conn.execute(
                """CREATE TABLE IF NOT EXISTS metricas_execucoes (
                    id BIGSERIAL PRIMARY KEY,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    latencia_rag_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
                    latencia_tools_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
                    latencia_llm_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
                    latencia_total_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
                    tokens_entrada INTEGER NOT NULL DEFAULT 0,
                    tokens_saida INTEGER NOT NULL DEFAULT 0,
                    custo_estimado_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
                    cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
                    fallback_utilizado BOOLEAN NOT NULL DEFAULT FALSE)"""
            )
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_SCHEMA,))


def ping_banco() -> dict:
    inicio = time.perf_counter()
    with get_pool().connection() as conn:
        agora = conn.execute("SELECT NOW()").fetchone()[0]
    return {
        "timestamp": agora.isoformat(),
        "responseTimeMs": round((time.perf_counter() - inicio) * 1000, 2),
    }