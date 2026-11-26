import argparse
from pathlib import Path
from langchain_chroma import Chroma
from langchain_community.document_loaders import PyPDFLoader
from langchain_core.documents import Document
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from src.config import settings


# Instancia o modelo local de embeddings multilíngue para gerar vetores sem custo de API
def obter_embeddings() -> HuggingFaceEmbeddings:
    # Configura o modelo HuggingFace para rodar na CPU de forma compatível com português
    return HuggingFaceEmbeddings(
        model_name="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        model_kwargs={"device": "cpu"},
        encode_kwargs={"normalize_embeddings": True},
    )


# Extrai o primeiro título Markdown de um texto para enriquecer os metadados do chunk
def _extrair_titulo_markdown(texto: str, padrao: str) -> str:
    # Percorre as linhas procurando o primeiro cabeçalho iniciado com '#'
    for linha in texto.splitlines():
        linha_limpa = linha.strip()
        if linha_limpa.startswith("#"):
            return linha_limpa.lstrip("#").strip()
    return padrao


# Carrega todos os arquivos .md e .pdf da pasta base de conhecimento com seus metadados
def carregar_documentos_base(diretorio_base: str | None = None) -> list[Document]:
    base_path = Path(diretorio_base or settings.base_conhecimento_dir)
    documentos: list[Document] = []

    # Retorna lista vazia se o diretório de base ainda não existir
    if not base_path.exists():
        return documentos

    # Varre recursivamente todos os arquivos .md (incluindo subpastas como mds/)
    for caminho_md in sorted(base_path.rglob("*.md")):
        conteudo = caminho_md.read_text(encoding="utf-8").strip()
        if not conteudo:
            continue
        titulo = _extrair_titulo_markdown(conteudo, caminho_md.stem)
        # Cria o documento LangChain anexando nome do arquivo, tipo e título
        documentos.append(
            Document(
                page_content=conteudo,
                metadata={
                    "fonte": caminho_md.name,
                    "caminho": str(caminho_md),
                    "tipo": "markdown",
                    "titulo": titulo,
                },
            )
        )

    # Varre recursivamente todos os arquivos .pdf (incluindo subpastas como pdfs/)
    for caminho_pdf in sorted(base_path.rglob("*.pdf")):
        try:
            # Carrega cada página do PDF separadamente usando PyPDFLoader
            loader = PyPDFLoader(str(caminho_pdf))
            paginas = loader.load()
            for pagina in paginas:
                texto_pagina = pagina.page_content.strip()
                if not texto_pagina:
                    continue
                # Preserva o número da página e o nome do PDF nos metadados
                documentos.append(
                    Document(
                        page_content=texto_pagina,
                        metadata={
                            "fonte": caminho_pdf.name,
                            "caminho": str(caminho_pdf),
                            "tipo": "pdf",
                            "titulo": caminho_pdf.stem,
                            "pagina": pagina.metadata.get("page", 0) + 1,
                        },
                    )
                )
        except Exception as erro:
            # Registra aviso sem abortar a ingestão dos demais arquivos caso um PDF esteja corrompido ou protegido
            print(f"[AVISO] Falha ao ler PDF '{caminho_pdf.name}': {erro}")

    return documentos


# Divide os documentos carregados em chunks menores preservando parágrafos e seções
def dividir_em_chunks(documentos: list[Document]) -> list[Document]:
    # Configura o splitter com tamanho de 600 caracteres, sobreposição de 100 e separadores hierárquicos
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=600,
        chunk_overlap=100,
        separators=["\n## ", "\n### ", "\n\n", "\n", " "],
    )
    chunks = splitter.split_documents(documentos)

    # Garante que cada chunk mantenha o título da seção ou do arquivo nos metadados
    for indice, chunk in enumerate(chunks):
        chunk.metadata["chunk_id"] = indice
        if "titulo" not in chunk.metadata:
            chunk.metadata["titulo"] = _extrair_titulo_markdown(
                chunk.page_content, chunk.metadata.get("fonte", "documento")
            )

    return chunks


# Indexa os chunks no ChromaDB persistente e retorna o objeto vectorstore
def indexar_base_conhecimento(
    forcar_reindexacao: bool = False,
    embeddings: HuggingFaceEmbeddings | None = None,
) -> Chroma:
    emb = embeddings or obter_embeddings()
    persist_dir = Path(settings.chroma_dir)
    persist_dir.mkdir(parents=True, exist_ok=True)

    # Abre a coleção persistida no ChromaDB
    vectorstore = Chroma(
        collection_name="bedarce_conhecimento",
        embedding_function=emb,
        persist_directory=str(persist_dir),
    )

    # Verifica quantos vetores já existem na coleção para evitar reprocessamento desnecessário
    quantidade_existente = vectorstore._collection.count()
    if quantidade_existente > 0 and not forcar_reindexacao:
        return vectorstore

    # Se forçado a reindexar e já houver dados, limpa a coleção antes de reinserir
    if forcar_reindexacao and quantidade_existente > 0:
        ids_existentes = vectorstore._collection.get()["ids"]
        if ids_existentes:
            vectorstore._collection.delete(ids=ids_existentes)

    # Executa as etapas de carregamento e chunking dos arquivos .md e .pdf
    documentos = carregar_documentos_base()
    chunks = dividir_em_chunks(documentos)

    # Adiciona os chunks ao banco vetorial apenas se houver conteúdo extraído
    if chunks:
        vectorstore.add_documents(chunks)
        print(
            f"[INGESTAO] Indexados {len(chunks)} chunks de {len(documentos)} documentos/páginas em '{persist_dir}'."
        )
    else:
        print("[AVISO] Nenhum documento válido encontrado para indexar.")

    return vectorstore


# Garante que a base vetorial esteja pronta ao iniciar o serviço e permite execução via linha de comando
def garantir_base_vetorial(forcar_reindexacao: bool = False) -> Chroma:
    return indexar_base_conhecimento(forcar_reindexacao=forcar_reindexacao)


# Permite rodar este arquivo diretamente no terminal para testar ou reindexar a base
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ingestão da base de conhecimento BEDARCE no ChromaDB.")
    parser.add_argument(
        "--reindex",
        action="store_true",
        help="Recria os embeddings e reindexa todos os arquivos .md e .pdf do zero.",
    )
    args = parser.parse_args()
    store = garantir_base_vetorial(forcar_reindexacao=args.reindex)
    print(f"[OK] Total de vetores na coleção 'bedarce_conhecimento': {store._collection.count()}")