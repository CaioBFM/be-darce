require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const { processarEvento, criarIndices } = require('./projecao');

const app = express();
const port = Number(process.env.PORT || 5003);
const mongoUri = process.env.MONGO_URI;
const client = new MongoClient(mongoUri);
const db = () => client.db();

app.use(express.json({ limit: '1mb' }));

const TITULOS = {
  400: 'Requisição inválida',
  401: 'Não autenticado',
  403: 'Acesso negado',
  404: 'Não encontrado',
  500: 'Erro interno',
};

function problema(res, req, status, code, detail) {
  return res.status(status).type('application/problem+json').json({
    type: 'about:blank',
    title: TITULOS[status] || 'Erro',
    status,
    detail,
    instance: req.originalUrl,
    code,
  });
}

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Serviço de leitura da gamificação em execução.',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'gamificacao-leitura-service',
  });
});

app.get('/db', async (req, res) => {
  const start = Date.now();
  try {
    const result = await client.db().admin().command({ ping: 1 });
    return res.status(200).json({
      status: 'success',
      message: 'Conexão com o banco de dados estabelecida.',
      service: 'gamificacao-leitura-service',
      database: {
        ping: result.ok,
        responseTimeMs: Date.now() - start,
      },
    });
  } catch (error) {
    console.error('Erro de conexão com o MongoDB de gamificação:', error.message);
    return res.status(503).json({
      status: 'error',
      message: 'Falha na conexão com o banco de dados.',
      service: 'gamificacao-leitura-service',
    });
  }
});

// Recebe os eventos entregues pelo Relay do modelo de escrita.
app.post('/v1/internal/eventos', async (req, res) => {
  try {
    const ack = await processarEvento(db(), req.body);
    if (ack.situacao === 'RECEBIDO') console.log(`Projeção: ${req.body.tipo} ${ack.eventoId} aplicado.`);
    return res.status(200).json(ack);
  } catch (error) {
    if (error.validacao) return problema(res, req, 400, 'VALIDATION_ERROR', error.message);
    throw error;
  }
});

// ---------- Consultas (modelo de leitura) ----------

function sincronizacao(doc) {
  if (!doc) return { versao: 0, sincronizadoEm: null, defasagemMs: null, ultimoEventoId: null };
  return {
    versao: doc.versao,
    sincronizadoEm: doc.sincronizadoEm,
    defasagemMs: doc.defasagemMs,
    ultimoEventoId: doc.ultimoEventoId,
  };
}

async function buscarProgresso(usuarioId) {
  return db().collection('progresso').findOne({ _id: usuarioId });
}

function concluidasDaTrilha(progresso, trilhaId) {
  const trilha = progresso?.trilhas.find((t) => t.trilhaId === trilhaId);
  return new Set(trilha?.etapasConcluidasIds || []);
}

// Uma etapa fica bloqueada enquanto a anterior (pela ordem) não for concluída.
function etapasComBloqueio(trilha, progresso, comUsuario) {
  const concluidas = concluidasDaTrilha(progresso, trilha._id);
  return trilha.etapas.map((etapa, i) => ({
    ...etapa,
    bloqueada: comUsuario && i > 0 && !concluidas.has(trilha.etapas[i - 1].id),
    concluida: concluidas.has(etapa.id),
  }));
}

function resumoEtapa({ id, trilhaId, titulo, ordem, tipo, pontuacao, bloqueada, concluida }) {
  return { id, trilhaId, titulo, ordem, tipo, pontuacao, bloqueada, concluida };
}

function formatarTrilha(trilha, progresso, comUsuario) {
  return {
    id: trilha._id,
    nome: trilha.nome,
    descricao: trilha.descricao,
    publicoAlvo: trilha.publicoAlvo,
    ativa: trilha.ativa,
    etapas: etapasComBloqueio(trilha, progresso, comUsuario).map(resumoEtapa),
  };
}

app.get('/v1/trilhas', async (req, res) => {
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(req.query.pageSize, 10) || 20, 1), 100);
  const filtro = { ativa: true };
  if (req.query.publicoAlvo) filtro.publicoAlvo = req.query.publicoAlvo;

  const usuarioId = req.get('X-Usuario-Id');
  const [total, trilhas, progresso] = await Promise.all([
    db().collection('trilhas').countDocuments(filtro),
    db().collection('trilhas').find(filtro).sort({ _id: 1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    usuarioId ? buscarProgresso(usuarioId) : null,
  ]);
  res.status(200).json({
    items: trilhas.map((trilha) => formatarTrilha(trilha, progresso, Boolean(usuarioId))),
    total,
    page,
    pageSize,
  });
});

