 'use strict';
/**
 * REST CRUD do Firebase Realtime Database para o ADM.
 * Nunca expor CRUD genérico sem autenticação: todas as operações aqui exigem
 * sessão ADM emitida por /api/v1/admin/login.
 */
const crypto = require('node:crypto');
const E=(http,message)=>Object.assign(new Error(message),{http});
const ID=/^[A-Za-z0-9_-]{1,100}$/;
const READ_ROOTS=new Set(['produtos','configuracoes','pedidos','entregas',
 'motoboys','motoboyFeed','localizacoesMotoboys','alertasLoja','auditoria',
 'banners','promocoes','categorias','cupons']);
const WRITABLE_ITEMS=new Set(['produtos','banners','promocoes','categorias','cupons']);
const CONFIG_SECTIONS=new Set(['loja','aparencia','imagens','textos','tiposProduto',
 'catalogo','entrega','retirada','funcionamento','checkout','pagamentos','motoboys',
 'tags','icones','notificacoes']);
const STRIP_KEYS=new Set(['tokenHash','codeHash','codeSalt','fcmToken',
 'qr_code_base64','segredo','password','senha','refreshToken']);
function safeRead(v){
 if(Array.isArray(v))return v.map(safeRead);
 if(v && typeof v==='object')return Object.fromEntries(
  Object.entries(v).filter(([k])=>!STRIP_KEYS.has(k)).map(([k,x])=>[k,safeRead(x)]));
 return v;
}
function cleanJson(v,depth=0){
 if(depth>8)throw E(400,'Estrutura JSON muito profunda.');
 if(v===null||typeof v==='boolean')return v;
 if(typeof v==='string'){if(v.length>750000)throw E(413,'Campo de texto muito grande.');return v;}
 if(typeof v==='number'){if(!Number.isFinite(v))throw E(400,'Número inválido.');return v;}
 if(Array.isArray(v)){
  if(v.length>300)throw E(413,'Lista muito grande.');
  return v.map(x=>cleanJson(x,depth+1));
 }
 if(v&&typeof v==='object'){
  const pairs=Object.entries(v);
  if(pairs.length>150)throw E(413,'Muitos campos.');
  return Object.fromEntries(pairs.map(([k,x])=>{
   if(!ID.test(k)||['__proto__','constructor','prototype'].includes(k))
    throw E(400,'Nome de campo inválido.');
   return [k,cleanJson(x,depth+1)];
  }));
 }
 throw E(400,'Tipo JSON inválido.');
}
function flattenLeaves(obj, prefix='', result={}){
 for(const [k,v] of Object.entries(obj)){
  const key=prefix?prefix+'/'+k:k;
  if(v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length){
   flattenLeaves(v,key,result);
  }else result[key]=v;
 }
 return result;
}
function ensureObject(x){
 if(!x||typeof x!=='object'||Array.isArray(x))throw E(400,'Envie um objeto JSON em data.');
}
function productCheck(o){
 ensureObject(o);
 if(typeof o.nome!=='string'||o.nome.trim().length<2||o.nome.length>120)
  throw E(400,'Produto precisa de nome (2 a 120 caracteres).');
 if(typeof o.categoria!=='string'||!o.categoria.trim()||o.categoria.length>90)
  throw E(400,'Produto precisa de categoria.');
 if(typeof o.valor!=='number'||!Number.isFinite(o.valor)||o.valor<0||o.valor>100000)
  throw E(400,'Preço valor inválido.');
 if(o.estoque!==undefined&&o.estoque!==null&&
  (!Number.isInteger(o.estoque)||o.estoque<0||o.estoque>1000000))
  throw E(400,'Estoque inválido.');
 if(o.imagem!==undefined && o.imagem!==''){
  if(typeof o.imagem!=='string'||o.imagem.length>700000||
   !/^(https:\/\/[^\s"'<>]+|data:image\/(webp|png|jpeg);base64,[a-zA-Z0-9+/=]+)$/.test(o.imagem))
   throw E(400,'Imagem inválida. Use HTTPS ou base64 até 500 KB.');
 }
 if(o.ativo!==undefined&&typeof o.ativo!=='boolean')throw E(400,'Ativo deve ser booleano.');
 return o;
}
async function audit(root,uid,acao,caminho){
 try{await root('auditoria').push({uid,acao,caminho,em:Date.now(),origem:'api-v1'});}
 catch(e){console.error('[audit]',e.message);}
}
function createResourceApi({database,send,bodyJSON,apiAuth}){
 const root=p=>database().ref(p);
 const read=async p=>(await root(p).once('value')).val();
 async function handle(req,res,p){
  if(!p.startsWith('/api/v1/dados/'))throw E(404,'Rota não encontrada.');
  const parts=p.slice('/api/v1/dados/'.length).split('/');
  if(parts.length>2||!parts[0]||parts.some(x=>x && !ID.test(x)))throw E(400,'Caminho inválido.');
  const [collection,id]=parts;
  if(!READ_ROOTS.has(collection))throw E(403,'Coleção não disponibilizada na API.');
  const admin=await apiAuth.verify(req,'admin');
  const r=root(collection+(id?'/'+id:''));
  if(req.method==='GET'){
   let value;
   if(!id && collection==='pedidos'){
    value=(await root('pedidos').orderByChild('criadoEm').limitToLast(250).once('value')).val();
   }else if(!id && collection==='auditoria'){
    value=(await root('auditoria').orderByChild('em').limitToLast(100).once('value')).val();
   }else value=await read(collection+(id?'/'+id:''));
   return send(res,200,{colecao:collection,id:id||null,dados:safeRead(value)});
  }
  if(collection==='configuracoes'){
   if(req.method!=='PATCH'||!id||!CONFIG_SECTIONS.has(id))
    throw E(405,'Configurações: somente PATCH /configuracoes/{secao}.');
   const body=await bodyJSON(req,768000), data=cleanJson(body.data);
   ensureObject(data);
   if(!Object.keys(data).length)throw E(400,'Não foram enviados campos.');
   // Atualização por caminhos folha: não apaga irmãos dos campos modificados.
   const leaves=flattenLeaves(data);
   if(Object.keys(leaves).length>200)throw E(413,'Muitos campos de configuração.');
   await r.update(leaves);
   await audit(root,admin.uid,'config.patch',collection+'/'+id);
   return send(res,200,{ok:true,id,dados:safeRead(await read(collection+'/'+id))});
  }
  if(!WRITABLE_ITEMS.has(collection))throw E(405,'Coleção somente leitura. Use endpoints próprios para pedidos e entregas.');
  if(req.method==='POST'){
   if(id)throw E(405,'POST deve apontar para a coleção, sem ID.');
   const body=await bodyJSON(req,1000000);
   const newId=body.id===undefined?crypto.randomUUID():String(body.id);
   if(!ID.test(newId))throw E(400,'ID inválido.');
   const value=cleanJson(body.data);
   ensureObject(value);
   if(collection==='produtos')productCheck(value);
   const result=await root(collection+'/'+newId).transaction(old=>old===null?value:undefined,undefined,false);
   if(!result.committed)throw E(409,'Registro já existe.');
   await audit(root,admin.uid,'registro.criado',collection+'/'+newId);
   return send(res,201,{ok:true,id:newId,dados:safeRead(value)});
  }
  if(!id)throw E(405,'Informe um ID de registro.');
  if(req.method==='DELETE'){
   const existing=await read(collection+'/'+id);
   if(existing===null||existing===undefined)throw E(404,'Registro não encontrado.');
   await r.remove();
   await audit(root,admin.uid,'registro.excluido',collection+'/'+id);
   return send(res,200,{ok:true,id});
  }
  if(req.method==='PUT'||req.method==='PATCH'){
   const body=await bodyJSON(req,1000000),patch=cleanJson(body.data);
   ensureObject(patch);
   if(req.method==='PUT'){
    if(collection==='produtos')productCheck(patch);
    await r.set(patch);
    await audit(root,admin.uid,'registro.substituido',collection+'/'+id);
   }else{
    const old=await read(collection+'/'+id);
    if(old===null||old===undefined)throw E(404,'Registro não encontrado.');
    if(collection==='produtos')productCheck({...old,...patch});
    await r.update(patch);
    await audit(root,admin.uid,'registro.atualizado',collection+'/'+id);
   }
   return send(res,200,{ok:true,id,dados:safeRead(await read(collection+'/'+id))});
  }
  throw E(405,'Método não permitido.');
 }
 return {handle,safeRead,cleanJson,productCheck};
}
module.exports={createResourceApi,safeRead,cleanJson,productCheck,flattenLeaves};
