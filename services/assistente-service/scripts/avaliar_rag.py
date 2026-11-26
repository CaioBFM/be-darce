import json
import time
from pathlib import Path
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from src.agente import executar_agente
from src.config import settings
from src.llm_factory import criar_modelo_llm
from src.metricas import estimar_tokens_e_custo
from src.rag import consultar_rag_com_fontes

# Define as 5 perguntas de avaliação para comparar LLM pura, RAG e Agente
PERGUNTAS_AVALIACAO = [
    "Quais são os principais gatilhos emocionais associados ao Transtorno do Jogo segundo a base da plataforma?",
]

# Define pausa de 65s para resetar a janela TPM da Groq e k=1 para reduzir consumo de tokens
_PAUSA_ENTRE_PERGUNTAS_SEGUNDOS = 65.0
_TOP_K_AVALIACAO = 1
_ARQUIVO_SAIDA = Path(__file__).resolve().parent.parent / "avaliacao_mensagens.jsonl"


# Anexa um registro JSON imediatamente no arquivo de saída (escrita incremental resposta a resposta)
def _anexar_registro(registro: dict, caminho: Path = _ARQUIVO_SAIDA) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    # Abre em modo append e força flush para persistir cada resposta na hora no disco
    with caminho.open("a", encoding="utf-8") as arquivo:
        arquivo.write(json.dumps(registro, ensure_ascii=False) + "\n")
        arquivo.flush()


# Invoca uma função com espera segura caso o plano gratuito da Groq atinja o limite de TPM (429)
def _chamar_com_espera_tpm(operacao, max_tentativas: int = 3):
    for tentativa in range(1, max_tentativas + 1):
        try:
            return operacao()
        except Exception as erro:
            msg = str(erro).lower()
            eh_rate_limit = "429" in msg or "rate limit" in msg or "tokens per minute" in msg
            if not eh_rate_limit or tentativa == max_tentativas:
                raise
            # Aguarda 25s antes de tentar novamente para liberar tokens na janela de 1 minuto
            print(f"[RATE LIMIT] Aguardando 25s para liberar TPM (tentativa {tentativa}/{max_tentativas})...")
            time.sleep(25.0)


# Executa uma pergunta na LLM pura (sem RAG, sem tools e sem agente)
def _executar_llm_pura(pergunta: str, llm) -> dict:
    prompt_direto = ChatPromptTemplate.from_messages([
        ("system", "Responda de forma clara, objetiva e concisa em português."),
        ("human", "{pergunta}"),
    ])
    chain = prompt_direto | llm | StrOutputParser()

    inicio = time.perf_counter()
    resposta = _chamar_com_espera_tpm(lambda: chain.invoke({"pergunta": pergunta}))
    latencia_ms = round((time.perf_counter() - inicio) * 1000, 2)

    tokens_info = estimar_tokens_e_custo(
        texto_entrada=pergunta,
        texto_saida=resposta,
        modelo=settings.llm_model,
    )
    return {
        "resposta": resposta.strip(),
        "latencia_ms": latencia_ms,
        **tokens_info,
    }


# Executa uma pergunta pelo agente LangChain com tools e regras do sistema
def _executar_modo_agente(pergunta: str, usuario_id: str = "paciente-001") -> dict:
    inicio = time.perf_counter()
    resultado = _chamar_com_espera_tpm(
        lambda: executar_agente(
            mensagem=pergunta,
            usuario_id=f"avaliacao-{usuario_id}",
        )
    )
    latencia_ms = round((time.perf_counter() - inicio) * 1000, 2)

    resposta_texto = (resultado.get("resposta") or "").strip()
    tokens_info = estimar_tokens_e_custo(
        texto_entrada=pergunta,
        texto_saida=resposta_texto,
        modelo=settings.llm_model,
    )
    return {
        "resposta": resposta_texto,
        "tools_chamadas": resultado.get("tools_chamadas", []),
        "latencia_ms": latencia_ms,
        **tokens_info,
    }


# Executa as 5 perguntas gravando cada resposta individualmente no arquivo JSONL em tempo real
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
            "latencia_ms": dados_pura["latencia_ms"],
            "tokens_entrada": dados_pura["tokens_entrada"],
            "tokens_saida": dados_pura["tokens_saida"],
        })

        # 2. Com RAG e gravação imediata
        dados_rag = _chamar_com_espera_tpm(lambda p=pergunta: consultar_rag_com_fontes(p, k=_TOP_K_AVALIACAO))
        tokens_rag = estimar_tokens_e_custo(
            texto_entrada=pergunta,
            texto_saida=dados_rag.get("resposta", ""),
            modelo=settings.llm_model,
        )
        _anexar_registro({
            "numero_pergunta": idx,
            "pergunta": pergunta,
            "tipo_agente": "com_rag",
            "resposta": (dados_rag.get("resposta") or "").strip(),
            "fontes": dados_rag.get("fontes", []),
            "latencia_rag_ms": dados_rag.get("latencia_rag_ms", 0.0),
            "tokens_entrada": tokens_rag["tokens_entrada"],
            "tokens_saida": tokens_rag["tokens_saida"],
        })

        # 3. Com Agente e gravação imediata
        dados_agente = _executar_modo_agente(pergunta)
        _anexar_registro({
            "numero_pergunta": idx,
            "pergunta": pergunta,
            "tipo_agente": "com_agente",
            "resposta": dados_agente["resposta"],
            "tools_chamadas": dados_agente["tools_chamadas"],
            "latencia_ms": dados_agente["latencia_ms"],
            "tokens_entrada": dados_agente["tokens_entrada"],
            "tokens_saida": dados_agente["tokens_saida"],
        })

        # Aguarda janela TPM entre perguntas, exceto após a última
        if idx < len(PERGUNTAS_AVALIACAO):
            print(f"[AVALIACAO] Aguardando {_PAUSA_ENTRE_PERGUNTAS_SEGUNDOS:.0f}s para resetar TPM...")
            time.sleep(_PAUSA_ENTRE_PERGUNTAS_SEGUNDOS)

    print(f"[OK] Registro incremental concluído em '{_ARQUIVO_SAIDA}'.")
    return _ARQUIVO_SAIDA


# Permite executar o script diretamente pelo módulo Python
if __name__ == "__main__":
    executar_avaliacao(limpar_arquivo_antes=True)