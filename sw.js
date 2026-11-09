// Réseau d'abord : l'appli affiche toujours la dernière version publiée,
// et le cache ne sert que hors connexion.
// (L'ancienne version servait le cache en priorité : une mise à jour n'apparaissait jamais.)
const CACHE = 'fuel-v3';
const ASSETS = ['/', '/index.html', '/manifest.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET' || url.includes('supabase.co') || url.includes('/.netlify/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok && url.startsWith(self.location.origin)) {
          const copie = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copie));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