app.get('/v1/trilhas/:id', async (req, res) => {
  const usuarioId = req.get('X-Usuario-Id');
  const [trilha, progresso] = await Promise.all([
    db().collection('trilhas').findOne({ _id: req.params.id }),
    usuarioId ? buscarProgresso(usuarioId) : null,
  ]);
  if (!trilha) return problema(res, req, 404, 'NOT_FOUND', 'Trilha não encontrada.');
  return res.status(200).json(formatarTrilha(trilha, progresso, Boolean(usuarioId)));
});

app.get('/v1/trilhas/:trilhaId/etapas/:etapaId', async (req, res) => {
  const usuarioId = req.get('X-Usuario-Id');
  const [trilha, progresso] = await Promise.all([
    db().collection('trilhas').findOne({ _id: req.params.trilhaId }),
    usuarioId ? buscarProgresso(usuarioId) : null,
  ]);
  const etapa = trilha && etapasComBloqueio(trilha, progresso, Boolean(usuarioId))
    .find((e) => e.id === req.params.etapaId);
  if (!etapa) return problema(res, req, 404, 'NOT_FOUND', 'Etapa não encontrada.');
  if (etapa.bloqueada) {
    return problema(res, req, 403, 'ETAPA_BLOQUEADA', 'Conclua a etapa anterior para liberar esta.');
  }
  return res.status(200).json(etapa);
});

async function montarProgresso(usuarioId) {
  const progresso = await buscarProgresso(usuarioId);
  const comProgresso = progresso?.trilhas.map((t) => t.trilhaId) || [];
  const trilhas = await db().collection('trilhas')
    .find(
      { $or: [{ ativa: true, publicoAlvo: 'PACIENTE' }, { _id: { $in: comProgresso } }] },
      { projection: { nome: 1, totalEtapas: 1 } },
    )
    .sort({ _id: 1 })
    .toArray();

  const itens = trilhas.map((trilha) => {
    const etapasConcluidas = concluidasDaTrilha(progresso, trilha._id).size;
    return {
      trilhaId: trilha._id,
      nome: trilha.nome,
      etapasConcluidas,
      totalEtapas: trilha.totalEtapas,
      progressoPercentual: trilha.totalEtapas
        ? Math.round((etapasConcluidas / trilha.totalEtapas) * 1000) / 10
        : 0,
    };
  });

  return {
    usuarioId,
    pontosTotais: progresso?.pontosTotais || 0,
    nivel: progresso?.nivel || 1,
    etapasConcluidas: progresso?.etapasConcluidas || 0,
    totalEtapas: itens.reduce((soma, item) => soma + item.totalEtapas, 0),
    trilhas: itens,
    sincronizacao: sincronizacao(progresso),
  };
}

app.get('/v1/usuarios/me/progresso', async (req, res) => {
  const usuarioId = req.get('X-Usuario-Id');
  if (!usuarioId) return problema(res, req, 401, 'UNAUTHORIZED', 'Cabeçalho X-Usuario-Id ausente.');
  return res.status(200).json(await montarProgresso(usuarioId));
});

app.get('/v1/usuarios/:id/progresso', async (req, res) => {
  res.status(200).json(await montarProgresso(req.params.id));
});

app.get('/v1/usuarios/:id/nivel', async (req, res) => {
  const progresso = await buscarProgresso(req.params.id);
  res.status(200).json({
    usuarioId: req.params.id,
    pontos: progresso?.pontosTotais || 0,
    nivel: progresso?.nivel || 1,
  });
});

app.get('/v1/estatisticas/niveis', async (req, res) => {
  const niveis = await db().collection('progresso')
    .aggregate([
      { $group: { _id: '$nivel', usuarios: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, nivel: '$_id', usuarios: 1 } },
    ])
    .toArray();
  res.status(200).json({ niveis });
});

app.use((req, res) => problema(res, req, 404, 'NOT_FOUND', 'Rota não encontrada.'));

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') return problema(res, req, 400, 'VALIDATION_ERROR', 'Corpo JSON inválido.');
  console.error('Erro inesperado no serviço de leitura:', error);
  return problema(res, req, 500, 'INTERNAL_ERROR', 'Erro inesperado ao consultar o modelo de leitura.');
});

async function start() {
  try {
    await client.connect();
    await criarIndices(db());
    app.listen(port, '0.0.0.0', () => {
      console.log(`Serviço de leitura ouvindo na porta ${port}`);
    });
  } catch (error) {
    console.error('Não foi possível iniciar o serviço de leitura:', error.message);
    process.exitCode = 1;
  }
}

start();

process.on('SIGTERM', async () => {
  await client.close();
  process.exit(0);
});
