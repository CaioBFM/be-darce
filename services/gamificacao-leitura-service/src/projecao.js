// Projeção dos eventos do modelo de escrita para os documentos de leitura (MongoDB).
//
// Idempotência em duas camadas:
// 1. eventos_processados guarda o eventoId de cada evento aplicado; uma entrega
//    repetida (at-least-once) é reconhecida e respondida sem reprocessar.
// 2. Cada documento guarda a versão do agregado; um snapshot mais antigo que o
//    atual (entrega fora de ordem) é descartado.

const TIPOS = ['TRILHA_ATUALIZADA', 'ETAPA_CONCLUIDA'];

function erroValidacao(mensagem) {
  const error = new Error(mensagem);
  error.validacao = true;
  return error;
}

function validarEnvelope(evento) {
  if (!evento || typeof evento !== 'object') throw erroValidacao('Corpo do evento ausente.');
  if (typeof evento.eventoId !== 'string' || !evento.eventoId) throw erroValidacao('eventoId é obrigatório.');
  if (!TIPOS.includes(evento.tipo)) throw erroValidacao(`Tipo de evento não suportado: ${evento.tipo}.`);
  if (!evento.dados || typeof evento.dados !== 'object') throw erroValidacao('dados é obrigatório.');
  if (!Number.isInteger(evento.tipo === 'ETAPA_CONCLUIDA' ? evento.dados.progresso?.versao : evento.dados.versao)) {
    throw erroValidacao('O snapshot do agregado precisa de versão inteira.');
  }
}

// Atualiza o documento somente se a versão recebida for mais nova.
async function gravarVersionado(colecao, id, versao, campos) {
  try {
    const resultado = await colecao.updateOne(
      { _id: id, $or: [{ versao: { $lt: versao } }, { versao: { $exists: false } }] },
      { $set: { ...campos, versao } },
      { upsert: true },
    );
    return resultado.modifiedCount + resultado.upsertedCount > 0;
  } catch (error) {
    // Documento já existe com versão >= recebida: o filtro falha e o upsert colide no _id.
    if (error.code === 11000) return false;
    throw error;
  }
}

function metadadosSincronizacao(evento) {
  const agora = new Date();
  const ocorridoEm = new Date(evento.ocorridoEm);
  return {
    ultimoEventoId: evento.eventoId,
    sincronizadoEm: agora,
    defasagemMs: Number.isNaN(ocorridoEm.getTime()) ? null : agora - ocorridoEm,
  };
}

async function projetarTrilha(db, evento) {
  const trilha = evento.dados;
  return gravarVersionado(db.collection('trilhas'), trilha.id, trilha.versao, {
    nome: trilha.nome,
    descricao: trilha.descricao,
    publicoAlvo: trilha.publicoAlvo,
    ativa: trilha.ativa,
    etapas: [...trilha.etapas].sort((a, b) => a.ordem - b.ordem),
    totalEtapas: trilha.etapas.length,
    atualizadoEm: new Date(trilha.atualizadoEm),
    ...metadadosSincronizacao(evento),
  });
}

async function projetarConclusao(db, evento) {
  const { progresso, etapaId, trilhaId, pontosGanhos, concluidaEm } = evento.dados;
  const porTrilha = new Map();
  for (const conclusao of progresso.etapasConcluidas) {
    if (!porTrilha.has(conclusao.trilhaId)) porTrilha.set(conclusao.trilhaId, []);
    porTrilha.get(conclusao.trilhaId).push(conclusao.etapaId);
  }

  // Documento pré-calculado: pontos, nível e etapas concluídas prontos para leitura.
  return gravarVersionado(db.collection('progresso'), progresso.usuarioId, progresso.versao, {
    pontosTotais: progresso.pontosTotais,
    nivel: progresso.nivel,
    etapasConcluidas: progresso.etapasConcluidas.length,
    trilhas: [...porTrilha].map(([id, etapasConcluidasIds]) => ({ trilhaId: id, etapasConcluidasIds })),
    ultimaConclusao: { etapaId, trilhaId, pontosGanhos, concluidaEm: new Date(concluidaEm) },
    atualizadoEm: new Date(progresso.atualizadoEm),
    ...metadadosSincronizacao(evento),
  });
}

async function processarEvento(db, evento) {
  validarEnvelope(evento);
  const processados = db.collection('eventos_processados');
  if (await processados.findOne({ _id: evento.eventoId }, { projection: { _id: 1 } })) {
    return { eventoId: evento.eventoId, situacao: 'JA_PROCESSADO' };
  }

  const aplicado = evento.tipo === 'TRILHA_ATUALIZADA'
    ? await projetarTrilha(db, evento)
    : await projetarConclusao(db, evento);

  try {
    await processados.insertOne({
      _id: evento.eventoId,
      tipo: evento.tipo,
      agregadoId: evento.agregadoId,
      aplicado,
      recebidoEm: new Date(),
    });
  } catch (error) {
    // Duas entregas simultâneas do mesmo evento: a projeção é idempotente, basta uma marca.
    if (error.code !== 11000) throw error;
  }
  return { eventoId: evento.eventoId, situacao: 'RECEBIDO' };
}

async function criarIndices(db) {
  await Promise.all([
    db.collection('trilhas').createIndex({ ativa: 1, publicoAlvo: 1 }),
    db.collection('progresso').createIndex({ nivel: 1 }),
  ]);
}

module.exports = { processarEvento, criarIndices };
