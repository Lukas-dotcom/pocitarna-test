// === Context collector for Shoptet frontend – v2 ===
// collects (1) dataLayer / shoptet object   (2) DOM‑only data
// then emits:   contextDataLayerReady   &   contextDOMready
// finally dumps timing + snapshots to console for quick verification

(function () {
  "use strict";

  /*─────────────────────────── helpers ───────────────────────────*/
  const $  = (q, root = document) => root.querySelector(q);
  const $$ = (q, root = document) => Array.from(root.querySelectorAll(q));
  const txt = (el) => (el ? el.textContent.replace(/\u00A0/g, " ").trim() : "");
  const num = (s) => {
    const n = parseFloat(String(s).replace(/[\s\u00A0]/g, "").replace(/,/g, "."));
    return Number.isFinite(n) ? n : undefined;
  };
  const stripCur = (s) => s.replace(/[€£$]|Kč|CZK|EUR|USD/gi, "");
  const getMs = (start) => Math.round((performance.now() - start) * 10) / 10;

  /*──────────────────────── timing ───────────────────────────────*/
  const startedAt = performance.now();
  const timing = {
    startedAt: 0,            // always 0 (start reference)
    gtmDL:   { ready: false, t: null, data: null },
    shoptetObj: { ready: false, t: null, data: null },
    inlineDL:  { ready: false, t: null, data: null },
    domCtx:    { ready: false, t: null, data: null }
  };

  /*──────────────────── section 1 – dataLayer ───────────────────*/
  function readInlineDL () {
    try {
      const inline = document.querySelectorAll("script");
      for (const s of inline) {
        if (!s.textContent.includes("dataLayer = []")) continue;
        const m = s.textContent.match(/dataLayer\.push\((\{[\s\S]+?\})\)/);
        if (!m) continue;
        // eslint-disable-next-line no-new-func
        const obj = Function("return " + m[1])();
        return obj.shoptet?.customer ? obj.shoptet : null;
      }
    } catch (_) {}
    return null;
  }

  function finishInlineDL (data) {
    timing.inlineDL.ready = true;
    timing.inlineDL.t     = getMs(startedAt);
    timing.inlineDL.data  = data;
    maybeFireDLReady();
  }

  const inlineData = readInlineDL();
  if (inlineData) finishInlineDL(inlineData);

  // ── wait for window.dataLayer push with customer info ──
  function hookDataLayer () {
    if (!window.dataLayer) window.dataLayer = [];
    const origPush = window.dataLayer.push;
    window.dataLayer.push = function (...args) {
      const res = origPush.apply(this, args);
      scanDataLayer();
      return res;
    };
    scanDataLayer();
  }
  hookDataLayer();

  function scanDataLayer () {
    const dlItem = window.dataLayer.find((o) => o && o.shoptet && o.shoptet.customer);
    if (dlItem && !timing.gtmDL.ready) {
      timing.gtmDL.ready = true;
      timing.gtmDL.t     = getMs(startedAt);
      timing.gtmDL.data  = dlItem.shoptet.customer;
      maybeFireDLReady();
    }
  }

  // ── shoptet object on window (async) ──
  function pollShoptetObj () {
    if (timing.shoptetObj.ready) return;
    if (window.shoptet && window.shoptet.customer) {
      timing.shoptetObj.ready = true;
      timing.shoptetObj.t     = getMs(startedAt);
      timing.shoptetObj.data  = window.shoptet.customer;
      maybeFireDLReady();
    } else {
      requestAnimationFrame(pollShoptetObj);
    }
  }
  pollShoptetObj();

  /*──────── emit BUS event after both dataLayer & shoptetObj ─────*/
  function maybeFireDLReady () {
    if (timing.inlineDL.ready && timing.shoptetObj.ready && timing.gtmDL.ready) {
      if (maybeFireDLReady.done) return; // once
      maybeFireDLReady.done = true;
      window.dispatchEvent(new CustomEvent("contextDataLayerReady", { detail: {
        inline: timing.inlineDL.data,
        shoptet: timing.shoptetObj.data,
        gtm: timing.gtmDL.data,
        t: timing.gtmDL.t
      }}));
    }
  }

  /*────────────────── section 2 – DOM parsing ───────────────────*/
  const domCtx = {};
  function readDomCtx () {
    const pageType = timing.inlineDL.data?.pageType || window.shoptet?.pageType || "";
    if (pageType !== "productDetail") return; // only PD for now

    /* prices */
    const pWrap = $(".p-final-price-wrapper");
    domCtx.standardPrice   = num(stripCur(txt(pWrap?.querySelector(".price-standard"))));
    domCtx.priceSave       = txt(pWrap?.querySelector(".price-save"));
    domCtx.finalPrice      = num(stripCur(txt(pWrap?.querySelector(".price-final"))));
    domCtx.additionalPrice = num(stripCur(txt(pWrap?.querySelector(".price-additional"))));

    /* delivery estimate */
    domCtx.deliveryEstimate = txt($(".detail-parameters .delivery-time, .delivery-time[data-testid='deliveryTime']"));

    /* short description */
    domCtx.shortDescription = $(".p-short-description")?.innerText.trim() || "";

    /* cart amount + live update */
    const qtyInput = $("input[name='amount'].amount");
    if (qtyInput) {
      domCtx.cartAmount = parseInt(qtyInput.value, 10) || 1;
      qtyInput.addEventListener("input", () => {
        domCtx.cartAmount = parseInt(qtyInput.value, 10) || 1;
        window.dispatchEvent(new CustomEvent("contextDOMready", { detail: domCtx }));
      });
      ["increase", "decrease"].forEach((cls) => {
        $("button." + cls)?.addEventListener("click", () => {
          // next tick (input already changed)
          requestAnimationFrame(() => {
            domCtx.cartAmount = parseInt(qtyInput.value, 10) || 1;
            window.dispatchEvent(new CustomEvent("contextDOMready", { detail: domCtx }));
          });
        });
      });
    }

    /* related / alternative products */
    function grabProducts (selector) {
      return $$(selector).map((p) => {
        const a = p.querySelector("a.image");
        return {
          code: p.querySelector(".p-code span")?.innerText.trim() || null,
          id: p.dataset.microProductId || null,
          url: a?.href || null,
          img: a?.querySelector("img")?.src || null,
          imgBig: a?.querySelector("img")?.dataset.microImage || null,
          flags: $$(".flags span", p).map((f) => f.className.split(" ").find((c) => c.startsWith("flag-"))) || [],
          name: txt(p.querySelector("[data-testid='productCardName']")),
          rating: parseFloat(p.querySelector("[data-micro-rating-value]")?.dataset.microRatingValue) || null,
          availability: txt(p.querySelector(".availability")),
          availabilityTooltip: p.querySelector(".availability .show-tooltip")?.getAttribute("data-original-title") || "",
          availabilityAmount: txt(p.querySelector("[data-testid='numberAvailabilityAmount']")),
          standardPrice: txt(p.querySelector(".price-standard")),
          priceSave: txt(p.querySelector(".price-save")),
          finalPrice: txt(p.querySelector(".price-final")),
          additionalPrice: txt(p.querySelector(".price-additional")),
          priceId: p.querySelector("input[name='priceId']")?.value || null,
          productId: p.querySelector("input[name='productId']")?.value || null,
          csrf: p.querySelector("input[name='__csrf__']")?.value || null,
          shortDescription: p.querySelector(".p-desc")?.innerText.trim() || "",
          warranty: p.querySelector("[data-micro-warranty]")?.dataset.microWarranty || null
        };
      });
    }
    domCtx.relatedProducts     = grabProducts(".products-related .product");
    domCtx.alternativeProducts = grabProducts(".products-alternative .product");

    /* parameters from table */
    const params = $(".detail-parameters tbody");
    if (params) {
      $$("tr", params).forEach((tr) => {
        const keyEl = tr.querySelector("th span.row-header-label");
        const valEl = tr.querySelector("td");
        if (!keyEl || !valEl) return;
        const rawKey = keyEl.textContent.replace(/[:\s]+$/, "");
        const safeKey = rawKey.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
          .replace(/[^A-Za-z0-9]/g, "").replace(/^([0-9])/, "_$1");
        const value = txt(valEl);
        domCtx[`param${safeKey}`] = value;
      });
    }
  }

  function finishDomCtx () {
    if (timing.domCtx.ready) return;
    timing.domCtx.ready = true;
    timing.domCtx.t     = getMs(startedAt);
    timing.domCtx.data  = { ...domCtx };
    window.dispatchEvent(new CustomEvent("contextDOMready", { detail: domCtx }));
    dumpLog();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    readDomCtx();
    finishDomCtx();
  } else {
    window.addEventListener("DOMContentLoaded", () => {
      readDomCtx();
      finishDomCtx();
    });
  }

  /*─────────────── debug dump to console ───────────────────────*/
  function dumpLog () {
    console.log(JSON.stringify({
      startedAt: timing.startedAt,
      gtmDL: timing.gtmDL,
      shoptetObj: timing.shoptetObj,
      inlineDL: timing.inlineDL,
      domCtx: timing.domCtx
    }, null, 2));
  }
})();
