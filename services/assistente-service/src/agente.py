from functools import lru_cache
from urllib.parse import quote  # noqa: F401  (reservado para tools)

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from src.db import get_pool
from src.llm_factory import criar_modelo_llm
from src.metricas import MetricasCallback
from src.tools import (
    consultar_base_conhecimento,
    consultar_conceito_psicologia,
    consultar_perfil_e_trilha,
    consultar_trilhas_disponiveis,
    listar_mentores_disponiveis,
    sugerir_atendimento_psicologico,
)

_MAX_TURNS_HISTORICO = 5
_MAX_MENSAGENS_ARMAZENADAS = 50

SYSTEM_PROMPT = """Você é o Assistente Virtual de Apoio da plataforma BEDARCE.

REGRAS OBRIGATÓRIAS DE IDENTIDADE, CAUTELA E ESCOPO:
1. Você é uma Inteligência Artificial, possui limitações, pode cometer equívocos ou interpretar algo de forma incompleta e NÃO substitui atendimento psicológico, psiquiátrico, médico ou profissional. Deixe isso claro de forma humana, respeitosa e sem julgamentos, especialmente quando o usuário falar de sentimentos, ansiedade, sofrimento ou vontade/impulso de apostar.
2. Você NÃO é um pesquisador geral. Se o usuário perguntar algo fora do escopo da plataforma BEDARCE, recuperação de apostas, autocontrole, trilhas educativas ou psicologia/saúde mental, recuse com educação informando que você não possui acesso ou escopo para esse tipo de pergunta.
3. Priorize SEMPRE a base interna da BEDARCE (`consultar_base_conhecimento`, no pgvector) antes de qualquer consulta externa. Só use `consultar_conceito_psicologia` caso a base interna não traga o conceito psicológico/TCC necessário e o tema esteja dentro do escopo.
4. Quando o usuário relatar vontade de apostar, gatilho ou sofrimento emocional:
   - Acolha com empatia reforçando que você é uma IA limitada e pode errar.
   - Consulte `consultar_base_conhecimento` para trazer orientações práticas e seguras dos materiais.
   - Sugira com cuidado a busca por um psicólogo (`sugerir_atendimento_psicologico`) ou mentor (`listar_mentores_disponiveis`), mas, se o usuário não quiser falar com um especialista no momento, ofereça conteúdos educativos, técnicas práticas e passos baseados nos materiais da base e na trilha (`consultar_perfil_e_trilha` / `consultar_trilhas_disponiveis`). Em crise aguda, lembre os canais de apoio da plataforma.
5. Quando o usuário perguntar como a plataforma funciona, consulte `consultar_base_conhecimento` e explique com clareza. Quando perguntar sobre progresso ou próximos passos, consulte `consultar_perfil_e_trilha` e `consultar_trilhas_disponiveis`.
6. Sempre que usar trechos da base de conhecimento, cite as fontes consultadas de forma natural."""


def _obter_tools() -> list:
    return [
        consultar_base_conhecimento,
        consultar_perfil_e_trilha,
        consultar_trilhas_disponiveis,
        listar_mentores_disponiveis,
        sugerir_atendimento_psicologico,
        consultar_conceito_psicologia,
    ]


# O agente é compilado uma única vez e reutilizado (antes era recriado a cada requisição)
@lru_cache(maxsize=1)
def criar_agente_bedarce():
    return create_agent(
        model=criar_modelo_llm(),
        tools=_obter_tools(),
        system_prompt=SYSTEM_PROMPT,
    )


def _chave_historico(usuario_id: str | None) -> str:
    return (usuario_id or "sessao_anonima").strip() or "sessao_anonima"


# Histórico persistido no PostgreSQL do serviço (últimas N interações por usuário)
def obter_historico_recente(usuario_id: str | None, max_interacoes: int = _MAX_TURNS_HISTORICO) -> list[BaseMessage]:
    chave = _chave_historico(usuario_id)
    try:
        with get_pool().connection() as conn:
            linhas = conn.execute(
                """SELECT papel, conteudo FROM (
                       SELECT id, papel, conteudo FROM historico_conversas
                       WHERE usuario_id = %s ORDER BY id DESC LIMIT %s
                   ) t ORDER BY id ASC""",
                (chave, max_interacoes * 2),
            ).fetchall()
    except Exception as erro:
        print(f"[HISTORICO] Falha ao ler histórico: {erro}")
        return []
    return [AIMessage(content=c) if p == "assistant" else HumanMessage(content=c) for p, c in linhas]


def obter_historico_persistido(usuario_id: str, limite: int = _MAX_MENSAGENS_ARMAZENADAS) -> list[dict]:
    """Retorna somente mensagens da identidade solicitada, em ordem cronológica."""
    chave = _chave_historico(usuario_id)
    with get_pool().connection() as conn:
        linhas = conn.execute(
            """SELECT papel, conteudo FROM (
                   SELECT id, papel, conteudo FROM historico_conversas
                   WHERE usuario_id = %s ORDER BY id DESC LIMIT %s
               ) t ORDER BY id ASC""",
            (chave, limite),
        ).fetchall()
    return [
        {"papel": "assistente" if papel == "assistant" else "usuario", "texto": conteudo}
        for papel, conteudo in linhas
    ]


