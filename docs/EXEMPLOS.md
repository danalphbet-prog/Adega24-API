# Integração REST e SSE — exemplos

Defina `API_URL` com o endereço **real** informado pelo Render:

```bash
API_URL='https://SUA-API.onrender.com'
curl -s "$API_URL/api/health"
curl -s "$API_URL/api/v1/catalogo" | head -c 700
```

## Login de administrador

É necessário que o Firebase Authentication aceite e-mail/senha e que `/admins/{uid}` tenha o valor booleano `true` para esse usuário. O exemplo usa dados fictícios:

```bash
curl -X POST "$API_URL/api/v1/admin/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@exemplo.com","senha":"SENHA_DO_ADMIN"}'
```

A resposta retorna `token`. Utilize-o como **Bearer**, nunca na URL nem em arquivos estáticos:

```bash
TOKEN='COLE_A_SESSAO_RECEBIDA'
curl "$API_URL/api/v1/dados/produtos" -H "Authorization: Bearer $TOKEN"
```

## Criar produto

```bash
curl -X POST "$API_URL/api/v1/dados/produtos" \
 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
 -d '{"id":"gin_teste","data":{"nome":"Gin Teste","categoria":"Gin","valor":39.90,"ativo":true,"estoque":10}}'
```

## Alterar somente o preço (sem apagar outros campos)

```bash
curl -X PATCH "$API_URL/api/v1/dados/produtos/gin_teste" \
 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
 -d '{"data":{"valor":42.90}}'
```

## Editar configuração da loja ou entrega

```bash
curl -X PATCH "$API_URL/api/v1/dados/configuracoes/entrega" \
 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
 -d '{"data":{"habilitada":true,"taxa":7.50}}'
```

## Excluir produto

```bash
curl -X DELETE "$API_URL/api/v1/dados/produtos/gin_teste" \
 -H "Authorization: Bearer $TOKEN"
```

## Consultar pedidos pagos e pendentes (somente ADM)

```bash
curl "$API_URL/api/v1/dados/pedidos" -H "Authorization: Bearer $TOKEN"
```

**Não** use `PATCH /dados/pedidos/...` para alterar um Pix. Para alterar a etapa operacional de um pedido aprovado:

```bash
curl -X POST "$API_URL/api/v1/admin/acao" \
 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
 -d '{"acao":"pedido_etapa","id":"UUID_DO_PEDIDO","etapa":"em_preparo"}'
```

## Eventos em tempo real (SSE)

Catálogo público (não inclui pedidos nem dados privados):

```bash
curl -N "$API_URL/api/v1/eventos/catalogo"
```

Pedidos do ADM:

```bash
curl -N "$API_URL/api/v1/eventos/admin/pedidos" \
 -H "Authorization: Bearer $TOKEN"
```

O servidor envia linhas como:

```text
event: atualizacao
data: {"tipo":"pedidos","dados":{...}}
```

Cliente web: `EventSource` nativo não envia o Bearer no cabeçalho. Para **streams privados**, utilize `fetch()` e leia `response.body` com `getReader()`. Não envie o token por query string.

## Motoboy (somente a API lê o Firebase)

```bash
curl -X POST "$API_URL/api/motoboy/login" \
 -H 'Content-Type: application/json' -d '{"codigo":"CODIGO_EMITIDO_PELO_ADM"}'
```

Utilize o `token` retornado (não é um token do Firebase) nas chamadas seguintes:

```bash
MOTO_TOKEN='TOKEN_DO_APP'
curl -X POST "$API_URL/api/motoboy/online" \
  -H "Authorization: Bearer $MOTO_TOKEN" -H 'Content-Type: application/json' \
  -d '{"online":true}'

curl -X POST "$API_URL/api/motoboy/heartbeat" \
  -H "Authorization: Bearer $MOTO_TOKEN" -H 'Content-Type: application/json' -d '{}'

curl -X POST "$API_URL/api/motoboy/feed" \
  -H "Authorization: Bearer $MOTO_TOKEN" -H 'Content-Type: application/json' -d '{}'

curl -N "$API_URL/api/v1/eventos/motoboy" \
  -H "Authorization: Bearer $MOTO_TOKEN"
```

Os endpoints do app são `POST` para preservar compatibilidade com o backend existente. O motoboy não recebe segredos nem acesso à lista geral de pedidos da loja.

## Pedido + Pix

O checkout exige `checkoutId` UUID único e `checkoutToken` aleatório com 64 caracteres hexadecimais, `maiorDe18: true`, `modo: entrega|retirada`, itens com `id` e `quantidade`, cliente com nome, telefone, email e CPF, e endereço em caso de entrega. A API valida os preços no Realtime e emite o Pix pelo Mercado Pago:

```json
{
  "checkoutId":"f3e3dcf1-f204-4be5-93f4-fbdfe3d6af87",
  "checkoutToken":"64_CARACTERES_HEXADECIMAIS_GERADOS_DE_FORMA_SEGURA",
  "maiorDe18":true,
  "modo":"entrega",
  "cliente":{"nome":"Cliente Exemplo","telefone":"11999999999","email":"cliente@example.org","cpf":"CPF_VALIDO"},
  "endereco":"Rua Exemplo, 100, bairro, cidade",
  "itens":[{"id":"gin_teste","quantidade":1}]
}
```

O token mostrado acima é **placeholder**; não enviá-lo literalmente. O site precisa guardar o token gerado para consultar ou cancelar o próprio pedido em `/api/status`, `/api/cancel`, `/api/customer/order` com `{"id":"...","token":"..."}`. Antes de validar Pix real, configurar Mercado Pago e testar com ambiente de teste.
