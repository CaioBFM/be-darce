import httpx
from langchain_core.tools import tool
from src.config import settings
from src.rag import extrair_fontes, formatar_docs_com_fontes, obter_retriever

# Define palavras-chave permitidas para restringir consultas externas apenas ao domínio de psicologia e apostas
_TERMOS_PERMITIDOS_PSICOLOGIA = (
    "psicologia",
    "psicologico",
    "psicologica",
    "psiquiatria",
    "terapia",
    "cognitivo",
    "comportamental",
    "tcc",
    "transtorno do jogo",
    "jogo patologico",
    "vicio",
    "dependencia",
    "impulso",
    "recaida",
    "fissura",
    "ansiedade",
    "depressao",
    "estresse",
    "regulacao emocional",
    "emocao",
    "autoestima",
    "culpa",
    "vergonha",
    "apoio",
    "mentoria",
    "dsm",
)


# Verifica se a consulta externa está estritamente dentro do domínio de psicologia, saúde mental e apostas
def _eh_tema_psicologia_permitido(texto: str) -> bool:
    texto_lower = texto.lower()
    # Permite a consulta apenas se houver ao menos um termo ligado a psicologia, saúde mental ou apostas
    return any(termo in texto_lower for termo in _TERMOS_PERMITIDOS_PSICOLOGIA)


# Executa requisições HTTP GET internas via Gateway com tratamento seguro de timeouts e erros de rede
def _chamar_gateway_get(caminho: str, params: dict | None = None, headers: dict | None = None) -> tuple[bool, object]:
    base_url = settings.gateway_internal_url.rstrip("/")
    url = f"{base_url}{caminho}"
    try:
        # Usa timeout curto para não travar o agente caso algum serviço interno esteja indisponível
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(url, params=params, headers=headers)
            if resp.status_code == 200:
                return True, resp.json()
            return False, f"HTTP {resp.status_code}"
    except Exception as erro:
        return False, str(erro)


# Busca trechos nos materiais da BEDARCE (.md e .pdf no ChromaDB) para responder dúvidas dentro do contexto
@tool
def consultar_base_conhecimento(duvida: str) -> str:
    """Consulta a base de conhecimento da BEDARCE (documentos da plataforma e PDFs sobre transtorno do jogo, TCC e prevenção de recaídas). Use apenas para dúvidas dentro do domínio da plataforma, recuperação de apostas, autocontrole e psicologia."""
    # Obtém o retriever configurado no ChromaDB e recupera os trechos mais relevantes
    retriever = obter_retriever(k=4)
    docs = retriever.invoke(duvida)
    fontes = extrair_fontes(docs)
    contexto = formatar_docs_com_fontes(docs)
    fontes_texto = ", ".join(fontes) if fontes else "nenhuma fonte identificada"
    return f"Fontes consultadas: {fontes_texto}\n\nTrechos recuperados:\n{contexto}"


# Consulta dados do usuário e seu progresso na trilha de gamificação passando pelo Gateway
@tool
def consultar_perfil_e_trilha(usuario_id: str) -> str:
    """Consulta o perfil do usuário (em usuarios-service) e o progresso na trilha de gamificação (em gamificacao-leitura-service) via Gateway. Use quando o usuário perguntar sobre seu perfil, nível, pontos ou avanço na trilha."""
    # Busca os dados básicos do usuário no serviço de usuários via Gateway
    ok_user, dados_user = _chamar_gateway_get(f"/v1/usuarios/{usuario_id}")
    # Busca o progresso na trilha no modelo de leitura da gamificação via Gateway
    ok_prog, dados_prog = _chamar_gateway_get(f"/v1/usuarios/{usuario_id}/progresso")

    partes: list[str] = []
    if ok_user and isinstance(dados_user, dict):
        nome = dados_user.get("nome", "Usuário")
        papel = dados_user.get("papel", "PACIENTE")
        ativo = dados_user.get("ativo", True)
        partes.append(f"Usuário: {nome} (ID: {usuario_id}) | Papel: {papel} | Ativo: {ativo}")
    else:
        partes.append(f"Perfil do usuário '{usuario_id}' indisponível no momento ({dados_user}).")

    if ok_prog and isinstance(dados_prog, dict):
        nivel = dados_prog.get("nivel", 1)
        pontos = dados_prog.get("pontosTotais", 0)
        etapas_conc = dados_prog.get("etapasConcluidas", 0)
        total_etapas = dados_prog.get("totalEtapas", 0)
        trilhas = dados_prog.get("trilhas", [])
        partes.append(
            f"Gamificação: Nível {nivel} | Pontos: {pontos} | Etapas concluídas: {etapas_conc}/{total_etapas}"
        )
        # Lista o progresso por trilha para ajudar na recomendação da próxima etapa
        if isinstance(trilhas, list) and trilhas:
            resumo_trilhas = "; ".join(
                f"{t.get('nome', t.get('trilhaId'))}: {t.get('etapasConcluidas', 0)}/{t.get('totalEtapas', 0)} ({t.get('progressoPercentual', 0)}%)"
                for t in trilhas
            )
            partes.append(f"Trilhas: {resumo_trilhas}")
    else:
        partes.append(f"Progresso na trilha indisponível no momento ({dados_prog}).")

    return "\n".join(partes)


