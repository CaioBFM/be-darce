// Relay da outbox: lê eventos PENDENTE e os entrega via HTTP ao serviço de destino.
//
// - A cada RELAY_INTERVALO_MS (1 s) reserva um lote de até RELAY_LOTE (50) eventos.
// - A reserva usa FOR UPDATE SKIP LOCKED e um "lease" em proximo_envio: réplicas do
//   serviço nunca pegam o mesmo evento ao mesmo tempo e, se o processo cair no meio
//   do envio, o evento volta a ficar elegível quando o lease expira.
// - Erro transitório (rede, timeout, 5xx, 408, 429): nova tentativa com espera
//   exponencial (1 s, 2 s, 4 s... até 60 s). Ao atingir RELAY_MAX_TENTATIVAS, FALHA.
// - Erro permanente (demais 4xx, destino desconhecido): FALHA imediata para análise.
// - A entrega é at-least-once; o consumidor é idempotente pelo eventoId.
const { pool } = require('./db');

function configuracao() {
  return {
    intervaloMs: Number(process.env.RELAY_INTERVALO_MS || 1000),
    lote: Number(process.env.RELAY_LOTE || 50),
    maxTentativas: Number(process.env.RELAY_MAX_TENTATIVAS || 10),
    timeoutMs: Number(process.env.RELAY_TIMEOUT_MS || 3000),
    esperaMaximaS: Number(process.env.RELAY_ESPERA_MAXIMA_S || 60),
    leaseMs: Number(process.env.RELAY_LEASE_MS || 30000),
    destinos: {
      'gamificacao-leitura':
        process.env.GAMIFICACAO_LEITURA_URL || 'http://gamificacao-leitura-service:5003',
    },
  };
}

function resolverUrl(destino, destinos) {
  const separador = destino.indexOf(':');
  const servico = destino.slice(0, separador);
  const rota = destino.slice(separador + 1);
  return separador > 0 && destinos[servico] ? `${destinos[servico]}${rota}` : null;
}

async function reservarLote({ lote, leaseMs }) {
  const { rows } = await pool.query(
    `UPDATE outbox o
     SET proximo_envio = NOW() + $2 * INTERVAL '1 millisecond'
     FROM (
       SELECT id FROM outbox
       WHERE status = 'PENDENTE' AND proximo_envio <= NOW()
       ORDER BY criado_em
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     ) alvo
     WHERE o.id = alvo.id
     RETURNING o.*`,
    [lote, leaseMs],
  );
  return rows.sort((a, b) => a.criado_em - b.criado_em);
}

async function marcarEnviado(id) {
  await pool.query(
    `UPDATE outbox
     SET status = 'ENVIADO', tentativas = tentativas + 1, enviado_em = NOW(), ultimo_erro = NULL
     WHERE id = $1`,
    [id],
  );
}

async function marcarFalhaPermanente(id, erro) {
  await pool.query(
    `UPDATE outbox SET status = 'FALHA', tentativas = tentativas + 1, ultimo_erro = $2 WHERE id = $1`,
    [id, erro],
  );
}

async function agendarNovaTentativa(id, erro, { maxTentativas, esperaMaximaS }) {
  const { rows } = await pool.query(
    `UPDATE outbox
     SET tentativas = tentativas + 1,
         ultimo_erro = $2,
         status = CASE WHEN tentativas + 1 >= $3 THEN 'FALHA' ELSE 'PENDENTE' END,
         proximo_envio = NOW() + LEAST(POWER(2, tentativas), $4) * INTERVAL '1 second'
     WHERE id = $1
     RETURNING status, tentativas, proximo_envio`,
    [id, erro, maxTentativas, esperaMaximaS],
  );
  return rows[0];
}

async function entregar(evento, config) {
  const url = resolverUrl(evento.destino, config.destinos);
  if (!url) {
    await marcarFalhaPermanente(evento.id, `Destino desconhecido: ${evento.destino}`);
    return;
  }

  const envelope = {
    eventoId: evento.id,
    tipo: evento.tipo_evento,
    agregadoId: evento.agregado_id,
    ocorridoEm: evento.criado_em,
    dados: evento.payload,
  };

  let erro;
  let permanente = false;
  try {
    const resposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (resposta.ok) {
      await marcarEnviado(evento.id);
      const defasagemMs = Date.now() - new Date(evento.criado_em).getTime();
      console.log(`Relay: ${evento.tipo_evento} ${evento.id} entregue em ${defasagemMs} ms.`);
      return;
    }
    const corpo = (await resposta.text()).slice(0, 500);
    erro = `HTTP ${resposta.status}: ${corpo}`;
    permanente = resposta.status >= 400 && resposta.status < 500
      && resposta.status !== 408 && resposta.status !== 429;
  } catch (falha) {
    if (falha.name === 'TimeoutError') erro = `Tempo limite de ${config.timeoutMs} ms excedido`;
    else erro = falha.cause?.code ? `${falha.message} (${falha.cause.code})` : falha.message;
  }

  if (permanente) {
    await marcarFalhaPermanente(evento.id, erro);
    console.error(`Relay: ${evento.id} marcado como FALHA (erro permanente): ${erro}`);
    return;
  }
  const situacao = await agendarNovaTentativa(evento.id, erro, config);
  console.warn(
    `Relay: falha ao entregar ${evento.id} (tentativa ${situacao.tentativas}, agora ${situacao.status}): ${erro}`,
  );
}

function iniciarRelay() {
  const config = configuracao();
  let emExecucao = false;

  async function ciclo() {
    if (emExecucao) return;
    emExecucao = true;
    try {
      const eventos = await reservarLote(config);
      for (const evento of eventos) {
        await entregar(evento, config);
      }
    } catch (error) {
      console.error('Relay: erro no ciclo de envio:', error.message);
    } finally {
      emExecucao = false;
    }
  }

  const timer = setInterval(ciclo, config.intervaloMs);
  console.log(
    `Relay iniciado: intervalo ${config.intervaloMs} ms, lote ${config.lote}, `
    + `máximo de ${config.maxTentativas} tentativas, destino ${config.destinos['gamificacao-leitura']}.`,
  );
  return () => clearInterval(timer);
}

module.exports = { iniciarRelay };
