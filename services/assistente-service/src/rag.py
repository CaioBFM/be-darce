import time
from langchain_core.documents import Document
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnablePassthrough
from src.ingestao import garantir_base_vetorial
from src.llm_factory import criar_modelo_llm


# Cria e retorna o retriever configurado para buscar os k trechos mais relevantes no ChromaDB
def obter_retriever(k: int = 4):
    # Garante que o banco vetorial exista e esteja populado antes de criar o retriever
    vectorstore = garantir_base_vetorial(forcar_reindexacao=False)
    return vectorstore.as_retriever(search_kwargs={"k": k})


# Formata os documentos recuperados incluindo fonte e página para fundamentar e citar o contexto
def formatar_docs_com_fontes(docs: list[Document]) -> str:
    # Retorna aviso explícito quando nenhum trecho relevante é encontrado
    if not docs:
        return "Nenhum material específico encontrado na base de conhecimento."

    blocos: list[str] = []
    # Monta cada bloco textual com identificação de origem para facilitar citação na resposta
    for doc in docs:
        fonte = doc.metadata.get("fonte", "material_desconhecido")
        pagina = doc.metadata.get("pagina")
        origem = f"{fonte} (pág. {pagina})" if pagina else fonte
        blocos.append(f"[Fonte: {origem}]\n{doc.page_content.strip()}")

    return "\n\n---\n\n".join(blocos)


# Extrai a lista única de fontes consultadas a partir dos documentos recuperados
def extrair_fontes(docs: list[Document]) -> list[str]:
    fontes: list[str] = []
    # Mantém a ordem de relevância evitando nomes de fontes duplicados
    for doc in docs:
        fonte = doc.metadata.get("fonte")
        if fonte and fonte not in fontes:
            fontes.append(fonte)
    return fontes


# Cria o template de prompt que obriga o modelo a responder com base no contexto recuperado
def _criar_prompt_rag() -> ChatPromptTemplate:
    sistema = (
        "Você é um assistente de apoio informativo da plataforma BEDARCE. "
        "Responda à pergunta usando prioritariamente o CONTEXTO fornecido abaixo. "
        "Se o contexto não contiver informação suficiente, diga claramente o que não está "
        "especificado nos materiais sem inventar dados, e cite sempre o nome das fontes utilizadas."
    )
    usuario = (
        "Contexto recuperado:\n{contexto}\n\n"
        "Pergunta:\n{pergunta}"
    )
    return ChatPromptTemplate.from_messages([
        ("system", sistema),
        ("human", usuario),
    ])


# Monta e retorna a Chain LCEL completa de RAG usando o operador pipe (|)
def construir_rag_chain(k: int = 4):
    retriever = obter_retriever(k=k)
    prompt_rag = _criar_prompt_rag()
    llm = criar_modelo_llm()

    # Compõe a cadeia LCEL: recupera contexto, formata com fontes, monta prompt, chama LLM e extrai texto
    rag_chain = (
        {
            "contexto": retriever | formatar_docs_com_fontes,
            "pergunta": RunnablePassthrough(),
        }
        | prompt_rag
        | llm
        | StrOutputParser()
    )
    return rag_chain


# Executa uma consulta RAG completa retornando resposta, fontes utilizadas e tempo de recuperação em ms
def consultar_rag_com_fontes(pergunta: str, k: int = 4) -> dict:
    retriever = obter_retriever(k=k)

    # Mede o tempo gasto apenas na etapa de recuperação vetorial (embedding da query + busca no ChromaDB)
    inicio_busca = time.perf_counter()
    docs_recuperados = retriever.invoke(pergunta)
    latencia_busca_ms = (time.perf_counter() - inicio_busca) * 1000

    # Extrai as fontes únicas para que o assistente possa citá-las explicitamente
    fontes = extrair_fontes(docs_recuperados)
    contexto_formatado = formatar_docs_com_fontes(docs_recuperados)

    # Executa o restante da chain (prompt -> LLM -> parser) com o contexto já recuperado
    prompt_rag = _criar_prompt_rag()
    llm = criar_modelo_llm()
    chain_geracao = prompt_rag | llm | StrOutputParser()
    resposta = chain_geracao.invoke({"contexto": contexto_formatado, "pergunta": pergunta})

    return {
        "resposta": resposta,
        "fontes": fontes,
        "chunks_recuperados": len(docs_recuperados),
        "latencia_rag_ms": round(latencia_busca_ms, 2),
    }