'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createResourceApi,safeRead,flattenLeaves,productCheck}=require('../resource-api');
function fakeDb() {
 const root={
  produtos:{gin:{nome:'Gin',categoria:'Bebidas',valor:20,ativo:true,estoque:5}},
  pedidos:{ord1:{id:'ord1',status:'aprovado',tokenHash:'sigilo',pix:{qr_code_base64:'sigilo'}}},
  configuracoes:{entrega:{habilitada:true,taxa:3,sub:{a:1,b:2}}},
  motoboys:{mot1:{id:'mot1',nome:'Teste',codeHash:'segredo',codeSalt:'segredo'}}
 };
 function parts(p){return String(p).split('/').filter(Boolean)}
 function get(p){return parts(p).reduce((x,k)=>x?.[k],root)??null}
 function put(p,v){const a=parts(p),key=a.pop();let o=root;for(const k of a)o=o[k]??=(Object.create(null));o[key]=v;}
 function drop(p){const a=parts(p),k=a.pop();const o=a.reduce((x,p)=>x?.[p],root);if(o)delete o[k]}
 function ref(p){return {
  once:async()=>({val:()=>get(p)}),
  orderByChild:()=>({limitToLast:()=>({once:async()=>({val:()=>get(p)})})}),
  set:async v=>put(p,v),remove:async()=>drop(p),
  update:async value=>{for(const [k,v]of Object.entries(value))put(p+'/'+k,v);},
  transaction:async fn=>{const n=fn(get(p));if(n===undefined)return {committed:false};put(p,n);return {committed:true}},
  push:async v=>put(p+'/test',v)
 }}
 return {root,db:()=>({ref})};
}
const makeReq=(method,body)=>({method,body});
function api(db, role='admin'){
 const result=createResourceApi({database:db,send:(r,status,data)=>Object.assign(r,{status,data}),bodyJSON:async req=>req.body||{},apiAuth:{verify:async(_r,r)=>{if(role!==r)throw Object.assign(new Error('Negado'),{http:403});return {uid:'root1'}}}});
 return result;
}
test('CRUD cria, consulta, atualiza e exclui produtos no Realtime',async()=>{
 const {db,root}=fakeDb(),service=api(db),res={};
 await service.handle(makeReq('POST',{id:'cerveja',data:{nome:'Cerveja',categoria:'Cervejas',valor:6,ativo:true}}),res,'/api/v1/dados/produtos');
 assert.equal(res.status,201);
 await service.handle(makeReq('GET'),res,'/api/v1/dados/produtos/cerveja');
 assert.equal(res.data.dados.valor,6);
 await service.handle(makeReq('PATCH',{data:{valor:7.5}}),res,'/api/v1/dados/produtos/cerveja');
 assert.equal(root.produtos.cerveja.valor,7.5);
 assert.equal(root.produtos.cerveja.nome,'Cerveja');
 await service.handle(makeReq('DELETE'),res,'/api/v1/dados/produtos/cerveja');
 assert.equal(root.produtos.cerveja,undefined);
});
test('A API não permite CRUD genérico em status financeiro do pedido',async()=>{
 const {db,root}=fakeDb(),service=api(db),res={};
 await assert.rejects(service.handle(makeReq('PATCH',{data:{status:'aprovado'}}),res,'/api/v1/dados/pedidos/ord1'),e=>e.http===405);
 await assert.rejects(service.handle(makeReq('DELETE'),res,'/api/v1/dados/pedidos/ord1'),e=>e.http===405);
 assert.equal(root.pedidos.ord1.status,'aprovado');
 await service.handle(makeReq('GET'),res,'/api/v1/dados/pedidos/ord1');
 assert.equal(res.data.dados.tokenHash,undefined);
 assert.equal(res.data.dados.pix.qr_code_base64,undefined);
});
test('Permissões e proteção contra campos internos',async()=>{
 const {db}=fakeDb(),service=api(db,'motoboy');
 await assert.rejects(service.handle(makeReq('GET'),{},'/api/v1/dados/motoboys'),e=>e.http===403);
 const adm=api(db);
 await assert.rejects(adm.handle(makeReq('GET'),{},'/api/v1/dados/admins'),e=>e.http===403);
 await assert.rejects(adm.handle(makeReq('POST',{id:'a',data:{nome:'A',categoria:'B',valor:-1}}),{},'/api/v1/dados/produtos'),e=>e.http===400);
 assert.equal(safeRead({a:1,tokenHash:'a',nested:{codeSalt:'x',nome:'ok'}}).nested.codeSalt,undefined);
 assert.deepEqual(flattenLeaves({pix:{habilitado:true},raio:8}),{'pix/habilitado':true,raio:8});
});
test('PATCH aninhado em configurações preserva outros valores',async()=>{
 const {db,root}=fakeDb(),service=api(db),res={};
 await service.handle(makeReq('PATCH',{data:{sub:{a:99}}}),res,'/api/v1/dados/configuracoes/entrega');
 assert.equal(root.configuracoes.entrega.sub.a,99);
 assert.equal(root.configuracoes.entrega.sub.b,2);
 assert.equal(root.configuracoes.entrega.taxa,3);
});
test('Validação do valor e estoque não aceita valores incorretos',()=>{
 assert.throws(()=>productCheck({nome:'Gin',categoria:'Bebidas',valor:5,estoque:-2}),e=>e.http===400);
 assert.throws(()=>productCheck({nome:'Gin',categoria:'Bebidas',valor:5,imagem:'javascript:alert(1)'}),e=>e.http===400);
});
