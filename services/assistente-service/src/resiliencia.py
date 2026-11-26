import hashlib
import time
from threading import Lock
from typing import Callable, TypeVar

from psycopg.types.json import Jsonb
from tenacity import Retrying, retry_if_exception, stop_after_attempt, wait_exponential

from src.config import settings
from src.db import get_pool
from src.rag import extrair_fontes, obter_retriever

T = TypeVar("T")

_CIRCUIT_FALHAS_LIMITE = 3
_CIRCUIT_COOLDOWN_SEGUNDOS = 30.0


# Falha transitória = elegível para retry com backoff exponencial
def _eh_erro_transitorio(erro: BaseException) -> bool:
    if isinstance(erro, (TimeoutError, ConnectionError)):
        return True
    mensagem = str(erro).lower()
    indicadores = (
        "timeout", "timed out", "429", "rate limit", "500", "502", "503", "504",
        "connection", "temporarily unavailable",
    )
    return any(termo in mensagem for termo in indicadores)


# Cache de respostas com TTL guardado no PostgreSQL do próprio serviço (compartilhado entre réplicas)
class CacheRespostaTTL:
    def __init__(self, ttl_segundos: float | None = None) -> None:
        self.ttl_segundos = ttl_segundos or settings.cache_ttl_segundos

    @staticmethod
    def gerar_chave(usuario_id: str | None, mensagem: str) -> str:
        usuario_limpo = (usuario_id or "anonimo").strip().lower()
        mensagem_norm = " ".join(mensagem.strip().lower().split())
        return hashlib.sha256(f"{usuario_limpo}::{mensagem_norm}".encode("utf-8")).hexdigest()

    def obter(self, chave: str) -> dict | None:
        try:
            with get_pool().connection() as conn:
                linha = conn.execute(
                    "SELECT valor FROM cache_respostas WHERE chave = %s AND expira_em > NOW()",
                    (chave,),
                ).fetchone()
            return dict(linha[0]) if linha else None
        except Exception as erro:
            print(f"[CACHE] Falha na leitura (seguindo sem cache): {erro}")
            return None

    def salvar(self, chave: str, valor: dict) -> None:
        try:
            with get_pool().connection() as conn:
                conn.execute(
                    """INSERT INTO cache_respostas (chave, valor, expira_em)
                       VALUES (%s, %s, NOW() + make_interval(secs => %s))
                       ON CONFLICT (chave) DO UPDATE
                       SET valor = EXCLUDED.valor, expira_em = EXCLUDED.expira_em""",
                    (chave, Jsonb(valor), float(self.ttl_segundos)),
                )
                conn.execute("DELETE FROM cache_respostas WHERE expira_em < NOW()")
        except Exception as erro:
            print(f"[CACHE] Falha na escrita: {erro}")


# Circuit Breaker CLOSED -> OPEN -> HALF_OPEN (por réplica, em memória, como deve ser)
class CircuitBreakerLLM:
    def __init__(
        self,
        limite_falhas: int = _CIRCUIT_FALHAS_LIMITE,
        cooldown_segundos: float = _CIRCUIT_COOLDOWN_SEGUNDOS,
    ) -> None:
        self.limite_falhas = limite_falhas
        self.cooldown_segundos = cooldown_segundos
        self.estado = "CLOSED"
        self.falhas_consecutivas = 0
        self.aberto_ate = 0.0
        self._lock = Lock()

    def pode_executar(self) -> bool:
        agora = time.monotonic()
        with self._lock:
            if self.estado == "CLOSED":
                return True
            if self.estado == "OPEN":
                if agora >= self.aberto_ate:
                    self.estado = "HALF_OPEN"
                    return True
                return False
            return True

    def registrar_sucesso(self) -> None:
        with self._lock:
            self.falhas_consecutivas = 0
            self.estado = "CLOSED"
            self.aberto_ate = 0.0

    def registrar_falha(self) -> None:
        agora = time.monotonic()
        with self._lock:
            self.falhas_consecutivas += 1
            if self.estado == "HALF_OPEN" or self.falhas_consecutivas >= self.limite_falhas:
                self.estado = "OPEN"
                self.aberto_ate = agora + self.cooldown_segundos


cache_respostas = CacheRespostaTTL()
circuit_breaker_llm = CircuitBreakerLLM()


# Retry com backoff exponencial (1s -> 2s -> 4s) + Circuit Breaker
def executar_com_resiliencia(operacao: Callable[[], T]) -> T:
    if not circuit_breaker_llm.pode_executar():
        raise RuntimeError("CIRCUIT_OPEN: O circuito de chamadas ao LLM está temporariamente aberto.")

    retrier = Retrying(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=4),
        retry=retry_if_exception(_eh_erro_transitorio),
        reraise=True,
    )
    try:
        resultado = retrier(operacao)
    except Exception:
        circuit_breaker_llm.registrar_falha()
        raise
    circuit_breaker_llm.registrar_sucesso()
    return resultado


# Fallback: mensagem padrão + trecho principal do pgvector, sem depender do LLM
def gerar_resposta_fallback(pergunta: str) -> dict:
    inicio_rag = time.perf_counter()
    trecho_principal = ""
    fontes: list[str] = []

    try:
        docs = obter_retriever(k=1).invoke(pergunta)
        fontes = extrair_fontes(docs)
        if docs:
            doc_top = docs[0]
            fonte_top = doc_top.metadata.get("fonte", "material da BEDARCE")
            pagina_top = doc_top.metadata.get("pagina")
            origem = f"{fonte_top}, pág. {pagina_top}" if pagina_top else fonte_top
            trecho_limpo = " ".join(doc_top.page_content.strip().split())
            trecho_resumido = trecho_limpo[:450] + ("..." if len(trecho_limpo) > 450 else "")
            trecho_principal = f"\n\nTrecho principal encontrado ({origem}): \"{trecho_resumido}\""
    except Exception:
        trecho_principal = ""

    latencia_rag_ms = round((time.perf_counter() - inicio_rag) * 1000, 2)
    mensagem_padrao = (
        "No momento, meu módulo de Inteligência Artificial está temporariamente indisponível. "
        "Lembro que sou uma IA com limitações e não substituo atendimento profissional — se precisar "
        "de acolhimento agora, procure um psicólogo, um mentor ou os canais de apoio da plataforma BEDARCE."
        f"{trecho_principal}"
    )
    return {
        "resposta": mensagem_padrao,
        "tools_chamadas": [],
        "fontes": fontes,
        "fallback_utilizado": True,
        "cache_hit": False,
        "latencia_rag_ms": latencia_rag_ms,
        "timeout_configurado_s": settings.llm_timeout_seconds,
    }