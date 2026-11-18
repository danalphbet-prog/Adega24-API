# Adega24 · API Realtime Independente V1

**Somente a API.** Sem frontend, sem painel e sem APK neste ZIP. Ela será a ponte única entre **loja, ADM, aplicativo do entregador e Firebase Realtime Database**. Usa Node.js + `firebase-admin`, hospedada em um Web Service independente no Render. Preserva as estruturas do Firebase existentes; não exige importar ou apagar o banco.

## Arquitetura

```text
Site / Loja Pix ─────┐
Painel ADM ──────────┤ HTTPS REST + SSE (sem SDK do Realtime nos clientes)
App do Motoboy ──────┘
          │
          ▼
   ADEGA24 API / Render
     ├── Autenticação e permissões
     ├── CRUD de produtos/configurações/promoções/etc.
     ├── Pedidos e checkout Mercado Pago
     ├── Revezamento e feed dos motoboys
     ├── Rastreamento temporário
     └── Eventos SSE em tempo real
          │
          ▼
   Firebase Admin SDK
          │
          ▼
 Firebase Realtime Database
```

O backend é o único que precisa de acesso administrativo ao RTDB; **nunca entregue o JSON da conta de serviço aos clientes**. O front e o APK devem autenticar-se na API. Para tempo real, use **SSE** (`/api/v1/eventos/*`) ou polling de endpoints REST.

## Estruturas existentes (compatíveis)

- `/produtos/{id}` — `nome`, `categoria`, `valor`, `estoque`, `ativo`, `imagem`, `selos` etc. **`valor` é em reais.**
- `/configuracoes/{secao}` — `loja`, `entrega`, `retirada`, `funcionamento`, `checkout`, `pagamentos`, `aparencia`, `motoboys` etc.
- `/pedidos/{uuid}` — `status` financeiro (`aguardando_pagamento`, `aprovado`, `cancelado` etc.) **separado de** `statusOperacional` (`novo`, `aceito`, `em_preparo`, `pronto`, `em_entrega`, `concluido`).
- `/entregas/{uuid}` — atribuição de motoboy, oferta e etapas.
- `/motoboys`, `/motoboyFeed`, `/motoboyCodigos`, `/localizacoesMotoboys` — contas e sincronização de entregadores.
- `/auditoria`, `/alertasLoja` — trilhas de alteração e notificações internas.
- `/banners`, `/promocoes`, `/categorias`, `/cupons` — coleções opcionais; a API pode criá-las quando necessárias.

### O que a API pode modificar

A API possui **CRUD protegido por login ADM** para produtos, banners, promoções, categorias e cupons. Possui atualização parcial (`PATCH`) para seções autorizadas de configurações. Possui **leitura ADM** de pedidos, entregas, motoboys, localização, feeds e auditoria, com ocultação de campos privados. Pedidos, pagamentos, entregas e motoboys possuem **rotas específicas** que validam as regras do negócio; não é permitido falsificar Pix por um PATCH genérico.

A loja usa catálogo público, checkout Pix e consulta do próprio pedido com token. O APK usa login de motoboy por código, suas próprias ofertas e mudanças de etapas. **Não há CRUD público irrestrito**, por segurança.

## Rotas importantes

| Verbo | Rota | Acesso |
|---|---|---|
| GET | `/api/health` | Público: saúde do processo |
| GET | `/api/v1/catalogo` | Público: catálogo de itens ativos e configurações públicas |
| POST | `/api/v1/admin/login` | E-mail/senha Firebase Auth + `/admins/{uid}=true` |
| POST | `/api/v1/admin/me` | Admin: validar sessão |
| GET | `/api/v1/dados/{colecao}` | Admin: ler coleção autorizada |
| GET | `/api/v1/dados/{colecao}/{id}` | Admin: ler registro |
| POST | `/api/v1/dados/{colecao}` | Admin: criar registro em coleção editável |
| PUT | `/api/v1/dados/{colecao}/{id}` | Admin: substituir registro editável |
| PATCH | `/api/v1/dados/{colecao}/{id}` | Admin: atualizar campos do registro |
| DELETE | `/api/v1/dados/{colecao}/{id}` | Admin: excluir registro editável |
| PATCH | `/api/v1/dados/configuracoes/{secao}` | Admin: alterar apenas os campos enviados, sem eliminar os demais |
| POST | `/api/v1/admin/acao` | Admin: `pedido_etapa`, `produto_salvar`, `produto_excluir`, `config_salvar` |
| POST | `/api/checkout` | Cliente: cria pedido + Pix; valores conferidos pelo servidor |
| POST | `/api/status` | Cliente com ID e token: consultar Pix real |
| POST | `/api/cancel` | Cliente com ID e token: cancelar Pix quando possível |
| POST | `/api/mercadopago/webhook` | Mercado Pago: assinatura validada |
| POST | `/api/customer/order` | Cliente com ID/token: acompanhar status e obter link de rastreio válido |
| POST | `/api/motoboy/login` | Motoboy: código emitido pelo ADM |
| POST | `/api/motoboy/me`, `/feed`, `/online`, `/heartbeat` | Motoboy autenticado |
| POST | `/api/motoboy/accept`, `/decline`, `/stage`, `/alert` | Motoboy autenticado |
| POST | `/api/motoboy/admin/create`, `/list`, `/set-active`, `/retry`, `/config` | Admin |
| GET | `/api/v1/eventos/catalogo` | SSE público: mudanças de catálogo e loja |
| GET | `/api/v1/eventos/admin/pedidos` | SSE admin: alterações dos últimos 150 pedidos |
| GET | `/api/v1/eventos/admin/entregas` | SSE admin: mudanças nas entregas |
| GET | `/api/v1/eventos/admin/motoboys` | SSE admin: presença dos motoboys |
| GET | `/api/v1/eventos/motoboy` | SSE motoboy: alterações no próprio feed |

