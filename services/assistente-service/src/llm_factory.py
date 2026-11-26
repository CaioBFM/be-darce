import os
from langchain.chat_models import init_chat_model
from langchain_core.language_models.chat_models import BaseChatModel
from src.config import settings


# Exporta as chaves lidas pelo Pydantic para as variáveis de ambiente exigidas pelos SDKs dos provedores
def _preparar_credenciais() -> None:
    # Verifica cada chave configurada antes de injetar no ambiente do processo
    if settings.groq_api_key:
        os.environ["GROQ_API_KEY"] = settings.groq_api_key
    if settings.google_api_key:
        os.environ["GOOGLE_API_KEY"] = settings.google_api_key
    if settings.openai_api_key:
        os.environ["OPENAI_API_KEY"] = settings.openai_api_key


# Instancia dinamicamente qualquer modelo de chat suportado pelo LangChain a partir da configuração
def criar_modelo_llm(
    provider: str | None = None,
    model: str | None = None,
    temperature: float | None = None,
) -> BaseChatModel:
    # Garante que as chaves de autenticação estejam disponíveis no ambiente antes de criar o cliente
    _preparar_credenciais()

    # Resolve o provedor, o nome do modelo e a temperatura usando os padrões do .env se não forem passados
    prov = (provider or settings.llm_provider).strip()
    mod = (model or settings.llm_model).strip()
    temp = settings.llm_temperature if temperature is None else temperature

    # Monta o dicionário base de parâmetros aceitos pela interface unificada init_chat_model
    kwargs: dict = {
        "model": mod,
        "model_provider": prov,
        "temperature": temp,
    }

    # Configura o endereço do servidor local se o provedor escolhido for o Ollama
    if prov == "ollama":
        kwargs["base_url"] = settings.ollama_base_url
    else:
        # Define o timeout e zera retries nativos do SDK para delegar o controle à nossa camada de resiliência
        kwargs["timeout"] = settings.llm_timeout_seconds
        kwargs["max_retries"] = 0

    # Retorna a instância do modelo pronta para uso em chains e agentes
    return init_chat_model(**kwargs)