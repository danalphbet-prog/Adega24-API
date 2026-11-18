'use strict';
// ADEGA24 API Central V1 - somente este backend usa Firebase Admin e Mercado Pago.
const crypto=require('node:crypto');
const E=(http,message)=>Object.assign(new Error(message),{http});
const safe=(v,n=200)=>String(v??'').trim().slice(0,n);
const keyOk=s=>/^[a-zA-Z0-9_-]{1,90}$/.test(String(s||''));
const uuid=s=>/^[0-9a-f-]{36}$/i.test(String(s||''));
const photoOk=s=>!s || (typeof s==='string'&&s.length<=680000&&(/^(https:\/\/[^\s"'<>]+|data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+)$/.test(s)));
function createApiCentral({database,admin,send,bodyJSON}){
  const root=p=>database().ref(p);
  const read=async p=>(await root(p).once('value')).val();
  const SECRET=process.env.ADEGA_SESSION_SECRET||'';
  const LOGIN_ATTEMPTS=new Map();
  const hash=v=>crypto.createHmac('sha256',SECRET).update(v).digest('base64url');
  function createSession(role,id){
    if(SECRET.length<32)throw E(503,'Configure ADEGA_SESSION_SECRET no Render (mínimo 32 caracteres).');
    const ttl=role==='admin'?8*3600000:7*86400000;
    const p=Buffer.from(JSON.stringify({v:1,role,id,iat:Date.now(),exp:Date.now()+ttl,nonce:crypto.randomBytes(12).toString('hex')})).toString('base64url');
    return `${p}.${hash(p)}`;
  }
  async function verify(req,role){
    const bearer=String(req.headers.authorization||'').match(/^Bearer ([A-Za-z0-9._-]+)$/);
    if(!bearer||SECRET.length<32)throw E(401,'Sessão ausente. Faça login novamente.');
    const bits=bearer[1].split('.');
    if(bits.length!==2)throw E(401,'Sessão inválida.');
    const expected=hash(bits[0]);
    if(bits[1].length!==expected.length||!crypto.timingSafeEqual(Buffer.from(bits[1]),Buffer.from(expected)))throw E(401,'Sessão inválida.');
    let payload;try{payload=JSON.parse(Buffer.from(bits[0],'base64url').toString('utf8'));}catch{throw E(401,'Sessão inválida.');}
    if(payload.v!==1||payload.role!==role||!Number.isSafeInteger(payload.exp)||payload.exp<=Date.now()||!payload.id)throw E(401,'Sessão expirada.');
    if(role==='admin'&&(await read('admins/'+payload.id))!==true)throw E(403,'Administrador sem permissão.');
    if(role==='motoboy'){
      if(!/^[a-z0-9-]{36}$/i.test(payload.id))throw E(403,'Entregador inválido.');
      const driver=await read('motoboys/'+payload.id);
      if(!driver?.ativo||Number(payload.iat)<Number(driver.sessaoValidaDesde||0))throw E(403,'Entregador desativado ou sessão revogada.');
    }
    return {uid:role==='motoboy'?'motoboy_'+payload.id:payload.id,role,...(role==='motoboy'?{motoboyId:payload.id}:{})};
  }
  const auth={createSession,verify};
  async function login(req,res){
    const key=process.env.FIREBASE_WEB_API_KEY||'';
    if(!key)throw E(503,'FIREBASE_WEB_API_KEY não configurada.');
    const ip=safe(req.headers['cf-connecting-ip']||req.socket?.remoteAddress||'?',80);const now=Date.now();
    if(LOGIN_ATTEMPTS.size>1000)for(const [k,v] of LOGIN_ATTEMPTS)if(v.until<now)LOGIN_ATTEMPTS.delete(k);
    const record=LOGIN_ATTEMPTS.get(ip)||{count:0,until:now+600000};
    if(now>record.until){record.count=0;record.until=now+600000;}
    record.count++;LOGIN_ATTEMPTS.set(ip,record);
    if(record.count>12)throw E(429,'Muitas tentativas de login. Aguarde alguns minutos.');
    const b=await bodyJSON(req,4000), email=safe(b.email,200), password=String(b.senha||'');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!password||password.length>200)throw E(400,'Informe e-mail e senha válidos.');
    const response=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='+encodeURIComponent(key),{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true}),signal:AbortSignal.timeout(15000)
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw E(401,'Credenciais inválidas.');
    const decoded=await admin.auth().verifyIdToken(data.idToken);
    if((await read('admins/'+decoded.uid))!==true)throw E(403,'Usuário sem autorização ADM.');
    send(res,200,{token:createSession('admin',decoded.uid),uid:decoded.uid,email:decoded.email||email});
  }
  function publicConfig(c){return Object.fromEntries(['loja','aparencia','imagens','textos','tiposProduto','catalogo','entrega','retirada','funcionamento','checkout','pagamentos'].map(k=>{
    if(k==='pagamentos')return[k,{pix:{habilitado:c.pagamentos?.pix?.habilitado!==false,prazoLojaMinutos:c.pagamentos?.pix?.prazoLojaMinutos||10}}];
    if(k==='loja')return[k,Object.fromEntries(['nome','descricao','whatsapp','telefone','bairro','cidade','endereco','ativa'].map(x=>[x,c.loja?.[x]]))];
    return[k,c[k]||{}];
  }));}
  async function getCatalog(){
    const [products,cfg]=await Promise.all([read('produtos'),read('configuracoes')]);
    const visible=Object.fromEntries(Object.entries(products||{}).filter(([,p])=>p?.ativo===true).map(([id,p])=>[id,{
      id,nome:safe(p.nome,120),marca:safe(p.marca,80),descricao:safe(p.descricao,450),categoria:safe(p.categoria,80),valor:Number(p.valor)||0,
      imagem:photoOk(p.imagem)?p.imagem||'':'',destaque:!!p.destaque,estoque:Number.isInteger(p.estoque)?p.estoque:null,selos:Array.isArray(p.selos)?p.selos:[]
    }]));
    return {produtos:visible,configuracoes:publicConfig(cfg||{}),servidorEm:Date.now()};
  }
  async function catalog(req,res){return send(res,200,await getCatalog());}
  async function adminData(req,res){
    await verify(req,'admin');
    const [products,cfg,orders,motoboys,deliveries,activity]=await Promise.all(['produtos','configuracoes','pedidos','motoboys','entregas','auditoria'].map(read));
    const ordered=Object.entries(orders||{}).sort((a,b)=>(b[1]?.criadoEm||0)-(a[1]?.criadoEm||0)).slice(0,250);
    send(res,200,{produtos:products||{},configuracoes:cfg||{},pedidos:Object.fromEntries(ordered.map(([id,o])=>[id,{...o,pix:undefined,tokenHash:undefined}])),
      motoboys:Object.values(motoboys||{}).map(d=>({id:d.id,nome:d.nome,whatsapp:d.whatsapp,ativo:!!d.ativo,online:!!d.online,ultimoHeartbeat:d.ultimoHeartbeat||0})),
      entregas:deliveries||{},auditoria:Object.fromEntries(Object.entries(activity||{}).sort((a,b)=>(b[1]?.em||0)-(a[1]?.em||0)).slice(0,60))});
  }
  async function audit(uid,acao,detalhe){await root('auditoria').push({uid,acao:safe(acao,90),detalhe:safe(detalhe,240),em:Date.now()});}
  async function adminAction(req,res){
    const u=await verify(req,'admin'),b=await bodyJSON(req,750000),action=safe(b.acao,35);
    if(action==='pedido_etapa'){
      const id=safe(b.id,80), stage=safe(b.etapa,40);
      if(!uuid(id)||!['novo','aceito','em_preparo','pronto','em_entrega','concluido','cancelado'].includes(stage))throw E(400,'Etapa inválida.');
      const p=await read('pedidos/'+id);
      if(!p||p.status!=='aprovado')throw E(409,'Somente pedidos com Pix confirmado podem avançar.');
      if(['concluido','cancelado'].includes(p.statusOperacional))throw E(409,'Pedido já encerrado.');
      const allowed={novo:['aceito','em_preparo','pronto','cancelado'],aceito:['em_preparo','pronto','cancelado'],em_preparo:['pronto','cancelado'],pronto:['em_entrega','concluido','cancelado'],em_entrega:['concluido','cancelado']};
      if(!(allowed[p.statusOperacional||'novo']||[]).includes(stage))throw E(409,'Transição operacional não permitida.');
      await root('pedidos/'+id).update({statusOperacional:stage,atualizadoOperacionalEm:Date.now(),atualizadoPor:u.uid});
      await audit(u.uid,'Andamento alterado',`Pedido ${id.slice(0,8)}: ${stage}`);
      return send(res,200,{ok:true});
    }
    if(action==='produto_salvar'){
      const id=safe(b.id,90),p=b.produto||{};
      if(!keyOk(id)||!safe(p.nome,120)||!safe(p.categoria,80))throw E(400,'ID, nome e categoria obrigatórios.');
      if(!Number.isFinite(Number(p.valor))||Number(p.valor)<0||Number(p.valor)>100000)throw E(400,'Preço inválido.');
      if(p.estoque!==null&&p.estoque!==undefined&&(!Number.isInteger(Number(p.estoque))||Number(p.estoque)<0))throw E(400,'Estoque inválido.');
      if(!photoOk(p.imagem))throw E(400,'Imagem inválida ou acima de 500 KB.');
      const old=await read('produtos/'+id)||{};
      const item={...old,nome:safe(p.nome,120),categoria:safe(p.categoria,80),marca:safe(p.marca,80),descricao:safe(p.descricao,800),valor:Number(p.valor),
        ativo:p.ativo===true,destaque:p.destaque===true,estoque:p.estoque===null||p.estoque===undefined?null:Number(p.estoque),
        selos:Array.isArray(p.selos)?p.selos.filter(keyOk).slice(0,12):old.selos||[],
        imagem:p.imagem===undefined?old.imagem||'':p.imagem};
      await root('produtos/'+id).set(item);await audit(u.uid,'Produto salvo',id);return send(res,200,{ok:true});
    }
    if(action==='produto_excluir'){
      const id=safe(b.id,90);if(!keyOk(id))throw E(400,'ID inválido.');
      await root('produtos/'+id).remove();await audit(u.uid,'Produto removido',id);return send(res,200,{ok:true});
    }
    if(action==='config_salvar'){
      const section=safe(b.secao,60), data=b.dados;
      if(!['loja','aparencia','textos','imagens','entrega','retirada','funcionamento','tiposProduto','catalogo','checkout'].includes(section)||!data||typeof data!=='object'||Array.isArray(data))throw E(400,'Configuração inválida.');
      function allowedDeep(value,depth=0){if(depth>5)throw E(400,'Configuração profunda demais.');if(value===null||typeof value==='boolean')return value;
        if(typeof value==='string')return safe(value,500);if(typeof value==='number'&&Number.isFinite(value))return value;
        if(Array.isArray(value))return value.slice(0,20).map(v=>allowedDeep(v,depth+1));
        if(typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>/^[a-zA-Z0-9_-]{1,60}$/.test(k)&&!['__proto__','constructor','prototype'].includes(k)).map(([k,v])=>[k,allowedDeep(v,depth+1)]));
        throw E(400,'Campo inválido.');}
      const sanitized=allowedDeep(data);
      const flat={};function walk(obj,base=''){for(const [k,v] of Object.entries(obj)){const p=base?base+'/'+k:k;
        if(v!==null&&typeof v==='object'&&!Array.isArray(v))walk(v,p);else flat[p]=v;
      }}walk(sanitized);
      if(Object.keys(flat).length>150)throw E(400,'Muitos campos na atualização.');
      await root('configuracoes/'+section).update(flat);
      await audit(u.uid,'Configuração alterada',section);return send(res,200,{ok:true});
    }
    throw E(404,'Operação não encontrada.');
  }
  async function handle(req,res,p){
    if(req.method==='GET'&&p==='/api/v1/catalogo')return catalog(req,res);
    if(req.method==='POST'&&p==='/api/v1/admin/login')return login(req,res);
    if(req.method==='POST'&&p==='/api/v1/admin/dados')return adminData(req,res);
    if(req.method==='POST'&&p==='/api/v1/admin/acao')return adminAction(req,res);
    if(req.method==='POST'&&p==='/api/v1/admin/me'){const u=await verify(req,'admin');return send(res,200,{ok:true,uid:u.uid});}
    throw E(404,'Rota não encontrada.');
  }
  return {handle,auth,getCatalog};
}
module.exports={createApiCentral};
