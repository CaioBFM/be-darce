// Comandos do modelo de escrita. Cada comando altera o PostgreSQL e grava o evento
// correspondente na outbox dentro da MESMA transação, eliminando o risco de dual write.
const { randomUUID } = require('node:crypto');
const { transacao } = require('./db');
const { ErroHttp } = require('./erros');
const { registrarEvento, snapshotTrilha, snapshotProgresso } = require('./outbox');

const PONTOS_POR_NIVEL = 50;
const TIPOS_ETAPA = ['LEITURA', 'VIDEO', 'ATIVIDADE', 'QUESTIONARIO'];
const PUBLICOS = ['PACIENTE', 'MENTOR'];

function calcularNivel(pontos) {
  return 1 + Math.floor(pontos / PONTOS_POR_NIVEL);
}

function texto(valor, campo, { min = 1, max, obrigatorio = true } = {}) {
  if (valor === undefined || valor === null) {
    if (!obrigatorio) return null;
    throw new ErroHttp(400, 'VALIDATION_ERROR', `O campo "${campo}" é obrigatório.`);
  }
  if (typeof valor !== 'string' || valor.trim().length < min || (max && valor.length > max)) {
    throw new ErroHttp(400, 'VALIDATION_ERROR', `O campo "${campo}" é inválido.`);
  }
  return valor.trim();
}

function inteiro(valor, campo, minimo) {
  if (!Number.isInteger(valor) || valor < minimo) {
    throw new ErroHttp(400, 'VALIDATION_ERROR', `O campo "${campo}" deve ser um inteiro >= ${minimo}.`);
  }
  return valor;
}

function validarTrilha(body = {}) {
  const publicoAlvo = body.publicoAlvo;
  if (
    !Array.isArray(publicoAlvo)
    || publicoAlvo.length === 0
    || new Set(publicoAlvo).size !== publicoAlvo.length
    || !publicoAlvo.every((p) => PUBLICOS.includes(p))
  ) {
    throw new ErroHttp(400, 'VALIDATION_ERROR', 'O campo "publicoAlvo" deve listar PACIENTE e/ou MENTOR.');
  }
  return {
    nome: texto(body.nome, 'nome', { max: 120 }),
    descricao: texto(body.descricao, 'descricao', { min: 0, max: 1000 }),
    publicoAlvo,
  };
}

function validarQuiz(quiz) {
  if (quiz === undefined || quiz === null) return [];
  if (!Array.isArray(quiz)) throw new ErroHttp(400, 'VALIDATION_ERROR', 'O campo "quiz" deve ser uma lista.');
  return quiz.map((questao, i) => {
    const opcoes = questao?.opcoes;
    if (!Array.isArray(opcoes) || opcoes.length < 2 || !opcoes.every((o) => typeof o === 'string' && o)) {
      throw new ErroHttp(400, 'VALIDATION_ERROR', `A questão ${i + 1} precisa de pelo menos duas opções.`);
    }
    const respostaCorreta = inteiro(questao.respostaCorreta, `quiz[${i}].respostaCorreta`, 0);
    if (respostaCorreta >= opcoes.length) {
      throw new ErroHttp(400, 'VALIDATION_ERROR', `A resposta correta da questão ${i + 1} não existe.`);
    }
    return {
      id: questao.id ? texto(questao.id, `quiz[${i}].id`, { max: 64 }) : `q-${i + 1}`,
      enunciado: texto(questao.enunciado, `quiz[${i}].enunciado`, { max: 500 }),
      opcoes,
      respostaCorreta,
    };
  });
}

function validarEtapa(body = {}) {
  if (!TIPOS_ETAPA.includes(body.tipo)) {
    throw new ErroHttp(400, 'VALIDATION_ERROR', `O campo "tipo" deve ser um de: ${TIPOS_ETAPA.join(', ')}.`);
  }
  const quiz = validarQuiz(body.quiz);
  if (body.tipo === 'QUESTIONARIO' && quiz.length === 0) {
    throw new ErroHttp(400, 'VALIDATION_ERROR', 'Etapas do tipo QUESTIONARIO precisam de quiz.');
  }
  return {
    titulo: texto(body.titulo, 'titulo', { max: 120 }),
    tipo: body.tipo,
    conteudo: texto(body.conteudo, 'conteudo', { max: 20000 }),
    urlConteudo: texto(body.urlConteudo, 'urlConteudo', { max: 2048, obrigatorio: false }),
    ordem: inteiro(body.ordem, 'ordem', 1),
    pontuacao: inteiro(body.pontuacao, 'pontuacao', 0),
    quiz,
  };
}

function validarRespostas(quiz, respostas) {
  if (quiz.length === 0) return;
  if (!Array.isArray(respostas)) {
    throw new ErroHttp(400, 'VALIDATION_ERROR', 'Esta etapa exige as respostas do questionário.');
  }
  const escolhidas = new Map(respostas.map((r) => [r?.questaoId, r?.opcaoSelecionada]));
  const acertos = quiz.filter((questao) => escolhidas.get(questao.id) === questao.respostaCorreta).length;
  if (acertos !== quiz.length) {
    throw new ErroHttp(
      400,
      'QUIZ_INCORRETO',
      `Respostas incorretas: ${acertos} de ${quiz.length} acertos. Revise o conteúdo e tente novamente.`,
    );
  }
}

