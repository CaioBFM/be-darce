from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# Define a classe de configurações tipadas que carrega variáveis do arquivo .env
class Settings(BaseSettings):
    # Configura a busca pelo arquivo .env
    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Define a porta do microsserviço de IA e a URL interna do Gateway com valores padrões caso naõ ache o .env
    port_assistente: int = 5006
    gateway_internal_url: str = "http://localhost:8080"

    # Calcula os caminhos absolutos padrão para a base de conhecimento e para o banco vetorial ChromaDB
    base_conhecimento_dir: str = str(
        Path(__file__).resolve().parent.parent / "base_conhecimento"
    )
    chroma_dir: str = str(Path(__file__).resolve().parent.parent / "chroma_db")

    # Define o provedor principal, modelo, temperatura de criatividade e tempo limite de resposta
    llm_provider: str = "groq"
    llm_model: str = "llama-3.3-70b-versatile"
    llm_temperature: float = 0.2
    llm_timeout_seconds: float = 15.0

    # Define o provedor e modelo secundários opcionais para acionamento em caso de fallback
    llm_fallback_provider: str = ""
    llm_fallback_model: str = ""

    # Armazena as chaves de API dos provedores em nuvem e o endereço local do servidor Ollama
    groq_api_key: str = ""
    google_api_key: str = ""
    openai_api_key: str = ""
    ollama_base_url: str = "http://localhost:11434"


# Instancia o objeto global de configurações para ser importado pelos demais módulos do serviço
settings = Settings()