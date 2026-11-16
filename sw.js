// Service worker : fait tourner l'appli sans réseau (les fichiers de l'appli sont gardés sur le téléphone).
// Augmenter VERSION à chaque mise à jour de l'appli pour que les téléphones rechargent les nouveaux fichiers.
var VERSION = "inv-v4";
var SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return; // les envois vers le relais ne passent jamais par le cache
  var url = new URL(req.url);
  var sameOrigin = url.origin === location.origin;
  var isScanLib = url.hostname === "unpkg.com";
  if (!sameOrigin && !isScanLib) return;
  // Réseau d'abord (pour recevoir les mises à jour), cache en secours (hors ligne).
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return caches.match(req).then(function (r) { return r || caches.match("index.html"); }); })
  );
});
