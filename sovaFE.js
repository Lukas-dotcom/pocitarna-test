// === SOVA Context Extractor – FRONTEND =====================================================
// 🛠️  drop this <script> anywhere in Shoptet HTML editor (e.g. "Kódy třetích stran")
//      – no external deps, pure ES2015+ –
//      – collects context ASAP, keeps it in‑sync and emits events over SOVA.bus –
// -----------------------------------------------------------------------------
// 1)  Context from *dataLayer* & *shoptet* globals  (section ID: ctxDL)
// 2)  Context from DOM (page‑type specific)        (section ID: ctxDOM)
// 3)  Benchmarks (t = ms since scriptStart)        (section ID: meta)
// -----------------------------------------------------------------------------
//  Emits once both sections are ready:      bus.emit('contextDataLayerReady' , ctxDL )
//                                           bus.emit('contextDOMready'       , ctxDOM)
//  Always emits diff on any change:         bus.emit('context:update'        , {snapshot,changedKeys,reason})
// ============================================================================
(function(){
  const SCRIPT_START = performance.now();

  /* ---------------------------------------------------------------------- *
   *  MICRO BUS  (very small pub/sub – identical to admin‑side helper)      *
   * ---------------------------------------------------------------------- */
  const SOVA = (window.SOVA = window.SOVA || {});
  if(!SOVA.bus){
    const map=new Map();
    SOVA.bus={
      on(ev,fn){const l=map.get(ev)||[];l.push(fn);map.set(ev,l);return()=>{const a=map.get(ev)||[];a.splice(a.indexOf(fn),1);} },
      once(ev,fn){const off=this.on(ev,p=>{off();fn(p)});return off},
      emit(ev,p){(map.get(ev)||[]).slice().forEach(fn=>{try{fn(p)}catch(e){console.error(e)})})
    };
  }
  const bus=SOVA.bus;

  /* ---------------------------------------------------------------------- *
   *  HELPERS                                                              *
   * ---------------------------------------------------------------------- */
  const $  =(sel,root=document)=>root.querySelector(sel);
  const $$ =(sel,root=document)=>Array.from(root.querySelectorAll(sel));
  const txt = el=>el?.textContent.trim()||'';
  const money = el=>{if(!el)return undefined;const s=txt(el).replace(/\u00a0/g,' ').replace(/[€£$]|Kč|CZK/gi,'');return Number(s.replace(/[^\d,.-]/g,'').replace(',','.'))||undefined};
  const now = ()=>Math.round(performance.now()-SCRIPT_START);

  /* ---------------------------------------------------------------------- *
   *  STATE  +  diff / notify                                              *
   * ---------------------------------------------------------------------- */
  const state  = Object.create(null);        // flat KV snapshot
  const dirty  = new Set();                  // keys scheduled to recalc
  const lenses = new Map();                  // id -> fn(root) => patch
  const listeners=new Set();
  let scheduled=false;

  const onUpdate  = fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
  const snapshot  = ()=>({...state});
  const patchKeys = (patch,reason)=>{
    const changed=new Set();
    for(const [k,v] of Object.entries(patch||{})){
      if(state[k]!==v){state[k]=v;changed.add(k);} }
    if(!changed.size)return;
    const snap=snapshot();
    listeners.forEach(fn=>fn({snapshot:snap,changedKeys:changed,reason}));
    bus.emit('context:update',{snapshot:snap,changedKeys:[...changed],reason});
  };
  const schedule = (id,reason)=>{dirty.add(id);if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{
    scheduled=false;const reasonTag=reason||'scheduled';
    dirty.forEach(id=>{dirty.delete(id);const fn=lenses.get(id);if(fn){try{patchKeys(fn(),`lens:${id}:${reasonTag}`);}catch(e){console.error(e);}}});
  });};

  /* ---------------------------------------------------------------------- *
   *  SECTION 1 – inline <script> dataLayer push + window.dataLayer         *
   * ---------------------------------------------------------------------- */
  (function initDataLayer(){
    const LENS_ID='ctxDL';
    function extract(){
      const out={};
      // try inline first object – walk dataLayer array until we find shoptet obj
      const dl=window.dataLayer||[];
      const first=dl.find(o=>o && o.shoptet);
      if(first?.shoptet){ mergeShoptet(first.shoptet,out); }
      // fallback: window.shoptet object (tiny customer subset)
      if(window.shoptet?.customer){ out.customerGuid=window.shoptet.customer.guid; out.customerEmail=window.shoptet.customer.email; }
      return out;
    }
    function mergeShoptet(src,tgt){
      const s=src||{};
      tgt.pageType=s.pageType;
      tgt.currency=s.currency;
      tgt.language=s.language;
      tgt.projectId=s.projectId;
      // customer
      if(s.customer){Object.assign(tgt,{
        customerGuid:s.customer.guid,
        customerEmail:s.customer.email,
        customerFullName:s.customer.fullName,
        customerPriceRatio:s.customer.priceRatio,
        customerPriceListId:s.customer.priceListId,
        customerGroupId:s.customer.groupId,
        customerRegistered:s.customer.registered,
        customerMainAccount:s.customer.mainAccount});}
      // cartInfo (flattened few essentials)
      if(s.cartInfo){Object.assign(tgt,{
        cartInfoId:s.cartInfo.id,
        cartInfoFreeShipping:s.cartInfo.freeShipping,
        cartInfoTaxMode:s.cartInfo.taxMode});}
    }

    // initial read ASAP (inline script already ran) ----------------
    lenses.set(LENS_ID,()=>({
      tDL: now(),
      ...extract()
    }));
    schedule(LENS_ID,'init');

    // hook dataLayer.push for runtime updates ----------------------
    const origPush = (window.dataLayer||[]).push.bind(window.dataLayer);
    window.dataLayer.push=function(...args){ const r=origPush(...args); if(args.some(o=>o&&o.shoptet)){ schedule(LENS_ID,'push'); } return r; };

    // notify once ready (first successful read) --------------------
    onUpdate(({changedKeys})=>{ if(changedKeys.has('tDL')) bus.emit('contextDataLayerReady', snapshot()); });
  })();

  /* ---------------------------------------------------------------------- *
   *  SECTION 2 – page‑type specific DOM scraping                           *
   * ---------------------------------------------------------------------- */
  (function initDOM(){
    const LENS_ID='ctxDOM';
    function extract(){
      const out={ tDOM: now() };
      const pType=state.pageType || $('body').dataset.pageType || '';

      if(pType==='productDetail'){ Object.assign(out, scrapeProductDetail()); }
      else if(pType==='cart'){    Object.assign(out, scrapeCart()); }
      else if(pType==='checkout/shippingBilling') { Object.assign(out, scrapeBillingShipping()); }
      else if(pType==='checkout/customer'){ Object.assign(out, scrapeCustomerDetails()); }
      // others can be added here …
      return out;
    }

    /* ---- PRODUCT DETAIL ------------------------------------------------ */
    function scrapeProductDetail(){
      const out={};
      // prices -----------------------------------------------------------
      out.standardPrice = money($('.price-standard span'));
      out.priceSave     = txt($('.price-save')) || undefined;
      out.finalPrice    = money($('.price-final strong'));
      out.additionalPrice = money($('.price-additional'));

      // delivery estimate
      out.deliveryEstimate = txt($('.delivery-time .show-tooltip'));

      // cart amount (dynamic)
      const amountInput=$('input[name="amount"].amount');
      out.cartAmount = Number(amountInput?.value||1);

      // short description (HTML)
      out.shortDescription = $('.p-short-description')?.innerHTML.trim();

      // related / alternative products (ids only to keep payload sane)
      out.relatedProducts     = $$('.products-related .product[data-micro-product-id]').map(p=>p.dataset.microProductId);
      out.alternativeProducts = $$('.products-alternative .product[data-micro-product-id]').map(p=>p.dataset.microProductId);

      // product meta from dataLayer (already flattened) – reuse state
      const keys=[
        'productId','productGuid','productCode','productName','productManufacturer',
        'productPriceWithVat','productCurrency','productHasVariants'];
      keys.forEach(k=>{ if(state[k]!==undefined) out[k]=state[k]; });

      return out;
    }

    /* ---- CART PAGE ----------------------------------------------------- */
    function scrapeCart(){
      const out={};
      const rows=$$('.cart-table tbody tr[data-micro-product-id]');
      out.cartItems = rows.map(r=>{
        const id      = r.dataset.microProductId;
        const code    = r.dataset.microSku || txt($('.p-code span',r));
        const name    = txt($('[data-testid="cellProductName"] a',r));
        const qty     = Number($('input[name="amount"].amount',r)?.value||1);
        const unit    = money($('[data-testid="cartItemPrice"]',r));
        const total   = money($('[data-testid="cartPrice"]',r));
        return {id,code,name,qty,unitPrice:unit,totalPrice:total};
      });
      out.cartTotal         = money('[data-testid="recapFullPrice"]');
      out.cartTotalNoVat    = money('[data-testid="recapFullPriceNoVat"]');
      out.deliveryEstimate  = txt($('.delivery-time strong'));
      return out;
    }

    /* ---- CHECKOUT – SHIPPING & BILLING -------------------------------- */
    function scrapeBillingShipping(){
      const out={};
      const selBilling = $('.order-summary-billing [data-testid="recapDeliveryMethod"]');
      const selShipping= $('.order-summary-shipping [data-testid="recapDeliveryMethod"]');
      out.selectedBilling  = selBilling?.innerText.trim();
      out.billingPrice     = money(selBilling?.querySelector('[data-testid="recapItemPrice"]'));
      out.selectedShipping = selShipping?.innerText.trim();
      out.shippingPrice    = money(selShipping?.querySelector('[data-testid="recapItemPrice"]'));
      return out;
    }

    /* ---- CHECKOUT – CUSTOMER DETAILS ---------------------------------- */
    function scrapeCustomerDetails(){
      const out={};
      out.billFullName   = $('#billFullName')?.value.trim();
      out.email          = $('#email')?.value.trim();
      out.phone          = $('#phone')?.value.trim();
      out.phoneCode      = $('.js-phone-code option:checked')?.textContent.trim();
      out.billStreet     = $('#billStreet')?.value.trim();
      out.billCity       = $('#billCity')?.value.trim();
      out.billZip        = $('#billZip')?.value.trim();
      out.billCountryId  = $('#billCountryIdInput')?.value;
      out.anotherShipping= $('#another-shipping')?.checked || false;
      out.remark         = $('#remark')?.value.trim();
      return out;
    }

    // lens registration & first run --------------------------------------
    lenses.set(LENS_ID,extract);
    schedule(LENS_ID,'init');

    // observer to rescan on DOM mutations (inputs, ajax)
    new MutationObserver(()=>schedule(LENS_ID,'MO')).observe(document.body,{subtree:true,childList:true});
    document.addEventListener('input', ()=>schedule(LENS_ID,'input'), true);
    document.addEventListener('change',()=>schedule(LENS_ID,'change'),true);

    // fire ready once first ctxDOM built
    onUpdate(({changedKeys})=>{ if(changedKeys.has('tDOM')) bus.emit('contextDOMready', snapshot()); });
  })();

  /* ---------------------------------------------------------------------- *
   *  TEST LOG OUTPUT  (remove on production)                               *
   * ---------------------------------------------------------------------- */
  SOVA.bus.once('contextDOMready', ctx=>{
    console.groupCollapsed('[SOVA ctx ready]', ctx.tDL+'ms DL / '+ctx.tDOM+'ms DOM');
    console.table(ctx);
    console.groupEnd();
  });

  /* ---------------------------------------------------------------------- *
   *  PUBLIC API                                                           *
   * ---------------------------------------------------------------------- */
  window.SOVAL = window.SOVAL||{};
  window.SOVAL.getContextFront = {
    onUpdate,
    snapshot,
    ensure(keys){ keys.forEach(id=>schedule(id,'ensure')); }
  };
})();
