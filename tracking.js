'use strict';
/**
 * Adega24 Rastreamento V2 — acesso curto e revogável, SSE derivado do Realtime.
 * NÃO permite leitura pública de localização no Firebase.
 * O link contém uma credencial no #fragmento (não chega em logs HTTP).
 */
const crypto = require('node:crypto');
const ORDER_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE=new Set(['aceito','retirado','em_entrega']);
const CLOSED=new Set(['concluido','cancelado','estornado','expirado','recusado']);
const bad=(http,message)=>Object.assign(new Error(message),{http});
const clamp=(n,min,max,def)=>Number.isFinite(Number(n))?Math.min(max,Math.max(min,Number(n))):def;
const fixedEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));

function createTracking({database,admin,send,bodyJSON,authorizedOrder,apiAuth,secret=process.env.ADEGA_TRACKING_SECRET,baseUrl=process.env.ADEGA_PUBLIC_URL||'https://adega24.onrender.com'}){
 const secretKey=(typeof secret==='string'&&secret.length>=32)?secret:'';
 const ref=p=>database().ref(p);
 const get=async p=>(await ref(p).once('value')).val();
 const sessions=new Map();
 const now=()=>Date.now();
 const publicBase=()=>{
  const url=new URL(baseUrl);
  if(url.protocol!=='https:' && !['localhost','127.0.0.1'].includes(url.hostname))throw bad(503,'Configure ADEGA_PUBLIC_URL com HTTPS.');
  return url.origin;
 };
 async function settings(){return {...{rastreamentoHabilitado:true,exibirRastreioCliente:true,tempoLinkHoras:12,mostrarMapaCliente:true},...(await get('configuracoes/motoboys')||{})};}
 function makeCode(id,r){return crypto.createHmac('sha256',secretKey).update(['adega24-rastreio-v2',id,r.nonce,r.motoboyId].join('|')).digest('hex').slice(0,48);}
 async function checkActive(id){
  if(!ORDER_ID.test(String(id||'')))throw bad(404,'Rastreio indisponível.');
  const [token,e,o,c]=await Promise.all([get('rastreiosPrivados/'+id),get('entregas/'+id),get('pedidos/'+id),settings()]);
  if(!token||token.bloqueado||!e||!o||o.status!=='aprovado'||o.modo!=='entrega'||!ACTIVE.has(e.status)||!e.motoboyId||token.motoboyId!==e.motoboyId||o.statusOperacional==='concluido'||o.statusOperacional==='cancelado'||c.rastreamentoHabilitado===false||now()>=Number(token.expiraEm)||!secretKey)throw bad(410,'O rastreamento foi encerrado ou está indisponível.');
  return {token,e,o,c};
 }
 async function issue(id,motoboyId,{renew=false}={}){
  if(!secretKey)return false; // Operação da entrega prossegue mesmo se rastreio não estiver configurado.
  const c=await settings();if(c.rastreamentoHabilitado===false)return false;
  const e=await get('entregas/'+id),o=await get('pedidos/'+id);
  if(!e||!o||o.status!=='aprovado'||!ACTIVE.has(e.status)||e.motoboyId!==motoboyId)return false;
  const t=now();const expiration=t+clamp(c.tempoLinkHoras,1,24,12)*3600000;
  const r=ref('rastreiosPrivados/'+id);
  const result=await r.transaction(prev=>{
   if(!renew && prev && !prev.bloqueado && prev.motoboyId===motoboyId && prev.expiraEm>t)return;
   return {nonce:crypto.randomBytes(20).toString('hex'),motoboyId,criadoEm:t,expiraEm:expiration,bloqueado:false};
  },undefined,false);
  return result.committed;
 }
 async function revoke(id){if(ORDER_ID.test(String(id||'')))await ref('rastreiosPrivados/'+id).remove();}
 async function link(id){
  const {token}=await checkActive(id);
  return `${publicBase()}/rastreio/?pedido=${encodeURIComponent(id)}#codigo=${makeCode(id,token)}`;
 }
 async function verifyCode(id,code){
  if(!/^[0-9a-f]{48}$/i.test(String(code||'')))throw bad(404,'Código de rastreamento inválido.');
  const state=await checkActive(id);
  if(!fixedEqual(makeCode(id,state.token),String(code).toLowerCase()))throw bad(404,'Código de rastreamento inválido.');
  return state;
 }
 async function verifyAdmin(req){return apiAuth.verify(req,'admin');}
 function safeOrder(o,id){
  return {id,status:o.status,statusOperacional:o.statusOperacional||'novo',modo:o.modo,criadoEm:o.criadoEm||0,expiraEm:o.expiraEm||0,
   nome:String(o.nome||'').slice(0,90),endereco:o.modo==='entrega'?String(o.endereco||'').slice(0,220):'',
   itens:(Array.isArray(o.itens)?o.itens:[]).slice(0,80).map(i=>({nome:String(i.nome||'').slice(0,130),quantidade:Math.max(1,Number(i.quantidade)||1),precoCentavos:Number(i.precoCentavos)||0,parcialCentavos:Number(i.parcialCentavos)||0})),
   totalCentavos:Number(o.totalCentavos)||0,taxaCentavos:Number(o.taxaCentavos)||0};
 }
 async function customerOrder(req,res){
  const b=await bodyJSON(req,4096);await authorizedOrder(b);
  // A autorização pelo token segue /api/status, mas os dados atuais vêm do RTDB,
  // evitando usar a cópia de checkout em CACHE (que pode ter Pix antigo).
  const o=await get('pedidos/'+b.id);
  const tokenDigest=crypto.createHash('sha256').update(String(b.token)).digest('hex');
  if(!o||!fixedEqual(o.tokenHash,tokenDigest))throw bad(404,'Pedido não encontrado.');
  const result={pedido:safeOrder(o,b.id),rastreamentoDisponivel:false};
  if(o.status==='aprovado'&&o.modo==='entrega'){
   const c=await settings();
   if(c.exibirRastreioCliente!==false){try{result.linkRastreio=await link(b.id);result.rastreamentoDisponivel=true;}catch(e){if(e.http!==410&&e.http!==503)throw e;}}
  }
  return send(res,200,result);
 }
 const attempts=new Map();
 function throttle(req){const ip=String(req.socket?.remoteAddress||'unknown').slice(0,96);const t=now();const a=attempts.get(ip)||{n:0,expires:t+600000};if(a.expires<=t){a.n=0;a.expires=t+600000;}a.n++;attempts.set(ip,a);if(attempts.size>5000)for(const [k,v] of attempts)if(v.expires<t)attempts.delete(k);if(a.n>60)throw bad(429,'Muitas consultas de rastreio.');}
 async function newSession(req,res){
  throttle(req);const b=await bodyJSON(req,4096);await verifyCode(b.id,b.codigo);
  const sid=crypto.randomBytes(24).toString('base64url');sessions.set(sid,{id:b.id,code:String(b.codigo).toLowerCase(),createdAt:now(),expires:now()+8*60000});
  if(sessions.size>1500)for(const [k,v] of sessions)if(v.expires<now())sessions.delete(k);
  return send(res,200,{sessao:sid,expiraEm:now()+8*60000});
 }
 async function snapshot(id){
  const {e,o,c}=await checkActive(id);
  const [d,loc,app]=await Promise.all([get('motoboys/'+e.motoboyId),get('localizacoesMotoboys/'+e.motoboyId),get('configuracoes/aparencia')]);
  const fresh=!!(loc&&Number.isFinite(loc.latitude)&&Number.isFinite(loc.longitude)&&Math.abs(loc.latitude)<=90&&Math.abs(loc.longitude)<=180&&now()-Number(loc.atualizadoEm)<180000);
  const tema={};for(const key of ['corFundo','corSuperficie','corTexto','corPrincipal','corSecundaria'])if(/^#[0-9a-f]{6}$/i.test(String(app?.[key]||'')))tema[key]=app[key];
  return {pedido:id.slice(0,8),etapa:e.status,atualizadoEm:e.atualizadoEm||0,motoboyNome:String(d?.nome||'Entregador').slice(0,80),tema,localizacao:(c.mostrarMapaCliente!==false&&fresh)?{latitude:loc.latitude,longitude:loc.longitude,atualizadoEm:loc.atualizadoEm,precisao:loc.precisao??null}:null};
 }
 async function stream(req,res,url){
  const sid=url.searchParams.get('sessao')||'';const sess=sessions.get(sid);
  if(!sess||sess.expires<now())throw bad(401,'Sessão expirada. Atualize o link.');
  // Sessão é consumida na primeira conexão: nunca armazenada no Firebase.
  sessions.delete(sid);await verifyCode(sess.id,sess.code);
  const st=await checkActive(sess.id);
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  res.write(': conexao iniciada\n\n');let closed=false,queued=false;const watchers=[];
  const stop=()=>{if(closed)return;closed=true;clearInterval(heartbeat);clearTimeout(timeout);for(const [r,cb] of watchers)r.off('value',cb);try{res.end();}catch{}};
  let chain=Promise.resolve();
  function notify(){if(closed||queued)return;queued=true;chain=chain.then(async()=>{
   queued=false;
   try{
    await verifyCode(sess.id,sess.code);
    const data=await snapshot(sess.id);
    if(!closed)res.write('event: position\ndata: '+JSON.stringify(data)+'\n\n');
   }catch(e){if(!closed){res.write('event: ended\ndata: '+JSON.stringify({message:e.message})+'\n\n');stop();}}
  }).catch(e=>{console.error('[Tracking/SSE]',e.message);stop();});}
  const refs=[ref('entregas/'+sess.id),ref('pedidos/'+sess.id+'/status'),ref('pedidos/'+sess.id+'/statusOperacional')];
  refs.push(ref('localizacoesMotoboys/'+st.e.motoboyId),ref('rastreiosPrivados/'+sess.id),ref('configuracoes/motoboys/rastreamentoHabilitado'),ref('configuracoes/aparencia'));
  const heartbeat=setInterval(()=>{if(closed)return;if(now()-sess.createdAt>=8*60000){res.write('event: reconnect\ndata: {}\n\n');stop();}else {res.write(': heartbeat\n\n');notify();}},25000);
  const timeout=setTimeout(()=>stop(),8*60000+5000);
  for(const r of refs){const cb=()=>notify();watchers.push([r,cb]);r.on('value',cb,e=>{console.error('[Tracking/listener]',e.code||e.message);stop();});}
  req.on('close',stop);res.on('close',stop);notify();
 }
 async function handler(req,res,p,url){
  if(p==='/api/customer/order'&&req.method==='POST')return customerOrder(req,res);
  if(p==='/api/tracking/session'&&req.method==='POST')return newSession(req,res);
  if(p==='/api/tracking/events'&&req.method==='GET')return stream(req,res,url);
  if(p==='/api/tracking/admin/link'&&req.method==='POST'){
   await verifyAdmin(req);const b=await bodyJSON(req,4096);if(!ORDER_ID.test(String(b.id||'')))throw bad(400,'Pedido inválido.');
   if(b.renovar===true){const e=await get('entregas/'+b.id);if(!e||!e.motoboyId)throw bad(409,'Entrega sem motoboy.');const ok=await issue(b.id,e.motoboyId,{renew:true});if(!ok)throw bad(409,'Rastreio indisponível.');}
   const endereco=await link(b.id);return send(res,200,{link:endereco});
  }
  if(p==='/api/tracking/admin/revoke'&&req.method==='POST'){
   await verifyAdmin(req);const b=await bodyJSON(req,4096);if(!ORDER_ID.test(String(b.id||'')))throw bad(400,'Pedido inválido.');
   await ref('rastreiosPrivados/'+b.id).update({bloqueado:true});return send(res,200,{ok:true});
  }
  throw bad(405,'Rota/método indisponível.');
 }
 return {handler,issue,revoke,link,verifyCode,snapshot,customerOrder,settings};
}
module.exports={createTracking};
