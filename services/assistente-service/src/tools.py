from urllib.parse import quote

import httpx
from langchain_core.tools import tool

from src.config import settings
from src.rag import extrair_fontes, formatar_docs_com_fontes, obter_retriever

_TERMOS_PERMITIDOS_PSICOLOGIA = (
    "psicologia", "psicologico", "psicologica", "psiquiatria", "terapia", "cognitivo",
    "comportamental", "tcc", "transtorno do jogo", "jogo patologico", "vicio", "dependencia",
    "impulso", "recaida", "fissura", "ansiedade", "depressao", "estresse", "regulacao emocional",
    "emocao", "autoestima", "culpa", "vergonha", "apoio", "mentoria", "dsm",
)


def _eh_tema_psicologia_permitido(texto: str) -> bool:
    texto_lower = texto.lower()
    return any(termo in texto_lower for termo in _TERMOS_PERMITIDOS_PSICOLOGIA)


# GET no listener INTERNO do Gateway (porta 8081, rotas /v1/services/...). Nunca fala direto com microsserviços.
def _chamar_gateway_get(caminho: str, params: dict | None = None, headers: dict | None = None) -> tuple[bool, object]:
    url = f"{settings.gateway_internal_url.rstrip('/')}{caminho}"
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(url, params=params, headers=headers)
            if resp.status_code == 200:
                return True, resp.json()
            return False, f"HTTP {resp.status_code}"
    except Exception as erro:
        return False, str(erro)


@tool
def consultar_base_conhecimento(duvida: str) -> str:
    """Consulta a base de conhecimento da BEDARCE (documentos da plataforma e PDFs sobre transtorno do jogo, TCC e prevenção de recaídas). Use apenas para dúvidas dentro do domínio da plataforma, recuperação de apostas, autocontrole e psicologia."""
    docs = obter_retriever(k=4).invoke(duvida)
    fontes = extrair_fontes(docs)
    contexto = formatar_docs_com_fontes(docs)
    fontes_texto = ", ".join(fontes) if fontes else "nenhuma fonte identificada"
    return f"Fontes consultadas: {fontes_texto}\n\nTrechos recuperados:\n{contexto}"


@tool
def consultar_perfil_e_trilha(usuario_id: str) -> str:
    """Consulta o perfil do usuário (usuarios-service) e o progresso na trilha de gamificação (gamificacao-leitura-service) via Gateway. Use quando o usuário perguntar sobre seu perfil, nível, pontos ou avanço na trilha."""
    ok_user, dados_user = _chamar_gateway_get(f"/v1/services/usuarios/usuarios/{quote(usuario_id, safe='')}")
    ok_prog, dados_prog = _chamar_gateway_get(
        "/v1/services/gamificacao-leitura/usuarios/me/progresso",
        headers={"X-Usuario-Id": usuario_id},
    )

    partes: list[str] = []
    if ok_user and isinstance(dados_user, dict):
        partes.append(
            f"Usuário: {dados_user.get('nome', 'Usuário')} (ID: {usuario_id}) | "
            f"Papel: {dados_user.get('papel', 'PACIENTE')} | Ativo: {dados_user.get('ativo', True)}"
        )
    else:
        partes.append(f"Perfil do usuário '{usuario_id}' indisponível no momento ({dados_user}).")

    if ok_prog and isinstance(dados_prog, dict):
        partes.append(
            f"Gamificação: Nível {dados_prog.get('nivel', 1)} | Pontos: {dados_prog.get('pontosTotais', 0)} | "
            f"Etapas concluídas: {dados_prog.get('etapasConcluidas', 0)}/{dados_prog.get('totalEtapas', 0)}"
        )
        trilhas = dados_prog.get("trilhas", [])
        if isinstance(trilhas, list) and trilhas:
            resumo = "; ".join(
                f"{t.get('nome', t.get('trilhaId'))}: {t.get('etapasConcluidas', 0)}/{t.get('totalEtapas', 0)} "
                f"({t.get('progressoPercentual', 0)}%)"
                for t in trilhas
            )
            partes.append(f"Trilhas: {resumo}")
    else:
        partes.append(f"Progresso na trilha indisponível no momento ({dados_prog}).")

    return "\n".join(partes)


