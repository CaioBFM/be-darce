import time
from threading import Lock

from langchain_core.callbacks import BaseCallbackHandler
from psycopg.rows import dict_row

from src.config import settings
from src.db import get_pool

# Tabela de referência (US$ por 1 milhão de tokens): (entrada, saída)
_PRECOS_POR_MILHAO: dict[str, tuple[float, float]] = {
    "referencia_padrao": (0.15, 0.60),
    "groq_default": (0.05, 0.08),
    "openai/gpt-oss-20b": (0.07, 0.30),
    "llama-3.3-70b-versatile": (0.59, 0.79),
}

_VOLUMES_PROJECAO = (1_000, 10_000, 100_000, 1_000_000)


def estimar_tokens_e_custo(
    texto_entrada: str,
    texto_saida: str,
    usage_metadata: dict | None = None,
    modelo: str | None = None,
) -> dict:
    tokens_entrada = 0
    tokens_saida = 0

    if isinstance(usage_metadata, dict) and usage_metadata:
        tokens_entrada = int(usage_metadata.get("input_tokens") or usage_metadata.get("prompt_tokens") or 0)
        tokens_saida = int(usage_metadata.get("output_tokens") or usage_metadata.get("completion_tokens") or 0)

    # Sem contagem real do provedor: aproximação de ~4 caracteres por token
    if tokens_entrada <= 0:
        tokens_entrada = max(1, len(texto_entrada) // 4) if texto_entrada.strip() else 0
    if tokens_saida <= 0:
        tokens_saida = max(1, len(texto_saida) // 4) if texto_saida.strip() else 0

    nome_modelo = (modelo or settings.llm_model).strip()
    preco_in, preco_out = _PRECOS_POR_MILHAO.get(nome_modelo, _PRECOS_POR_MILHAO["referencia_padrao"])
    custo_usd = (tokens_entrada / 1_000_000) * preco_in + (tokens_saida / 1_000_000) * preco_out
    ref_in, ref_out = _PRECOS_POR_MILHAO["referencia_padrao"]
    custo_ref = (tokens_entrada / 1_000_000) * ref_in + (tokens_saida / 1_000_000) * ref_out

    return {
        "tokens_entrada": tokens_entrada,
        "tokens_saida": tokens_saida,
        "tokens_totais": tokens_entrada + tokens_saida,
        "custo_estimado_usd": round(custo_usd, 8),
        "custo_referencia_usd": round(custo_ref, 8),
    }


# Callback LangChain: mede tempo REAL das tools/RAG e tokens REAIS reportados pelo provedor
class MetricasCallback(BaseCallbackHandler):
    def __init__(self) -> None:
        self._lock = Lock()
        self._tools_em_andamento: dict = {}
        self.latencia_tools_ms = 0.0
        self.latencia_rag_ms = 0.0
        self.tokens_entrada = 0
        self.tokens_saida = 0

    def on_tool_start(self, serialized, input_str, *, run_id, **kwargs):
        nome = (serialized or {}).get("name") or kwargs.get("name") or ""
        with self._lock:
            self._tools_em_andamento[run_id] = (time.perf_counter(), nome)

    def _finalizar_tool(self, run_id) -> None:
        with self._lock:
            inicio, nome = self._tools_em_andamento.pop(run_id, (None, ""))
            if inicio is None:
                return
            ms = (time.perf_counter() - inicio) * 1000
            self.latencia_tools_ms += ms
            if nome == "consultar_base_conhecimento":
                self.latencia_rag_ms += ms

    def on_tool_end(self, output, *, run_id, **kwargs):
        self._finalizar_tool(run_id)

    def on_tool_error(self, error, *, run_id, **kwargs):
        self._finalizar_tool(run_id)

    def on_llm_end(self, response, **kwargs):
        with self._lock:
            for geracoes in response.generations:
                for geracao in geracoes:
                    uso = getattr(getattr(geracao, "message", None), "usage_metadata", None)
                    if uso:
                        self.tokens_entrada += int(uso.get("input_tokens", 0))
                        self.tokens_saida += int(uso.get("output_tokens", 0))

    @property
    def usage_metadata(self) -> dict:
        return {"input_tokens": self.tokens_entrada, "output_tokens": self.tokens_saida}


# Métricas persistidas no PostgreSQL do serviço (sobrevivem a restart e somam todas as réplicas)
class ColetorMetricas:
    def registrar(self, m: dict) -> None:
        try:
            with get_pool().connection() as conn:
                conn.execute(
                    """INSERT INTO metricas_execucoes
                       (latencia_rag_ms, latencia_tools_ms, latencia_llm_ms, latencia_total_ms,
                        tokens_entrada, tokens_saida, custo_estimado_usd, cache_hit, fallback_utilizado)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        float(m.get("latencia_rag_ms", 0.0)),
                        float(m.get("latencia_tools_ms", 0.0)),
                        float(m.get("latencia_llm_ms", 0.0)),
                        float(m.get("latencia_total_ms", 0.0)),
                        int(m.get("tokens_entrada", 0)),
                        int(m.get("tokens_saida", 0)),
                        float(m.get("custo_estimado_usd", 0.0)),
                        bool(m.get("cache_hit", False)),
                        bool(m.get("fallback_utilizado", False)),
                    ),
                )
        except Exception as erro:
            print(f"[METRICAS] Falha ao registrar: {erro}")

    def resumo(self) -> dict:
        with get_pool().connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            geral = cur.execute(
                """SELECT COUNT(*) AS total,
                          COUNT(*) FILTER (WHERE cache_hit) AS cache_hits,
                          COUNT(*) FILTER (WHERE fallback_utilizado) AS fallbacks,
                          COALESCE(AVG(latencia_rag_ms),0) AS rag,
                          COALESCE(AVG(latencia_tools_ms),0) AS tools,
                          COALESCE(AVG(latencia_llm_ms),0) AS llm,
                          COALESCE(AVG(latencia_total_ms),0) AS total_ms,
                          COALESCE(SUM(tokens_entrada),0) AS tin,
                          COALESCE(SUM(tokens_saida),0) AS tout,
                          COALESCE(SUM(custo_estimado_usd),0) AS custo
                   FROM metricas_execucoes"""
            ).fetchone()
            # Operações que realmente chamaram o LLM (sem cache e sem fallback)
            reais = cur.execute(
                """SELECT COUNT(*) AS n,
                          COALESCE(AVG(latencia_total_ms),0) AS media_ms,
                          COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latencia_total_ms),0) AS p50_ms,
                          COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latencia_total_ms),0) AS p95_ms,
                          COALESCE(AVG(tokens_entrada),0) AS tin,
                          COALESCE(AVG(tokens_saida),0) AS tout,
                          COALESCE(AVG(custo_estimado_usd),0) AS custo_op
                   FROM metricas_execucoes WHERE NOT cache_hit AND NOT fallback_utilizado"""
            ).fetchone()
            ultimas = cur.execute(
                """SELECT criado_em, latencia_total_ms, tokens_entrada, tokens_saida,
                          custo_estimado_usd, cache_hit, fallback_utilizado
                   FROM metricas_execucoes ORDER BY id DESC LIMIT 10"""
            ).fetchall()

        total = int(geral["total"])
        taxa_cache = (geral["cache_hits"] / total) if total else 0.0
        custo_op = float(reais["custo_op"])

        projecao = [
            {
                "operacoes_por_mes": vol,
                "custo_usd_sem_cache": round(vol * custo_op, 4),
                "custo_usd_com_cache_atual": round(vol * (1 - taxa_cache) * custo_op, 4),
            }
            for vol in _VOLUMES_PROJECAO
        ]

        return {
            "modelo": settings.llm_model,
            "total_requisicoes": total,
            "total_cache_hits": int(geral["cache_hits"]),
            "taxa_cache_hit_pct": round(taxa_cache * 100, 2),
            "total_fallbacks": int(geral["fallbacks"]),
            "latencias_medias_ms": {
                "rag": round(float(geral["rag"]), 2),
                "tools": round(float(geral["tools"]), 2),
                "llm": round(float(geral["llm"]), 2),
                "total": round(float(geral["total_ms"]), 2),
            },
            "latencia_chamadas_llm_ms": {
                "amostras": int(reais["n"]),
                "media": round(float(reais["media_ms"]), 2),
                "p50": round(float(reais["p50_ms"]), 2),
                "p95": round(float(reais["p95_ms"]), 2),
            },
            "tokens": {
                "entrada": int(geral["tin"]),
                "saida": int(geral["tout"]),
                "total": int(geral["tin"]) + int(geral["tout"]),
                "media_entrada_por_operacao": round(float(reais["tin"]), 1),
                "media_saida_por_operacao": round(float(reais["tout"]), 1),
            },
            "custo_estimado_total_usd": round(float(geral["custo"]), 8),
            "custo_medio_por_operacao_usd": round(custo_op, 8),
            "projecao_custo_em_escala": projecao,
            "ultimas_execucoes": ultimas,
        }


coletor_metricas = ColetorMetricas()