import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from src.agente import executar_agente, gerar_boas_vindas, obter_historico_persistido
from src.config import settings
from src.db import inicializar_schema, ping_banco
from src.ingestao import garantir_base_vetorial
from src.metricas import coletor_metricas, estimar_tokens_e_custo
from src.resiliencia import (
    CacheRespostaTTL,
    cache_respostas,
    circuit_breaker_llm,
    executar_com_resiliencia,
    gerar_resposta_fallback,
)


# Na subida: espera o banco, cria o schema e garante a base vetorial indexada (ingestão idempotente)
@asynccontextmanager
async def lifespan(_: FastAPI):
    inicializar_schema()
    garantir_base_vetorial()
    yield


app = FastAPI(
    title="BEDARCE - Assistente Virtual de Apoio",
    version="2.0.0",
    description="Microsserviço de IA: RAG em pgvector, tools via Gateway, resiliência e métricas.",
    lifespan=lifespan,
)


class BoasVindasRequest(BaseModel):
    usuario_id: str | None = Field(default=None)
    nome_usuario: str | None = Field(default=None)


class MensagemRequest(BaseModel):
    mensagem: str = Field(..., min_length=1, max_length=2000)
    usuario_id: str | None = Field(default=None)
    historico: list[dict] | None = Field(default=None)


@app.get("/")
def raiz() -> dict:
    return {"status": "ok", "message": "Serviço do assistente em execução."}


# Liveness: não depende do LLM nem do banco (o LLM é dependência falível, tratada por resiliência)
@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "assistente-service",
        "provider": settings.llm_provider,
        "model": settings.llm_model,
        "circuit_breaker_estado": circuit_breaker_llm.estado,
    }


# Mesmo contrato dos outros serviços, para o painel de diagnóstico do portal
@app.get("/db")
def db() -> JSONResponse:
    try:
        return JSONResponse({"status": "success", "service": "assistente-service", "database": ping_banco()})
    except Exception:
        return JSONResponse({"status": "error", "message": "Falha na conexão com o banco."}, status_code=503)


@app.post("/v1/assistente/boas-vindas")
def post_boas_vindas(
    payload: BoasVindasRequest,
    x_usuario_id: str | None = Header(default=None, alias="X-Usuario-Id"),
) -> dict:
    inicio = time.perf_counter()
    usuario_id = (x_usuario_id or "").strip()
    if not usuario_id:
        raise HTTPException(status_code=400, detail="Identificação do usuário obrigatória.")
    resultado = gerar_boas_vindas(usuario_id=usuario_id, nome_usuario=payload.nome_usuario)
    resultado["latencia_total_ms"] = round((time.perf_counter() - inicio) * 1000, 2)
    return resultado


@app.get("/v1/assistente/historico")
def get_historico(x_usuario_id: str | None = Header(default=None, alias="X-Usuario-Id")) -> dict:
    usuario_id = (x_usuario_id or "").strip()
    if not usuario_id:
        raise HTTPException(status_code=400, detail="Identificação do usuário obrigatória.")
    return {"mensagens": obter_historico_persistido(usuario_id)}


@app.post("/v1/assistente/mensagem")
def post_mensagem(
    payload: MensagemRequest,
    x_usuario_id: str | None = Header(default=None, alias="X-Usuario-Id"),
) -> dict:
    inicio_total = time.perf_counter()
    usuario_id = (x_usuario_id or "").strip()
    if not usuario_id:
        raise HTTPException(status_code=400, detail="Identificação do usuário obrigatória.")
    chave_cache = CacheRespostaTTL.gerar_chave(usuario_id, payload.mensagem)

    # Camada 1: cache
    item_cache = cache_respostas.obter(chave_cache)
    if item_cache is not None:
        metricas_hit = {
            "latencia_rag_ms": 0.0, "latencia_tools_ms": 0.0, "latencia_llm_ms": 0.0,
            "latencia_total_ms": round((time.perf_counter() - inicio_total) * 1000, 2),
            "tokens_entrada": 0, "tokens_saida": 0, "custo_estimado_usd": 0.0,
            "cache_hit": True, "fallback_utilizado": False,
        }
        coletor_metricas.registrar(metricas_hit)
        return {**item_cache, "cache_hit": True, "fallback_utilizado": False, "metricas": metricas_hit}

    # Camada 2: agente com retry/backoff + circuit breaker
    try:
        inicio_agente = time.perf_counter()
        resultado = executar_com_resiliencia(
            lambda: executar_agente(
                mensagem=payload.mensagem,
                usuario_id=usuario_id,
                historico_externo=payload.historico,
            )
        )
        latencia_agente_ms = (time.perf_counter() - inicio_agente) * 1000
        latencia_total_ms = round((time.perf_counter() - inicio_total) * 1000, 2)

        resposta_texto = resultado["resposta"]
        latencia_tools_ms = resultado.get("latencia_tools_ms", 0.0)
        estimativa = estimar_tokens_e_custo(
            texto_entrada=payload.mensagem,
            texto_saida=resposta_texto,
            usage_metadata=resultado.get("usage_metadata"),
        )
        metricas_exec = {
            "latencia_rag_ms": resultado.get("latencia_rag_ms", 0.0),
            "latencia_tools_ms": latencia_tools_ms,
            "latencia_llm_ms": round(max(latencia_agente_ms - latencia_tools_ms, 0.0), 2),
            "latencia_total_ms": latencia_total_ms,
            **estimativa,
            "cache_hit": False,
            "fallback_utilizado": False,
        }
        coletor_metricas.registrar(metricas_exec)

        resposta_final = {
            "resposta": resposta_texto,
            "tools_chamadas": resultado.get("tools_chamadas", []),
            "fontes": resultado.get("fontes", []),
            "usuario_id": usuario_id,
            "cache_hit": False,
            "fallback_utilizado": False,
            "metricas": metricas_exec,
        }
        cache_respostas.salvar(chave_cache, resposta_final)
        return resposta_final

    # Camada 3: degradação elegante (nunca cacheada)
    except Exception as erro:
        print(f"[FALLBACK] {type(erro).__name__}: {erro}")
        fallback = gerar_resposta_fallback(payload.mensagem)
        metricas_fb = {
            "latencia_rag_ms": fallback.get("latencia_rag_ms", 0.0),
            "latencia_tools_ms": 0.0, "latencia_llm_ms": 0.0,
            "latencia_total_ms": round((time.perf_counter() - inicio_total) * 1000, 2),
            "tokens_entrada": 0, "tokens_saida": 0, "custo_estimado_usd": 0.0,
            "cache_hit": False, "fallback_utilizado": True,
        }
        coletor_metricas.registrar(metricas_fb)
        return {
            "resposta": fallback["resposta"],
            "tools_chamadas": fallback["tools_chamadas"],
            "fontes": fallback["fontes"],
            "usuario_id": usuario_id,
            "cache_hit": False,
            "fallback_utilizado": True,
            "metricas": metricas_fb,
        }


@app.get("/v1/assistente/metricas")
def get_metricas() -> dict:
    resumo = coletor_metricas.resumo()
    resumo["circuit_breaker_estado"] = circuit_breaker_llm.estado
    return resumo
