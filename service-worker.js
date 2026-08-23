const CACHE_NAME = "felpfit-v150-release";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./felpfit-native-alerts-v2.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./ranks/bronze.webp",
  "./ranks/prata.webp",
  "./ranks/ouro.webp",
  "./ranks/mitico.webp",
  "./ranks/lendario.webp",
  "./ranks/mestre.webp"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if(event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);

  // API nunca entra no cache: perfil e sessão precisam vir do servidor.
  if(requestUrl.pathname.startsWith("/api/")) return;

  if(requestUrl.origin !== self.location.origin){
    return;
  }

  // Medalhas e ícones já fazem parte do app. Cache-first evita qualquer
  // espera de rede e mantém tudo disponível no modo offline.
  if(requestUrl.pathname.startsWith("/ranks/") || requestUrl.pathname.startsWith("/icons/")){
    event.respondWith((async()=>{
      const cached=await caches.match(event.request);
      if(cached) return cached;

      const response=await fetch(event.request);
      if(response.ok){
        const cache=await caches.open(CACHE_NAME);
        await cache.put(event.request,response.clone());
      }
      return response;
    })());
    return;
  }

  const network=fetch(event.request).then(async response=>{
    if(response.ok){
      const cache=await caches.open(CACHE_NAME);
      await cache.put(event.request,response.clone());
    }
    return response;
  });

  event.waitUntil(network.then(()=>undefined).catch(()=>undefined));
  event.respondWith(network.catch(async()=>
    await caches.match(event.request) || await caches.match("./index.html")
  ));
});

self.addEventListener("push", event => {
  let payload={};
  try{payload=event.data?.json()||{}}catch{payload={body:event.data?.text()||"Você tem uma pergunta nova no FelpFit."}}
  const title=payload.title||"FelpFit";
  const options={
    body:payload.body||"Sua pergunta diária está esperando.",
    icon:"./icons/icon-192.png",
    badge:"./icons/icon-192.png",
    tag:payload.tag||"felpfit-question",
    renotify:true,
    timestamp:payload.timestamp||Date.now(),
    data:payload.data||{url:"./"}
  };
  event.waitUntil(self.registration.showNotification(title,options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target=new URL(event.notification.data?.url||"./",self.location.origin).href;
  event.waitUntil(
    clients.matchAll({type:"window",includeUncontrolled:true}).then(windows=>{
      const existing=windows.find(client=>new URL(client.url).origin===self.location.origin);
      if(existing){
        existing.navigate(target);
        return existing.focus();
      }
      return clients.openWindow(target);
    })
  );
});