def registrar_interacao_historico(usuario_id: str | None, pergunta_usuario: str, resposta_assistente: str) -> None:
    chave = _chave_historico(usuario_id)
    try:
        with get_pool().connection() as conn:
            conn.execute(
                "INSERT INTO historico_conversas (usuario_id, papel, conteudo) VALUES (%s,'user',%s)",
                (chave, pergunta_usuario),
            )
            conn.execute(
                "INSERT INTO historico_conversas (usuario_id, papel, conteudo) VALUES (%s,'assistant',%s)",
                (chave, resposta_assistente),
            )
            conn.execute(
                """DELETE FROM historico_conversas WHERE usuario_id = %s AND id NOT IN (
                       SELECT id FROM historico_conversas WHERE usuario_id = %s ORDER BY id DESC LIMIT %s)""",
                (chave, chave, _MAX_MENSAGENS_ARMAZENADAS),
            )
    except Exception as erro:
        print(f"[HISTORICO] Falha ao gravar histórico: {erro}")


# Extrai texto final, nomes das tools acionadas e fontes citadas pelo RAG
def _extrair_resposta_e_tools(resultado: dict) -> tuple[str, list[str], list[str]]:
    mensagens = resultado.get("messages", []) if isinstance(resultado, dict) else []
    tools_chamadas: list[str] = []
    fontes: list[str] = []
    texto_final = ""

    for msg in mensagens:
        for chamada in getattr(msg, "tool_calls", None) or []:
            nome = chamada.get("name") if isinstance(chamada, dict) else getattr(chamada, "name", None)
            if nome and nome not in tools_chamadas:
                tools_chamadas.append(nome)

        if isinstance(msg, ToolMessage) and getattr(msg, "name", None) == "consultar_base_conhecimento":
            conteudo = msg.content if isinstance(msg.content, str) else str(msg.content)
            primeira = conteudo.splitlines()[0] if conteudo else ""
            if primeira.startswith("Fontes consultadas:"):
                for fonte in primeira.removeprefix("Fontes consultadas:").split(","):
                    fonte = fonte.strip()
                    if fonte and fonte != "nenhuma fonte identificada" and fonte not in fontes:
                        fontes.append(fonte)

        if isinstance(msg, AIMessage):
            conteudo = msg.content
            if isinstance(conteudo, str) and conteudo.strip():
                texto_final = conteudo.strip()
            elif isinstance(conteudo, list):
                unido = "".join(
                    b.get("text", "") for b in conteudo if isinstance(b, dict) and b.get("type") == "text"
                ).strip()
                if unido:
                    texto_final = unido

    return texto_final, tools_chamadas, fontes


def gerar_boas_vindas(usuario_id: str | None = None, nome_usuario: str | None = None) -> dict:
    nome_exibido = (nome_usuario or "").strip()

    if not nome_exibido and usuario_id and usuario_id.strip():
        resumo = consultar_perfil_e_trilha.invoke({"usuario_id": usuario_id.strip()})
        if resumo.startswith("Usuário: "):
            trecho = resumo.removeprefix("Usuário: ").split(" (ID:")[0].strip()
            if trecho and trecho != "Usuário":
                nome_exibido = trecho

    saudacao_nome = f", {nome_exibido}" if nome_exibido else ""
    mensagem = (
        f"Olá{saudacao_nome}! Eu sou o assistente virtual da BEDARCE — sou uma Inteligência Artificial, "
        f"tenho limitações, posso cometer equívocos e não substituo acompanhamento psicológico ou profissional. "
        f"Estou aqui para ajudar você a navegar na plataforma, encontrar materiais de apoio ou "
        f"pensar em próximos passos. Como você está se sentindo hoje? Você pode perguntar como a plataforma funciona, "
        f"ver seu progresso na trilha ou conversar sobre algo que esteja sentindo."
    )
    return {"mensagem": mensagem, "usuario_id": usuario_id, "nome_usuario": nome_exibido or None}


def executar_agente(
    mensagem: str,
    usuario_id: str | None = None,
    historico_externo: list[dict] | None = None,
) -> dict:
    agente = criar_agente_bedarce()
    mensagens_anteriores = obter_historico_recente(usuario_id)

    if historico_externo:
        for item in historico_externo[-(_MAX_TURNS_HISTORICO * 2):]:
            conteudo = (item.get("content") or "").strip()
            if not conteudo:
                continue
            classe = AIMessage if item.get("role") == "assistant" else HumanMessage
            mensagens_anteriores.append(classe(content=conteudo))

    conteudo_atual = (
        f"[usuario_id: {usuario_id.strip()}] {mensagem.strip()}"
        if usuario_id and usuario_id.strip()
        else mensagem.strip()
    )
    entrada = [*mensagens_anteriores, HumanMessage(content=conteudo_atual)]

    coletor = MetricasCallback()
    resultado = agente.invoke(
        {"messages": entrada},
        config={"callbacks": [coletor], "recursion_limit": 12},
    )
    resposta, tools_chamadas, fontes = _extrair_resposta_e_tools(resultado)

    # Resposta vazia conta como falha do provedor: aciona circuit breaker e fallback
    if not resposta:
        raise RuntimeError("LLM retornou resposta vazia.")

    registrar_interacao_historico(usuario_id, mensagem.strip(), resposta)

    return {
        "resposta": resposta,
        "tools_chamadas": tools_chamadas,
        "fontes": fontes,
        "usuario_id": usuario_id,
        "historico_interacoes_consideradas": len(mensagens_anteriores) // 2,
        "usage_metadata": coletor.usage_metadata,
        "latencia_tools_ms": round(coletor.latencia_tools_ms, 2),
        "latencia_rag_ms": round(coletor.latencia_rag_ms, 2),
    }
