'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createApiCentral}=require('../api-central');
const crypto=require('node:crypto');
process.env.ADEGA_SESSION_SECRET='f'.repeat(64);
const fake={admins:{admin123:true},motoboys:{'d4695282-09ad-4eba-b6b7-85c458c7c5b9':{id:'d4695282-09ad-4eba-b6b7-85c458c7c5b9',ativo:true}},produtos:{p1:{nome:'Gin',categoria:'Gin',valor:39.9,ativo:true},p2:{nome:'Vodka',categoria:'Vodka',valor:12,ativo:false}},configuracoes:{loja:{nome:'Adega Teste'},pagamentos:{pix:{habilitado:true}}}};
function tree(p){return p.split('/').filter(Boolean).reduce((v,k)=>v?.[k],fake)}
const database=()=>({ref:p=>({once:async()=>({val:()=>tree(p)}),update:async d=>Object.assign(tree(p),d),set:async v=>{throw Error('no write')},push:()=>{throw Error('no push')}})});
const bodyJSON=async req=>req.body||{},send=(res,code,data)=>{res.code=code;res.data=data};
const api=createApiCentral({database,admin:{auth:()=>({verifyIdToken:async()=>({uid:'admin123'})})},send,bodyJSON});
test('API gera token assinado e valida o papel',async()=>{
 const token=api.auth.createSession('motoboy','d4695282-09ad-4eba-b6b7-85c458c7c5b9');
 const req={headers:{authorization:'Bearer '+token}};
 const who=await api.auth.verify(req,'motoboy');assert.equal(who.role,'motoboy');
 await assert.rejects(api.auth.verify(req,'admin'),/Sessão expirada/);
 await assert.rejects(api.auth.verify({headers:{authorization:'Bearer '+token.slice(0,-2)+'xx'}},'motoboy'),/Sessão inválida/);
});
test('catálogo público só apresenta ativos e não expõe dados privados',async()=>{
 const res={};await api.handle({method:'GET'},res,'/api/v1/catalogo');
 assert.equal(res.code,200);assert.equal(res.data.produtos.p1.nome,'Gin');assert.equal(res.data.produtos.p2,undefined);
 assert.equal(res.data.configuracoes.pagamentos.pix.habilitado,true);assert.equal(res.data.configuracoes.loja.nome,'Adega Teste');
});
test('admin sem autorização é barrado',async()=>{
 const token=api.auth.createSession('admin','no-admin');
 await assert.rejects(api.handle({method:'POST',headers:{authorization:'Bearer '+token},body:{}},{},'/api/v1/admin/dados'),/Administrador sem permissão/);
});
