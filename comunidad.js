/* Comunidad MF · funciona junto a index.html sin tocar su código.
   Se apoya en: #pd (ficha de producto), #productGrid (tarjetas), #comunidad / #cmHome (portada),
   #cmGrid y #cmToken (comunidad.html). */
(function () {
  "use strict";
  var API = "/.netlify/functions/comunidad";
   var REVIEWS_LOADED = false;
  var TOKEN = new URLSearchParams(location.search).get("t") || "";
  var DATA = [], tokenProducts = [], tokenContext = {}, tokenReady = Promise.resolve([]), cur = { mode: "look" }, rating = 0, file = null, dlg;
  var CLIENT_ID = "";
  try {
    CLIENT_ID = localStorage.getItem("mf-community-client-id") || "";
    if (!CLIENT_ID) {
      CLIENT_ID = "client-" + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
      localStorage.setItem("mf-community-client-id", CLIENT_ID);
    }
  } catch (e) {
    CLIENT_ID = "guest-" + Date.now().toString(36);
  }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

  /* ---------- Valoraciones (solo cuentan las aprobadas) ---------- */
  function rateHTML(id) {
    var l = DATA.filter(function (p) { return p.product === id; });
    if (!l.length) return "";
    var avg = l.reduce(function (s, p) { return s + p.rating; }, 0) / l.length, r = Math.round(avg);
    return '<p class="cm-rate" aria-label="Valoración ' + avg.toFixed(1) + ' de 5, ' + l.length + ' reseñas"><b aria-hidden="true">' +
      "★★★★★".slice(0, r) + "☆☆☆☆☆".slice(0, 5 - r) + "</b><span>" + avg.toFixed(1) + " · " + l.length + (l.length === 1 ? " reseña" : " reseñas") + "</span></p>";
  }
  function productReviewsHTML(id) {
    var l = DATA.filter(function (p) { return p.product === id; });
    if (!l.length) return "";
    var stars = function (n) {
      n = Math.max(0, Math.min(5, Math.round(n || 0)));
      return "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);
    };
    return '<section class="cm-product-reviews" aria-label="Opiniones de clientas">' +
      '<div class="cm-pr-head"><div><p class="cm-pr-kicker">Opiniones</p><h3>Lo que dicen nuestras clientas</h3></div>' +
      '<span class="cm-pr-count">' + l.length + (l.length === 1 ? " reseña" : " reseñas") + '</span></div>' +
      '<div class="cm-pr-list">' + l.map(function (p) {
        return '<article class="cm-pr-card">' +
          (p.hasPhoto ? '<a class="cm-pr-photo" href="' + API + '?action=photo&id=' + p.id + '" target="_blank" rel="noopener"><img loading="lazy" decoding="async" src="' + API + '?action=photo&id=' + p.id + '" alt="Foto de una clienta con ' + esc(p.productName) + '"></a>' : '') +
          '<div class="cm-pr-copy"><div class="cm-pr-stars" aria-label="' + p.rating + ' de 5">' + stars(p.rating) + '</div>' +
          (p.text ? '<p class="cm-pr-text">“' + esc(p.text) + '”</p>' : '') +
          '<p class="cm-pr-meta">' + (p.customerName ? esc(p.customerName) : 'Clienta MF') + (p.verified ? ' · ✓ Compra verificada' : '') + '</p></div>' +
          '</article>';
      }).join("") + '</div></section>';
  }

  function decorate() {
  $$(".card[data-product]").forEach(function (c) {
    var h = $("h3", c), r = h && !$(".cm-rate", c) ? rateHTML(c.dataset.product) : "";
    if (r) h.insertAdjacentHTML("afterend", r);
  });
  var i = $("#pd .pd-info[data-product]");
  if (!i) return;
  var id = i.dataset.product, r = !$(".cm-rate", i) ? rateHTML(id) : "";
  if (r) {
    $("h2", i).insertAdjacentHTML("afterend", r);
  } else if (REVIEWS_LOADED && !$(".cm-no-reviews", i)) {
    $("h2", i).insertAdjacentHTML("afterend", '<p class="cm-no-reviews">Aún no hay reseñas</p>');
  }
  if (!$(".cm-share", i)) $(".pd-btns", i).insertAdjacentHTML("afterend", '<button class="cm-share" type="button" data-cm-share="' + esc(id) + '">Comparte tu look</button>');
  if (!$(".cm-review", i)) $(".pd-btns", i).insertAdjacentHTML("afterend", '<button class="cm-review" type="button" data-cm-review="' + esc(id) + '">Escribir reseña</button>');
  if (!$(".cm-product-reviews", i)) $(".pd-btns", i).insertAdjacentHTML("afterend", productReviewsHTML(id));
}
  /* ---------- Galería ---------- */
  function itemHTML(p, i) {
    return '<figure class="cm-item" style="animation-delay:' + (i % 8) * 60 + 'ms"><div class="cm-img"><img loading="lazy" decoding="async" src="' + API + "?action=photo&id=" + p.id +
      '" alt="Look de una clienta con ' + esc(p.productName) + '"></div><figcaption><p class="cm-model">' + esc(p.productName) + "</p>" +
      (p.instagram ? '<a class="cm-ig" href="https://www.instagram.com/' + esc(p.instagram) + '/" target="_blank" rel="noopener">@' + esc(p.instagram) + "</a>" : "") +
      '<p class="cm-badges"><span>Clienta MF ✓</span>' + (p.verified ? "<span>✓ Compra verificada</span>" : "") + "</p>" +
      '<a class="cm-link" href="/?producto=' + esc(p.product) + '">Ver producto</a></figcaption></figure>';
  }
  function render() {
    var ph = DATA.filter(function (p) { return p.hasPhoto; }), g = $("#cmGrid"), h = $("#cmHome");
    if (g) g.innerHTML = ph.length ? ph.map(itemHTML).join("") : '<p class="cm-empty">Muy pronto verás aquí los looks de nuestras clientas.</p>';
    if (h) {
      var top = ph.slice().sort(function (a, b) { return (b.featured - a.featured) || (b.created - a.created); }).slice(0, 4);
      if (top.length >= 3) { h.innerHTML = top.map(itemHTML).join(""); $("#comunidad").hidden = false; }
    }
  }

  /* ---------- Formulario ---------- */
  function resize(f) {
    return new Promise(function (ok, ko) {
      var img = new Image(), u = URL.createObjectURL(f);
      img.onload = function () {
        var s = Math.min(1, 1400 / Math.max(img.width, img.height)), c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u);
        c.toBlob(function (b) { b ? ok(b) : ko(); }, "image/jpeg", 0.85);
      };
      img.onerror = function () { ko(new Error("No pudimos leer esa imagen. Prueba con otra fotografía.")); };
      img.src = u;
    });
  }
  function stars() { $$(".cm-stars button", dlg).forEach(function (b) { b.classList.toggle("on", +b.dataset.v <= rating); b.setAttribute("aria-pressed", +b.dataset.v === rating); }); }

  function build() {
    dlg = document.createElement("dialog"); dlg.className = "co cm-dlg"; dlg.setAttribute("aria-labelledby", "cmT");
    dlg.innerHTML = '<div class="co-in"><div class="co-head"><h2 id="cmT"></h2><button class="dlg-close" type="button" data-close aria-label="Cerrar"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg></button></div>' +
      '<form novalidate><p class="sr"><label>No llenar<input name="empresa" tabindex="-1" autocomplete="off"></label></p>' +
      '<label class="field cm-sel"><span>Producto</span><select name="sel"></select></label>' +
      '<div class="cm-photo-upload"><p class="cm-intro">¿Quieres compartir una foto? Es opcional y quedará pendiente de revisión.</p>' +
      '<ul class="cm-guide"><li>Buena iluminación</li><li>Imagen nítida</li><li>Calzado visible</li><li>Outfit cuidado</li><li>Fotografía apropiada para representar la marca</li></ul>' +
      '<p class="cm-avoid">Evitamos fotografías borrosas, de baja calidad, con contenido ofensivo o sin relación con el producto.</p>' +
      '<label class="cm-drop"><input type="file" name="file" accept="image/*"><img alt="Vista previa" hidden><span>Subir fotografía</span></label>' +
      '<label class="cm-consent"><input type="checkbox" name="consent"><span>Autorizo a MF a usar mi fotografía en su página web y redes sociales.</span></label></div>' +
      '<div class="field"><span>Tu calificación</span><div class="cm-stars" role="group" aria-label="Calificación">' +
      [1, 2, 3, 4, 5].map(function (n) { return '<button type="button" data-v="' + n + '" aria-label="' + n + (n === 1 ? " estrella" : " estrellas") + '" aria-pressed="false">★</button>'; }).join("") + "</div></div>" +
      '<label class="field"><span>Tu nombre</span><input name="customerName" maxlength="120" autocomplete="name" placeholder="Cómo quieres aparecer"></label>' +
      '<label class="field"><span>Tu reseña</span><textarea name="text" rows="3" maxlength="500" placeholder="Cuéntanos cómo te quedaron"></textarea></label>' +
      '<div class="cm-look"><label class="field"><span>Instagram (opcional)</span><input name="instagram" placeholder="@tuusuario" autocapitalize="off" autocomplete="off"></label></div>' +
      '<p class="err" role="alert"></p><button class="btn btn-solid btn-block" type="submit" style="margin-top:24px">Enviar para revisión</button>' +
      '<p class="co-fine cm-look">Revisamos cada fotografía antes de publicarla.</p></form></div>';
    document.body.appendChild(dlg);
    var f = $("form", dlg);
    dlg.addEventListener("click", function (e) {
      var b = e.target.closest(".cm-stars button");
      if (b) { rating = +b.dataset.v; stars(); }
      if (e.target === dlg) dlg.close();
    });
    f.elements.file.addEventListener("change", function () {
      file = this.files[0] || null; var im = $(".cm-drop img", f);
      if (file) { im.src = URL.createObjectURL(file); im.hidden = false; $(".cm-drop span", f).hidden = true; }
    });
    f.addEventListener("submit", function (e) { e.preventDefault(); submit(f); });
  }

  function openForm(o) {
    if (!dlg) build();
    cur = o;
    var f = $("form", dlg), look = o.mode !== "rate", sel = f.elements.sel;
    f.reset(); rating = 0; file = null; stars();
    $(".cm-drop img", f).hidden = true; $(".cm-drop span", f).hidden = false; $(".err", f).textContent = "";
    $$(".cm-look", f).forEach(function (el) { el.hidden = !look; });
    var nameInput = f.elements.customerName;
    nameInput.value = tokenContext.customerName || "";
    nameInput.readOnly = !!TOKEN && !!tokenContext.customerName;
    $(".cm-photo-upload", f).hidden = false;
    $(".cm-photo-upload .cm-intro", f).textContent = look ? "Comparte una foto donde tu MF sean protagonistas y formen parte de un outfit cuidado." : "¿Quieres compartir una foto? Es opcional y quedará pendiente de revisión.";
    $(".cm-photo-upload .cm-guide", f).hidden = !look;
    $(".cm-photo-upload .cm-avoid", f).hidden = !look;
    $(".cm-photo-upload .cm-consent", f).hidden = false;
    sel.innerHTML = o.products.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + "</option>"; }).join("");
    $(".cm-sel", f).hidden = o.products.length === 1;
    $("#cmT", dlg).textContent = look ? "Comparte tu look" : "Califica tu compra";
    var b = $('button[type="submit"]', f); b.disabled = false; b.textContent = "Enviar para revisión";
    if (!dlg.open) dlg.showModal();
  }

  function submit(f) {
    var err = $(".err", f), look = cur.mode !== "rate", sel = f.elements.sel, btn = $('button[type="submit"]', f);
    if (!rating) { err.textContent = "Elige tu calificación."; return; }
    if (!f.elements.customerName.value.trim()) { err.textContent = "Escribe tu nombre para identificar tu opinión."; return; }
    if (look && !file) { err.textContent = "Sube una fotografía para compartir tu look."; return; }
    if (file && !f.elements.consent.checked) { err.textContent = "Necesitamos tu autorización para usar la fotografía."; return; }
    if (!look && !f.elements.text.value.trim()) { err.textContent = "Escribe una pequeña reseña."; return; }
    err.textContent = ""; btn.disabled = true; btn.textContent = "Enviando…";
    (file ? resize(file) : Promise.resolve(null)).then(function (blob) {
      var fd = new FormData();
      fd.append("product", sel.value); fd.append("productName", sel.options[sel.selectedIndex].textContent);
      fd.append("rating", rating); fd.append("text", f.elements.text.value);
      fd.append("customerName", f.elements.customerName.value.trim());
      fd.append("clientId", CLIENT_ID);
      fd.append("empresa", f.elements.empresa.value); fd.append("token", TOKEN);
      if (look || file) {
        fd.append("instagram", f.elements.instagram.value);
        if (file) { fd.append("consent", "1"); fd.append("photo", blob, "look.jpg"); }
      }
      return fetch(API, { method: "POST", body: fd });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || "No pudimos enviarlo. Inténtalo de nuevo."); });
    }).then(function () {
      f.innerHTML = '<p class="cm-thanks">' + (look ? "Gracias por compartir tu look." : "Gracias por calificar tu compra.") +
        "<small>" + (look ? "Tu fotografía quedó pendiente de revisión. Si la aprobamos, aparecerá en Comunidad MF." : "Tu reseña se publicará después de una revisión rápida.") + "</small></p>" +
        '<button class="btn btn-block" type="button" data-close style="margin-top:28px">Cerrar</button>';
      $("[data-close]", f).addEventListener("click", function () { dlg.close(); });
    }).catch(function (x) { err.textContent = x.message || "No pudimos enviarlo. Inténtalo de nuevo."; btn.disabled = false; btn.textContent = "Enviar para revisión"; });
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-cm-share],[data-cm-review],[data-cm-open]");
    if (!b) return;
    if (b.dataset.cmShare || b.dataset.cmReview) {
      var id = b.dataset.cmShare || b.dataset.cmReview;
      var name = $("#pd .pd-info h2") ? $("#pd .pd-info h2").textContent : "";
      openForm({ mode: b.dataset.cmReview ? "rate" : "look", products: [{ id: id, name: name }] });
    } else if (TOKEN) {
      tokenReady.then(function (products) { if (products.length) openForm({ mode: b.dataset.cmOpen, products: products }); });
    }
  });
  ["#pd", "#productGrid"].forEach(function (s) { var el = $(s); if (el) new MutationObserver(decorate).observe(el, { childList: true, subtree: true }); });

  // Enlace desde la comunidad: /?producto=id-del-producto abre esa ficha en la tienda.
  var pid = new URLSearchParams(location.search).get("p");
  if (pid && $("#productGrid")) {
    var opener = document.createElement("button"); opener.hidden = true; opener.dataset.view = pid;
    document.body.appendChild(opener); opener.click(); opener.remove();
  }

  // Enlace post-compra: /comunidad.html?t=TOKEN (lo generas en /moderar.html).
  var box = $("#cmToken");
  if (TOKEN && box) {
    // El bloque post-compra debe ser visible de inmediato. La validación del token
    // se hace en segundo plano para evitar que un fallo de red/API o una caché
    // oculte por completo las opciones de la clienta.
    box.hidden = false;
    tokenReady = fetch(API + "?action=token&t=" + encodeURIComponent(TOKEN), { cache: "no-store" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (x) {
      if (!x.ok || !Array.isArray(x.d.products) || !x.d.products.length) {
        var msg = x.d.error || "No pudimos validar este enlace de compra.";
        box.querySelector(".cm-token-copy").textContent = msg;
        tokenProducts = [];
        return [];
      }
      tokenContext = x.d || {};
      tokenProducts = x.d.products;
      return tokenProducts;
    }).catch(function () {
      var copy = box.querySelector(".cm-token-copy");
      if (copy) copy.textContent = "No pudimos validar el enlace en este momento. Recarga la página e inténtalo de nuevo.";
      tokenProducts = [];
      return [];
    });
  }

fetch(API + "?action=public")
  .then(function (r) {
    if (!r.ok) throw new Error("reviews");
    return r.json();
  })
  .then(function (d) {
    if (!Array.isArray(d)) throw new Error("reviews");
    REVIEWS_LOADED = true;
    DATA = d;
    render();
    decorate();
  })
  .catch(function () {});
