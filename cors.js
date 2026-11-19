'use strict';
/**
 * CORS para a API Adega24 (Node.js http nativo).
 * Não altera autenticação, acesso ao Firebase ou assinatura dos webhooks.
 * - Rotas públicas: acessíveis em qualquer origem.
 * - Rotas privadas: origens informadas em ADEGA_CORS_ORIGINS.
 * - Testador aberto como arquivo local (Origin: null): aceito por padrão.
 *   Em produção, defina ADEGA_CORS_ALLOW_NULL_ORIGIN=false depois dos testes.
 * - Requisições sem Origin (por exemplo, Android/Termux) continuam funcionando.
 */
const PUBLIC_PATHS = new Set([
  '/',
  '/api/health',
  '/api/v1/catalogo',
  '/api/v1/eventos/catalogo'
]);
const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Accept,Content-Type,Authorization,X-API-Key,X-Cron-Secret,X-Requested-With';

function permittedOrigin(origin, pathname, env = process.env) {
  if (!origin) return true; // Apps nativos/servidores que não enviam Origin
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (origin === 'null') return env.ADEGA_CORS_ALLOW_NULL_ORIGIN !== 'false';
  const allowlist = String(env.ADEGA_CORS_ORIGINS || '')
    .split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);
  return allowlist.includes(origin);
}

function handleCors(req, res, pathname, env = process.env) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin) {
    if (!permittedOrigin(origin, pathname, env)) {
      const err = new Error('Origem não autorizada. Adicione o domínio em ADEGA_CORS_ORIGINS no Render.');
      err.http = 403;
      throw err;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    const vary = String(res.getHeader('Vary') || '');
    if (!vary.split(',').some(item => item.trim().toLowerCase() === 'origin')) {
      res.setHeader('Vary', vary ? vary + ', Origin' : 'Origin');
    }
  }
  if (req.method !== 'OPTIONS') return false;

  res.writeHead(204, {
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store'
  });
  res.end();
  return true;
}

module.exports = { handleCors, permittedOrigin };
