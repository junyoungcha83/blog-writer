// 블로그작성 — 이력 동기화 API (개인용, 토큰 보호)
// - GET /api/data : X-Edit-Token 일치 시 전체 이력 반환
// - PUT /api/data : X-Edit-Token 일치 시 전체 이력 저장
// KV: HIST (단일 키 "bw-history")  ·  Secret: EDIT_TOKEN
const KEY = 'bw-history';
const MAX_BYTES = 12 * 1024 * 1024;   // 이력(스테이지 포함)이 커서 넉넉히
const ALLOWED = ['https://junyoungcha83.github.io','http://localhost:8000','http://127.0.0.1:8000'];
function cors(req){ const o=req.headers.get('Origin')||''; const a=ALLOWED.includes(o)?o:ALLOWED[0];
  return { 'Access-Control-Allow-Origin':a,'Access-Control-Allow-Methods':'GET, PUT, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Edit-Token','Access-Control-Max-Age':'86400','Vary':'Origin' }; }
function json(b,s,x){ return new Response(JSON.stringify(b),{status:s,headers:{'Content-Type':'application/json; charset=utf-8',...x}}); }
const valid = p => p && typeof p==='object' && Array.isArray(p.items);
export default {
  async fetch(req, env){
    const url = new URL(req.url), c = cors(req);
    if(req.method==='OPTIONS') return new Response(null,{headers:c});
    if(url.pathname==='/api/data'){
      const t = req.headers.get('X-Edit-Token')||'';
      if(!env.EDIT_TOKEN || t!==env.EDIT_TOKEN) return json({error:'unauthorized'},401,c);
      if(req.method==='GET'){ const raw = await env.HIST.get(KEY);
        return new Response(raw || JSON.stringify({items:[]}),{headers:{...c,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}}); }
      if(req.method==='PUT'){ const body = await req.text();
        if(body.length>MAX_BYTES) return json({error:'too_large'},413,c);
        let p; try{ p=JSON.parse(body); }catch{ return json({error:'invalid_json'},400,c); }
        if(!valid(p)) return json({error:'invalid_shape'},400,c);
        await env.HIST.put(KEY, body); return json({ok:true,count:p.items.length},200,c); }
      return json({error:'method_not_allowed'},405,c);
    }
    if(url.pathname==='/'||url.pathname==='/api/health') return json({ok:true,service:'blog-writer-api'},200,c);
    return new Response('Not Found',{status:404,headers:c});
  },
};