**Todas as rotas autenticadas exigem** `Authorization: Bearer <token>` (exceto login e checkout público). Não envie tokens em query strings. Para SSE autenticado no navegador, utilize `fetch()` + `response.body` (o `EventSource` padrão não permite configurar o cabeçalho Authorization).

### Regras Pix

- Nunca confiar no preço ou no status de pagamento enviado pelo navegador ou APK.
- O checkout **recalcula o preço lendo `/produtos`** e valida o total com o Mercado Pago.
- A confirmação ocorre via webhook assinado, consulta `/api/status` ou rotina de conciliação.
- **Somente** `status='aprovado'` e `modo='entrega'` entram na fila dos motoboys. `statusOperacional='pronto'` não prova pagamento.
- A loja usa ID UUID e token hex de 64 caracteres para recuperar pedidos com segurança.

Consulte `docs/EXEMPLOS.md` para chamadas REST, SSE e login.

## Publicar como um novo repositório — Termux

**Não copie para `~/Adega24-git` agora.** Esta API é um projeto separado; a loja e o APK atuais devem continuar funcionando enquanto fazemos a migração.

1. Baixe `ADEGA24_API_REALTIME_V1.zip` no celular.
2. Execute:

```bash
mkdir -p ~/projetos-adega
unzip -o ~/storage/downloads/ADEGA24_API_REALTIME_V1.zip -d ~/projetos-adega
cd ~/projetos-adega/ADEGA24_API_REALTIME_V1 || exit 1
npm install
npm run check
npm test

git init -b main
git add .
git commit -m "Adega24 API Realtime independente V1"
gh repo create Adega24-API --private --source=. --remote=origin --push
```

Se `gh repo create` reclamar que o repositório já existe, associe o remoto existente com `git remote add origin https://github.com/danalphbet-prog/Adega24-API.git` e `git push -u origin main` (apenas depois de confirmar que é o repositório correto).

## Render (serviço separado do site)

1. Render → **New → Web Service** → conectar `danalphbet-prog/Adega24-API`, branch `main`.
2. Runtime **Node**, build command `npm install`, start command `npm start`, root directory vazia, porta pelo ambiente `PORT=10000`.
3. Adicionar em **Environment**:

| Variável | Valor |
|---|---|
| `FIREBASE_DATABASE_URL` | URL da mesma instância RTDB existente |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | JSON privado da conta de serviço do mesmo projeto Firebase, **ou** Secret File com `GOOGLE_APPLICATION_CREDENTIALS` |
| `FIREBASE_WEB_API_KEY` | Firebase Web API key do projeto (para login do ADM por e-mail/senha) |
| `ADEGA_SESSION_SECRET` | `openssl rand -hex 32` executado localmente; **não publicar** |
| `ADEGA_CORS_ORIGINS` | Domínio(s) do site/ADM, com esquema HTTPS, separados por vírgula, sem barra final |
| `MP_ACCESS_TOKEN` | Token Mercado Pago para checkout real; opcional enquanto testar CRUD |
| `MP_WEBHOOK_SECRET` | Segredo de assinatura do webhook Mercado Pago |
| `ADEGA_TRACKING_SECRET` | Segredo de rastreio (gerar outro com `openssl rand -hex 32`) |
| `ADEGA_PUBLIC_URL` | URL pública do **site** que servirá a página `/rastreio/` |
| `PORT` | `10000` ou porta fornecida pelo Render |

Gere seus segredos **no Termux**, não reutilize valores divulgados em conversas. Não suba `.env`, JSON de conta de serviço ou dados privados ao GitHub.

4. Salve/deploy e abra `https://<sua-api>.onrender.com/api/health` (a URL efetiva é informada pelo Render).
5. Verifique `GET /api/v1/catalogo`. O health apenas confirma que o processo está no ar; a chamada de catálogo prova acesso ao RTDB. **A API não muda automaticamente a URL do site ou do APK antigos.**
6. Configure URL e segredo do webhook na conta do Mercado Pago para `https://<sua-api>.onrender.com/api/mercadopago/webhook` antes de usar pagamentos reais.

## Atenção ao Firebase

`config/regras-restritivas-EXEMPLO.json` é um **modelo** para uso futuro, não para aplicar agora. Bloquear acesso direto antes de migrar a loja e o APK quebraria o sistema antigo. As regras de segurança do RTDB não limitam as credenciais administrativas do backend; por isso, **não exponha a conta de serviço**. Preservar índices `.indexOn: ["criadoEm","expiraEm"]` em `/pedidos`.

A API **não precisa gerar Firebase Custom Tokens** no login do motoboy e, portanto, não depende da IAM Credentials API para esse fluxo. O login ADM usa o Firebase Authentication por e-mail/senha via API e verifica se o UID está em `/admins`. Se o administrador antigo só faz login pelo Google, será necessário habilitar um método compatível ou implementar o fluxo OAuth no próximo passo.

## Testes locais

```bash
npm run check
npm test
```

Os testes usam banco simulado, não criam nem apagam pedidos de produção. **O pacote não foi implantado no Render, não efetuou pagamento real e não foi validado contra sua instância ativa do Firebase.** Publique em um serviço de teste primeiro.