async function concluirEtapa({ usuarioId, etapaId, respostas }) {
  return transacao(async (client) => {
    const { rows: etapas } = await client.query(
      `SELECT e.id, e.trilha_id, e.ordem, e.pontuacao, e.quiz, t.ativa
       FROM etapas e JOIN trilhas t ON t.id = e.trilha_id
       WHERE e.id = $1`,
      [etapaId],
    );
    const etapa = etapas[0];
    if (!etapa) throw new ErroHttp(404, 'NOT_FOUND', 'Etapa não encontrada.');
    if (!etapa.ativa) throw new ErroHttp(409, 'TRILHA_INATIVA', 'A trilha desta etapa não está ativa.');

    // Bloqueia a linha de pontuação do usuário: conclusões simultâneas do mesmo
    // usuário são serializadas e cada uma gera uma versão distinta do agregado.
    await client.query(
      'INSERT INTO pontuacoes (usuario_id) VALUES ($1) ON CONFLICT (usuario_id) DO NOTHING',
      [usuarioId],
    );
    const { rows: pontuacoes } = await client.query(
      'SELECT pontos FROM pontuacoes WHERE usuario_id = $1 FOR UPDATE',
      [usuarioId],
    );

    const { rowCount: jaConcluida } = await client.query(
      'SELECT 1 FROM conclusoes WHERE usuario_id = $1 AND etapa_id = $2',
      [usuarioId, etapaId],
    );
    if (jaConcluida) throw new ErroHttp(409, 'ETAPA_JA_CONCLUIDA', 'Esta etapa já foi concluída.');

    const { rows: anteriores } = await client.query(
      `SELECT e.id, (c.etapa_id IS NOT NULL) AS concluida
       FROM etapas e
       LEFT JOIN conclusoes c ON c.etapa_id = e.id AND c.usuario_id = $3
       WHERE e.trilha_id = $1 AND e.ordem < $2
       ORDER BY e.ordem DESC
       LIMIT 1`,
      [etapa.trilha_id, etapa.ordem, usuarioId],
    );
    if (anteriores[0] && !anteriores[0].concluida) {
      throw new ErroHttp(403, 'ETAPA_BLOQUEADA', 'Conclua a etapa anterior da trilha antes desta.');
    }

    validarRespostas(etapa.quiz, respostas);

    const { rows: conclusoes } = await client.query(
      `INSERT INTO conclusoes (usuario_id, etapa_id, pontos_ganhos)
       VALUES ($1, $2, $3) RETURNING concluida_em`,
      [usuarioId, etapaId, etapa.pontuacao],
    );
    const pontosTotais = pontuacoes[0].pontos + etapa.pontuacao;
    const nivel = calcularNivel(pontosTotais);
    await client.query(
      `UPDATE pontuacoes
       SET pontos = $2, nivel = $3, versao = versao + 1, atualizado_em = NOW()
       WHERE usuario_id = $1`,
      [usuarioId, pontosTotais, nivel],
    );

    const progresso = await snapshotProgresso(client, usuarioId);
    const concluidaEm = conclusoes[0].concluida_em;
    const evento = await registrarEvento(client, {
      tipo: 'ETAPA_CONCLUIDA',
      agregadoId: usuarioId,
      payload: {
        usuarioId,
        etapaId,
        trilhaId: etapa.trilha_id,
        pontosGanhos: etapa.pontuacao,
        concluidaEm,
        progresso,
      },
    });

    return {
      etapaId,
      pontosGanhos: etapa.pontuacao,
      pontosTotais,
      nivel,
      concluidaEm,
      eventoId: evento.id,
    };
  });
}

async function criarTrilha(body) {
  const dados = validarTrilha(body);
  return transacao(async (client) => {
    const id = randomUUID();
    await client.query(
      'INSERT INTO trilhas (id, nome, descricao, publico_alvo) VALUES ($1, $2, $3, $4)',
      [id, dados.nome, dados.descricao, dados.publicoAlvo],
    );
    const trilha = await snapshotTrilha(client, id);
    await registrarEvento(client, { tipo: 'TRILHA_ATUALIZADA', agregadoId: id, payload: trilha });
    return trilha;
  });
}

async function inserirEtapa(client, trilhaId, dados, id = randomUUID()) {
  const { rows } = await client.query(
    'SELECT COALESCE(MAX(ordem), 0) AS maior FROM etapas WHERE trilha_id = $1',
    [trilhaId],
  );
  // Uma ordem além do fim vira "última posição"; no meio, desloca as seguintes.
  const ordem = Math.min(dados.ordem, rows[0].maior + 1);
  await client.query(
    'UPDATE etapas SET ordem = ordem + 1 WHERE trilha_id = $1 AND ordem >= $2',
    [trilhaId, ordem],
  );
  await client.query(
    `INSERT INTO etapas (id, trilha_id, titulo, tipo, conteudo, url_conteudo, ordem, pontuacao, quiz)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, trilhaId, dados.titulo, dados.tipo, dados.conteudo, dados.urlConteudo, ordem, dados.pontuacao,
      JSON.stringify(dados.quiz)],
  );
  return id;
}

async function criarEtapa(trilhaId, body) {
  const dados = validarEtapa(body);
  return transacao(async (client) => {
    const { rowCount } = await client.query('SELECT 1 FROM trilhas WHERE id = $1 FOR UPDATE', [trilhaId]);
    if (!rowCount) throw new ErroHttp(404, 'NOT_FOUND', 'Trilha não encontrada.');

    const etapaId = await inserirEtapa(client, trilhaId, dados);
    await client.query(
      'UPDATE trilhas SET versao = versao + 1, atualizado_em = NOW() WHERE id = $1',
      [trilhaId],
    );
    const trilha = await snapshotTrilha(client, trilhaId);
    await registrarEvento(client, { tipo: 'TRILHA_ATUALIZADA', agregadoId: trilhaId, payload: trilha });
    return trilha.etapas.find((etapa) => etapa.id === etapaId);
  });
}

module.exports = {
  concluirEtapa,
  criarTrilha,
  criarEtapa,
  inserirEtapa,
  validarEtapa,
  calcularNivel,
  PONTOS_POR_NIVEL,
};