# Lista as trilhas disponíveis na plataforma filtrando por público-alvo via Gateway
@tool
def consultar_trilhas_disponiveis(publico_alvo: str = "PACIENTE") -> str:
    """Consulta as trilhas educativas ativas na plataforma BEDARCE para um público-alvo (ex.: PACIENTE). Use quando o usuário quiser conhecer as trilhas disponíveis ou começar/avançar na jornada."""
    # Consulta o endpoint de trilhas do serviço de leitura via Gateway
    ok, dados = _chamar_gateway_get("/v1/trilhas", params={"publicoAlvo": publico_alvo})
    if not ok or not isinstance(dados, dict):
        return f"Não foi possível consultar as trilhas no momento ({dados})."

    itens = dados.get("items", [])
    # Informa quando não há trilhas cadastradas para o público solicitado
    if not itens:
        return f"Nenhuma trilha ativa encontrada para o público '{publico_alvo}' no momento."

    linhas: list[str] = []
    # Resume nome, descrição e etapas de cada trilha retornada
    for trilha in itens:
        nome = trilha.get("nome", "Trilha")
        desc = trilha.get("descricao", "")
        etapas = trilha.get("etapas", [])
        etapas_nomes = ", ".join(e.get("titulo", "Etapa") for e in etapas) if isinstance(etapas, list) else ""
        linhas.append(f"- {nome}: {desc} | Etapas: {etapas_nomes}")

    return "Trilhas disponíveis:\n" + "\n".join(linhas)


# Consulta mentores ativos na comunidade via Gateway para sugerir apoio entre pares
@tool
def listar_mentores_disponiveis() -> str:
    """Consulta os mentores cadastrados na comunidade BEDARCE via Gateway. Use quando o usuário buscar troca de experiências com mentores ou apoio entre pares."""
    # Busca a lista de mentores no serviço de comunidade via Gateway
    ok, dados = _chamar_gateway_get("/v1/mentores")
    if not ok or not isinstance(dados, list):
        return f"Não foi possível consultar a lista de mentores no momento ({dados})."

    # Filtra apenas mentores com status ATIVO quando o campo existir
    ativos = [m for m in dados if m.get("status", "ATIVO") == "ATIVO"]
    if not ativos:
        return "Nenhum mentor ativo encontrado no momento na comunidade."

    linhas = [
        f"- {m.get('nome', 'Mentor')} (ID: {m.get('usuarioId', '-')}, status: {m.get('status', 'ATIVO')})"
        for m in ativos
    ]
    return "Mentores disponíveis na comunidade:\n" + "\n".join(linhas)


# Orienta sobre busca de psicólogo na plataforma quando ainda não há endpoint específico de psicólogos
@tool
def sugerir_atendimento_psicologico(motivo: str = "") -> str:
    """Orienta o usuário sobre como buscar acompanhamento psicológico na BEDARCE quando ele precisar de suporte clínico. Como ainda não há listagem específica de psicólogos na API, orienta a procurar um psicólogo geral na plataforma."""
    # Retorna orientação geral e segura sem inventar profissionais ou dados inexistentes
    foco = f" relacionada a '{motivo}'" if motivo else ""
    return (
        f"No momento não há uma listagem individual de psicólogos disponível na consulta automática{foco}. "
        "Recomende ao usuário procurar um psicólogo na área de atendimento da plataforma BEDARCE "
        "para acompanhamento profissional adequado, reforçando que a IA não substitui um psicólogo."
    )


# Consulta conceitos gerais restritos exclusivamente a psicologia, saúde mental e transtorno do jogo
@tool
def consultar_conceito_psicologia(tema: str) -> str:
    """Busca definições conceituais em português restritas a psicologia, saúde mental, TCC e transtorno do jogo. Bloqueia assuntos fora desse escopo."""
    # Bloqueia qualquer tema fora de psicologia, saúde mental e apostas antes de fazer busca externa
    if not _eh_tema_psicologia_permitido(tema):
        return (
            "BLOQUEADO_ESCOPO: Este assistente não é um pesquisador geral e só pode consultar "
            "assuntos relacionados à plataforma BEDARCE, recuperação de apostas, TCC e psicologia."
        )

    try:
        import wikipedia  # importação local para não quebrar caso a biblioteca não esteja instalada

        # Configura o idioma português e busca um resumo curto do conceito psicológico
        wikipedia.set_lang("pt")
        try:
            resumo = wikipedia.summary(tema, sentences=3)
        except wikipedia.exceptions.DisambiguationError as erro:
            resumo = wikipedia.summary(erro.options[0], sentences=3)
        return f"Referência conceitual ({tema}): {resumo}"
    except Exception:
        return f"Não foi possível obter definição externa para '{tema}' no momento."