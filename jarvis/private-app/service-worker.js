"use strict";
const CACHE_NAME="one-jarvis-private-app-shell-v1";
const SHELL_ASSETS=["/private-app/","/private-app/index.html","/private-app/styles.css","/private-app/voice-core.js","/private-app/app.js","/private-app/manifest.webmanifest","/private-app/icons/icon.svg"];
self.addEventListener("install",event=>{event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL_ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("one-jarvis-private-app-")&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",event=>{
  const request=event.request;if(request.method!=="GET")return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith("/v1/")||url.pathname.startsWith("/health")||url.pathname.includes("/auth/"))return;
  if(!SHELL_ASSETS.includes(url.pathname))return;
  if(request.mode==="navigate"){
    event.respondWith(fetch(request).then(response=>{
      if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put("/private-app/",copy));}
      return response;
    }).catch(()=>caches.match("/private-app/")));
    return;
  }
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request)));
});
