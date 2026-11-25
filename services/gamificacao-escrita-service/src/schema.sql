-- Modelo de escrita da Gamificação (lado de comandos do CQRS).
-- Executado na inicialização do serviço; todas as instruções são idempotentes.

CREATE TABLE IF NOT EXISTS trilhas (
  id            TEXT PRIMARY KEY,
  nome          VARCHAR(120)  NOT NULL,
  descricao     VARCHAR(1000) NOT NULL DEFAULT '',
  publico_alvo  TEXT[]        NOT NULL,
  ativa         BOOLEAN       NOT NULL DEFAULT TRUE,
  versao        INTEGER       NOT NULL DEFAULT 1,
  criado_em     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS etapas (
  id           TEXT PRIMARY KEY,
  trilha_id    TEXT         NOT NULL REFERENCES trilhas (id),
  titulo       VARCHAR(120) NOT NULL,
  tipo         TEXT         NOT NULL CHECK (tipo IN ('LEITURA', 'VIDEO', 'ATIVIDADE', 'QUESTIONARIO')),
  conteudo     TEXT         NOT NULL,
  url_conteudo TEXT,
  ordem        INTEGER      NOT NULL CHECK (ordem >= 1),
  pontuacao    INTEGER      NOT NULL CHECK (pontuacao >= 0),
  quiz         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- Adiada para permitir reordenar etapas (ordem = ordem + 1) em uma única instrução.
  CONSTRAINT etapas_trilha_ordem_unica UNIQUE (trilha_id, ordem) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS pontuacoes (
  usuario_id    TEXT PRIMARY KEY,
  pontos        INTEGER     NOT NULL DEFAULT 0 CHECK (pontos >= 0),
  nivel         INTEGER     NOT NULL DEFAULT 1 CHECK (nivel >= 1),
  -- Versão do agregado "progresso do usuário"; o modelo de leitura descarta eventos mais antigos.
  versao        INTEGER     NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conclusoes (
  usuario_id    TEXT        NOT NULL,
  etapa_id      TEXT        NOT NULL REFERENCES etapas (id),
  pontos_ganhos INTEGER     NOT NULL,
  concluida_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (usuario_id, etapa_id)
);

-- Outbox: o evento é gravado na mesma transação da alteração de negócio.
CREATE TABLE IF NOT EXISTS outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_evento   TEXT        NOT NULL,
  agregado_id   TEXT        NOT NULL,
  destino       TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'ENVIADO', 'FALHA')),
  tentativas    INTEGER     NOT NULL DEFAULT 0,
  proximo_envio TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultimo_erro   TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_em    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS outbox_pendentes_idx
  ON outbox (proximo_envio, criado_em)
  WHERE status = 'PENDENTE';
