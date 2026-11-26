# Demonstração da SAGA — promoção de paciente para mentor

A SAGA é orquestrada pelo serviço `saga-orquestrador`. O estado durável da execução fica no PostgreSQL do **Atendimento** (`promocoes_mentor`). Os serviços mantêm seus próprios dados e executam transações locais.

## Fluxo

1. **Atendimento (início):** verifica se o paciente existe e está apto; cria a execução `EM_ANDAMENTO` e registra os passos.
2. **Usuários:** altera o papel de `PACIENTE` para `MENTOR`.
3. **Comunidade (pivô):** cria o perfil oficial do mentor. Depois da confirmação, a promoção é definitiva.
4. **Gamificação:** libera a trilha `Formação de mentores` (`t-2`). Essa etapa é idempotente e pode ser repetida sem desfazer a promoção.
5. Se a Comunidade rejeitar a criação, o orquestrador executa a compensação em Usuários: `MENTOR` volta para `PACIENTE`.

A SAGA segue o fluxo de quatro serviços descrito na arquitetura DEV. A alteração em Gamificação é pequena e específica: uma inscrição idempotente na trilha já existente `t-2`, sem modificar o restante do CQRS.

## Subir o projeto

Na raiz:

```bash
cp .env.example .env
docker compose up --build -d
```

Aguarde os serviços ficarem saudáveis:

```bash
docker compose ps
```

## Caminho feliz

Enviar pelo Insomnia:

- Método: `POST`
- URL: `http://localhost:8080/saga/v1/promocoes-mentor`
- Header: `Content-Type: application/json`
- Body:

```json
{
  "usuarioId": "paciente-001"
}
```

Resultado esperado: HTTP `201`; usuário `paciente-001` fica com papel `MENTOR`; o perfil de Ana Souza aparece na Comunidade; a trilha `t-2` é liberada para ela; a SAGA fica `CONCLUIDA`.

## Falha com compensação real

Enviar:

- Método: `POST`
- URL: `http://localhost:8080/saga/v1/promocoes-mentor`
- Header: `Content-Type: application/json`
- Body:

```json
{
  "usuarioId": "paciente-002",
  "simularFalhaComunidade": true
}
```

A flag provoca uma rejeição controlada no serviço de Comunidade. A sequência observável é: Usuários grava `MENTOR`; Comunidade rejeita o perfil; o orquestrador chama o endpoint compensatório de Usuários; o banco de Usuários volta a registrar `PACIENTE`. A execução termina como `COMPENSADA`.

## Conferir os dados persistidos

- `GET http://localhost:8080/saga/v1/demo/estado` — visão conjunta para a demonstração, incluindo a inscrição na trilha.
- `GET http://localhost:8080/saga/v1/promocoes-mentor` — histórico das execuções.
- `GET http://localhost:8080/saga/v1/promocoes-mentor/{id}` — estado e passos de uma execução específica.

Para comprovar que a compensação foi real, observe `paciente-002` na lista `usuarios`: seu papel deve ser `PACIENTE`. Ele também não deve aparecer na lista `mentores` da Comunidade nem receber inscrição na trilha `t-2`. A execução deve conter `usuarios: COMPENSADO`, `comunidade: FALHOU` e status `COMPENSADA`.

## Registros de demonstração

Os dois registros são criados automaticamente, sem duplicação, na inicialização dos serviços:

| ID | Nome | Papel inicial | Cenário |
|---|---|---|---|
| `paciente-001` | Ana Souza | `PACIENTE` | Caminho feliz |
| `paciente-002` | Bruno Lima | `PACIENTE` | Falha simulada e compensação |

Para repetir a demonstração do caminho feliz do zero, remova os volumes locais antes de subir novamente (isso apaga os bancos locais):

```bash
docker compose down -v
docker compose up --build -d
```

A falha é acionada explicitamente pelo corpo da requisição; não depende de desligar containers ou indisponibilizar bancos. Se a Gamificação falhar depois do pivô, o orquestrador mantém a promoção e registra `PENDENTE_POS_PIVO`, sem executar compensação.
