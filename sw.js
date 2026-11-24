// Offline support: app files are cached; the page itself is fetched fresh when online.
const C='library-v27';
const SHELL=['./','index.html','manifest.webmanifest','icon.svg','icon-192.png','zxing.min.js','bg.jpg','bg-small.jpg','bg-lounge.jpg','bg-lounge-small.jpg','sync.js','firebase-config.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET')return;
  if(u.origin===location.origin){
    e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('index.html'))));
  }else if(/covers\.openlibrary\.org|books\.google|googleusercontent|fonts\.(googleapis|gstatic)\.com/.test(u.host)){
    e.respondWith(caches.open('library-img').then(c=>c.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{if(r.ok||r.type==='opaque')c.put(e.request,r.clone());return r}))));
  }
});
