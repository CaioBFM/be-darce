// Demonstração do CQRS da Gamificação: escrita no PostgreSQL -> Outbox/Relay -> leitura no MongoDB.
//
// Roda dentro do contêiner de escrita, que alcança os dois serviços pela rede interna:
//   docker compose exec -T gamificacao-escrita-service node - < scripts/demo-cqrs.js
// PowerShell:
//   Get-Content scripts/demo-cqrs.js -Raw | docker compose exec -T gamificacao-escrita-service node -

const ESCRITA = process.env.DEMO_ESCRITA_URL || `http://127.0.0.1:${process.env.PORT || 5002}`;
const LEITURA = process.env.DEMO_LEITURA_URL
  || process.env.GAMIFICACAO_LEITURA_URL
  || 'http://gamificacao-leitura-service:5003';
const usuarioId = process.env.DEMO_USUARIO || `demo-${Date.now()}`;

async function chamar(base, metodo, rota, corpo) {
  const resposta = await fetch(`${base}${rota}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Usuario-Id': usuarioId },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: resposta.status, corpo: await resposta.json() };
}

const concluir = (etapaId, respostas) =>
  chamar(ESCRITA, 'POST', `/v1/etapas/${etapaId}/conclusao`, respostas ? { respostas } : {});
const lerProgresso = () => chamar(LEITURA, 'GET', '/v1/usuarios/me/progresso');

function titulo(texto) {
  console.log(`\n=== ${texto} ===`);
}

function resumo({ pontosTotais, nivel, etapasConcluidas, sincronizacao }) {
  return `pontos=${pontosTotais} nivel=${nivel} etapasConcluidas=${etapasConcluidas} versao=${sincronizacao.versao}`;
}

// Faz polling no modelo de leitura até refletir a versão esperada.
async function aguardarLeitura(versaoEsperada, limiteMs = 10000) {
  const inicio = Date.now();
  for (;;) {
    const { corpo } = await lerProgresso();
    if (corpo.sincronizacao.versao >= versaoEsperada) return { corpo, esperaMs: Date.now() - inicio };
    if (Date.now() - inicio > limiteMs) throw new Error('O modelo de leitura não refletiu a escrita a tempo.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function escreverEConferir(rotulo, etapaId, respostas, versao) {
  const escrita = await concluir(etapaId, respostas);
  console.log(`[ESCRITA  PostgreSQL] ${rotulo} -> HTTP ${escrita.status}`, escrita.corpo);
  const { corpo, esperaMs } = await aguardarLeitura(versao);
  console.log(`[LEITURA  MongoDB   ] ${resumo(corpo)}`);
  console.log(
    `                      refletido após ${esperaMs} ms de polling; `
    + `defasagem registrada na projeção: ${corpo.sincronizacao.defasagemMs} ms`,
  );
  return corpo;
}

async function main() {
  console.log(`Usuário de demonstração: ${usuarioId}`);
  console.log(`Escrita: ${ESCRITA} | Leitura: ${LEITURA}`);

  titulo('1. Estado inicial no modelo de leitura');
  console.log('[LEITURA  MongoDB   ]', resumo((await lerProgresso()).corpo));

  titulo('2. Regras do modelo de escrita');
  const bloqueada = await concluir('e-2');
  console.log(`Concluir e-2 antes de e-1 -> HTTP ${bloqueada.status} ${bloqueada.corpo.code}`);

  titulo('3. Escrita refletida na leitura (e-1, 10 pontos)');
  await escreverEConferir('concluir e-1', 'e-1', null, 1);

  const repetida = await concluir('e-1');
  console.log(`Concluir e-1 de novo -> HTTP ${repetida.status} ${repetida.corpo.code}`);

  titulo('4. Mais escritas: e-2, questionário e-3 e subida de nível em e-4');
  await escreverEConferir('concluir e-2', 'e-2', null, 2);
  const errado = await concluir('e-3', [{ questaoId: 'q-1', opcaoSelecionada: 1 }, { questaoId: 'q-2', opcaoSelecionada: 1 }]);
  console.log(`Questionário com resposta errada -> HTTP ${errado.status} ${errado.corpo.code}`);
  await escreverEConferir('concluir e-3', 'e-3', [
    { questaoId: 'q-1', opcaoSelecionada: 0 },
    { questaoId: 'q-2', opcaoSelecionada: 1 },
  ], 3);
  const final = await escreverEConferir('concluir e-4', 'e-4', null, 4);
  console.log('Trilhas no modelo de leitura:', final.trilhas);

  titulo('5. Outbox no PostgreSQL');
  const outbox = await chamar(ESCRITA, 'GET', '/v1/internal/outbox?limite=5');
  console.log('Resumo:', outbox.corpo.resumo);
  for (const evento of outbox.corpo.eventos) {
    console.log(
      `  ${evento.tipo_evento.padEnd(18)} ${evento.agregado_id.padEnd(20)} ${evento.status.padEnd(9)} `
      + `tentativas=${evento.tentativas} defasagem=${evento.defasagem_ms ?? '-'} ms`,
    );
  }
}

main().catch((error) => {
  console.error('Falha na demonstração:', error.message);
  process.exit(1);
});
