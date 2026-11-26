from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    port_assistente: int = 5006
    # Listener INTERNO do Gateway (porta 8081): é por ele que as tools chegam aos outros serviços
    gateway_internal_url: str = "http://localhost:8081"

    base_conhecimento_dir: str = str(
        Path(__file__).resolve().parent.parent / "base_conhecimento"
    )

    # Banco próprio do assistente (PostgreSQL + pgvector)
    db_host: str = "localhost"
    db_port: int = 5432
    db_user: str = "postgres"
    db_password: str = ""
    db_name: str = "assistente"
    colecao_vetorial: str = "bedarce_conhecimento"

    # Cache de respostas (guardado no Postgres, compartilhado entre réplicas)
    cache_ttl_segundos: float = 600.0

    llm_provider: str = "groq"
    llm_model: str = "openai/gpt-oss-20b"
    llm_temperature: float = 0.2
    llm_timeout_seconds: float = 15.0

    llm_fallback_provider: str = ""
    llm_fallback_model: str = ""

    groq_api_key: str = ""
    google_api_key: str = ""
    openai_api_key: str = ""
    ollama_base_url: str = "http://localhost:11434"


settings = Settings()
