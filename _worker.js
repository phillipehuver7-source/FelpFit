const encoder = new TextEncoder();
const PRIMARY_PROFILE_ID = "d3bc2940-6692-468f-98d6-44c598349cb2";

function json(data, status=200, headers={}){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}
  });
}

function base64url(bytes){
  let binary="";
  for(const byte of bytes) binary+=String.fromCharCode(byte);
  return btoa(binary).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
}

async function signature(value, secret){
  const key=await crypto.subtle.importKey(
    "raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]
  );
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC",key,encoder.encode(value))));
}

async function constantTimeEqual(left,right){
  const [leftHash,rightHash]=await Promise.all([
    crypto.subtle.digest("SHA-256",encoder.encode(String(left))),
    crypto.subtle.digest("SHA-256",encoder.encode(String(right)))
  ]);
  if(typeof crypto.subtle.timingSafeEqual==="function"){
    return crypto.subtle.timingSafeEqual(leftHash,rightHash);
  }
  const a=new Uint8Array(leftHash);
  const b=new Uint8Array(rightHash);
  let difference=0;
  for(let index=0;index<a.length;index++) difference|=a[index]^b[index];
  return difference===0;
}

function getCookie(request, name){
  const cookies=request.headers.get("Cookie")||"";
  for(const part of cookies.split(";")){
    const [key,...value]=part.trim().split("=");
    if(key===name) return value.join("=");
  }
  return "";
}

async function isAuthenticated(request, env){
  const token=getCookie(request,"felpfit_session");
  const [payload,sig]=token.split(".");
  if(!payload||!sig) return false;
  if(!await constantTimeEqual(await signature(payload,env.AUTH_SECRET),sig)) return false;

  try{
    const normalized=payload.replaceAll("-","+").replaceAll("_","/");
    const data=JSON.parse(atob(normalized));
    return data.exp>Date.now()&&data.sub===env.AUTH_USERNAME;
  }catch{
    return false;
  }
}

async function login(request, env){
  let body;
  try{body=await request.json()}catch{return json({error:"JSON inválido"},400)}

  const [usernameOk,passwordOk]=await Promise.all([
    constantTimeEqual(body.username||"",env.AUTH_USERNAME||""),
    constantTimeEqual(body.password||"",env.AUTH_PASSWORD||"")
  ]);
  if(!usernameOk||!passwordOk){
    return json({error:"Usuário ou senha errados"},401);
  }

  const payload=base64url(encoder.encode(JSON.stringify({
    sub:env.AUTH_USERNAME,
    exp:Date.now()+365*24*60*60*1000
  })));
  const token=`${payload}.${await signature(payload,env.AUTH_SECRET)}`;

  return json({ok:true},200,{
    "Set-Cookie":`felpfit_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`
  });
}

function logout(){
  return json({ok:true},200,{
    "Set-Cookie":"felpfit_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
  });
}

async function refreshSession(env){
  const payload=base64url(encoder.encode(JSON.stringify({
    sub:env.AUTH_USERNAME,
    exp:Date.now()+365*24*60*60*1000
  })));
  const token=`${payload}.${await signature(payload,env.AUTH_SECRET)}`;

  return json({authenticated:true},200,{
    "Set-Cookie":`felpfit_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`
  });
}

async function listProfiles(env){
  const {results}=await env.DB.prepare(
    "SELECT id, name, weight, goal, state, created_at, updated_at FROM profiles WHERE id = ?"
  ).bind(PRIMARY_PROFILE_ID).all();

  return json({profiles:results.map(row=>{
    let state={};
    try{state=JSON.parse(row.state||"{}")}catch{}
    return {
      id:row.id,
      name:row.name,
      weight:row.weight,
      goal:row.goal,
      state,
      createdAt:row.created_at,
      updatedAt:row.updated_at
    };
  })});
}

