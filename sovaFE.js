/* =========================================================
   Shoptet Context Harvester – v0.1 SKELETON
   ---------------------------------------------------------
   * Čte 2 nezávislé zdroje dat
     1) inline dataLayer.push({'shoptet': …})   →  Context 1
     2) DOM (podle pageType)                    →  Context 2
   * Vypočítá latence od startu skriptu
   * Publikuje události přes window.SOVA.bus
   * Vždy loguje snapshot + časy
   * Čistý JS, bez externích závislostí
   ========================================================= */
(function(){
  "use strict";

  /* -------------------------------------------------- utils */
  const $  = (q, r = document) => r.querySelector(q);
  const $$ = (q, r = document) => Array.from(r.querySelectorAll(q));
  const slugify = s => s.normalize('NFD')
                        .replace(/\p{Diacritic}/gu,'')
                        .replace(/[^\w]+/g,'_')
                        .replace(/^_+|_+$/g,'')
                        .toLowerCase();
  const bus = (function ensureBus(){
    const g = window;
    g.SOVA = g.SOVA || {};
    if(g.SOVA.bus) return g.SOVA.bus;
    const map = new Map();
    return g.SOVA.bus = {
      on(ev,fn){ const a=(map.get(ev)||[]); a.push(fn); map.set(ev,a); return ()=>{ const b=map.get(ev)||[]; const i=b.indexOf(fn); if(i>-1){ b.splice(i,1); map.set(ev,b);} }; },
      emit(ev,p){ (map.get(ev)||[]).slice().forEach(fn=>{ try{fn(p);}catch(e){console.error(e);} }); }
    };
  })();

  /* -------------------------------------------------- state */
  const t0 = performance.now();
  const snapshot = { startedAt: 0 };
  let dlReady = false;
  let domReady = false;

  /* -------------------------------------------------- Context 1 – inline dataLayer */
  function harvestInlineDL(obj){
    if(dlReady) return; // first wins
    if(!obj || !obj.shoptet) return;
    const src = obj.shoptet;
    const out = {};
    // ---- primární pole ----
    out.pageType   = src.pageType;
    out.currency   = src.currency;
    out.currencyInfoDecimalSeparator   = src.currencyInfo?.decimalSeparator;
    out.currencyInfoExchangeRate       = src.currencyInfo?.exchangeRate;
    out.currencyInfoPriceDecimalPlaces = src.currencyInfo?.priceDecimalPlaces;
    out.currencyInfoSymbol             = src.currencyInfo?.symbol;
    out.language  = src.language;
    out.projectId = src.projectId;
    // ---- customer ----
    if(src.customer){
      Object.assign(out, {
        customerGuid:        src.customer.guid,
        customerEmail:       src.customer.email,
        customerFullName:    src.customer.fullName,
        customerPriceRatio:  src.customer.priceRatio,
        customerPriceListId: src.customer.priceListId,
        customerGroupId:     src.customer.groupId,
        customerRegistered:  src.customer.registered,
        customerMainAccount: src.customer.mainAccount,
      });
    }
    // ---- cartInfo (flatten) ----
    if(src.cartInfo){
      const ci = src.cartInfo;
      out.cartInfoId                     = ci.id;
      out.cartInfoFreeShipping           = ci.freeShipping;
      out.cartInfoLeftToFreeGift         = ci.leftToFreeGift?.priceLeft;
      out.cartInfoLeftToFreeGiftFormatted= ci.leftToFreeGift?.formattedPrice;
      out.cartInfoFreeGift               = ci.freeGift;
      out.cartInfoLeftToFreeShipping     = ci.leftToFreeShipping?.priceLeft;
      out.cartInfoLeftToFreeShippingformatted = ci.leftToFreeShipping?.formattedPrice;
      out.cartInfoDiscountCoupon         = ci.discountCoupon?.length? ci.discountCoupon : [];
      out.cartInfoNoBillingShippingPriceWithoutVat = ci.getNoBillingShippingPrice?.withoutVat;
      out.cartInfoNoBillingShippingPriceWithVat    = ci.getNoBillingShippingPrice?.withVat;
      out.cartInfoNoBillingShippingPriceVat        = ci.getNoBillingShippingPrice?.vat;
      out.cartInfoTaxMode             = ci.taxMode;
      // cartItems table
      if(Array.isArray(ci.cartItems)){
        out.cartItems = ci.cartItems.map(i=>({
          code:i.code, guid:i.guid, priceId:i.priceId, quantity:i.quantity,
          priceWithVat:i.priceWithVat, priceWithoutDiscount:i.priceWithoutDiscount,
          itemId:i.itemId, name:i.name, weight:i.weight
        }));
      }
    }
    // ---- traffic_type ----
    out.trafficType = src.traffic_type;

    snapshot.inlineDL = {
      ready: true,
      t: +(performance.now()-t0).toFixed(1),
      data: out
    };
    dlReady = true;
    bus.emit('contextDataLayerReady', snapshot.inlineDL);
    maybeLog();
  }

  // Hook do dataLayer.push, ale rovnou zkusíme z existujícího pole
  (function hookDataLayer(){
    const g = window;
    g.dataLayer = g.dataLayer || [];
    // Zkus inline již přítomné položky
    g.dataLayer.forEach(harvestInlineDL);
    // Hook push
    const origPush = g.dataLayer.push.bind(g.dataLayer);
    g.dataLayer.push = function(...args){ args.forEach(harvestInlineDL); return origPush(...args); };
  })();

  /* -------------------------------------------------- Context 2 – DOM */
  const DOM_READERS = {
    productDetail(){
      const out = {};
      // standardPrice / save / final / additional
      const priceWrap = $('.p-final-price-wrapper');
      if(priceWrap){
        out.standardPrice   = priceWrap.querySelector('.price-standard span')?.innerText.trim();
        out.priceSave       = priceWrap.querySelector('.price-save')?.innerText.trim();
        out.finalPrice      = priceWrap.querySelector('.price-final')?.innerText.trim();
        out.additionalPrice = priceWrap.querySelector('.price-additional')?.innerText.trim();
      }
      // deliveryEstimate
      out.deliveryEstimate = $('[data-testid="deliveryTime"] .show-tooltip')?.innerText.trim();
      // cartAmount input value
      out.cartAmount = parseInt($('input[name="amount"][data-testid="cartAmount"]')?.value || '0',10);
      // shortDescription (html)
      out.shortDescription = $('.p-short-description')?.innerHTML.trim();
      // relatedProducts & alternativeProducts
      out.relatedProducts = readProductGrid('.products-related');
      out.alternativeProducts = readProductGrid('.products-alternative');
      // category & params table
      const paramsTbl = $('.detail-parameters');
      if(paramsTbl){
        const rows = $$('tr', paramsTbl);
        rows.forEach(tr=>{
          const header = tr.querySelector('th .row-header-label')?.innerText.replace(':','').trim();
          if(!header) return;
          const key = slugify('parametr_'+header);
          const v = tr.querySelector('td')?.innerText.trim();
          out[key] = v;
        });
      }
      return out;
    }
    // TODO: cart, billingAndShipping, customerDetails
  };

  function readProductGrid(sel){
    const grid = $(sel);
    if(!grid) return [];
    return $$('.product', grid).map(p=>{
      const out={};
      const link = p.querySelector('a.image');
      out.url = link?.href;
      out.img = link?.querySelector('img')?.getAttribute('src') || '';
      out.imgBig = link?.querySelector('img')?.getAttribute('data-micro-image') || '';
      out.name = p.querySelector('[data-testid="productCardName"]')?.innerText.trim();
      out.flags = $$('span.flag', p).map(f=>f.classList.contains('flag-discount')?'flag-discount':f.className.replace('flag ','').trim());
      out.finalPrice = p.querySelector('.price-final strong')?.innerText.trim();
      out.standardPrice = p.querySelector('.price-standard span')?.innerText.trim();
      out.priceSave = p.querySelector('.price-save')?.innerText.trim();
      out.additionalPrice = p.querySelector('.price-additional')?.innerText.trim();
      out.rating = parseFloat(p.querySelector('[data-micro-rating-value]')?.getAttribute('data-micro-rating-value')||'0');
      out.availability = p.querySelector('.availability')?.innerText.trim();
      out.availabilityTooltip = p.querySelector('.availability .show-tooltip')?.getAttribute('data-original-title')||'';
      out.code = p.querySelector('.p-code span[data-micro="sku"]')?.innerText.trim();
      out.productId = p.getAttribute('data-micro-product-id');
      out.priceId = p.querySelector('input[name="priceId"]')?.value;
      return out;  
    });
  }

  function harvestDOM(){
    if(domReady) return; // only first full harvest
    const pt = snapshot.inlineDL?.data?.pageType || window.dataLayer?.find(o=>o.shoptet)?.shoptet?.pageType || '';
    const reader = DOM_READERS[pt];
    const data = reader ? reader() : {};
    snapshot.dom = {
      ready: true,
      t: +(performance.now()-t0).toFixed(1),
      data
    };
    domReady = true;
    bus.emit('contextDOMready', snapshot.dom);
    maybeLog();
  }

  /* DOM ready / mutation observers */
  function onDomReady(){
    if(document.readyState === 'loading'){
      document.addEventListener('DOMContentLoaded', harvestDOM, { once:true });
    } else {
      harvestDOM();
    }
  }
  onDomReady();

  // safety fallback – když se DOM mění (např. SPA navigace) → můžeme přeharvestovat
  new MutationObserver((muts)=>{
    if(domReady) return;
    if(muts.some(m=>m.addedNodes.length)) harvestDOM();
  }).observe(document.documentElement,{ childList:true, subtree:true });

  /* -------------------------------------------------- log */
  function maybeLog(){
    if(dlReady && domReady){
      if(!snapshot.startedAt) snapshot.startedAt = 0;
      console.log('%cShoptet context snapshot','background:#222;color:#bada55', JSON.parse(JSON.stringify(snapshot)) );
    }
  }
})();
