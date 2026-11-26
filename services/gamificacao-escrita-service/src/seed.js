// Trilhas iniciais. Cada trilha criada aqui também gera um evento na outbox,
// então o modelo de leitura recebe o catálogo pelo mesmo caminho Outbox/Relay.
const { transacao, LOCK_MIGRACAO } = require('./db');
const { registrarEvento, snapshotTrilha } = require('./outbox');
const { inserirEtapa, validarEtapa } = require('./comandos');

const TRILHAS = [
  {
    id: 't-1',
    nome: 'Primeiros passos',
    descricao: 'Psicoeducação inicial sobre o transtorno do jogo e estratégias de prevenção de recaídas.',
    publicoAlvo: ['PACIENTE'],
    etapas: [
      {
        id: 'e-1',
        titulo: 'Entendendo o transtorno do jogo',
        tipo: 'LEITURA',
        conteudo:
          'O transtorno do jogo é uma condição reconhecida pelo DSM-5-TR, marcada pela perda de controle sobre '
          + 'as apostas apesar dos prejuízos. Reconhecer o problema é o primeiro passo da recuperação.',
        ordem: 1,
        pontuacao: 10,
      },
      {
        id: 'e-2',
        titulo: 'Reconhecendo gatilhos',
        tipo: 'VIDEO',
        conteudo:
          'Gatilhos são situações, emoções ou pensamentos que antecedem a vontade de apostar, como tédio, '
          + 'dívidas, notificações de casas de apostas ou jogos de futebol. Anote os seus.',
        ordem: 2,
        pontuacao: 15,
      },
      {
        id: 'e-3',
        titulo: 'Verificando o aprendizado',
        tipo: 'QUESTIONARIO',
        conteudo: 'Responda às questões sobre os conteúdos anteriores.',
        ordem: 3,
        pontuacao: 20,
        quiz: [
          {
            id: 'q-1',
            enunciado: 'Qual estratégia ajuda a reconhecer um gatilho?',
            opcoes: ['Observar e registrar as situações que antecedem a vontade de apostar', 'Ignorar os sentimentos'],
            respostaCorreta: 0,
          },
          {
            id: 'q-2',
            enunciado: 'Apostar para recuperar perdas anteriores é:',
            opcoes: ['Uma forma segura de quitar dívidas', 'Um padrão de risco típico do transtorno do jogo'],
            respostaCorreta: 1,
          },
        ],
      },
      {
        id: 'e-4',
        titulo: 'Plano de prevenção de recaídas',
        tipo: 'ATIVIDADE',
        conteudo:
          'Monte seu plano: liste seus gatilhos, uma ação alternativa para cada um e uma pessoa de confiança '
          + 'para contatar em momentos de crise.',
        ordem: 4,
        pontuacao: 25,
      },
    ],
  },
  {
    id: 't-2',
    nome: 'Formação de mentores',
    descricao: 'Trilha exclusiva para mentores: acolhimento, escuta ativa e limites do papel de mentor.',
    publicoAlvo: ['MENTOR'],
    etapas: [
      {
        id: 'e-5',
        titulo: 'O papel do mentor',
        tipo: 'LEITURA',
        conteudo:
          'O mentor compartilha sua experiência e acolhe, mas não substitui o acompanhamento psicológico. '
          + 'Encaminhe situações de risco a profissionais.',
        ordem: 1,
        pontuacao: 20,
      },
      {
        id: 'e-6',
        titulo: 'Escuta ativa',
        tipo: 'ATIVIDADE',
        conteudo: 'Pratique ouvir sem julgar, validar sentimentos e fazer perguntas abertas.',
        ordem: 2,
        pontuacao: 30,
      },
    ],
  },
];

async function semear() {
  for (const definicao of TRILHAS) {
    await transacao(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_MIGRACAO]);
      const { rowCount } = await client.query(
        `INSERT INTO trilhas (id, nome, descricao, publico_alvo)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [definicao.id, definicao.nome, definicao.descricao, definicao.publicoAlvo],
      );
      if (!rowCount) return;

      for (const etapa of definicao.etapas) {
        await inserirEtapa(client, definicao.id, validarEtapa(etapa), etapa.id);
      }
      const trilha = await snapshotTrilha(client, definicao.id);
      await registrarEvento(client, { tipo: 'TRILHA_ATUALIZADA', agregadoId: definicao.id, payload: trilha });
      console.log(`Trilha inicial "${definicao.nome}" criada.`);
    });
  }
}

module.exports = { semear };
