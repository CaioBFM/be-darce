#!/usr/bin/env bash
# Comandos curtos para demonstrar o CQRS da Gamificação passo a passo.
# Cada comando faz UMA chamada real e mostra a requisição e a resposta.
#
#   ./scripts/cqrs.sh concluir <usuario> <etapa> [q-1=0,q-2=1]   comando no modelo de escrita (PostgreSQL)
#   ./scripts/cqrs.sh progresso <usuario>                         consulta no modelo de leitura (MongoDB)
#   ./scripts/cqrs.sh outbox [PENDENTE|ENVIADO|FALHA]             eventos da outbox
#   ./scripts/cqrs.sh tabela <usuario>                            linhas do usuário no PostgreSQL
#   ./scripts/cqrs.sh documento <usuario>                         documento do usuário no MongoDB
#   ./scripts/cqrs.sh relay                                       logs recentes do Relay
set -euo pipefail
cd "$(dirname "$0")/.."

ESCRITA=gamificacao-escrita-service
POSTGRES_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2)
POSTGRES_DB=$(grep -E '^POSTGRES_DB_GAMIFICACAO=' .env | cut -d= -f2)

# Executa a chamada HTTP de dentro do contêiner de escrita, que alcança os dois serviços pela rede interna.
read -r -d '' JS_HTTP <<'JS' || true
const { METODO, URL_ALVO, USUARIO, RESPOSTAS, ROTULO } = process.env;
const corpo = RESPOSTAS
  ? { respostas: RESPOSTAS.split(',').map((par) => {
      const [questaoId, opcao] = par.split('=');
      return { questaoId, opcaoSelecionada: Number(opcao) };
    }) }
  : undefined;
const cabecalhos = { 'Content-Type': 'application/json', ...(USUARIO ? { 'X-Usuario-Id': USUARIO } : {}) };
console.log(`\x1b[36m${ROTULO}\x1b[0m`);
console.log(`\x1b[2m→ ${METODO} ${URL_ALVO}${USUARIO ? `   X-Usuario-Id: ${USUARIO}` : ''}\x1b[0m`);
fetch(URL_ALVO, { method: METODO, headers: cabecalhos, body: corpo && JSON.stringify(corpo), signal: AbortSignal.timeout(4000) })
  .then(async (resposta) => {
    const cor = resposta.ok ? '\x1b[32m' : '\x1b[33m';
    console.log(`${cor}← HTTP ${resposta.status}\x1b[0m`);
    console.dir(await resposta.json(), { depth: null, colors: true });
  })
  .catch((erro) => console.log(`\x1b[31m✗ sem resposta: ${erro.cause?.code || erro.name}\x1b[0m`));
JS

http() {
  local rotulo=$1 metodo=$2 url=$3 usuario=${4:-} respostas=${5:-}
  docker compose exec -T \
    -e ROTULO="$rotulo" -e METODO="$metodo" -e URL_ALVO="$url" -e USUARIO="$usuario" -e RESPOSTAS="$respostas" \
    "$ESCRITA" node -e "$JS_HTTP"
}

uso() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

comando=${1:-}
[ -n "$comando" ] || uso
shift
if [ $# -ge 1 ] && [ "$comando" != outbox ] && ! [[ $1 =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "Usuário inválido: use letras, números, _ ou -." >&2
  exit 1
fi

case "$comando" in
  concluir)
    [ $# -ge 2 ] || uso
    http "[ESCRITA · PostgreSQL] concluir etapa $2" POST "http://127.0.0.1:5002/v1/etapas/$2/conclusao" "$1" "${3:-}"
    ;;
  progresso)
    [ $# -ge 1 ] || uso
    http "[LEITURA · MongoDB] progresso de $1" GET "http://gamificacao-leitura-service:5003/v1/usuarios/me/progresso" "$1"
    ;;
  outbox)
    http "[ESCRITA · PostgreSQL] outbox" GET "http://127.0.0.1:5002/v1/internal/outbox?limite=5${1:+&status=$1}"
    ;;
  tabela)
    [ $# -ge 1 ] || uso
    docker compose exec -T db-gamificacao-escrita psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -c "SELECT usuario_id, pontos, nivel, versao FROM pontuacoes WHERE usuario_id = '$1';" \
      -c "SELECT tipo_evento, status, tentativas, criado_em::time(0) AS criado, enviado_em::time(0) AS enviado
          FROM outbox WHERE agregado_id = '$1' ORDER BY criado_em;"
    ;;
  documento)
    [ $# -ge 1 ] || uso
    docker compose exec -T db-gamificacao-leitura mongosh --quiet bedarce_gamificacao_leitura \
      --eval "printjson(db.progresso.findOne({ _id: '$1' }, { trilhas: 0 }))"
    ;;
  relay)
    docker compose logs --no-log-prefix --since 2m "$ESCRITA" | grep 'Relay:' | tail -n 6
    ;;
  *)
    uso
    ;;
esac
