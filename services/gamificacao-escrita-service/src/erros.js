// Erros de negócio no formato application/problem+json usado nos contratos OpenAPI.
const TITULOS = {
  400: 'Requisição inválida',
  401: 'Não autenticado',
  403: 'Acesso negado',
  404: 'Não encontrado',
  409: 'Conflito',
  500: 'Erro interno',
};

class ErroHttp extends Error {
  constructor(status, code, detail) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

function enviarProblema(res, req, status, code, detail) {
  return res
    .status(status)
    .type('application/problem+json')
    .json({
      type: 'about:blank',
      title: TITULOS[status] || 'Erro',
      status,
      detail,
      instance: req.originalUrl,
      code,
    });
}

module.exports = { ErroHttp, enviarProblema };
