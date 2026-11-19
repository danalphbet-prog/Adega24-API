'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleCors, permittedOrigin } = require('../cors');
function response() {
  const headers = Object.create(null);
  return {
    headers,
    getHeader(k) { return headers[k.toLowerCase()]; },
    setHeader(k,v) { headers[k.toLowerCase()] = v; },
    writeHead(code, other) {
      this.statusCode = code;
      for (const [k,v] of Object.entries(other)) this.setHeader(k,v);
    },
    end() { this.ended = true; }
  };
}

test('GET health aceita qualquer origem, mas mantém retorno normal', () => {
  const res = response();
  const didEnd = handleCors({ method: 'GET', headers: { origin: 'https://exemplo.com' } }, res, '/api/health', {});
  assert.equal(didEnd, false);
  assert.equal(res.getHeader('Access-Control-Allow-Origin'), 'https://exemplo.com');
  assert.equal(res.getHeader('Vary'), 'Origin');
});
test('HTML aberto direto do celular pode testar rotas privadas com autenticação real', () => {
  const res = response();
  assert.equal(handleCors({ method: 'GET', headers: { origin: 'null' } }, res, '/api/v1/dados/produtos', {}), false);
  assert.equal(res.getHeader('Access-Control-Allow-Origin'), 'null');
});
test('preflight OPTIONS permite Content-Type, Bearer, X-API-Key', () => {
  const res = response();
  assert.equal(handleCors({ method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-headers': 'authorization,content-type' } }, res, '/api/v1/admin/me', {}), true);
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.match(res.getHeader('Access-Control-Allow-Headers'), /Authorization/);
  assert.match(res.getHeader('Access-Control-Allow-Headers'), /X-API-Key/);
});
test('origens não autorizadas continuam bloqueadas em rotas protegidas', () => {
  assert.equal(permittedOrigin('https://dominio-invalido.com', '/api/v1/dados/produtos', {ADEGA_CORS_ORIGINS:'https://adega24.onrender.com'}), false);
  assert.throws(() => handleCors({method:'GET',headers:{origin:'https://dominio-invalido.com'}},response(),'/api/v1/dados/produtos',{ADEGA_CORS_ORIGINS:'https://adega24.onrender.com'}), e => e.http === 403);
});
test('domínios da loja e painel configurados no Render funcionam', () => {
  const env={ADEGA_CORS_ORIGINS:'https://loja.exemplo, https://painel.exemplo/'};
  assert.equal(permittedOrigin('https://loja.exemplo','/api/v1/admin/me',env),true);
  assert.equal(permittedOrigin('https://painel.exemplo','/api/v1/admin/me',env),true);
});
test('Origin null pode ser desativado após os testes', () => {
  assert.equal(permittedOrigin('null','/api/v1/dados/produtos',{ADEGA_CORS_ALLOW_NULL_ORIGIN:'false'}),false);
  assert.equal(permittedOrigin('null','/api/health',{ADEGA_CORS_ALLOW_NULL_ORIGIN:'false'}),true);
});
test('requisições nativas sem Origin não são bloqueadas', () => {
  assert.equal(handleCors({method:'POST',headers:{}},response(),'/api/v1/admin/me',{}),false);
});