@tool
def consultar_trilhas_disponiveis(publico_alvo: str = "PACIENTE") -> str:
    """Consulta as trilhas educativas ativas na plataforma BEDARCE para um público-alvo (ex.: PACIENTE). Use quando o usuário quiser conhecer as trilhas disponíveis ou começar/avançar na jornada."""
    ok, dados = _chamar_gateway_get(
        "/v1/services/gamificacao-leitura/trilhas", params={"publicoAlvo": publico_alvo}
    )
    if not ok or not isinstance(dados, dict):
        return f"Não foi possível consultar as trilhas no momento ({dados})."

    itens = dados.get("items", [])
    if not itens:
        return f"Nenhuma trilha ativa encontrada para o público '{publico_alvo}' no momento."

    linhas = []
    for trilha in itens:
        etapas = trilha.get("etapas", [])
        nomes = ", ".join(e.get("titulo", "Etapa") for e in etapas) if isinstance(etapas, list) else ""
        linhas.append(f"- {trilha.get('nome', 'Trilha')}: {trilha.get('descricao', '')} | Etapas: {nomes}")
    return "Trilhas disponíveis:\n" + "\n".join(linhas)


@tool
def listar_mentores_disponiveis() -> str:
    """Consulta os mentores cadastrados na comunidade BEDARCE via Gateway. Use quando o usuário buscar troca de experiências com mentores ou apoio entre pares."""
    ok, dados = _chamar_gateway_get("/v1/services/comunidade/mentores")
    if ok and isinstance(dados, dict):
        dados = dados.get("items", [])
    if not ok or not isinstance(dados, list):
        return f"Não foi possível consultar a lista de mentores no momento ({dados})."

    ativos = [m for m in dados if m.get("status", "ATIVO") == "ATIVO"]
    if not ativos:
        return "Nenhum mentor ativo encontrado no momento na comunidade."
    linhas = [
        f"- {m.get('nome', 'Mentor')} (ID: {m.get('usuarioId', '-')}, status: {m.get('status', 'ATIVO')})"
        for m in ativos
    ]
    return "Mentores disponíveis na comunidade:\n" + "\n".join(linhas)


@tool
def sugerir_atendimento_psicologico(motivo: str = "") -> str:
    """Orienta o usuário sobre como buscar acompanhamento psicológico na BEDARCE quando ele precisar de suporte clínico. Como ainda não há listagem específica de psicólogos na API, orienta a procurar um psicólogo geral na plataforma."""
    foco = f" relacionada a '{motivo}'" if motivo else ""
    return (
        f"No momento não há uma listagem individual de psicólogos disponível na consulta automática{foco}. "
        "Recomende ao usuário procurar um psicólogo na área de atendimento da plataforma BEDARCE "
        "para acompanhamento profissional adequado, reforçando que a IA não substitui um psicólogo."
    )


@tool
def consultar_conceito_psicologia(tema: str) -> str:
    """Busca definições conceituais em português restritas a psicologia, saúde mental, TCC e transtorno do jogo. Bloqueia assuntos fora desse escopo."""
    if not _eh_tema_psicologia_permitido(tema):
        return (
            "BLOQUEADO_ESCOPO: Este assistente não é um pesquisador geral e só pode consultar "
            "assuntos relacionados à plataforma BEDARCE, recuperação de apostas, TCC e psicologia."
        )
    try:
        import wikipedia

        wikipedia.set_lang("pt")
        try:
            resumo = wikipedia.summary(tema, sentences=3)
        except wikipedia.exceptions.DisambiguationError as erro:
            resumo = wikipedia.summary(erro.options[0], sentences=3)
        return f"Referência conceitual ({tema}): {resumo}"
    except Exception:
        return f"Não foi possível obter definição externa para '{tema}' no momento."