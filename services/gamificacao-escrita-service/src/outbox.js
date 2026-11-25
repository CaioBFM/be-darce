// Gravação de eventos na outbox e montagem dos snapshots enviados ao modelo de leitura.
// Os eventos carregam o estado completo do agregado (com versão), o que torna a
// projeção idempotente e tolerante a entregas repetidas ou fora de ordem.

const DESTINO_LEITURA = 'gamificacao-leitura:/v1/internal/eventos';

async function registrarEvento(client, { tipo, agregadoId, payload, destino = DESTINO_LEITURA }) {
  const { rows } = await client.query(
    `INSERT INTO outbox (tipo_evento, agregado_id, destino, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING id, criado_em`,
    [tipo, agregadoId, destino, payload],
  );
  return rows[0];
}

function quizPublico(quiz) {
  return (quiz || []).map(({ id, enunciado, opcoes }) => ({ id, enunciado, opcoes }));
}

async function snapshotTrilha(client, trilhaId) {
  const { rows: trilhas } = await client.query(
    `SELECT id, nome, descricao, publico_alvo, ativa, versao, atualizado_em
     FROM trilhas WHERE id = $1`,
    [trilhaId],
  );
  const trilha = trilhas[0];
  const { rows: etapas } = await client.query(
    `SELECT id, trilha_id, titulo, tipo, conteudo, url_conteudo, ordem, pontuacao, quiz
     FROM etapas WHERE trilha_id = $1 ORDER BY ordem`,
    [trilhaId],
  );
  return {
    id: trilha.id,
    nome: trilha.nome,
    descricao: trilha.descricao,
    publicoAlvo: trilha.publico_alvo,
    ativa: trilha.ativa,
    versao: trilha.versao,
    atualizadoEm: trilha.atualizado_em,
    etapas: etapas.map((etapa) => ({
      id: etapa.id,
      trilhaId: etapa.trilha_id,
      titulo: etapa.titulo,
      tipo: etapa.tipo,
      conteudo: etapa.conteudo,
      urlConteudo: etapa.url_conteudo,
      ordem: etapa.ordem,
      pontuacao: etapa.pontuacao,
      quiz: quizPublico(etapa.quiz),
    })),
  };
}

async function snapshotProgresso(client, usuarioId) {
  const { rows: pontuacoes } = await client.query(
    'SELECT pontos, nivel, versao, atualizado_em FROM pontuacoes WHERE usuario_id = $1',
    [usuarioId],
  );
  const { rows: conclusoes } = await client.query(
    `SELECT c.etapa_id, e.trilha_id, c.pontos_ganhos, c.concluida_em
     FROM conclusoes c
     JOIN etapas e ON e.id = c.etapa_id
     WHERE c.usuario_id = $1
     ORDER BY c.concluida_em, c.etapa_id`,
    [usuarioId],
  );
  const pontuacao = pontuacoes[0];
  return {
    usuarioId,
    pontosTotais: pontuacao.pontos,
    nivel: pontuacao.nivel,
    versao: pontuacao.versao,
    atualizadoEm: pontuacao.atualizado_em,
    etapasConcluidas: conclusoes.map((conclusao) => ({
      etapaId: conclusao.etapa_id,
      trilhaId: conclusao.trilha_id,
      pontosGanhos: conclusao.pontos_ganhos,
      concluidaEm: conclusao.concluida_em,
    })),
  };
}

module.exports = { DESTINO_LEITURA, registrarEvento, snapshotTrilha, snapshotProgresso, quizPublico };