async function ensurePushTables(env){
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    app_version TEXT NOT NULL DEFAULT '1.2.1',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_push_profile ON push_subscriptions(profile_id, enabled)").run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    date_key TEXT NOT NULL,
    question_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    status INTEGER,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    sent_at TEXT NOT NULL,
    UNIQUE(endpoint, date_key, question_id, phase)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_releases (
    version TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT NOT NULL,
    published_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS release_notification_log (
    endpoint TEXT NOT NULL,
    version TEXT NOT NULL,
    phase TEXT NOT NULL,
    status INTEGER,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    sent_at TEXT NOT NULL,
    PRIMARY KEY(endpoint, version, phase)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_test_requests (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    processed_at TEXT,
    delivered_count INTEGER,
    last_status INTEGER,
    last_error TEXT
  )`).run();
}

async function pushApi(request,env,url){
  await ensurePushTables(env);

  if(url.pathname==="/api/push/public-key"&&request.method==="GET"){
    // A chave pública VAPID pode ficar no cliente; só a chave privada é secreta.
    return json({publicKey:env.VAPID_PUBLIC_KEY||"BGaLCva-VLCkD5jbhtN0Aun1sOe0AZLmRcBo66LR-QUzfB1nhTHDscmqaIK6xKaY9GKM3vAkCNYPh9v35ErPJnc"});
  }

  if(url.pathname==="/api/push/status"&&request.method==="GET"){
    const row=await env.DB.prepare(
      "SELECT COUNT(*) count FROM push_subscriptions WHERE profile_id=? AND enabled=1"
    ).bind(PRIMARY_PROFILE_ID).first();
    return json({enabled:Number(row?.count||0)>0,devices:Number(row?.count||0)});
  }

  if(url.pathname==="/api/push/subscribe"&&request.method==="POST"){
    let body;
    try{body=await request.json()}catch{return json({error:"Assinatura inválida"},400)}
    const endpoint=String(body?.endpoint||"");
    const p256dh=String(body?.keys?.p256dh||"");
    const auth=String(body?.keys?.auth||"");
    const appVersion=String(body?.appVersion||"unknown").slice(0,40);
    if(!endpoint.startsWith("https://")||!p256dh||!auth) return json({error:"Assinatura incompleta"},400);
    const now=new Date().toISOString();
    await env.DB.prepare(`INSERT INTO push_subscriptions
      (endpoint,profile_id,p256dh,auth,user_agent,app_version,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(endpoint) DO UPDATE SET
      profile_id=excluded.profile_id,p256dh=excluded.p256dh,auth=excluded.auth,
      user_agent=excluded.user_agent,app_version=excluded.app_version,enabled=1,updated_at=excluded.updated_at`
    ).bind(endpoint,PRIMARY_PROFILE_ID,p256dh,auth,String(request.headers.get("User-Agent")||"").slice(0,500),appVersion,now,now).run();
    return json({ok:true});
  }

  if(url.pathname==="/api/push/unsubscribe"&&request.method==="POST"){
    let body={};
    try{body=await request.json()}catch{}
    const endpoint=String(body?.endpoint||"");
    if(endpoint) await env.DB.prepare("UPDATE push_subscriptions SET enabled=0,updated_at=? WHERE endpoint=?")
      .bind(new Date().toISOString(),endpoint).run();
    return json({ok:true});
  }

  if(url.pathname==="/api/push/test"&&request.method==="POST"){
    await env.DB.prepare("INSERT INTO push_test_requests(id,profile_id,requested_at) VALUES(?,?,?)")
      .bind(crypto.randomUUID(),PRIMARY_PROFILE_ID,new Date().toISOString()).run();
    return json({ok:true,delivery:"within-one-minute"},202);
  }

  return null;
}

async function saveProfile(request, env, id){
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return json({error:"ID inválido"},400);
  if(id!==PRIMARY_PROFILE_ID) return json({error:"Perfil antigo não autorizado"},409);
  if(Number(request.headers.get("Content-Length")||0)>1_000_000) return json({error:"Perfil muito grande"},413);

  let body;
  try{body=await request.json()}catch{return json({error:"JSON inválido"},400)}

  const name=String(body.name||"").trim().slice(0,100);
  if(!name) return json({error:"Nome obrigatório"},400);

  const state=JSON.stringify(body.state||{});
  if(encoder.encode(state).byteLength>1_000_000) return json({error:"Perfil muito grande"},413);
  const createdAt=String(body.createdAt||new Date().toISOString());

  // A revisão nasce no aparelho. Snapshot atrasado nunca pode sobrescrever novo.
  const requestedUpdatedAt=String(body.updatedAt||"");
  const parsedUpdatedAt=Date.parse(requestedUpdatedAt);
  const updatedAt=Number.isFinite(parsedUpdatedAt)
    ? new Date(parsedUpdatedAt).toISOString()
    : new Date().toISOString();

  const existing=await env.DB.prepare(
    "SELECT updated_at FROM profiles WHERE id=?"
  ).bind(id).first();

  if(existing?.updated_at){
    const existingMs=Date.parse(existing.updated_at);
    const incomingMs=Date.parse(updatedAt);
    if(Number.isFinite(existingMs)&&Number.isFinite(incomingMs)&&incomingMs<existingMs){
      return json({ok:true,skipped:"stale-snapshot",updatedAt:existing.updated_at});
    }
  }

  await env.DB.prepare(`
    INSERT INTO profiles(id,name,weight,goal,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      weight=excluded.weight,
      goal=excluded.goal,
      state=excluded.state,
      updated_at=excluded.updated_at
  `).bind(id,name,Number(body.weight||0),Number(body.goal||0),state,createdAt,updatedAt).run();

  return json({ok:true,updatedAt});
}

async function api(request, env, url){
  if(url.pathname==="/api/login"&&request.method==="POST") return login(request,env);
  if(url.pathname==="/api/logout"&&request.method==="POST") return logout();
  if(!await isAuthenticated(request,env)) return json({error:"Não autorizado"},401);

  if(url.pathname==="/api/session"&&request.method==="GET") return refreshSession(env);
  if(url.pathname==="/api/profiles"&&request.method==="GET") return listProfiles(env);
  if(url.pathname.startsWith("/api/push/")){
    const result=await pushApi(request,env,url);
    if(result) return result;
  }

  const match=url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
  if(match&&request.method==="PUT") return saveProfile(request,env,decodeURIComponent(match[1]));
  if(match&&request.method==="DELETE"){
    const id=decodeURIComponent(match[1]);
    if(id!==PRIMARY_PROFILE_ID) return json({error:"Perfil antigo não autorizado"},409);
    await env.DB.prepare("DELETE FROM profiles WHERE id=?").bind(id).run();
    return json({ok:true});
  }

  return json({error:"Rota não encontrada"},404);
}

export default {
  async fetch(request, env){
    const url=new URL(request.url);
    try{
      if(url.pathname.startsWith("/api/")) return await api(request,env,url);
      return await env.ASSETS.fetch(request);
    }catch(error){
      console.error(JSON.stringify({event:"request_error",path:url.pathname,error:String(error?.message||error)}));
      return url.pathname.startsWith("/api/")
        ? json({error:"Erro interno"},500)
        : new Response("Erro interno",{status:500});
    }
  }
};
