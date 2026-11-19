'use strict';
// ADEGA24 API REALTIME V1 - serviço independente. Somente esta API acessa o RTDB.
const http = require('node:http');
const crypto = require('node:crypto');
const admin = require('firebase-admin');
const PORT = Number(process.env.PORT || 10000);
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const MP_BASE = process.env.MP_API_URL || 'https://api.mercadopago.com';
const DB_URL = process.env.FIREBASE_DATABASE_URL || 'https://appqua-22-default-rtdb.firebaseio.com';
const DEFAULTS = require('./config/adega-defaults.json');
const {createApiCentral}=require('./api-central');
const {createMotoboy}=require('./motoboy');
const {createTracking}=require('./tracking');
const {createResourceApi}=require('./resource-api');
const {createEventsApi}=require('./events-api');
const {handleCors}=require('./cors');
const CACHE = new Map(), RATE = new Map();
let firebaseDb;
const configRef = () => database().ref('configuracoes');
const error = (code,message) => Object.assign(new Error(message),{http:code});
const clean = (v,max=120) => typeof v==='string' ? v.trim().slice(0,max) : '';
const uuid = s => typeof s==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const hash = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const centavos = v => { const n=Number(v);return Number.isFinite(n)&&n>0&&n<=100000?Math.round(n*100):0; };
const numero = (v,fallback=0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const pagamentoFinal = s => ['aprovado','cancelado','recusado','estornado','expirado'].includes(s);
const mapStatus = s => ({approved:'aprovado',rejected:'recusado',cancelled:'cancelado',refunded:'estornado',charged_back:'estornado',in_process:'processando',authorized:'processando'})[s]||'aguardando_pagamento';
function database(){
  if(!firebaseDb){
    if(!admin.apps.length){
      const options={databaseURL:DB_URL};
      if(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)options.credential=admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
      else options.credential=admin.credential.applicationDefault();
      admin.initializeApp(options);
    }
    firebaseDb=admin.database();
  }
  return firebaseDb;
}
const SAFE_HEADERS={'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"};
function send(res,status,data){res.writeHead(status,{...SAFE_HEADERS,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function bodyJSON(req,max=25*1024){const chunks=[];let length=0;for await(const part of req){length+=part.length;if(length>max)throw error(413,'Solicitação excedeu o limite.');chunks.push(part);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw error(400,'JSON inválido.');}}
function fillMissing(actual,defaults){
  const out=actual&&typeof actual==='object'&&!Array.isArray(actual)?{...actual}:{};
  let changed=!(actual&&typeof actual==='object'&&!Array.isArray(actual));
  for(const [k,v] of Object.entries(defaults)){
    if(!(k in out)||out[k]===null){out[k]=v;changed=true;}
    else if(v&&typeof v==='object'&&!Array.isArray(v)){
      const [nested,wasChanged]=fillMissing(out[k],v);
      if(wasChanged){out[k]=nested;changed=true;}
    }
  }
  return [out,changed];
}
async function seedConfig(){
  await configRef().transaction(current=>{
    const [merged,changed]=fillMissing(current,DEFAULTS);
    // Corrige especificamente configuração antiga que ainda dizia "Functions não publicadas".
    const pix=current?.pagamentos?.pix;
    if(pix?.habilitado===false && /Ativar depois de configurar/i.test(pix.observacao||'')){
      merged.pagamentos.pix.habilitado=true;
      merged.pagamentos.pix.observacao='Ativado após migração para backend Mercado Pago no Render.';
      return merged;
    }
    return changed?merged:undefined;
  }, undefined, false);
}
function publicOrder(o){return {id:o.id,status:o.status,total:o.totalCentavos/100,criadoEm:o.criadoEm,expiraEm:o.expiraEm,expiracaoMercadoPago:o.expiracaoMercadoPago||null,pagamentoId:o.pagamentoId,pix:o.pix||{},itens:o.itens||[],modo:o.modo,registroPendente:!!o.registroPendente};}
async function mp(url,opts={}){
  if(!MP_TOKEN)throw error(503,'MP_ACCESS_TOKEN não configurado no Render.');
  let r;
  try{r=await fetch(MP_BASE+url,{...opts,headers:{Authorization:'Bearer '+MP_TOKEN,Accept:'application/json',...(opts.body?{'Content-Type':'application/json'}:{}),...opts.headers},signal:AbortSignal.timeout(28000)});}
  catch(e){throw error(503,'Mercado Pago não respondeu. Consulte o pedido antes de tentar novamente.');}
  const data=await r.json().catch(()=>({}));
  if(!r.ok){const cause=Array.isArray(data.cause)?clean(String(data.cause[0]?.code||''),50):'';console.error('[MP]',r.status,cause);throw error(502,`Mercado Pago: HTTP ${r.status}${cause?' ('+cause+')':''}.`);}
  return data;
}
function verifyMP(mpPayment,o){
  const amount=Math.round(Number(mpPayment.transaction_amount)*100);
  if(String(mpPayment.external_reference)!==o.id||amount!==o.totalCentavos||mpPayment.payment_method_id!=='pix')throw error(502,'Pagamento Mercado Pago não corresponde ao pedido.');
}
function requestShape(data){
  if(!uuid(data.checkoutId)||!/^[a-f0-9]{64}$/i.test(data.checkoutToken||''))throw error(400,'Identificador do pedido inválido.');
  if(data.maiorDe18!==true)throw error(400,'Confirme a maioridade.');
  if(!['retirada','entrega'].includes(data.modo))throw error(400,'Forma de recebimento inválida.');
  if(!Array.isArray(data.itens)||!data.itens.length||data.itens.length>100)throw error(400,'Carrinho inválido.');
  const seen=new Set();
  for(const x of data.itens){if(!x||!/^[\w-]{1,90}$/.test(x.id||'')||seen.has(x.id)||!Number.isInteger(x.quantidade)||x.quantidade<1||x.quantidade>100)throw error(400,'Produto/quantidade inválido.');seen.add(x.id);}
  const c=data.cliente||{};
  const nome=clean(c.nome,90),telefone=clean(c.telefone,25).replace(/\D/g,''),email=clean(c.email,160).toLowerCase(),cpf=clean(c.cpf,25).replace(/\D/g,'');
  if(nome.length<3||telefone.length<10||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^\d{11}$/.test(cpf))throw error(400,'Confira nome, telefone, e-mail e CPF para o Pix.');
  const endereco=data.modo==='entrega'?clean(data.endereco,220):'';
  if(data.modo==='entrega'&&endereco.length<15)throw error(400,'Endereço de entrega incompleto.');
  return {id:data.checkoutId,token:data.checkoutToken,nome,telefone,email,cpf,endereco,modo:data.modo,ids:data.itens.map(i=>({id:i.id,quantidade:i.quantidade}))};
}
async function quote(source){
  const cfg=(await configRef().once('value')).val()||DEFAULTS;
  if(cfg.loja?.ativa===false||cfg.funcionamento?.aberta===false)throw error(409,'A adega está fechada para pedidos.');
  if(cfg.pagamentos?.pix?.habilitado===false)throw error(409,'Pagamento por Pix indisponível.');
  const maxDifferent=Math.min(100,Math.max(1,numero(cfg.checkout?.maxProdutosDiferentes,20)));
  const maxQty=Math.min(100,Math.max(1,numero(cfg.checkout?.maxUnidadesPorProduto,25)));
  if(source.ids.length>maxDifferent)throw error(400,'Limite de produtos diferentes excedido.');
  if(source.modo==='entrega'&&cfg.entrega?.habilitada!==true)throw error(400,'Entrega não habilitada.');
  if(source.modo==='retirada'&&cfg.retirada?.habilitada!==true)throw error(400,'Retirada não habilitada.');
  const itens=await Promise.all(source.ids.map(async item=>{
    if(item.quantidade>maxQty)throw error(400,'Quantidade acima do limite definido pela adega.');
    const p=(await database().ref('produtos/'+item.id).once('value')).val();
    if(!p||p.ativo!==true)throw error(409,'Produto foi desativado: '+item.id);
    if(Number.isInteger(p.estoque)&&p.estoque<item.quantidade)throw error(409,'Estoque insuficiente: '+clean(p.nome));
    const precoCentavos=centavos(p.valor);
    if(!precoCentavos)throw error(409,'Preço indisponível: '+clean(p.nome));
    return {id:item.id,nome:clean(p.nome,130)||item.id,quantidade:item.quantidade,precoCentavos,parcialCentavos:precoCentavos*item.quantidade};
  }));
  const taxaCentavos=source.modo==='entrega'?Math.round(Math.max(0,numero(cfg.entrega?.taxa))*100):0;
  const totalCentavos=itens.reduce((s,i)=>s+i.parcialCentavos,taxaCentavos);
  if(totalCentavos<100||totalCentavos>50000000)throw error(400,'Total fora do limite aceito para Pix.');
  const minimo=centavos(cfg.entrega?.pedidoMinimo);
  if(source.modo==='entrega'&&totalCentavos-taxaCentavos<minimo)throw error(409,'Pedido abaixo do valor mínimo de entrega.');
  return {itens,taxaCentavos,totalCentavos,
    prazoLojaMinutos:Math.max(1,Math.min(30,numero(cfg.pagamentos?.pix?.prazoLojaMinutos,10))),
    prazoMpMinutos:Math.max(30,Math.min(43200,numero(cfg.pagamentos?.pix?.prazoMercadoPagoMinutos,30)))};
}
function rateLimit(req){const key=clean(req.headers['cf-connecting-ip'],60)||req.socket.remoteAddress||'local';const now=Date.now();for(const [k,v] of RATE)if(v.until<now)RATE.delete(k);const x=RATE.get(key)||{n:0,until:now+3600000};if(++x.n>25)throw error(429,'Muitas solicitações de pagamento.');RATE.set(key,x);}
async function persist(o){await database().ref('pedidos/'+o.id).set(o);}
async function checkout(req,res){
  const data=await bodyJSON(req),input=requestShape(data);
  const tokenHash=hash(input.token);
  let fromDb=(await database().ref('pedidos/'+input.id).once('value')).val();
  if(fromDb){if(fromDb.tokenHash!==tokenHash)throw error(403,'Não autorizado.');return send(res,200,publicOrder(fromDb));}
  if(CACHE.has(input.id)){
    const entry=CACHE.get(input.id);
    if(entry.tokenHash!==tokenHash)throw error(403,'Não autorizado.');
    return send(res,200,publicOrder(await entry.promise));
  }
  rateLimit(req);
  const promise=(async()=>{
    const quoteData=await quote(input);
    const now=Date.now(),expiraEm=now+quoteData.prazoLojaMinutos*60000;
    const paymentExpire=new Date(now+Math.max(31,quoteData.prazoMpMinutos)*60000).toISOString();
    const order={id:input.id,tokenHash,fontePrecos:'realtime_validado_servidor',precificacaoConferida:true,
      nome:input.nome,telefone:input.telefone,email:input.email,endereco:input.endereco,modo:input.modo,
      itens:quoteData.itens,taxaCentavos:quoteData.taxaCentavos,totalCentavos:quoteData.totalCentavos,
      status:'aguardando_pagamento',statusOperacional:'novo',criadoEm:now,atualizadoEm:now,expiraEm,
      expiracaoMercadoPago:paymentExpire};
    const payment=await mp('/v1/payments',{method:'POST',headers:{'X-Idempotency-Key':input.id},body:JSON.stringify({
      transaction_amount:quoteData.totalCentavos/100,description:'Pedido Adega 24 '+input.id.slice(0,8),
      payment_method_id:'pix',external_reference:input.id,date_of_expiration:paymentExpire,
      payer:{email:input.email,first_name:input.nome.split(' ')[0],last_name:input.nome.split(' ').slice(1).join(' ')||'Cliente',
        identification:{type:'CPF',number:input.cpf}}
    })});
    if(!payment.id)throw error(502,'Mercado Pago não retornou ID do Pix.');
    verifyMP(payment,order);
    const tx=payment.point_of_interaction?.transaction_data||{};
    order.pagamentoId=String(payment.id);
    order.status=mapStatus(payment.status);
    order.pix={qr_code:tx.qr_code||'',qr_code_base64:tx.qr_code_base64||'',ticket_url:tx.ticket_url||''};
    if(!order.pix.qr_code&&!order.pix.qr_code_base64&&!order.pix.ticket_url&&order.status!=='aprovado')throw error(502,'Mercado Pago não retornou o QR Code. Confira sua conta.');
    try{await persist(order);order.registroPendente=false;}
    catch(e){console.error('[Firebase] Pedido ainda não salvo',input.id,e.code||e.message);order.registroPendente=true;}
    return order;
  })();
  CACHE.set(input.id,{tokenHash,promise});
  try{return send(res,200,publicOrder(await promise));}
  catch(e){CACHE.delete(input.id);throw e;}
}
async function authorizedOrder(b){
  if(!uuid(b.id)||!/^[a-f0-9]{64}$/i.test(b.token||''))throw error(400,'Consulta de pedido inválida.');
  const entry=CACHE.get(b.id);
  let o=entry?.tokenHash===hash(b.token)?await entry.promise:null;
  if(!o)o=(await database().ref('pedidos/'+b.id).once('value')).val();
  if(!o||o.tokenHash!==hash(b.token))throw error(404,'Pedido não encontrado.');
  return o;
}
async function updateOrder(o){
  o.atualizadoEm=Date.now();
  try{
    await database().ref('pedidos/'+o.id).update({status:o.status,statusOperacional:o.statusOperacional,
      atualizadoEm:o.atualizadoEm,ultimaConsulta:o.ultimaConsulta||Date.now(),expiraEm:o.expiraEm||null,
      ...(o.registroPendente?o:{})});
    o.registroPendente=false;
  }catch(e){console.error('[Firebase] Falha ao atualizar pedido',o.id,e.code||e.message);o.registroPendente=true;}
}
async function reconcile(o,{cancel=false,expired=false}={}){
  if(!o.expiraEm&&o.criadoEm)o.expiraEm=o.criadoEm+600000;
  if(!o.pagamentoId||['aprovado','estornado','cancelado','recusado','expirado'].includes(o.status))return o;
  const pay=await mp('/v1/payments/'+encodeURIComponent(o.pagamentoId));
  verifyMP(pay,o);
  const status=mapStatus(pay.status);
  if(status==='aprovado'||pagamentoFinal(status)){
    o.status=status;
    if(status==='aprovado')o.statusOperacional='novo';
  }else if(cancel||(expired&&Date.now()>=o.expiraEm)){
    // Só libera o carrinho DEPOIS de cancelamento confirmado pelo Mercado Pago.
    try{
      const cancelled=await mp('/v1/payments/'+encodeURIComponent(o.pagamentoId),{
        method:'PUT',body:JSON.stringify({status:'cancelled'})
      });
      const converted=mapStatus(cancelled.status);
      if(converted==='cancelado')o.status=expired?'expirado':'cancelado';
      else if(converted==='aprovado')o.status='aprovado';
      else o.status='cancelamento_pendente';
    }catch(e){
      // Uma corrida com o pagamento pode ter ocorrido. Verifica novamente antes de liberar.
      const latest=await mp('/v1/payments/'+encodeURIComponent(o.pagamentoId));
      verifyMP(latest,o);
      const converted=mapStatus(latest.status);
      o.status=converted==='aprovado'?'aprovado':converted==='cancelado'?(expired?'expirado':'cancelado'):'cancelamento_pendente';
    }
  }else{o.status=status;}
  o.ultimaConsulta=Date.now();
  await updateOrder(o);
  return o;
}
async function status(req,res){
  const o=await authorizedOrder(await bodyJSON(req));
  if(!pagamentoFinal(o.status))await reconcile(o,{expired:true});
  return send(res,200,publicOrder(o));
}
async function cancel(req,res){
  const o=await authorizedOrder(await bodyJSON(req));
  if(!pagamentoFinal(o.status))await reconcile(o,{cancel:true});
  return send(res,200,publicOrder(o));
}
function validWebhookSignature(req,url){
  if(!MP_WEBHOOK_SECRET)return false;
  const sign=clean(req.headers['x-signature'],256);
  const requestId=clean(req.headers['x-request-id'],256);
  const ts=sign.match(/(?:^|,)\s*ts=([^,]+)/)?.[1];
  const digest=sign.match(/(?:^|,)\s*v1=([0-9a-f]{64})/i)?.[1];
  const rawId=url.searchParams.get('data.id');
  if(!ts||!digest||!requestId||!rawId||!/^\d{10,16}$/.test(ts))return false;
  const timestamp=Number(ts);const millis=timestamp<1e11?timestamp*1000:timestamp;
  if(Math.abs(Date.now()-millis)>10*60*1000)return false;
  const content=`id:${rawId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const expected=crypto.createHmac('sha256',MP_WEBHOOK_SECRET).update(content).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(digest,'hex'));
}
async function webhook(req,res,url){
  if(!validWebhookSignature(req,url))throw error(401,'Assinatura do webhook inválida.');
  const b=await bodyJSON(req,16*1024);
  if(b.type!=='payment'&&b.action!=='payment.created'&&b.action!=='payment.updated')return send(res,200,{ok:true});
  const id=url.searchParams.get('data.id');
  if(!/^\d{1,24}$/.test(id||''))throw error(400,'Pagamento inválido.');
  const pay=await mp('/v1/payments/'+encodeURIComponent(id));
  const orderId=String(pay.external_reference||'');
  if(!uuid(orderId))return send(res,200,{ok:true});
  const order=(await database().ref('pedidos/'+orderId).once('value')).val();
  if(!order||String(order.pagamentoId)!==String(pay.id))return send(res,200,{ok:true});
  verifyMP(pay,order);
  const next=mapStatus(pay.status);
  if(next==='aprovado'||next==='estornado'||!pagamentoFinal(order.status)){
    order.status=next==='cancelado'&&Date.now()>=order.expiraEm?'expirado':next;
    if(next==='aprovado')order.statusOperacional='novo';
    order.ultimaConsulta=Date.now();
    await updateOrder(order);
  }
  return send(res,200,{ok:true});
}
async function cleanupExpiredOrders(){
  const now=Date.now();
  const snapshot=await database().ref('pedidos').orderByChild('expiraEm').endAt(now).limitToLast(30).once('value');
  const orders=snapshot.val()||{};
  for(const [id,o] of Object.entries(orders)){
    if(!o||!o.pagamentoId||pagamentoFinal(o.status)||!o.expiraEm||o.expiraEm>now)continue;
    try{await reconcile(o,{expired:true});}catch(e){console.error('[Expiry]',id,e.message);}
  }
}
const central=createApiCentral({database,admin,send,bodyJSON});
const resources=createResourceApi({database,send,bodyJSON,apiAuth:central.auth});
const events=createEventsApi({database,apiAuth:central.auth,getCatalog:central.getCatalog});
const tracking=createTracking({database,admin,send,bodyJSON,authorizedOrder,apiAuth:central.auth});
const motoboy=createMotoboy({database,admin,send,bodyJSON,tracking,apiAuth:central.auth});
async function handle(req,res){
  const url=new URL(req.url||'/', 'http://localhost'),p=url.pathname;
  // CORS da Adega24: origens públicas, domínios autorizados e testador local.
  if(handleCors(req,res,p))return;
  if(p.startsWith('/api/v1/dados/'))return resources.handle(req,res,p);
  if(p.startsWith('/api/v1/eventos/'))return events.handle(req,res,p);
  if(p.startsWith('/api/v1/'))return central.handle(req,res,p);
  if(p.startsWith('/api/motoboy/'))return motoboy.handler(req,res,p);
  if(p.startsWith('/api/tracking/')||p==='/api/customer/order')return tracking.handler(req,res,p,url);
  if(req.method==='GET'&&p==='/api/health')return send(res,200,{ok:true,servico:'Adega24 API Realtime',versao:'1.0.0',mercadoPagoConfigurado:!!MP_TOKEN,webhookConfigurado:!!MP_WEBHOOK_SECRET});
  if(req.method==='GET'&&p==='/')return send(res,200,{servico:'Adega24 API Realtime',documentacao:'Consulte README.md no repositorio.',health:'/api/health',catalogo:'/api/v1/catalogo'});
  if(req.method==='POST'&&p==='/api/checkout')return checkout(req,res);
  if(req.method==='POST'&&p==='/api/status')return status(req,res);
  if(req.method==='POST'&&p==='/api/cancel')return cancel(req,res);
  if(req.method==='POST'&&p==='/api/mercadopago/webhook')return webhook(req,res,url);
  if(req.method==='POST'&&p==='/api/cron/expire'){
    const given=clean(req.headers['x-cron-secret'],200),secret=process.env.ADEGA_CRON_SECRET||'';
    if(!secret||given!==secret)throw error(403,'Não autorizado.');
    await cleanupExpiredOrders();return send(res,200,{ok:true});
  }
  return send(res,404,{error:'Rota não encontrada. Este serviço hospeda somente a API.'});
}
const server=http.createServer((req,res)=>handle(req,res).catch(e=>{
  console.error('[API]',e.http||500,e.message);
  if(!res.headersSent)send(res,e.http||500,{error:e.http?e.message:'Erro interno. Consulte logs no Render.'});
}));
if(require.main===module){
  server.listen(PORT,'0.0.0.0',()=>console.log('Adega24 API Realtime V1 na porta',PORT));
  motoboy.start();
  seedConfig().then(()=>console.log('[Config] Defaults sincronizados sem apagar configurações')).catch(e=>console.error('[Config] Não foi possível criar defaults:',e.message));
  const expireJob=setInterval(()=>cleanupExpiredOrders().catch(e=>console.error('[Expiry]',e.message)),60000);
  expireJob.unref();
}
module.exports={server,quote,requestShape,fillMissing,reconcile,validWebhookSignature,seedConfig};
