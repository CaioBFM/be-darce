import json
import time
from pathlib import Path
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from src.config import settings
from src.llm_factory import criar_modelo_llm
from src.metricas import MetricasCallback, estimar_tokens_e_custo
from src.rag import consultar_rag_com_fontes
from src.resiliencia import executar_com_resiliencia

# Perguntas de domínio para comparar a mesma LLM sem recuperação e com RAG.
PERGUNTAS_AVALIACAO = [
    "Quais são os principais gatilhos emocionais associados ao Transtorno do Jogo segundo a base da plataforma?",
    "Como a BEDARCE organiza o apoio e as trilhas educativas para pessoas em recuperação?",
    "Que estratégias da TCC podem ajudar a lidar com impulsos e prevenir recaídas em apostas?",
    "Qual é o papel da rede de apoio e da mentoria na recuperação de apostas?",
    "Quais impactos sociais das apostas online são descritos nos materiais da base?",
]

_TOP_K_AVALIACAO = 1
_ARQUIVO_SAIDA = Path(__file__).resolve().parent.parent / "avaliacao_mensagens.jsonl"


# Anexa um registro JSON imediatamente no arquivo de saída (escrita incremental resposta a resposta)
def _anexar_registro(registro: dict, caminho: Path = _ARQUIVO_SAIDA) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    # Abre em modo append e força flush para persistir cada resposta na hora no disco
    with caminho.open("a", encoding="utf-8") as arquivo:
        arquivo.write(json.dumps(registro, ensure_ascii=False) + "\n")
        arquivo.flush()


# Executa uma pergunta na LLM pura (sem RAG, sem tools e sem agente)
def _executar_llm_pura(pergunta: str, llm) -> dict:
    prompt_direto = ChatPromptTemplate.from_messages([
        ("system", "Responda de forma clara, objetiva e concisa em português."),
        ("human", "{pergunta}"),
    ])
    chain = prompt_direto | llm | StrOutputParser()

    metricas = MetricasCallback()
    inicio = time.perf_counter()
    resposta = executar_com_resiliencia(
        lambda: chain.invoke({"pergunta": pergunta}, config={"callbacks": [metricas]})
    )
    latencia_ms = round((time.perf_counter() - inicio) * 1000, 2)

    tokens_info = estimar_tokens_e_custo(
        texto_entrada=pergunta,
        texto_saida=resposta,
        usage_metadata=metricas.usage_metadata,
        modelo=settings.llm_model,
    )
    return {
        "resposta": resposta.strip(),
        "latencia_ms": latencia_ms,
        **tokens_info,
    }


# Executa as cinco perguntas e grava as duas respostas de cada uma, sem inventar resultados.
def executar_avaliacao(limpar_arquivo_antes: bool = True) -> Path:
    if limpar_arquivo_antes and _ARQUIVO_SAIDA.exists():
        # Limpa execução anterior apenas no início de uma nova rodada completa
        _ARQUIVO_SAIDA.unlink()

    llm = criar_modelo_llm()

    for idx, pergunta in enumerate(PERGUNTAS_AVALIACAO, start=1):
        print(f"[AVALIACAO] Pergunta {idx}/{len(PERGUNTAS_AVALIACAO)}...")

        # 1. LLM pura (sem nada) e gravação imediata
        dados_pura = _executar_llm_pura(pergunta, llm)
        _anexar_registro({
            "numero_pergunta": idx,
            "pergunta": pergunta,
            "tipo_agente": "llm_pura",
            "resposta": dados_pura["resposta"],
            "fontes": [],
            "latencia_total_ms": dados_pura["latencia_ms"],
            **{chave: dados_pura[chave] for chave in (
                "tokens_entrada", "tokens_saida", "tokens_totais",
                "custo_estimado_usd", "custo_referencia_usd",
            )},
        })

        # 2. Com RAG e gravação imediata
        dados_rag = executar_com_resiliencia(
            lambda p=pergunta: consultar_rag_com_fontes(p, k=_TOP_K_AVALIACAO)
        )
        tokens_rag = estimar_tokens_e_custo(
            texto_entrada=dados_rag.get("texto_entrada_estimativa", pergunta),
            texto_saida=dados_rag.get("resposta", ""),
            usage_metadata=dados_rag.get("usage_metadata"),
            modelo=settings.llm_model,
        )
        _anexar_registro({
            "numero_pergunta": idx,
            "pergunta": pergunta,
            "tipo_agente": "com_rag",
            "resposta": (dados_rag.get("resposta") or "").strip(),
            "fontes": dados_rag.get("fontes", []),
            "latencia_recuperacao_ms": dados_rag.get("latencia_rag_ms", 0.0),
            "latencia_total_ms": dados_rag.get("latencia_total_ms", 0.0),
            **{chave: tokens_rag[chave] for chave in (
                "tokens_entrada", "tokens_saida", "tokens_totais",
                "custo_estimado_usd", "custo_referencia_usd",
            )},
        })

    print(f"[OK] Registro incremental concluído em '{_ARQUIVO_SAIDA}'.")
    return _ARQUIVO_SAIDA


# Permite executar o script diretamente pelo módulo Python
if __name__ == "__main__":
    executar_avaliacao(limpar_arquivo_antes=True)
