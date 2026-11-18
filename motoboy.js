'use strict';
// Adega24 Motoboy MVP — Firebase Admin only; nunca inclui segredos no APK.
const crypto = require('node:crypto');
const ID_RE = /^[a-zA-Z0-9_-]{12,100}$/;
const codeNormal = v => String(v || '').toUpperCase().replace(/[\s-]/g, '');
const limit = (v,n=120) => String(v??'').trim().slice(0,n);
const phone = v => limit(v,40).replace(/\D/g,'').slice(0,15);
const err = (status,msg) => Object.assign(new Error(msg),{http:status});
const defaults = {tempoOfertaSegundos:60,intervaloLocalizacaoSegundos:60,limiteAtivos:1,habilitado:true};
const now = ()=>Date.now();
const validId = s => ID_RE.test(String(s||''));
function createMotoboy({database,admin,send,bodyJSON,tracking=null,apiAuth}) {
  let busy=Promise.resolve();
  const LOGIN_ATTEMPTS=new Map();
  const serial = task => {const p=busy.then(task);busy=p.catch(e=>console.error('[Motoboy/serial]',e.message));return p;};
  const root = p => database().ref(p);
  const read = async p=>(await root(p).once('value')).val();
  async function config(){return {...defaults,...(await read('configuracoes/motoboys')||{})};}
  function makeCode(){return crypto.randomBytes(12).toString('hex').toUpperCase();}
  function passwordHash(code,salt){return crypto.scryptSync(code,salt,64).toString('hex');}
  function equalHash(a,b){if(!a||!b||a.length!==b.length)return false;return crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
  function safeDriver(d){return {id:d.id,nome:d.nome,whatsapp:d.whatsapp,ativo:!!d.ativo,online:!!d.online,ultimoHeartbeat:d.ultimoHeartbeat||0,criadoEm:d.criadoEm||0};}
  async function verify(req,role) {return apiAuth.verify(req,role);}
  function orderData(id,o){return {id,pedidoId:id,clienteNome:limit(o.nome,90),telefone:phone(o.telefone),endereco:limit(o.endereco,220),itens:(Array.isArray(o.itens)?o.itens:[]).slice(0,80).map(i=>({nome:limit(i.nome,120),quantidade:Math.max(1,Math.min(999,Number(i.quantidade)||1))})),taxaCentavos:Math.max(0,Math.round(Number(o.taxaCentavos)||0)),criadoEm:Number(o.criadoEm)||now(),status:'aguardando',motoboyId:null,ofertadoPara:null,ofertaExpiraEm:0,recusados:{},atualizadoEm:now()};}
  // Apenas ofertas com Pix realmente aprovado e entrega solicitada.
  async function ingestOrder(id,o){
    if(!validId(id)||!o||o.modo!=='entrega')return;
    if(o.status!=='aprovado'){
      if(['estornado','cancelado','expirado'].includes(o.status)){
        const e=await read('entregas/'+id);
        if(e && e.status!=='concluido' && e.status!=='cancelado'){await root('entregas/'+id).update({status:'cancelado',ofertadoPara:null,atualizadoEm:now()});if(tracking)await tracking.revoke(id).catch(err=>console.error('[Tracking/revoke]',err.message));}
      }
      return;
    }
    if(o.statusOperacional==='concluido'||o.statusOperacional==='cancelado'){
      const e=await read('entregas/'+id);
      if(e&&e.status!=='concluido'&&e.status!=='cancelado'){
        await root('entregas/'+id).update({status:o.statusOperacional,ofertadoPara:null,ofertaExpiraEm:0,...(o.statusOperacional==='concluido'?{concluidoEm:now()}:{}),atualizadoEm:now()});
        if(tracking)await tracking.revoke(id).catch(err=>console.error('[Tracking/revoke]',err.message));
        if(e.motoboyId)await feed(e.motoboyId);
        if(e.ofertadoPara)await feed(e.ofertadoPara);
      }
      return;
    }
    if(o.criadoEm && now()-Number(o.criadoEm)>8*3600000)return; // sem reativar pedidos antigos
    await root('entregas/'+id).transaction(current => current===null ? orderData(id,o) : undefined,undefined,false);
    await dispatch();
  }
  async function feed(id){
    const d=await read('motoboys/'+id);if(!d)return;
    const entries=await read('entregas')||{};
    const active={},finished={};let offer=null;
    for(const [oid,e] of Object.entries(entries)){
      if(e.status==='ofertado'&&e.ofertadoPara===id&&e.ofertaExpiraEm>now()){
        offer={...publicDelivery(e),expiraEm:e.ofertaExpiraEm};
      }
      if(e.motoboyId!==id)continue;
      if(e.status==='concluido')finished[oid]=publicDelivery(e);
      else if(e.status!=='cancelado')active[oid]=publicDelivery(e);
    }
    const sevenDays=Object.entries(finished).filter(([,e])=>e.concluidoEm>=now()-7*86400000);
    await root('motoboyFeed/'+id).set({perfil:{id,nome:d.nome,whatsapp:d.whatsapp,online:!!d.online},oferta:offer,ativos:active,concluidos:Object.fromEntries(sevenDays),atualizadoEm:now()});
  }
  function publicDelivery(e){return {id:e.id,clienteNome:e.clienteNome,telefone:e.telefone,endereco:e.endereco,itens:e.itens||[],taxaCentavos:e.taxaCentavos||0,status:e.status,criadoEm:e.criadoEm,motoboyId:e.motoboyId||null,aceitoEm:e.aceitoEm||0,retiradoEm:e.retiradoEm||0,concluidoEm:e.concluidoEm||0};}
  async function push(id,delivery){
    const d=await read('motoboys/'+id);
    if(!d?.fcmToken)return;
    try{await admin.messaging().send({token:d.fcmToken,data:{type:'offer',orderId:delivery.id,expires:String(delivery.ofertaExpiraEm)},android:{priority:'high',notification:{channelId:'adega_ofertas',sound:'default'}},notification:{title:'Nova entrega • Adega24',body:'Você tem 60 segundos para responder.'}});}
    catch(e){console.error('[Motoboy/FCM]',id,e.code||e.message);}
  }
  async function dispatch(){return serial(async()=>{
    const cfg=await config();if(cfg.habilitado===false)return;
    const ds=await read('motoboys')||{},all=await read('entregas')||{};
    const ids=Object.keys(ds).filter(id=>ds[id]?.ativo&&ds[id]?.online&&now()-(ds[id]?.ultimoHeartbeat||0)<95000).sort((a,b)=>(ds[a].criadoEm||0)-(ds[b].criadoEm||0));
    const count=Object.fromEntries(ids.map(id=>[id,0]));
    const pendingOffer=new Set();
    const allDeliveries=Object.values(all);
    const lim=Math.max(1,Math.min(6,Number(cfg.limiteAtivos)||1));
    for(const e of allDeliveries)if((e.motoboyId && ['aceito','retirado','em_entrega'].includes(e.status))||(e.ofertadoPara&&e.status==='ofertado'&&e.ofertaExpiraEm>now())){const id=e.motoboyId||e.ofertadoPara;if(id in count)count[id]++;if(e.status==='ofertado')pendingOffer.add(id);}
    let cursor=Number(await read('sistema/motoboys/cursor'))||0;
    for(const e of allDeliveries.sort((a,b)=>(a.criadoEm||0)-(b.criadoEm||0))){
      if(e.status==='ofertado'&&e.ofertaExpiraEm<=now()){
        const old=e.ofertadoPara;
        e.recusados=e.recusados||{};
        if(old)e.recusados[old]=true;
        e.status='aguardando';e.ofertadoPara=null;e.ofertaExpiraEm=0;
        await root('entregas/'+e.id).update({status:'aguardando',ofertadoPara:null,ofertaExpiraEm:0,recusados:e.recusados,atualizadoEm:now()});
        if(old)await feed(old);
      }
      if(e.status!=='aguardando'||!ids.length)continue;
      const eligible=[];
      for(let j=0;j<ids.length;j++){
        const id=ids[(cursor+j)%ids.length];
        if(count[id]<lim&&!pendingOffer.has(id)&&!e.recusados?.[id])eligible.push(id);
      }
      if(!eligible.length){
        // Uma recusa completa não causa loop infinito: alerta o ADM.
        if(ids.length && ids.every(id=>e.recusados?.[id]))await root('entregas/'+e.id).update({status:'sem_motoboy',atualizadoEm:now()});
        continue;
      }
      const id=eligible[0];cursor=(ids.indexOf(id)+1)%ids.length;
      const expires=now()+Math.max(15,Math.min(180,Number(cfg.tempoOfertaSegundos)||60))*1000;
      const t=await root('entregas/'+e.id).transaction(current=>current?.status==='aguardando'?{...current,status:'ofertado',ofertadoPara:id,ofertaExpiraEm:expires,atualizadoEm:now()}:undefined,undefined,false);
      if(t.committed){count[id]++;pendingOffer.add(id);await root('sistema/motoboys/cursor').set(cursor);await feed(id);push(id,{id:e.id,ofertaExpiraEm:expires}).catch(console.error);}
    }
  });}
  async function changeDelivery(id,driverId,action){
    if(!validId(id))throw err(400,'Pedido inválido.');
    return serial(async()=>{
      const e=await read('entregas/'+id);if(!e)throw err(404,'Entrega não localizada.');
      const time=now();let updates={};
      if(action==='aceitar'){
        const order=await read('pedidos/'+id);
        if(!order||order.status!=='aprovado')throw err(409,'Pagamento não está aprovado.');
        if(e.status!=='ofertado'||e.ofertadoPara!==driverId||e.ofertaExpiraEm<=time)throw err(409,'Oferta expirada ou atribuída a outro entregador.');
        updates={status:'aceito',motoboyId:driverId,ofertadoPara:null,ofertaExpiraEm:0,aceitoEm:time};
      }else if(action==='recusar'){
        if(e.status!=='ofertado'||e.ofertadoPara!==driverId)throw err(409,'Oferta não disponível.');
        updates={status:'aguardando',ofertadoPara:null,ofertaExpiraEm:0,recusados:{...(e.recusados||{}),[driverId]:true}};
      }else{
        if(e.motoboyId!==driverId)throw err(403,'Entrega não atribuída à sua conta.');
        const allowed={retirado:['aceito'],em_entrega:['retirado'],concluido:['em_entrega']};
        if(!allowed[action]?.includes(e.status))throw err(409,'Etapa inválida.');
        updates={status:action,...(action==='retirado'?{retiradoEm:time}:{}),...(action==='concluido'?{concluidoEm:time}:{})};
      }
      const tx=await root('entregas/'+id).transaction(cur=>{
        if(!cur||cur.status!==e.status||cur.ofertadoPara!==e.ofertadoPara||cur.motoboyId!==e.motoboyId)return;
        return {...cur,...updates,atualizadoEm:time};
      },undefined,false);
      if(!tx.committed)throw err(409,'Entrega mudou, atualize a tela.');
      // Não sobrescrever status financeiro.
      if(action==='aceitar' && tracking){
        try{await tracking.issue(id,driverId);}catch(e){console.error('[Motoboy/tracking]',e.message);}
      }
      if(action==='concluido' && tracking){
        try{await tracking.revoke(id);}catch(e){console.error('[Motoboy/tracking-revoke]',e.message);}
      }
      if(action==='aceitar'){
        const o=await read('pedidos/'+id);
        if(!o||o.status!=='aprovado')throw err(409,'Pagamento não está aprovado.');
        if(!o.statusOperacional||o.statusOperacional==='novo')await root('pedidos/'+id).update({statusOperacional:'aceito',atualizadoOperacionalEm:time,atualizadoPor:'motoboy:'+driverId});
      }
      if(action==='retirado')await root('pedidos/'+id).update({statusOperacional:'em_entrega',atualizadoOperacionalEm:time,atualizadoPor:'motoboy:'+driverId});
      if(action==='concluido')await root('pedidos/'+id).update({statusOperacional:'concluido',atualizadoOperacionalEm:time,atualizadoPor:'motoboy:'+driverId});
      await feed(driverId); // feed do recusante remove oferta; se outro, atualiza a lista.
      dispatch().catch(console.error);
      return {ok:true,status:updates.status};
    });
  }
  async function handler(req,res,p){
    if(!p.startsWith('/api/motoboy/'))return false;
    if(req.method!=='POST')throw err(405,'Apenas POST.');
    if(p==='/api/motoboy/login'){
      const ip=limit(req.headers['cf-connecting-ip']||req.socket?.remoteAddress||'desconhecido',70);
      const rec=LOGIN_ATTEMPTS.get(ip)||{count:0,until:now()+900000};
      if(rec.until<now()){rec.count=0;rec.until=now()+900000;}
      if(++rec.count>20)throw err(429,'Muitas tentativas de código. Tente mais tarde.');
      LOGIN_ATTEMPTS.set(ip,rec);
      if(LOGIN_ATTEMPTS.size>2000)for(const [key,v] of LOGIN_ATTEMPTS)if(v.until<now())LOGIN_ATTEMPTS.delete(key);
      const b=await bodyJSON(req,4096);const code=codeNormal(b.codigo);if(!/^[0-9A-F]{24}$/.test(code))throw err(401,'Código inválido.');
      const index=await read('motoboyCodigos/'+crypto.createHash('sha256').update(code).digest('hex'));
      if(!validId(index))throw err(401,'Código inválido.');
      const d=await read('motoboys/'+index);
      if(!d?.ativo||!equalHash(passwordHash(code,d.codeSalt),d.codeHash))throw err(401,'Código inválido ou desativado.');
      const token=apiAuth.createSession('motoboy',d.id);
      return send(res,200,{token,perfil:safeDriver(d)});
    }
    const role=p.startsWith('/api/motoboy/admin/')?'admin':'motoboy',u=await verify(req,role);
    const b=await bodyJSON(req,16000);
    const id=u.motoboyId;
    if(role==='admin'){
      if(p==='/api/motoboy/admin/list')return send(res,200,{motoboys:Object.values(await read('motoboys')||{}).map(safeDriver),entregas:await read('entregas')||{},localizacoes:await read('localizacoesMotoboys')||{},alertas:await read('alertasLoja')||{},config:await config()});
      if(p==='/api/motoboy/admin/create'){
        const nome=limit(b.nome,90),whatsapp=phone(b.whatsapp);
        if(nome.length<3||whatsapp.length<10)throw err(400,'Informe nome e WhatsApp válido.');
        const newId=crypto.randomUUID(),code=makeCode(),salt=crypto.randomBytes(16).toString('hex');
        const d={id:newId,nome,whatsapp,ativo:true,online:false,criadoEm:now(),ultimoHeartbeat:0,codeSalt:salt,codeHash:passwordHash(code,salt)};
        await root('motoboys/'+newId).set(d);
        await root('motoboyCodigos/'+crypto.createHash('sha256').update(code).digest('hex')).set(newId);
        await feed(newId);
        return send(res,200,{motoboy:safeDriver(d),codigo:code});
      }
      if(p==='/api/motoboy/admin/set-active'){
        if(!validId(b.id))throw err(400,'ID inválido.');const d=await read('motoboys/'+b.id);if(!d)throw err(404,'Motoboy não encontrado.');
        await root('motoboys/'+b.id).update({ativo:b.ativo===true,online:b.ativo===true?!!d.online:false});
        if(b.ativo!==true){await root('motoboys/'+b.id).update({sessaoValidaDesde:now()});await root('localizacoesMotoboys/'+b.id).remove();await admin.auth().revokeRefreshTokens('motoboy_'+b.id).catch(()=>{});}
        await feed(b.id);return send(res,200,{ok:true});
      }
      if(p==='/api/motoboy/admin/retry'){
        if(!validId(b.id))throw err(400,'Pedido inválido.');
        const e=await read('entregas/'+b.id);
        const order=await read('pedidos/'+b.id);
        if(!e||!order||order.status!=='aprovado'||e.status!=='sem_motoboy')throw err(409,'Somente entregas sem motoboy e pagas podem voltar à fila.');
        await root('entregas/'+b.id).update({status:'aguardando',recusados:{},ofertadoPara:null,ofertaExpiraEm:0,atualizadoEm:now()});
        dispatch().catch(console.error);return send(res,200,{ok:true});
      }
      if(p==='/api/motoboy/admin/config'){
        const patch={
          ...(b.tempoOfertaSegundos===undefined?{}:{tempoOfertaSegundos:Math.max(15,Math.min(180,Number(b.tempoOfertaSegundos)||60))}),
          ...(b.limiteAtivos===undefined?{}:{limiteAtivos:Math.max(1,Math.min(6,Number(b.limiteAtivos)||1))}),
          intervaloLocalizacaoSegundos:60,
          ...(b.habilitado===undefined?{}:{habilitado:b.habilitado===true}),
          ...(b.rastreamentoHabilitado===undefined?{}:{rastreamentoHabilitado:b.rastreamentoHabilitado===true}),
          ...(b.exibirRastreioCliente===undefined?{}:{exibirRastreioCliente:b.exibirRastreioCliente===true}),
          ...(b.mostrarMapaCliente===undefined?{}:{mostrarMapaCliente:b.mostrarMapaCliente===true}),
          ...(b.tempoLinkHoras===undefined?{}:{tempoLinkHoras:Math.max(1,Math.min(24,Number(b.tempoLinkHoras)||12))}),
          ...(b.popupPedidoAtivo===undefined?{}:{popupPedidoAtivo:b.popupPedidoAtivo===true}),
          ...(b.popupPedidoPendente===undefined?{}:{popupPedidoPendente:b.popupPedidoPendente===true})
        };
        await root('configuracoes/motoboys').update(patch);dispatch().catch(console.error);return send(res,200,{config:patch});
      }
      throw err(404,'Operação ADM não encontrada.');
    }
    if(p==='/api/motoboy/me')return send(res,200,{perfil:safeDriver(await read('motoboys/'+id)),config:await config()});
    if(p==='/api/motoboy/feed')return send(res,200,{feed:await read('motoboyFeed/'+id)||{},config:await config(),lojaNome:await read('configuracoes/loja/nome')||'Adega24',aparencia:await read('configuracoes/aparencia')||{}});
    if(p==='/api/motoboy/online'){
      const online=b.online===true;
      await root('motoboys/'+id).update({online,ultimoHeartbeat:online?now():0});
      await feed(id);dispatch().catch(console.error);return send(res,200,{ok:true,online});
    }
    if(p==='/api/motoboy/device'){
      if(!/^[A-Za-z0-9:_-]{20,300}$/.test(String(b.token||'')))throw err(400,'Token FCM inválido.');
      await root('motoboys/'+id).update({fcmToken:b.token});return send(res,200,{ok:true});
    }
    if(p==='/api/motoboy/heartbeat'){
      const updates={ultimoHeartbeat:now()};
      await root('motoboys/'+id).update(updates);
      if(Number.isFinite(b.latitude)&&Number.isFinite(b.longitude)&&Math.abs(b.latitude)<=90&&Math.abs(b.longitude)<=180){
        const d=await read('motoboys/'+id);if(d.online)await root('localizacoesMotoboys/'+id).set({latitude:b.latitude,longitude:b.longitude,precisao:Number.isFinite(b.precisao)?Math.max(0,Math.min(10000,b.precisao)):null,atualizadoEm:now()});
      }
      dispatch().catch(console.error);return send(res,200,{ok:true});
    }
    if(['/api/motoboy/accept','/api/motoboy/decline','/api/motoboy/stage'].includes(p)){
      const action=p.endsWith('/accept')?'aceitar':p.endsWith('/decline')?'recusar':String(b.etapa||'');
      return send(res,200,await changeDelivery(b.id,id,action));
    }
    if(p==='/api/motoboy/alert'){
      const type=String(b.tipo||'').replace(/[^a-z_]/g,'').slice(0,30);
      if(!['ajuda','cliente_ausente','endereco_incorreto','acidente','outro'].includes(type))throw err(400,'Alerta inválido.');
      await root('alertasLoja').push({motoboyId:id,motoboyNome:limit((await read('motoboys/'+id)).nome),tipo:type,detalhe:limit(b.detalhe,180),criadoEm:now(),status:'novo'});
      return send(res,200,{ok:true});
    }
    throw err(404,'Rota não encontrada.');
  }
  function start(){
    // Estado durável no Realtime. Nenhuma entrega pode nascer de Pix não aprovado.
    const orders=root('pedidos').orderByChild('criadoEm').limitToLast(250);
    for(const event of ['child_added','child_changed'])orders.on(event,snap=>ingestOrder(snap.key,snap.val()).catch(e=>console.error('[Motoboy/order]',e.message)));
    const timer=setInterval(()=>dispatch().catch(e=>console.error('[Motoboy/tick]',e.message)),5000);timer.unref();
    console.log('[Motoboy] sincronização e revezamento ativados.');
  }
  return {handler,start,config,ingestOrder,dispatch,changeDelivery,feed};
}
module.exports={createMotoboy};
