/* =============================================================
   contextFrontend_flat.js — FRONTEND context collector for Shoptet
   - Pure JS, no deps. Flat structure except tables (arrays of rows).
   - Emits bus events: contextDataLayerReady, contextDOMready, contextDOMupdate
   - Measures how long DL/DOM parsing took and logs to console.
   ============================================================= */
(function initContextFrontend(){
  // ===== BUS fallback (compatible with SOVA.bus if already present) =====
  const SOVA = (window.SOVA = window.SOVA || {});
  if (!SOVA.bus) {
    const _map = new Map();
    SOVA.bus = {
      on(ev, fn){ const a=_map.get(ev)||[]; a.push(fn); _map.set(ev,a); return ()=>{ const b=_map.get(ev)||[]; const i=b.indexOf(fn); if(i>-1){ b.splice(i,1); _map.set(ev,b); } }; },
      once(ev, fn){ const off=this.on(ev, (p)=>{ off(); try{ fn(p); }catch(e){ console.error(e); } }); return off; },
      emit(ev, payload){ (_map.get(ev)||[]).slice().forEach(fn=>{ try{ fn(payload); }catch(e){ console.error('[bus handler]',e); } }); }
    };
  }
  const bus = SOVA.bus;

  // ===== Utils =====
  const $  = (q,root=document)=> root.querySelector(q);
  const $$ = (q,root=document)=> Array.from(root.querySelectorAll(q));
  const toNum = v => { if (v == null) return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  const toInt = v => { if (v == null) return undefined; const n = parseInt(v,10); return Number.isNaN(n) ? undefined : n; };
  const NBSP = ' '; // literal NBSP
  const text = (el)=> (el?.textContent||'').replaceAll(NBSP,' ').trim();
  const html = (el)=> el ? el.innerHTML.trim() : '';
  const sanitizeId = s => String(s||'').replace(/[^A-Za-z0-9]/g,'');
  const safeKey = raw => raw
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^A-Za-z0-9]+/g,'')
    .replace(/^([0-9])/,'_$1');

  // Split parameter values into a set (array) by a comma followed by a LONG run of spaces.
  // Example raw: "aaaa,                                                                                 bbbb, cccccc"
  // => ["aaaa", "bbbb, cccccc"]
  const SEP_LONG_COMMA = /,[\s\u00A0]{8,}/; // comma + 8+ spaces (incl. NBSP)
  function splitParamValues(raw){
    if (!raw) return [];
    // Keep commas; only split on "comma + long whitespace"
    return raw.split(SEP_LONG_COMMA)
              .map(s => s.replace(/\s+/g,' ').trim())
              .filter(Boolean)
              // dedupe while preserving order
              .filter((v,i,a)=>a.indexOf(v)===i);
  }

  // ===== Global flat context holder =====
  const ctx = Object.create(null); // flat; tables are arrays

  // ===== DataLayer reader (FLATTENED per spec) =====
  function getLatestShoptetLayer(){
    const dl = window.dataLayer || [];
    for (let i = dl.length - 1; i >= 0; i--) {
      const rec = dl[i];
      if (rec && typeof rec === 'object' && rec.shoptet) return rec.shoptet;
    }
    return null;
  }

  function buildDataLayerPatch(){
    const sh = getLatestShoptetLayer() || {};
    const out = {};

    // Basic
    out.pageType   = sh.pageType;
    out.currency   = sh.currency;
    out.language   = sh.language;
    out.projectId  = sh.projectId;

    // currencyInfo -> flattened
    const ci = sh.currencyInfo || {};
    out.currencyInfoDecimalSeparator   = ci.decimalSeparator;
    out.currencyInfoExchangeRate       = toNum(ci.exchangeRate);
    out.currencyInfoPriceDecimalPlaces = toNum(ci.priceDecimalPlaces);
    out.currencyInfoSymbol             = ci.symbol;

    // cartInfo -> flattened
    const c = sh.cartInfo || {};
    out.cartInfoId             = c.id;
    out.cartInfoFreeShipping   = !!c.freeShipping;
    out.cartInfoFreeGift       = !!c.freeGift;
    out.cartInfoDiscountCoupon = Array.isArray(c.discountCoupon) ? c.discountCoupon.slice() : c.discountCoupon;
    out.cartInfoTaxMode        = c.taxMode;

    if (c.leftToFreeGift){
      out.cartInfoLeftToFreeGiftFormatted = c.leftToFreeGift.formattedPrice;
      out.cartInfoLeftToFreeGift          = toNum(c.leftToFreeGift.priceLeft);
    }
    if (c.leftToFreeShipping){
      out.cartInfoLeftToFreeShipping          = toNum(c.leftToFreeShipping.priceLeft);
      out.cartInfoLeftToFreeShippingFormatted = c.leftToFreeShipping.formattedPrice;
    }
    if (c.getNoBillingShippingPrice){
      out.cartInfoNoBillingShippingPriceVat        = toNum(c.getNoBillingShippingPrice.vat);
      out.cartInfoNoBillingShippingPriceWithVat    = toNum(c.getNoBillingShippingPrice.withVat);
      out.cartInfoNoBillingShippingPriceWithoutVat = toNum(c.getNoBillingShippingPrice.withoutVat);
    }

    // cartItems (prefer cartInfo.cartItems; fallback to sh.cart)
    const rawItems = (Array.isArray(c.cartItems) && c.cartItems.length) ? c.cartItems : (Array.isArray(sh.cart) ? sh.cart : []);
    out.cartItems = rawItems.map(it => ({
      code: it.code,
      guid: it.guid,
      priceId: toInt(it.priceId),
      quantity: toNum(it.quantity),
      priceWithVat: toNum(it.priceWithVat),
      priceWithoutDiscount: toNum(it.priceWithoutDiscount),
      itemId: it.itemId,
      name: it.name,
      weight: toNum(it.weight)
    }));

    // customer -> flattened
    const cust = sh.customer || {};
    out.customerGuid        = cust.guid;
    out.customerEmail       = cust.email;
    out.customerFullName    = cust.fullName;
    out.customerPriceRatio  = toNum(cust.priceRatio);
    out.customerPriceListId = toInt(cust.priceListId);
    out.customerGroupId     = toInt(cust.groupId);
    out.customerRegistered  = !!cust.registered;
    out.customerMainAccount = !!cust.mainAccount;

    // traffic
    out.trafficType = sh.traffic_type || sh.trafficType;

    // product (only when on productDetail)
    const p = sh.product || {};
    if (sh.pageType === 'productDetail' && p){
      out.productId                   = p.id;
      out.productGuid                 = p.guid;
      out.productHasVariants          = !!p.hasVariants;
      out.productCode                 = Array.isArray(p.codes) && p.codes[0] ? p.codes[0].code : undefined;
      out.productName                 = p.name;
      out.productAppendix             = p.appendix;
      out.productWeight               = toNum(p.weight);
      out.productManufacturer         = p.manufacturer;
      out.productManufacturerGuid     = p.manufacturerGuid;
      out.productCurrentCategory      = p.currentCategory;
      out.productCurrentCategoryGuid  = p.currentCategoryGuid;
      out.productDefaultCategory      = p.defaultCategory;
      out.productDefaultCategoryGuid  = p.defaultCategoryGuid;
      out.productCurrency             = p.currency || sh.currency;
      out.productPriceWithVat         = toNum(p.priceWithVat ?? p.priceWithVatMin ?? p.priceWithVatMax);

      // productVariants table from product.codes (columns: code, quantity, stock<ID> for each stock id)
      out.productVariants = Array.isArray(p.codes) ? p.codes.map(row => {
        const r = { code: row.code, quantity: toNum(row.quantity) };
        (row.stocks || []).forEach(s => { const key = 'stock' + sanitizeId(s.id || ''); r[key] = toNum(s.quantity); });
        return r;
      }) : [];

      // stocks table from sh.stocks (id,title,isDeliveryPoint,visibleOnEshop)
      out.stocks = Array.isArray(sh.stocks) ? sh.stocks.map(s => ({
        id: s.id,
        title: s.title,
        isDeliveryPoint: !!s.isDeliveryPoint,
        visibleOnEshop: !!s.visibleOnEshop
      })) : [];
    }

    return out;
  }

  function readDataLayer(){
    const t0 = performance.now();
    const patch = buildDataLayerPatch();
    Object.assign(ctx, patch);
    const took = performance.now() - t0;
    try { bus.emit('contextDataLayerReady', { snapshot: { ...ctx }, tookMs: took }); } catch(e){}
    return took;
  }

  // Re-run DL on Shoptet updates
  function hook(path, after){
    try {
      const parts = path.split('.');
      let host = window[parts[0]];
      for (let i=1;i<parts.length-1;i++){ if (!host) return; host = host[parts[i]]; }
      const name = parts[parts.length-1];
      if (!host || !host[name] || host[name].__hooked) return;
      const orig = host[name];
      const wrap = function(){ const r = orig.apply(this, arguments); try{ after(); }catch(e){} return r; };
      wrap.__hooked = true;
      host[name] = wrap;
    } catch(e){}
  }
  const rerunDL = ()=> queueMicrotask(readDataLayer);
  hook('shoptet.tracking.updateDataLayerCartInfo', rerunDL);
  hook('shoptet.tracking.updateCartDataLayer', rerunDL);
  document.addEventListener('ShoptetDataLayerUpdated', rerunDL, true);

  // Initial DL read
  const dlMs = readDataLayer();

  // ===== DOM reader =====
  function parsePrices_Product(){
    const root = $('.p-final-price-wrapper');
    return {
      standardPrice : text(root?.querySelector('.price-standard span')) || undefined,
      priceSave     : text(root?.querySelector('.price-save')) || undefined,
      finalPrice    : text(root?.querySelector('.price-final [data-testid="productCardPrice"], .price-final strong') || root?.querySelector('.price.price-final strong')) || undefined,
      additionalPrice: text(root?.querySelector('.price-additional')) || undefined,
    };
  }

  function parseDeliveryEstimate_Product(){
    const d = $('.detail-parameters .delivery-time [data-testid="deliveryTime"] .show-tooltip, .detail-parameters .delivery-time [data-testid="deliveryTime"], .detail-parameters .delivery-time');
    return { deliveryEstimate: text(d) || undefined };
  }

  function readCartAmount_Product(root=document){
    const input = root.querySelector('input.amount[data-testid="cartAmount"], input.amount[name="amount"]');
    return input ? toInt(input.value) : undefined;
  }

  function parseShortDescription_Product(){
    const el = $('.p-short-description [data-testid="productCardShortDescr"], .p-short-description');
    return { shortDescription: html(el) };
  }

  function parseProductList(containerSel){
    const out = [];
    $$(containerSel + ' .product').forEach(card => {
      const p = card.querySelector('.p');
      const data = {};
      data.code = text(card.querySelector('.p-code [data-micro="sku"]')) || undefined;
      data.id   = p?.getAttribute('data-micro-product-id') || undefined;
      const aImg= card.querySelector('a.image');
      data.url  = aImg?.getAttribute('href') || undefined;
      const img = aImg?.querySelector('img');
      data.img  = img?.getAttribute('src') || undefined;
      data.imgBig = img?.getAttribute('data-micro-image') || undefined;
      data.flags = $$('.flags span.flag', card).map(s=> s.className.split(/\s+/).find(c=>c.startsWith('flag-'))).filter(Boolean);
      data.name = text(card.querySelector('[data-testid="productCardName"]')) || undefined;
      const starsWrap = card.querySelector('.stars-wrapper');
      data.rating = starsWrap ? toNum(starsWrap.getAttribute('data-micro-rating-value')) : undefined;
      const av = card.querySelector('.availability');
      const avSpan = av?.querySelector('.show-tooltip');
      data.availability = text(avSpan) || undefined;
      data.availabilityTooltip = avSpan?.getAttribute('data-original-title') || '';
      const color = (avSpan?.getAttribute('style')||'').match(/color\s*:\s*([^;]+)/i);
      data.availabilityColor = color ? color[1].trim() : '';

      // Prices
      data.standardPrice  = text(card.querySelector('.flags .price-standard span')) || undefined;
      data.priceSave      = text(card.querySelector('.flags .price-save')) || undefined;
      data.finalPrice     = text(card.querySelector('.price.price-final strong')) || undefined;
      data.additionalPrice= html(card.querySelector('.price-additional')) || undefined;

      // Hidden form fields
      data.priceId   = toInt(card.querySelector('input[name="priceId"]')?.value);
      data.productId = toInt(card.querySelector('input[name="productId"]')?.value) || toInt(data.id);
      data.csrf      = card.querySelector('input[name="__csrf__"]')?.value || '';

      // Short descr + warranty
      data.shortDescription = html(card.querySelector('[data-testid="productCardShortDescr"]')) || '';
      const offer = card.querySelector('[data-micro="offer"]');
      data.warranty = offer?.getAttribute('data-micro-warranty') || '';

      out.push(data);
    });
    return out;
  }

  function parseDetailParameters(){
    // Prefer detail-parameters INSIDE extended-description; fallback to global if needed
    const tbl = document.querySelector('.extended-description .detail-parameters') || document.querySelector('.detail-parameters');
    const result = {};
    if (!tbl) return result;

    // Kategorie + URL
    const catRow = Array.from(tbl.querySelectorAll('tr')).find(tr=>/Kategorie/i.test(tr.innerText));
    if (catRow){
      const a = catRow.querySelector('a[href]');
      result.category = text(a) || undefined;
      result.categoryURL = a?.getAttribute('href') || undefined;
    }

    // Záruka
    const warrRow = Array.from(tbl.querySelectorAll('tr')).find(tr=>/Z[aá]ruka/i.test(tr.innerText));
    if (warrRow) result.warranty = text(warrRow.querySelector('td')) || undefined;

    // EAN
    const eanRow = tbl.querySelector('.productEan');
    if (eanRow) result.EAN = text(eanRow.querySelector('.productEan__value')) || undefined;

    // Ostatní parametry -> flat key with ARRAY value (set semantics)
    Array.from(tbl.querySelectorAll('tr')).forEach(tr=>{
      const thTxt = (tr.querySelector('th')?.innerText || '').replaceAll(NBSP,' ').trim();
      const td = tr.querySelector('td');
      if (!thTxt || !td) return;
      if (/Kategorie|Z[aá]ruka|EAN/i.test(thTxt)) return; // already handled
      const key = 'parametr' + safeKey(thTxt);
      const rawVal = (td.innerText || '').replaceAll(NBSP,' '); // keep spacing to detect long separators
      result[key] = splitParamValues(rawVal);
    });

    return result;
  }

  // CART page readers
  function parseCartTable(){
    const rows = $$('.cart-table tbody tr.removeable');
    return rows.map(tr=>{
      const code = tr.getAttribute('data-micro-sku') || undefined;
      const a = tr.querySelector('.p-name a.main-link');
      const img = tr.querySelector('.cart-p-image img');
      const avLabel = tr.querySelector('.p-availability .availability-label.show-tooltip');
      const amountInput = tr.querySelector('input.amount[data-testid="cartAmount"]');
      return {
        code,
        URL: a?.getAttribute('href') || undefined,
        IMG: img?.getAttribute('src') || undefined,
        name: text(a) || undefined,
        availability: text(avLabel) || undefined,
        availabilityTooltip: avLabel?.getAttribute('data-original-title') || '',
        availabilityAmount: text(tr.querySelector('[data-testid="numberAvailabilityAmount"]')) || undefined,
        amount: amountInput ? toInt(amountInput.value) : undefined,
        unitPrice: text(tr.querySelector('[data-testid="cartItemPrice"]')) || undefined,
        totalPrice: text(tr.querySelector('[data-testid="cartPrice"]')) || undefined,
      };
    });
  }

  function parseCartTotals(){
    return {
      deliveryEstimate: text($('.delivery-time [data-testid="deliveryTime"] strong, .delivery-time [data-testid="deliveryTime"], .delivery-time strong')) || undefined,
      priceTotal: text($('[data-testid="recapFullPrice"]')) || undefined,
      priceTotalNoWAT: text($('[data-testid="recapFullPriceNoVat"]')) || undefined,
    };
  }

  // BILLING & SHIPPING page readers
  function parseCheckoutRecapItems(){
    const items = [];
    $$('.cart-items [data-testid="recapCartItem"]').forEach(ci=>{
      const a = ci.querySelector('[data-testid="cartProductName"]');
      items.push({
        URL: a?.getAttribute('href') || undefined,
        name: text(a) || undefined,
        amount: (text(ci.querySelector('[data-testid="recapItemAmount"]')) || '').replace(/\s+/g,' ').trim(),
        price: text(ci.querySelector('[data-testid="recapItemPrice"]')) || undefined,
      });
    });
    return items;
  }

  function parseCheckoutSelectedMethods(){
    const billEl = $('[data-testid="paymentMethods"] ~ .recapitulation-shipping-billing-info, [data-testid="recapDeliveryMethod"]');
    const shipEl = billEl?.parentElement?.querySelectorAll('.recapitulation-shipping-billing-info')[1] ||
                   $$('[data-testid="recapDeliveryMethod"]').slice(-1)[0];
    const billPrice = billEl?.querySelector('[data-testid="recapItemPrice"]');
    const shipPrice = shipEl?.querySelector('[data-testid="recapItemPrice"]');
    return {
      selectedBilling: billEl ? billEl.childNodes[billEl.childNodes.length-1]?.textContent?.trim() : undefined,
      billingPrice: text(billPrice) || undefined,
      selectedShipping: shipEl ? shipEl.childNodes[shipEl.childNodes.length-1]?.textContent?.trim() : undefined,
      shippingPrice: text(shipPrice) || undefined,
    };
  }

  function parseCheckoutTotals(){
    return {
      priceTotal: text($('div.price-wrapper [data-testid="recapFullPrice"]')) || undefined,
      priceTotalNoWAT: text($('div.price-wrapper [data-testid="recapFullPriceNoVat"]')) || undefined,
    };
  }

  function parseContactAndAddresses(){
    const out = {};
    // Contact
    out.name  = $('#billFullName')?.value || '';
    out.email = $('#email')?.value || '';
    out.phone = $('#phone')?.value || '';
    const phSel = $('select.js-phone-code');
    if (phSel){
      const opt = phSel.querySelector('option:checked');
      try { const data = JSON.parse(opt?.value || '{}'); out.phoneCode = data.phoneCode || ''; } catch{ out.phoneCode = ''; }
    }

    // Billing address
    out.billStreet = $('#billStreet')?.value || '';
    out.billCity   = $('#billCity')?.value || '';
    out.billZip    = $('#billZip')?.value || '';
    out.billCountryId = $('#billCountryIdInput')?.value || $('#billCountryId')?.value || '';

    // anotherShipping
    out.anotherShipping = !!$('#another-shipping')?.checked;

    // Delivery address
    out.deliveryFullName = $('#deliveryFullName')?.value || '';
    out.deliveryStreet   = $('#deliveryStreet')?.value || '';
    out.deliveryCity     = $('#deliveryCity')?.value || '';
    out.deliveryZip      = $('#deliveryZip')?.value || '';
    out.deliveryCompany  = $('#deliveryCompany')?.value || '';

    // Extras
    out.noteActive          = !!$('#add-note')?.checked;
    out.doNotSendNewsletter = !!$('#sendNewsletter')?.checked;
    out.setRegistration     = !!('#set-registration' && $('#set-registration')?.checked);
    out.remark              = $('#remark')?.value || '';

    return out;
  }

  function attachProductDOMListeners(){
    const qty = document.querySelector('input.amount[data-testid="cartAmount"]');
    const inc = document.querySelector('button[data-testid="increase"]');
    const dec = document.querySelector('button[data-testid="decrease"]');
    const fire = ()=> emitDOMUpdate({ cartAmount: readCartAmount_Product() });
    if (qty){ qty.addEventListener('input', fire, true); }
    if (inc){ inc.addEventListener('click', ()=> setTimeout(fire,0), true); }
    if (dec){ dec.addEventListener('click', ()=> setTimeout(fire,0), true); }
  }

  function attachCartDOMListeners(){
    $$('.cart-table tbody tr.removeable').forEach(tr=>{
      const qty = tr.querySelector('input.amount[data-testid="cartAmount"]');
      const inc = tr.querySelector('button[data-testid="increase"]');
      const dec = tr.querySelector('button[data-testid="decrease"]');
      const fire = ()=> emitDOMUpdate({ cartItemsDOM: parseCartTable(), ...parseCartTotals() });
      if (qty){ qty.addEventListener('input', fire, true); }
      if (inc){ inc.addEventListener('click', ()=> setTimeout(fire,0), true); }
      if (dec){ dec.addEventListener('click', ()=> setTimeout(fire,0), true); }
    });
  }

  function attachCheckoutDOMListeners(){
    const payWrap = $('#order-billing-methods');
    const shipWrap= $('#order-shipping-methods');
    const fire = ()=> emitDOMUpdate({
      cartItemsCheckout: parseCheckoutRecapItems(),
      ...parseCheckoutSelectedMethods(),
      ...parseCheckoutTotals(),
      ...parseContactAndAddresses(),
    });
    if (payWrap){ payWrap.addEventListener('click', ()=> setTimeout(fire,0), true); }
    if (shipWrap){ shipWrap.addEventListener('click', ()=> setTimeout(fire,0), true); }

    // Contact + addresses
    document.addEventListener('input', e=>{ if(e.target.closest('.co-contact-information, .co-shipping-address, .header-billing, #note')) fire(); }, true);
    document.addEventListener('change', e=>{ if(e.target.closest('.co-contact-information, .co-shipping-address, .header-billing, #note')) fire(); }, true);
  }

  function emitDOMReady(payload){ try{ bus.emit('contextDOMready', payload);}catch(e){} }
  function emitDOMUpdate(payload){ try{ bus.emit('contextDOMupdate', payload);}catch(e){} }

  function readDOM(){
    const t0 = performance.now();
    const page = ctx.pageType || (document.body?.className?.match(/page-(\w+)/)?.[1]);
    const patch = {};

    if (page === 'productDetail'){
      Object.assign(patch, parsePrices_Product());
      Object.assign(patch, parseDeliveryEstimate_Product());
      patch.cartAmount = readCartAmount_Product();
      Object.assign(patch, parseShortDescription_Product());
      patch.relatedProducts    = parseProductList('.products-related');
      patch.alternativeProducts= parseProductList('.products-alternative');
      Object.assign(patch, parseDetailParameters());

      attachProductDOMListeners();
    }

    if (page === 'cart'){
      patch.cartItems = parseCartTable();
      Object.assign(patch, parseCartTotals());
      attachCartDOMListeners();
    }

    if (page === 'billingAndShipping'){
      patch.cartItems = parseCheckoutRecapItems();
      Object.assign(patch, parseCheckoutSelectedMethods());
      Object.assign(patch, parseCheckoutTotals());
      attachCheckoutDOMListeners();
    }

    if (page === 'customerDetails'){
      patch.cartItems = parseCheckoutRecapItems();
      Object.assign(patch, parseCheckoutTotals());
      Object.assign(patch, parseCheckoutSelectedMethods());
      Object.assign(patch, parseContactAndAddresses());
      attachCheckoutDOMListeners();
    }

    Object.assign(ctx, patch);

    const took = performance.now() - t0;
    emitDOMReady({ snapshot: { ...ctx }, tookMs: took });
    return took;
  }

  const domMs = readDOM();

  // ===== Live logger: re-print snapshot on every tracked change =====
  (function installLiveLogger(){
    let raf = null;
    let lastSource = null;
    function scheduleLog(source, meta){
      lastSource = source;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(()=>{
        try {
          console.groupCollapsed(`[CTX] Update • ${lastSource}${meta?.tookMs!=null?` • ${Math.round(meta.tookMs)} ms`:''}`);
          console.log('[snapshot]', { ...ctx });
          console.groupEnd();
        } catch(e){}
        raf = null;
      });
    }
    bus.on('contextDataLayerReady', p => { if (p?.snapshot) Object.assign(ctx, p.snapshot); scheduleLog('DataLayer', { tookMs: p?.tookMs }); });
    bus.on('contextDOMready',      p => { if (p?.snapshot) Object.assign(ctx, p.snapshot); scheduleLog('DOM ready',  { tookMs: p?.tookMs }); });
    bus.on('contextDOMupdate',     () => { scheduleLog('DOM update'); });
  })();

  // ===== Dev: dump & timings =====
  try {
    console.info('[contextFrontend] DataLayer parsed in %d ms', Math.round(dlMs));
    console.info('[contextFrontend] DOM parsed in %d ms', Math.round(domMs));
    console.log('[contextFrontend] snapshot', { ...ctx });
  } catch(e){}
})();
