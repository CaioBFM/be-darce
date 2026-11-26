from collections import defaultdict
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from src.llm_factory import criar_modelo_llm
from src.tools import (
    consultar_base_conhecimento,
    consultar_conceito_psicologia,
    consultar_perfil_e_trilha,
    consultar_trilhas_disponiveis,
    listar_mentores_disponiveis,
    sugerir_atendimento_psicologico,
)

# Limita a memória de conversa às últimas 5 interações por chave de usuário ou sessão
_MAX_TURNS_HISTORICO = 5
# Armazena o histórico recente de mensagens em memória indexado por chave de usuário
_HISTORICO_POR_USUARIO: dict[str, list[BaseMessage]] = defaultdict(list)

# Define o System Prompt com identidade de IA limitada, prioridade do ChromaDB, cautela e bloqueio de escopo
SYSTEM_PROMPT = """Você é o Assistente Virtual de Apoio da plataforma BEDARCE.

REGRAS OBRIGATÓRIAS DE IDENTIDADE, CAUTELA E ESCOPO:
1. Você é uma Inteligência Artificial, possui limitações, pode cometer equívocos ou interpretar algo de forma incompleta e NÃO substitui atendimento psicológico, psiquiátrico, médico ou profissional. Deixe isso claro de forma humana, respeitosa e sem julgamentos, especialmente quando o usuário falar de sentimentos, ansiedade, sofrimento ou vontade/impulso de apostar.
2. Você NÃO é um pesquisador geral. Se o usuário perguntar algo fora do escopo da plataforma BEDARCE, recuperação de apostas, autocontrole, trilhas educativas ou psicologia/saúde mental, recuse com educação informando que você não possui acesso ou escopo para esse tipo de pergunta.
3. Priorize SEMPRE a base interna da BEDARCE (`consultar_base_conhecimento`, no ChromaDB) antes de qualquer consulta externa. Só use `consultar_conceito_psicologia` caso a base interna não traga o conceito psicológico/TCC necessário e o tema esteja dentro do escopo.
4. Quando o usuário relatar vontade de apostar, gatilho ou sofrimento emocional:
   - Acolha com empatia reforçando que você é uma IA limitada e pode errar.
   - Consulte `consultar_base_conhecimento` para trazer orientações práticas e seguras dos materiais.
   - Sugira com cuidado a busca por um psicólogo (`sugerir_atendimento_psicologico`) ou mentor (`listar_mentores_disponiveis`), mas, se o usuário não quiser falar com um especialista no momento, ofereça conteúdos educativos, técnicas práticas e passos baseados nos materiais do ChromaDB e na trilha (`consultar_perfil_e_trilha` / `consultar_trilhas_disponiveis`). Em crise aguda, lembre os canais de apoio da plataforma.
5. Quando o usuário perguntar como a plataforma funciona, consulte `consultar_base_conhecimento` e explique com clareza. Quando perguntar sobre progresso ou próximos passos, consulte `consultar_perfil_e_trilha` e `consultar_trilhas_disponiveis`.
6. Sempre que usar trechos da base de conhecimento, cite as fontes consultadas de forma natural."""


# Retorna a lista de tools disponíveis para o agente LangChain
def _obter_tools() -> list:
    # Agrupa todas as ferramentas internas via Gateway, RAG no ChromaDB e consulta restrita de psicologia
    return [
        consultar_base_conhecimento,
        consultar_perfil_e_trilha,
        consultar_trilhas_disponiveis,
        listar_mentores_disponiveis,
        sugerir_atendimento_psicologico,
        consultar_conceito_psicologia,
    ]


# Constrói a instância do agente LangChain usando create_agent e o factory agnóstico de LLM
def criar_agente_bedarce():
    # Instancia o modelo configurado no .env (Groq, Gemini, Ollama ou OpenAI)
    modelo = criar_modelo_llm()
    # Cria o agente com as tools e o prompt de sistema da BEDARCE
    return create_agent(
        model=modelo,
        tools=_obter_tools(),
        system_prompt=SYSTEM_PROMPT,
    )


# Resolve a chave usada para guardar o histórico recente do usuário ou sessão anônima
def _chave_historico(usuario_id: str | None) -> str:
    return (usuario_id or "sessao_anonima").strip() or "sessao_anonima"


# Recupera as últimas N interações (pares/mensagens recentes) salvas para a chave informada
def obter_historico_recente(usuario_id: str | None, max_interacoes: int = _MAX_TURNS_HISTORICO) -> list[BaseMessage]:
    chave = _chave_historico(usuario_id)
    mensagens = _HISTORICO_POR_USUARIO.get(chave, [])
    # Mantém no máximo as últimas (max_interacoes * 2) mensagens (pergunta + resposta por interação)
    limite_mensagens = max_interacoes * 2
    return list(mensagens[-limite_mensagens:])


# Registra uma nova interação (mensagem do usuário e resposta do assistente) mantendo no máximo 5 anteriores
def registrar_interacao_historico(
    usuario_id: str | None,
    pergunta_usuario: str,
    resposta_assistente: str,
    max_interacoes: int = _MAX_TURNS_HISTORICO,
) -> None:
    chave = _chave_historico(usuario_id)
    lista = _HISTORICO_POR_USUARIO[chave]
    # Adiciona a mensagem do usuário e a resposta final do agente ao histórico
    lista.append(HumanMessage(content=pergunta_usuario))
    lista.append(AIMessage(content=resposta_assistente))
    # Descarta interações antigas além do limite de 5 interações anteriores
    limite_mensagens = max_interacoes * 2
    if len(lista) > limite_mensagens:
        _HISTORICO_POR_USUARIO[chave] = lista[-limite_mensagens:]


