'use strict';
/** Eventos em tempo real via SSE: a API observa o RTDB; site e APK observam a API. */
const {safeRead}=require('./resource-api');
const E=(http,message)=>Object.assign(new Error(message),{http});
const ADMIN_EVENTS=new Set(['pedidos','entregas','motoboys','motoboyFeed','produtos','configuracoes','localizacoesMotoboys','alertasLoja']);
function createEventsApi({database,apiAuth,getCatalog}) {
  const db=p=>database().ref(p);
  let openStreams=0;
  async function handle(req,res,p) {
    if(req.method!=='GET')throw E(405,'Use GET para receber eventos SSE.');
    if(openStreams>=80)throw E(503,'Muitas conexões simultâneas. Tente novamente.');
    let paths=[],format,vfy=async()=>true;
    if(p==='/api/v1/eventos/catalogo') {
      paths=[db('produtos'),db('configuracoes')];
      format=async()=>({tipo:'catalogo',dados:await getCatalog()});
    } else if(p==='/api/v1/eventos/motoboy') {
      const driver=await apiAuth.verify(req,'motoboy');
      paths=[db('motoboyFeed/'+driver.motoboyId)];
      format=async v=>({tipo:'feed',dados:safeRead(v)});
      vfy=()=>apiAuth.verify(req,'motoboy');
    } else {
      const m=p.match(/^\/api\/v1\/eventos\/admin\/([A-Za-z0-9_-]+)$/);
      if(!m||!ADMIN_EVENTS.has(m[1]))throw E(404,'Stream desconhecido.');
      await apiAuth.verify(req,'admin');
      const section=m[1];
      paths=[section==='pedidos'?db('pedidos').orderByChild('criadoEm').limitToLast(150):db(section)];
      format=async v=>({tipo:section,dados:safeRead(v)});
      vfy=()=>apiAuth.verify(req,'admin');
    }
    res.writeHead(200,{
      'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-cache, no-transform',
      'Connection':'keep-alive','X-Accel-Buffering':'no',
      'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
    });
    openStreams++;
    let closed=false, updateTimer=null, sequence=0;
    const listeners=[];
    let lastValue=null;
    const stop=()=>{
      if(closed)return;closed=true;openStreams--;
      if(updateTimer)clearTimeout(updateTimer);
      clearInterval(ping);clearTimeout(expiry);
      listeners.forEach(([r,cb])=>r.off('value',cb));
      try{res.end();}catch{}
    };
    const push=async()=>{
      if(closed)return;
      try {
        const data=await format(lastValue);
        if(!closed)res.write('id: '+(++sequence)+'\nevent: atualizacao\ndata: '+JSON.stringify(data)+'\n\n');
      }catch(err){console.error('[SSE]',err.message);stop();}
    };
    const changed=(snap)=>{
      lastValue=snap.val();
      if(updateTimer)clearTimeout(updateTimer);
      updateTimer=setTimeout(()=>{updateTimer=null;push();},150);
    };
    const ping=setInterval(async()=>{
      if(closed)return;
      try{await vfy();if(!closed)res.write(': keepalive\n\n');}
      catch{stop();}
    },25000);
    const expiry=setTimeout(()=>{if(!closed)res.write('event: reconnect\ndata: {}\n\n');stop();},8*60000);
    req.on('close',stop);res.on('close',stop);
    res.write(': conectado\nretry: 3000\n\n');
    for(const r of paths){
      const cb=snap=>changed(snap);
      listeners.push([r,cb]);
      r.on('value',cb,err=>{console.error('[SSE/Firebase]',err.message);stop();});
    }
  }
  return {handle};
}
module.exports={createEventsApi};
