import argparse
from functools import lru_cache
from pathlib import Path
from threading import Lock

from langchain_core.documents import Document
from langchain_community.document_loaders import PyPDFLoader
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_postgres import PGVector
from langchain_text_splitters import RecursiveCharacterTextSplitter

from src.config import settings
from src.db import LOCK_INGESTAO, advisory_lock, get_pool, inicializar_schema, obter_engine

_estado: dict = {"vectorstore": None}
_lock = Lock()


# Modelo local de embeddings multilíngue (carregado uma única vez por processo)
@lru_cache(maxsize=1)
def obter_embeddings() -> HuggingFaceEmbeddings:
    return HuggingFaceEmbeddings(
        model_name="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        model_kwargs={"device": "cpu"},
        encode_kwargs={"normalize_embeddings": True},
    )


def _extrair_titulo_markdown(texto: str, padrao: str) -> str:
    for linha in texto.splitlines():
        linha_limpa = linha.strip()
        if linha_limpa.startswith("#"):
            return linha_limpa.lstrip("#").strip()
    return padrao


def carregar_documentos_base(diretorio_base: str | None = None) -> list[Document]:
    base_path = Path(diretorio_base or settings.base_conhecimento_dir)
    documentos: list[Document] = []
    if not base_path.exists():
        return documentos

    for caminho_md in sorted(base_path.rglob("*.md")):
        conteudo = caminho_md.read_text(encoding="utf-8").strip()
        if not conteudo:
            continue
        documentos.append(
            Document(
                page_content=conteudo,
                metadata={
                    "fonte": caminho_md.name,
                    "caminho": str(caminho_md),
                    "tipo": "markdown",
                    "titulo": _extrair_titulo_markdown(conteudo, caminho_md.stem),
                },
            )
        )

    for caminho_pdf in sorted(base_path.rglob("*.pdf")):
        try:
            for pagina in PyPDFLoader(str(caminho_pdf)).load():
                texto_pagina = pagina.page_content.strip()
                if not texto_pagina:
                    continue
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
            print(f"[AVISO] Falha ao ler PDF '{caminho_pdf.name}': {erro}")

    return documentos


def dividir_em_chunks(documentos: list[Document]) -> list[Document]:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=600,
        chunk_overlap=100,
        separators=["\n## ", "\n### ", "\n\n", "\n", " "],
    )
    chunks = splitter.split_documents(documentos)
    for indice, chunk in enumerate(chunks):
        chunk.metadata["chunk_id"] = indice
        if "titulo" not in chunk.metadata:
            chunk.metadata["titulo"] = _extrair_titulo_markdown(
                chunk.page_content, chunk.metadata.get("fonte", "documento")
            )
    return chunks


def _criar_vectorstore(embeddings: HuggingFaceEmbeddings) -> PGVector:
    return PGVector(
        embeddings=embeddings,
        collection_name=settings.colecao_vetorial,
        connection=obter_engine(),
        use_jsonb=True,
    )


def contar_vetores() -> int:
    with get_pool().connection() as conn:
        linha = conn.execute(
            """SELECT COUNT(*) FROM langchain_pg_embedding e
               JOIN langchain_pg_collection c ON c.uuid = e.collection_id
               WHERE c.name = %s""",
            (settings.colecao_vetorial,),
        ).fetchone()
    return int(linha[0])


# Indexa os chunks no PostgreSQL/pgvector (idempotente e seguro com várias réplicas)
def indexar_base_conhecimento(
    forcar_reindexacao: bool = False,
    embeddings: HuggingFaceEmbeddings | None = None,
) -> PGVector:
    emb = embeddings or obter_embeddings()
    with advisory_lock(LOCK_INGESTAO):
        vectorstore = _criar_vectorstore(emb)
        existentes = contar_vetores()
        if existentes > 0 and not forcar_reindexacao:
            return vectorstore

        if forcar_reindexacao and existentes > 0:
            vectorstore.delete_collection()
            vectorstore.create_collection()

        documentos = carregar_documentos_base()
        chunks = dividir_em_chunks(documentos)
        if chunks:
            vectorstore.add_documents(chunks)
            print(f"[INGESTAO] {len(chunks)} chunks de {len(documentos)} documentos/páginas indexados no pgvector.")
        else:
            print("[AVISO] Nenhum documento válido encontrado para indexar.")
    return vectorstore


# Devolve o vectorstore já pronto (cache em memória, sem recarregar modelo a cada requisição)
def garantir_base_vetorial(forcar_reindexacao: bool = False) -> PGVector:
    if _estado["vectorstore"] is not None and not forcar_reindexacao:
        return _estado["vectorstore"]
    with _lock:
        if _estado["vectorstore"] is None or forcar_reindexacao:
            _estado["vectorstore"] = indexar_base_conhecimento(forcar_reindexacao)
        return _estado["vectorstore"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ingestão da base de conhecimento BEDARCE no pgvector.")
    parser.add_argument("--reindex", action="store_true", help="Recria embeddings e reindexa tudo.")
    args = parser.parse_args()
    inicializar_schema()
    garantir_base_vetorial(forcar_reindexacao=args.reindex)
    print(f"[OK] Total de vetores na coleção '{settings.colecao_vetorial}': {contar_vetores()}")