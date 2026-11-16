import { useState } from 'react'
import './App.css'

const services = [
  { key: 'usuarios', name: 'Usuários', database: 'PostgreSQL' },
  { key: 'atendimento', name: 'Atendimento', database: 'PostgreSQL' },
  { key: 'gamificacao-escrita', name: 'Gamificação — escrita', database: 'PostgreSQL' },
  { key: 'gamificacao-leitura', name: 'Gamificação — leitura', database: 'MongoDB' },
  { key: 'comunidade', name: 'Comunidade', database: 'MongoDB' },
  { key: 'saga-orquestrador', name: 'Orquestrador SAGA', database: 'PostgreSQL de Atendimento (compartilhado)' },
]

function App() {
  const [results, setResults] = useState({})
  const [loading, setLoading] = useState(false)

  async function requestCheck(service, operation) {
    try {
      const response = await fetch(
        `/admin/v1/diagnostics/services/${service.key}/${operation}`,
      )
      const body = await response.json()
      return { ...body, httpStatus: response.status }
    } catch (error) {
      return {
        status: 'error',
        message: 'Não foi possível alcançar o Gateway.',
        detail: error.message,
      }
    }
  }

  async function checkOne(service, operation) {
    const key = `${service.key}:${operation}`
    setLoading(true)
    const result = await requestCheck(service, operation)
    setResults((current) => ({ ...current, [key]: result }))
    setLoading(false)
  }

  async function checkAll() {
    setLoading(true)
    const checks = await Promise.all(
      services.flatMap((service) =>
        ['health', 'db'].map(async (operation) => [
          `${service.key}:${operation}`,
          await requestCheck(service, operation),
        ]),
      ),
    )
    setResults(Object.fromEntries(checks))
    setLoading(false)
  }

  function renderResult(service, operation) {
    const result = results[`${service.key}:${operation}`]
    if (!result) return <span className="check-pending">Ainda não testado</span>
    const ok = result.status === 'success' || result.status === 'ok'
    if (!ok) return <span className="check-failed">{result.message}</span>
    if (operation === 'health') {
      return <span className="check-passed">Saudável · HTTP {result.httpStatus}</span>
    }

    const databaseResult = result.database?.timestamp
      ? `Banco respondeu em ${result.database.responseTimeMs} ms`
      : `Ping do banco: ${result.database?.ping ? 'OK' : 'sem resposta'}`
    return (
      <span className="check-passed">
        {databaseResult} · HTTP {result.httpStatus}
      </span>
    )
  }

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div className="admin-brand">
          <span className="admin-mark">B</span>
          <span>BEDARCE</span>
          <span className="admin-divider" />
          <span className="admin-panel-label">PAINEL ADMINISTRATIVO</span>
        </div>
        <span className="environment-tag">AMBIENTE LOCAL</span>
      </header>

      <section className="admin-content">
        <p className="admin-eyebrow">INFRAESTRUTURA · DIAGNÓSTICO</p>
        <h1>Visão do sistema</h1>
        <p className="admin-intro">
          Painel → Gateway → BFF Admin → Gateway interno → cada serviço e seu
          próprio banco de dados.
        </p>

        <section className="admin-diagnostics" aria-live="polite">
          <div className="diagnostics-heading">
            <div>
              <span className="admin-eyebrow">TESTE PONTA A PONTA</span>
              <h2>Serviços e bancos</h2>
            </div>
            <button type="button" onClick={checkAll} disabled={loading}>
              {loading ? 'Testando…' : 'Testar todos'}
            </button>
          </div>

          <div className="admin-service-grid">
            {services.map((service) => (
              <article className="admin-service-card" key={service.key}>
                <div className="admin-service-title">
                  <div>
                    <h3>{service.name}</h3>
                    <span>{service.database}</span>
                  </div>
                  <code>{service.key}</code>
                </div>
                <div className="admin-check-line">
                  <span>Serviço</span>
                  {renderResult(service, 'health')}
                  <button
                    type="button"
                    className="small-button"
                    onClick={() => checkOne(service, 'health')}
                    disabled={loading}
                  >
                    Testar
                  </button>
                </div>
                <div className="admin-check-line">
                  <span>Banco</span>
                  {renderResult(service, 'db')}
                  <button
                    type="button"
                    className="small-button"
                    onClick={() => checkOne(service, 'db')}
                    disabled={loading}
                  >
                    Testar
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>

      <footer className="admin-footer">
        <span>BEDARCE · diagnóstico administrativo</span>
        <span>Os bancos não são acessados diretamente pelo front-end.</span>
      </footer>
    </main>
  )
}

export default App
