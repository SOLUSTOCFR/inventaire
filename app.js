/* Inventaire Solustoc — appli web (PWA). Aucune donnée n'est stockée sur GitHub :
   tout reste sur le téléphone (IndexedDB) puis part vers le relais Google (Drive + Sheet de Brice). */
(function () {
  "use strict";
  var CFG = window.APP_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };

  // ---------- Utilitaires ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? n : 0; }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    return Math.random().toString(36).slice(2, 14);
  }
  function clean(s) { return String(s || "").trim().replace(/[\\/:*?"<>|#%]+/g, "-").replace(/\s+/g, " "); }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }
  function fmt(n) { return Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 2 }); }

  // ---------- Base locale (IndexedDB) ----------
  var db;
  function openDb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open("inventaire-solustoc", 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains("lines")) d.createObjectStore("lines", { keyPath: "id" });
        if (!d.objectStoreNames.contains("palettes")) d.createObjectStore("palettes", { keyPath: "id" });
      };
      r.onsuccess = function () { db = r.result; res(); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(store, mode, fn) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, mode), s = t.objectStore(store), out = fn(s);
      t.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); };
      t.onerror = function () { rej(t.error); };
      t.onabort = function () { rej(t.error); };
    });
  }
  function getAll(store) { return tx(store, "readonly", function (s) { return s.getAll(); }); }
  function put(store, v) { return tx(store, "readwrite", function (s) { return s.put(v); }); }

  // ---------- Session ----------
  var session = null; // {name, code, lot}
  function loadSession() { try { return JSON.parse(localStorage.getItem("inv_session")); } catch (e) { return null; } }
  function saveSession() { try { localStorage.setItem("inv_session", JSON.stringify(session)); } catch (e) {} }

  // ---------- État ----------
  var currentPalette = null;   // nom
  var editingId = null;        // id de la ligne en cours de modification
  var photos = [];             // [{blob, url}] du formulaire
  var syncing = false;
  var lastError = "";

  // ---------- Navigation ----------
  function show(view) {
    ["vLogin", "vPalettes", "vArticle"].forEach(function (v) { $(v).hidden = (v !== view); });
    $("bar").hidden = (view === "vLogin");
    $("backBtn").hidden = (view !== "vArticle");
    if (view === "vPalettes") { $("barTitle").textContent = "Palettes"; }
    window.scrollTo(0, 0);
  }

  // ---------- Connexion ----------
  function initLogin() {
    var dl = $("lotList"); dl.innerHTML = (CFG.LOTS || []).map(function (l) { return '<option value="' + esc(l) + '">'; }).join("");
    var cl = $("clientList"); cl.innerHTML = (CFG.CLIENTS || []).map(function (c) {
      return '<option value="' + esc(c[0]) + '">' + esc(c[1]) + "</option>";
    }).join("");
    var s = loadSession();
    if (s) { $("loginName").value = s.name || ""; $("loginLot").value = s.lot || ""; }
    else if (CFG.LOTS && CFG.LOTS[0]) $("loginLot").value = CFG.LOTS[0];
  }

  function call(payload) {
    return fetch(CFG.SCRIPT_URL, { method: "POST", body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); });
  }

  function doLogin() {
    var name = clean($("loginName").value), code = $("loginCode").value.trim(), lot = clean($("loginLot").value).toUpperCase();
    var msg = $("loginMsg"); msg.textContent = ""; msg.className = "msg";
    if (!name || !lot || (!code && CFG.SCRIPT_URL)) { msg.textContent = "Prénom, code et lot sont obligatoires."; return; }
    var btn = $("loginBtn"); btn.disabled = true; btn.textContent = "Vérification…";
    var done = function (offline) {
      session = { name: name, code: code, lot: lot };
      saveSession();
      btn.disabled = false; btn.textContent = "Commencer";
      $("loginCode").value = "";
      if (offline) toast("Hors ligne : le code sera vérifié à l'envoi.");
      enterPalettes();
    };
    var fail = function (m) { btn.disabled = false; btn.textContent = "Commencer"; msg.textContent = m; };
    if (!CFG.SCRIPT_URL) { done(false); return; }
    call({ action: "check", code: code, helper: name }).then(function (r) {
      if (r && r.ok) done(false); else fail("Code refusé. Vérifie-le auprès de Brice.");
    }).catch(function () {
      // Pas de réseau : on laisse commencer, le code sera contrôlé à l'envoi.
      if (!navigator.onLine) done(true); else fail("Le relais ne répond pas. Réessaie dans un instant.");
    });
  }

  function logout() {
    session = null; try { localStorage.removeItem("inv_session"); } catch (e) {}
    $("menuDlg").close(); initLogin(); show("vLogin");
  }

  // ---------- Palettes ----------
  function palId(lot, name) { return lot + "|" + name; }

  function enterPalettes() {
    $("barSub").textContent = session.lot + " · " + session.name;
    show("vPalettes"); renderPalettes(); updateChip(); sync();
  }

  function renderPalettes() {
    Promise.all([getAll("palettes"), getAll("lines")]).then(function (r) {
      var pals = r[0].filter(function (p) { return p.lot === session.lot; });
      var lines = r[1].filter(function (l) { return l.lot === session.lot && !l.deleted; });
      // palettes vues uniquement par les lignes (sécurité)
      lines.forEach(function (l) {
        if (!pals.some(function (p) { return p.name === l.palette; })) pals.push({ id: palId(l.lot, l.palette), lot: l.lot, name: l.palette, created: l.created });
      });
      pals.sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
      $("palEmpty").hidden = pals.length > 0;
      $("palList").innerHTML = pals.map(function (p) {
        var ls = lines.filter(function (l) { return l.palette === p.name; });
        var tot = ls.reduce(function (a, l) { return a + l.total; }, 0);
        return '<li class="tap" data-pal="' + esc(p.name) + '"><div><div class="t">' + esc(p.name) +
          '</div><div class="s">' + ls.length + " article(s) · " + fmt(tot) + ' pièces</div></div><div>›</div></li>';
      }).join("");
    });
  }

  function createPalette() {
    var name = clean($("newPalName").value), msg = $("palMsg"); msg.textContent = "";
    if (!name) { msg.textContent = "Donne un nom à la palette."; return; }
    getAll("palettes").then(function (all) {
      var exists = all.some(function (p) { return p.id === palId(session.lot, name); });
      var go = function () { $("newPalName").value = ""; openPalette(name); };
      if (exists) { go(); return; }
      put("palettes", { id: palId(session.lot, name), lot: session.lot, name: name, created: Date.now() }).then(go);
    });
  }

  // ---------- Article ----------
  function openPalette(name) {
    currentPalette = name; editingId = null;
    $("artPal").textContent = name; $("barTitle").textContent = name;
    resetForm(); show("vArticle"); renderLines();
  }

  function resetForm(keepClient) {
    var c = keepClient ? $("fClient").value : "";
    $("artForm").reset(); $("fClient").value = c;
    photos.forEach(function (p) { URL.revokeObjectURL(p.url); }); photos = [];
    editingId = null; $("editBanner").hidden = true; $("saveBtn").textContent = "Enregistrer et article suivant";
    $("artMsg").textContent = ""; renderThumbs(); updateTotal();
  }

  function updateTotal() {
    var ppc = num($("fPpc").value), c = num($("fCartons").value), v = num($("fVrac").value),
        cpp = num($("fCpp").value), pr = num($("fPrix").value);
    var total = ppc * c + v;
    $("tTotal").textContent = fmt(total);
    $("tPal").textContent = (cpp > 0 && c > 0) ? ("≈ " + fmt(Math.round(c / cpp * 100) / 100) + " palette(s) à " + fmt(cpp) + " colis") : "";
    $("tVal").textContent = (pr > 0 && total > 0) ? ("Valeur prix public : " + fmt(Math.round(total * pr * 100) / 100) + " €") : "";
  }

  function renderThumbs() {
    $("thumbs").innerHTML = "";
    photos.forEach(function (p, i) {
      var d = document.createElement("div"); d.className = "thumb";
      var im = document.createElement("img"); im.src = p.url; im.alt = "photo " + (i + 1);
      var b = document.createElement("button"); b.type = "button"; b.textContent = "×"; b.setAttribute("aria-label", "Retirer la photo");
      b.onclick = function () { URL.revokeObjectURL(p.url); photos.splice(i, 1); renderThumbs(); };
      d.appendChild(im); d.appendChild(b); $("thumbs").appendChild(d);
    });
    var full = photos.length >= (CFG.MAX_PHOTOS || 3);
    $("photoBtn").classList.toggle("disabled", full); $("photoBtn2").classList.toggle("disabled", full);
  }

  function compress(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var side = CFG.PHOTO_MAX_SIDE || 1600, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, side / Math.max(w, h));
        var cv = document.createElement("canvas"); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(function (b) { b ? res(b) : rej(new Error("compress")); }, "image/jpeg", CFG.PHOTO_QUALITY || 0.72);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("image")); };
      img.src = url;
    });
  }

  function onPhoto(ev) {
    var f = ev.target.files && ev.target.files[0]; ev.target.value = "";
    if (!f) return;
    if (photos.length >= (CFG.MAX_PHOTOS || 3)) { toast("Maximum " + (CFG.MAX_PHOTOS || 3) + " photos."); return; }
    compress(f).then(function (b) { photos.push({ blob: b, url: URL.createObjectURL(b) }); renderThumbs(); })
      .catch(function () { toast("Photo illisible, réessaie."); });
  }

  function saveLine(ev) {
    ev.preventDefault();
    var msg = $("artMsg"); msg.textContent = "";
    var ref = $("fRef").value.trim(), desig = $("fDesig").value.trim();
    var ppc = num($("fPpc").value), cartons = num($("fCartons").value), vrac = num($("fVrac").value);
    if (!ref && !desig) { msg.textContent = "Il faut au moins une référence ou une désignation."; return; }
    if (!(ppc > 0 && cartons > 0) && !(vrac > 0)) { msg.textContent = "Renseigne pièces par colis × nombre de colis, ou des pièces en vrac."; return; }
    if (photos.length < 1) { msg.textContent = "Prends au moins une photo."; return; }

    getAll("lines").then(function (all) {
      var existing = editingId ? all.filter(function (l) { return l.id === editingId; })[0] : null;
      var inPal = all.filter(function (l) { return l.lot === session.lot && l.palette === currentPalette; });
      var line = existing || {
        id: uid(), lot: session.lot, palette: currentPalette,
        seq: inPal.reduce(function (m, l) { return Math.max(m, l.seq || 0); }, 0) + 1,
        helper: session.name, created: Date.now(), photoNames: []
      };
      line.ref = ref; line.designation = desig; line.dluo = $("fDluo").value.trim();
      line.ppc = ppc; line.cartons = cartons; line.vrac = vrac; line.cpp = num($("fCpp").value);
      line.prix = num($("fPrix").value); line.client = $("fClient").value.trim().toUpperCase();
      line.comment = $("fComment").value.trim();
      line.total = ppc * cartons + vrac;
      line.photos = photos.map(function (p) { return p.blob; });
      line.photoNames = line.photos.map(function (b, i) {
        return clean(line.lot + "_" + line.palette + "_" + line.seq + "_" + line.id.slice(0, 5) + "_" + (i + 1)) + ".jpg";
      });
      line.updated = Date.now(); line.sync = "pending"; line.deleted = false;
      return put("lines", line);
    }).then(function () {
      toast(editingId ? "Article mis à jour ✓" : "Article enregistré ✓");
      resetForm(true); renderLines(); updateChip(); sync();
      $("fRef").focus();
    }).catch(function () { msg.textContent = "Enregistrement impossible sur ce téléphone (mémoire pleine ?)."; });
  }

  function renderLines() {
    getAll("lines").then(function (all) {
      var ls = all.filter(function (l) { return l.lot === session.lot && l.palette === currentPalette && !l.deleted; })
        .sort(function (a, b) { return b.seq - a.seq; });
      var tot = ls.reduce(function (a, l) { return a + l.total; }, 0);
      $("artPalStats").textContent = "· " + ls.length + " article(s) · " + fmt(tot) + " pièces";
      $("lineList").innerHTML = ls.map(function (l) {
        return '<li data-id="' + esc(l.id) + '"><div><div class="t">' + esc(l.designation || l.ref) + '</div><div class="s">' +
          (l.ref ? esc(l.ref) + " · " : "") + fmt(l.total) + " pièces · " + (l.photos ? l.photos.length : 0) + ' photo(s) <span class="tag ' +
          (l.sync === "sent" ? "sent" : "pending") + '">' + (l.sync === "sent" ? "envoyé" : "à envoyer") + '</span></div></div>' +
          '<div class="acts"><button data-act="edit" aria-label="Modifier">✏️</button><button data-act="del" aria-label="Supprimer">🗑️</button></div></li>';
      }).join("");
    });
  }

  function editLine(id) {
    getAll("lines").then(function (all) {
      var l = all.filter(function (x) { return x.id === id; })[0]; if (!l) return;
      resetForm(false); editingId = id;
      $("fRef").value = l.ref || ""; $("fDesig").value = l.designation || ""; $("fDluo").value = l.dluo || "";
      $("fPpc").value = l.ppc || ""; $("fCartons").value = l.cartons || ""; $("fVrac").value = l.vrac || "";
      $("fCpp").value = l.cpp || ""; $("fPrix").value = l.prix || ""; $("fClient").value = l.client || ""; $("fComment").value = l.comment || "";
      photos = (l.photos || []).map(function (b) { return { blob: b, url: URL.createObjectURL(b) }; });
      renderThumbs(); updateTotal();
      $("editBanner").hidden = false; $("saveBtn").textContent = "Mettre à jour l'article";
      window.scrollTo(0, 0);
    });
  }

  function deleteLine(id) {
    if (!confirm("Supprimer cet article ?")) return;
    getAll("lines").then(function (all) {
      var l = all.filter(function (x) { return x.id === id; })[0]; if (!l) return;
      l.deleted = true; l.sync = "pending"; l.updated = Date.now();
      return put("lines", l);
    }).then(function () { renderLines(); updateChip(); sync(); });
  }

  // ---------- Scan code-barres ----------
  var scanner = null;
  function loadScanLib() {
    return new Promise(function (res, rej) {
      if (window.Html5Qrcode) return res();
      var s = document.createElement("script");
      s.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
      s.onload = res; s.onerror = function () { rej(new Error("lib")); };
      document.head.appendChild(s);
    });
  }
  function openScan() {
    $("scanMsg").textContent = "Chargement de la caméra…"; $("scanDlg").showModal();
    loadScanLib().then(function () {
      scanner = new Html5Qrcode("reader");
      return scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 260, height: 150 } }, function (txt) {
        $("fRef").value = txt; closeScan(); toast("Code lu : " + txt);
      }, function () {});
    }).then(function () { $("scanMsg").textContent = "Place le code-barres dans le cadre."; })
      .catch(function () { $("scanMsg").textContent = "Scan impossible (caméra refusée ou pas de réseau). Tape la référence à la main."; });
  }
  function closeScan() {
    var done = function () { try { $("scanDlg").close(); } catch (e) {} scanner = null; };
    if (scanner) { scanner.stop().then(function () { scanner.clear(); done(); }).catch(done); } else done();
  }

  // ---------- Envoi vers le relais ----------
  function blobToDataUrl(b) {
    return new Promise(function (res, rej) {
      var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(b);
    });
  }

  function pendingLines() { return getAll("lines").then(function (all) { return all.filter(function (l) { return l.sync === "pending"; }); }); }

  function updateChip() {
    pendingLines().then(function (p) {
      var c = $("syncChip");
      if (!CFG.SCRIPT_URL) { c.textContent = "Local seulement"; return; }
      if (lastError && p.length) c.textContent = "⚠ " + p.length + " à envoyer";
      else if (p.length) c.textContent = "⏳ " + p.length + " à envoyer";
      else c.textContent = "✓ Tout est envoyé";
      $("mInfo").textContent = lastError ? ("Dernier incident : " + lastError) : "";
    });
  }

  function sendOne(l) {
    return Promise.all((l.photos || []).map(blobToDataUrl)).then(function (urls) {
      var payload = {
        action: "save", code: session.code, helper: session.name,
        line: {
          id: l.id, lot: l.lot, palette: l.palette, seq: l.seq, client: l.client, ref: l.ref, designation: l.designation,
          dluo: l.dluo, ppc: l.ppc, cartons: l.cartons, vrac: l.vrac, cpp: l.cpp, prix: l.prix, total: l.total,
          comment: l.comment, deleted: !!l.deleted, updated: l.updated, helper: l.helper
        },
        photos: l.deleted ? [] : urls.map(function (u, i) { return { name: l.photoNames[i], data: u }; })
      };
      return call(payload);
    });
  }

  function sync() {
    if (syncing || !session || !CFG.SCRIPT_URL || !navigator.onLine) { updateChip(); return Promise.resolve(); }
    syncing = true;
    var loop = function () {
      return pendingLines().then(function (list) {
        if (!list.length) return;
        var l = list[0], stamp = l.updated;
        return sendOne(l).then(function (r) {
          if (!r || !r.ok) {
            var err = (r && r.error) || "réponse invalide";
            if (err === "CODE_INVALIDE") { lastError = "code refusé"; toast("Code refusé : reconnecte-toi."); throw new Error("stop"); }
            lastError = err; throw new Error("stop");
          }
          lastError = "";
          return getAll("lines").then(function (all) {
            var cur = all.filter(function (x) { return x.id === l.id; })[0];
            if (cur && cur.updated === stamp) { cur.sync = "sent"; return put("lines", cur); } // pas modifié entre-temps
          });
        }).then(function () { updateChip(); return loop(); });
      });
    };
    return loop().catch(function (e) { if (!lastError) lastError = "réseau"; })
      .then(function () { syncing = false; updateChip(); if (!$("vArticle").hidden) renderLines(); if (!$("vPalettes").hidden) renderPalettes(); });
  }

  // ---------- Sauvegarde CSV locale ----------
  function exportCsv() {
    getAll("lines").then(function (all) {
      var ls = all.filter(function (l) { return !l.deleted; });
      var head = ["Lot", "N° palette", "Client", "EAN / réf", "Pièces par colis", "Nb colis", "Pièces en vrac", "Quantité totale",
        "Désignation", "DLUO/DLC", "Colis par palette", "Prix public", "Valeur totale", "Commentaires", "Photos", "Aidant", "Envoyé"];
      var rows = ls.map(function (l) {
        return [l.lot, l.palette, l.client, l.ref, l.ppc, l.cartons, l.vrac, l.total, l.designation, l.dluo, l.cpp, l.prix,
          l.prix ? Math.round(l.prix * l.total * 100) / 100 : "", l.comment, (l.photoNames || []).join(" ; "), l.helper, l.sync === "sent" ? "oui" : "non"];
      });
      var csv = [head].concat(rows).map(function (r) {
        return r.map(function (v) { v = String(v == null ? "" : v); return '"' + v.replace(/"/g, '""') + '"'; }).join(";");
      }).join("\r\n");
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
      a.download = "inventaire-" + (session ? session.lot : "lot") + "-" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
    });
  }

  // ---------- Branchements ----------
  function bind() {
    $("loginBtn").onclick = doLogin;
    $("loginCode").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
    $("newPalBtn").onclick = createPalette;
    $("newPalName").addEventListener("keydown", function (e) { if (e.key === "Enter") createPalette(); });
    $("palList").addEventListener("click", function (e) {
      var li = e.target.closest("li[data-pal]"); if (li) openPalette(li.getAttribute("data-pal"));
    });
    $("backBtn").onclick = function () { $("barTitle").textContent = "Palettes"; show("vPalettes"); renderPalettes(); };
    $("artForm").addEventListener("submit", saveLine);
    ["fPpc", "fCartons", "fCpp", "fVrac", "fPrix"].forEach(function (id) { $(id).addEventListener("input", updateTotal); });
    $("fPhoto").addEventListener("change", onPhoto); $("fPhotoGal").addEventListener("change", onPhoto);
    $("scanBtn").onclick = openScan; $("scanClose").onclick = closeScan;
    $("scanDlg").addEventListener("cancel", function (e) { e.preventDefault(); closeScan(); });
    $("cancelEdit").onclick = function () { resetForm(false); };
    $("lineList").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-act]"); if (!b) return;
      var id = b.closest("li").getAttribute("data-id");
      if (b.getAttribute("data-act") === "edit") editLine(id); else deleteLine(id);
    });
    $("syncChip").onclick = function () { lastError = ""; sync().then(function () { toast($("syncChip").textContent); }); };
    $("menuBtn").onclick = function () { updateChip(); $("menuDlg").showModal(); };
    $("mClose").onclick = function () { $("menuDlg").close(); };
    $("mSync").onclick = function () { $("menuDlg").close(); lastError = ""; sync(); };
    $("mCsv").onclick = exportCsv; $("mLogout").onclick = function () {
      pendingLines().then(function (p) {
        if (p.length && !confirm(p.length + " article(s) ne sont pas encore envoyés. Changer de personne quand même ? (Ils restent sur ce téléphone.)")) return;
        logout();
      });
    };
    window.addEventListener("online", sync);
    setInterval(function () { pendingLines().then(function (p) { if (p.length) sync(); }); }, 25000);
  }

  // ---------- Démarrage ----------
  openDb().then(function () {
    initLogin(); bind();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    var s = loadSession();
    if (s && s.name && s.lot && (s.code || !CFG.SCRIPT_URL)) { session = s; enterPalettes(); } else show("vLogin");
    if ("serviceWorker" in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register("sw.js").catch(function () {});
  }).catch(function () {
    document.body.innerHTML = '<main><h1>Inventaire Solustoc</h1><p>Ce navigateur bloque le stockage local (navigation privée ?). Ouvre l\'appli dans un onglet normal.</p></main>';
  });
})();