# Extrai o texto final da resposta e os nomes das tools acionadas durante a execução do agente
def _extrair_resposta_e_tools(resultado: dict) -> tuple[str, list[str]]:
    mensagens = resultado.get("messages", []) if isinstance(resultado, dict) else []
    tools_chamadas: list[str] = []
    texto_final = ""

    # Percorre as mensagens geradas pelo agente para registrar tools chamadas e obter a última resposta
    for msg in mensagens:
        tool_calls = getattr(msg, "tool_calls", None)
        if tool_calls:
            for chamada in tool_calls:
                nome_tool = chamada.get("name") if isinstance(chamada, dict) else getattr(chamada, "name", None)
                if nome_tool and nome_tool not in tools_chamadas:
                    tools_chamadas.append(nome_tool)

        # Captura o conteúdo textual de mensagens da IA que não sejam apenas pedidos de tool
        if isinstance(msg, AIMessage) and not isinstance(msg, ToolMessage):
            conteudo = msg.content
            if isinstance(conteudo, str) and conteudo.strip():
                texto_final = conteudo.strip()
            elif isinstance(conteudo, list):
                partes_texto = [
                    bloco.get("text", "")
                    for bloco in conteudo
                    if isinstance(bloco, dict) and bloco.get("type") == "text"
                ]
                unido = "".join(partes_texto).strip()
                if unido:
                    texto_final = unido

    return texto_final, tools_chamadas


# Gera a mensagem inicial de boas-vindas identificando a IA e apresentando opções de apoio e navegação
def gerar_boas_vindas(usuario_id: str | None = None, nome_usuario: str | None = None) -> dict:
    nome_exibido = (nome_usuario or "").strip()
    contexto_usuario = ""

    # Se um usuario_id for informado, busca o perfil e progresso via tool para personalizar a saudação
    if usuario_id and usuario_id.strip():
        resumo_perfil = consultar_perfil_e_trilha.invoke({"usuario_id": usuario_id.strip()})
        contexto_usuario = f" ({resumo_perfil.splitlines()[0]})" if resumo_perfil else ""
        if not nome_exibido and resumo_perfil.startswith("Usuário: "):
            # Extrai o nome exibido antes do parêntese de ID quando disponível
            trecho_nome = resumo_perfil.removeprefix("Usuário: ").split(" (ID:")[0].strip()
            if trecho_nome and trecho_nome != "Usuário":
                nome_exibido = trecho_nome

    saudacao_nome = f", {nome_exibido}" if nome_exibido else ""
    mensagem = (
        f"Olá{saudacao_nome}! Eu sou o assistente virtual da BEDARCE — sou uma Inteligência Artificial, "
        f"tenho limitações, posso cometer equívocos e não substituo acompanhamento psicológico ou profissional. "
        f"Estou aqui para ajudar você a navegar na plataforma{contexto_usuario}, encontrar materiais de apoio ou "
        f"pensar em próximos passos. Como você está se sentindo hoje? Você pode perguntar como a plataforma funciona, "
        f"ver seu progresso na trilha ou conversar sobre algo que esteja sentindo."
    )
    return {
        "mensagem": mensagem,
        "usuario_id": usuario_id,
        "nome_usuario": nome_exibido or None,
    }


# Executa o agente com o histórico recente e retorna resposta e tools usadas
def executar_agente(
    mensagem: str,
    usuario_id: str | None = None,
    historico_externo: list[dict] | None = None,
) -> dict:
    agente = criar_agente_bedarce()
    # Carrega até as últimas 5 interações anteriores salvas para o usuário/sessão
    mensagens_anteriores = obter_historico_recente(usuario_id, max_interacoes=_MAX_TURNS_HISTORICO)

    # Inclui mensagens de histórico externo caso o chamador envie explicitamente
    if historico_externo:
        for item in historico_externo[-(_MAX_TURNS_HISTORICO * 2):]:
            role = item.get("role", "user")
            content = (item.get("content") or "").strip()
            if not content:
                continue
            if role == "assistant":
                mensagens_anteriores.append(AIMessage(content=content))
            else:
                mensagens_anteriores.append(HumanMessage(content=content))

    # Acrescenta o usuario_id ao conteúdo da mensagem atual quando presente para orientar as tools
    conteudo_atual = (
        f"[usuario_id: {usuario_id.strip()}] {mensagem.strip()}"
        if usuario_id and usuario_id.strip()
        else mensagem.strip()
    )
    mensagens_entrada = [*mensagens_anteriores, HumanMessage(content=conteudo_atual)]

    # Invoca o agente LangChain com o histórico recente e a mensagem atual
    resultado = agente.invoke({"messages": mensagens_entrada})
    resposta_texto, tools_chamadas = _extrair_resposta_e_tools(resultado)

    # Salva esta interação no histórico recente limitado a 5 interações
    registrar_interacao_historico(usuario_id, mensagem.strip(), resposta_texto)

    return {
        "resposta": resposta_texto,
        "tools_chamadas": tools_chamadas,
        "usuario_id": usuario_id,
        "historico_interacoes_consideradas": len(mensagens_anteriores) // 2,
    }