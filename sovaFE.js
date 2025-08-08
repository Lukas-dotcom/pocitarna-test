// =======================================================
//  Shoptet – Front‑end Context Collector (pure JS)
//  ---------------------------------------------------
//  • Section 1  → reads the latest Shoptet object that
//                 lives inside `window.dataLayer`.
//  • Section 2  → scrapes the visible DOM according to
//                 `pageType` and keeps it in sync.
//  • Both parts fire hub events:
//         –  `contextDataLayerReady`
//         –  `contextDOMready`
//    with a plain‑object snapshot of the collected data.
//  • For dev/debug the script prints the snapshot and the
//    time spent in each section to the console.
// =======================================================

(function initContextFrontend(){
  // ----------  Small safe pub/sub BUS  ----------
  const BUS = (function(){
    const map = new Map();
    return {
      on(ev, fn){
        const arr = map.get(ev) || [];
        arr.push(fn); map.set(ev, arr);
        return () => { const a = map.get(ev) || []; const i = a.indexOf(fn); if(i>-1){ a.splice(i,1); map.set(ev,a);} };
      },
      emit(ev, payload){ (map.get(ev)||[]).slice().forEach(fn=>{ try{ fn(payload); }catch(e){ console.error('[bus]',e);} }); }
    };
  })();

  // ----------  Helpers  ----------
  const $  = (q, r=document) => r.querySelector(q);
  const $$ = (q, r=document) => Array.from(r.querySelectorAll(q));

  const ctx = Object.create(null);

  const t0 = performance.now();

  // =================================================
  //  SECTION 1 – DATALAYER
  // =================================================
  function readDataLayer(){
    const last = (window.dataLayer||[]).slice().reverse().find(o => o && o.shoptet);
    if(!last){ return; }

    const s = last.shoptet || {};

    // --- simple scalars ---------------------------------
    const pick = [
      'pageType','currency','currencyInfoDecimalSeparator','currencyInfoExchangeRate',
      'currencyInfoPriceDecimalPlaces','currencyInfoSymbol','language','projectId',
      'trafficType'
    ];
    pick.forEach(k => ctx[k] = s[k]);

    // --- cartInfo --------------------------------------
    if(s.cartInfo){
      const c = s.cartInfo;
      Object.assign(ctx, {
        cartInfoId: c.id,
        cartInfoFreeShipping: c.freeShipping,
        cartInfoLeftToFreeGiftFormatted: c.leftToFreeGiftFormatted,
        cartInfoLeftToFreeGift: c.leftToFreeGift,
        cartInfoFreeGift: c.freeGift,
        cartInfoLeftToFreeShipping: c.leftToFreeShipping,
        cartInfoLeftToFreeShippingFormatted: c.leftToFreeShippingformatted,
        cartInfoDiscountCoupon: c.discountCoupon,
        cartInfoNoBillingShippingPriceWithoutVat: c.noBillingShippingPriceWithoutVat,
        cartInfoNoBillingShippingPriceWithVat: c.noBillingShippingPriceWithVat,
        cartInfoNoBillingShippingPriceVat: c.noBillingShippingPriceVat,
        cartInfoTaxMode: c.taxMode
      });
      // cart items array
      ctx.cartItems = (c.items||[]).map(i=>({
        code: i.code,
        guid: i.guid,
        priceId: i.priceId,
        quantity: i.quantity,
        priceWithVat: i.priceWithVat,
        priceWithoutDiscount: i.priceWithoutDiscount,
        itemId: i.itemId,
        name: i.name,
        weight: i.weight
      }));
    }

    // --- customer --------------------------------------
    if(s.customer){
      const cu = s.customer;
      Object.assign(ctx, {
        customerGuid: cu.guid,
        customerEmail: cu.email,
        customerFullName: cu.fullName,
        customerPriceRatio: cu.priceRatio,
        customerPriceListId: cu.priceListId,
        customerGroupId: cu.groupId,
        customerRegistered: cu.registered,
        customerMainAccount: cu.mainAccount
      });
    }

    // --- product detail extras -------------------------
    if(ctx.pageType === 'productDetail' && s.product){
      const p = s.product;
      Object.assign(ctx, {
        productId: p.id,
        productGuid: p.guid,
        productHasVariants: p.hasVariants,
        productCode: p.code,
        productName: p.name,
        productAppendix: p.appendix,
        productWeight: p.weight,
        productManufacturer: p.manufacturer,
        productManufacturerGuid: p.manufacturerGuid,
        productCurrentCategory: p.currentCategory,
        productCurrentCategoryGuid: p.currentCategoryGuid,
        productDefaultCategory: p.defaultCategory,
        productDefaultCategoryGuid: p.defaultCategoryGuid,
        productCurrency: p.currency,
        productPriceWithVat: p.priceWithVat
      });
      ctx.productVariants = (p.variants||[]).map(v=>({
        code:v.code, quantity:v.quantity, stockExt:v.stockExt, stockId:v.stockId
      }));
      ctx.stocks = (p.stocks||[]).map(s=>({id:s.id,title:s.title,isDeliveryPoint:s.isDeliveryPoint,visibleOnEshop:s.visibleOnEshop}));
    }
  }

  readDataLayer();

  const t1 = performance.now();
  BUS.emit('contextDataLayerReady', { snapshot:{...ctx}, duration:t1-t0 });

  // Re‑read DL when Shoptet internals update it
  ['updateCartDataLayer','updateDataLayerCartInfo'].forEach(fnName => {
    const orig = window[fnName];
    if(typeof orig === 'function'){
      window[fnName] = function patched(){
        const r = orig.apply(this, arguments);
        readDataLayer();
        BUS.emit('contextDataLayerReady', { snapshot:{...ctx}, duration:0, via:fnName });
        return r;
      };
    }
  });

  // =================================================
  //  SECTION 2 – DOM SCRAPERS (per pageType)
  // =================================================

  // -------------- utilities ----------------
  const priceNum = txt => {
    if(!txt) return undefined;
    return Number(txt.replace(/\u00a0/g,' ').replace(/[^0-9,.-]/g,'').replace(',','.')) || undefined;
  };
  const txt = (sel,r=document) => $(sel,r)?.textContent.trim();

  function sanitizeParam(name){
    return name.normalize('NFD')
               .replace(/[^\w\s]/g,'')
               .replace(/\s+/g,'')
               .replace(/^\d+/,'');
  }

  // -------------- PAGE PARSERS ----------------
  function parseProductDetail(){
    const start = performance.now();

    // main price block
    ctx.standardPrice   = txt('.p-final-price-wrapper .price-standard span');
    ctx.priceSave       = txt('.p-final-price-wrapper .price-save');
    ctx.finalPrice      = txt('.p-final-price-wrapper .price-final-holder');
    ctx.additionalPrice = txt('.p-final-price-wrapper .price-additional');

    // delivery date
    ctx.deliveryEstimate = txt('.detail-parameters .delivery-time');

    // amount input (with listeners for changes)
    const amtInput = $('input[name="amount"][data-testid="cartAmount"]');
    if(amtInput){
      ctx.cartAmount = Number(amtInput.value);
      ['change','input'].forEach(ev=>amtInput.addEventListener(ev,()=>{
        ctx.cartAmount = Number(amtInput.value);
        BUS.emit('contextDOMupdate',{ key:'cartAmount', value:ctx.cartAmount });
      }));
      // plus/minus buttons
      $$('button[data-testid="increase"],button[data-testid="decrease"]').forEach(b=>
        b.addEventListener('click',()=>setTimeout(()=>{
          ctx.cartAmount = Number(amtInput.value);
          BUS.emit('contextDOMupdate',{ key:'cartAmount', value:ctx.cartAmount });
        },0)));
    }

    ctx.shortDescription = $('.p-short-description')?.innerHTML.trim();

    // --- related + alternative products as tables ---
    const grabProducts = (sel) => $$(sel+' .product').map(p=>{
      const img = p.querySelector('a.image img');
      const flags = $$('span.flag', p).map(f=>f.classList[1]||f.textContent.trim());
      const priceStd = txt('.flags-extra .price-standard span', p) || txt('.price-standard span', p);
      const priceSave = txt('.flags-extra .price-save', p) || txt('.price-save', p);
      const finalPrice = txt('.price-final strong', p) || txt('.price.price-final strong', p);
      const additionalPrice = txt('.price-additional', p);
      const form = p.querySelector('form.pr-action');
      return {
        code: txt('.p-code span[data-micro="sku"]',p),
        id: form?.querySelector('input[name="productId"]')?.value,
        url: p.querySelector('a.image')?.href,
        img: img?.src,
        imgBig: img?.dataset.microImage,
        flags,
        name: txt('[data-testid="productCardName"]', p),
        rating: Number(p.querySelector('.stars-wrapper')?.dataset.microRatingValue)||undefined,
        availability: txt('.availability'),
        availabilityTooltip: p.querySelector('.availability .show-tooltip')?.getAttribute('data-original-title')||'',
        availabilityColor: p.querySelector('.availability span')?.style.color||'',
        standardPrice: priceStd,
        priceSave,
        finalPrice,
        additionalPrice,
        priceId: form?.querySelector('input[name="priceId"]')?.value,
        productId: form?.querySelector('input[name="productId"]')?.value,
        csrf: form?.querySelector('input[name="__csrf__"]')?.value,
        shortDescription: $('.p-desc', p)?.innerHTML.trim(),
        warranty: p.querySelector('[data-micro-warranty]')?.getAttribute('data-micro-warranty')
      };
    });

    ctx.relatedProducts    = grabProducts('.products-related');
    ctx.alternativeProducts = grabProducts('.products-alternative');

    // --- category table params ---------------------------
    const tblRows = $$('.detail-parameters tr');
    tblRows.forEach(tr=>{
      const header = tr.querySelector('th .row-header-label')?.textContent.replace(':','').trim();
      const value  = tr.querySelector('td')?.innerText.trim();
      if(!header||!value) return;

      switch(header){
        case 'Kategorie':
          ctx.category = value; ctx.categoryURL = tr.querySelector('td a')?.href;
          break;
        case 'Záruka':
          ctx.warranty = value; break;
        case 'EAN':
          ctx.EAN = value; break;
        default:
          ctx['parametr'+sanitizeParam(header)] = value;
      }
    });

    const dur = performance.now()-start;
    BUS.emit('contextDOMready', { snapshot:{...ctx}, duration:dur, page:'productDetail' });
    return dur;
  }

  function parseCart(){
    const start = performance.now();

    const cartRows = $$('table.cart-table tr.removeable');
    ctx.cartItems = cartRows.map(tr=>{
      const img = tr.querySelector('.cart-p-image img');
      const nameLink = tr.querySelector('a.main-link');
      const amtInput = tr.querySelector('input[name="amount"]');
      const btns = $$('button.increase,button.decrease', tr);
      if(amtInput){
        ['change','input'].forEach(ev=>amtInput.addEventListener(ev,()=>{
          item.amount = Number(amtInput.value);
          BUS.emit('contextDOMupdate',{key:'cartItems',value:ctx.cartItems});
        }));
        btns.forEach(b=>b.addEventListener('click',()=>setTimeout(()=>{
          item.amount = Number(amtInput.value);
          BUS.emit('contextDOMupdate',{key:'cartItems',value:ctx.cartItems});
        },0)));
      }
      const item={
        code: tr.dataset.microSku,
        url: nameLink?.href,
        img: img?.src,
        name: nameLink?.textContent.trim(),
        availability: txt('.availability-label', tr),
        availabilityTooltip: tr.querySelector('.availability-label')?.getAttribute('data-original-title')||'',
        availabilityAmount: txt('.availability-amount', tr),
        amount: Number(amtInput?.value)||1,
        unitPrice: txt('[data-testid="cartItemPrice"]', tr),
        totalPrice: txt('[data-testid="cartPrice"]', tr)
      };
      return item;
    });

    ctx.deliveryEstimate = txt('.delivery-time');
    ctx.priceTotal = txt('[data-testid="recapFullPrice"]');
    ctx.priceTotalNoWAT = txt('[data-testid="recapFullPriceNoVat"]');

    const dur = performance.now()-start;
    BUS.emit('contextDOMready', { snapshot:{...ctx}, duration:dur, page:'cart' });
    return dur;
  }

  function parseBillingAndShipping(){
    const start = performance.now();

    // items
    ctx.cartItems = $$('.cart-items .cart-item').map(ci=>({
      url: ci.querySelector('a.main-link')?.href,
      name: txt('.cart-item-name', ci),
      amount: txt('.cart-item-amount', ci),
      price: txt('.cart-item-price', ci)
    }));

    ctx.itemsPrice = txt('[data-testid="recapItemTotalPrice"]');

    const bill = $('[data-testid="recapDeliveryMethod"]');
    if(bill){
      ctx.selectedBilling = bill.textContent.replace(/-?\s*[0-9\s]+[Kk][čČ].*/,'').trim();
      ctx.billingPrice = txt('[data-testid="recapDeliveryMethod"] span');
    }

    const ship = bill?.nextElementSibling;
    if(ship){
      ctx.selectedShipping = ship.textContent.replace(/(ZDARMA|[0-9\s]+[Kk][čČ]).*/,'').trim();
      ctx.shippingPrice = txt('[data-testid="recapDeliveryMethod"] + strong span');
    }

    ctx.priceTotal = txt('[data-testid="recapFullPrice"]');
    ctx.priceTotalNoWAT = txt('[data-testid="recapFullPriceNoVat"]');

    // listeners for option changes
    ['order-billing-methods','order-shipping-methods'].forEach(id=>{
      const box = $('#'+id);
      if(box){ box.addEventListener('click',()=>setTimeout(parseBillingAndShipping,0),true); }
    });

    const dur = performance.now()-start;
    BUS.emit('contextDOMready', { snapshot:{...ctx}, duration:dur, page:'billingAndShipping' });
    return dur;
  }

  function parseCustomerDetails(){
    const start = performance.now();
    parseBillingAndShipping(); // items + prices are same structure

    // contact fields + listeners
    const bind = (name, sel, evt='input') => {
      const el = $(sel);
      if(!el) return;
      ctx[name] = el.value;
      el.addEventListener(evt,()=>{ ctx[name] = el.value; BUS.emit('contextDOMupdate',{key:name,value:ctx[name]}); });
    };

    bind('name','#billFullName');
    bind('email','#email');
    bind('phone','#phone');

    const phoneSel = $('select.js-phone-code');
    if(phoneSel){
      ctx.phoneCode = phoneSel.selectedOptions[0]?.textContent.match(/\+\d+/)?.[0];
      phoneSel.addEventListener('change',()=>{ ctx.phoneCode = phoneSel.selectedOptions[0]?.textContent.match(/\+\d+/)?.[0]; BUS.emit('contextDOMupdate',{key:'phoneCode',value:ctx.phoneCode}); });
    }

    ['billStreet','billCity','billZip','billCompany'].forEach(id=>bind(id,'#'+id));
    const billCountryInput = $('#billCountryIdInput');
    ctx.billCountryId = billCountryInput?.value;

    // flags
    const flags = {
      anotherShipping:'#another-shipping',
      noteActive:'#add-note',
      doNotSendNewsletter:'#sendNewsletter',
      setRegistration:'#set-registration'
    };
    Object.entries(flags).forEach(([k,sel])=>{
      const cb = $(sel);
      if(cb){
        ctx[k] = cb.checked;
        cb.addEventListener('change',()=>{ ctx[k]=cb.checked; BUS.emit('contextDOMupdate',{key:k,value:ctx[k]}); });
      }
    });

    // delivery address (if visible)
    ['deliveryFullName','deliveryStreet','deliveryCity','deliveryZip','deliveryCompany'].forEach(id=>bind(id,'#'+id));

    // remark textarea
    const remark = $('#remark');
    if(remark){
      ctx.remark = remark.value;
      remark.addEventListener('input',()=>{ ctx.remark = remark.value; BUS.emit('contextDOMupdate',{key:'remark',value:ctx.remark}); });
    }

    const dur = performance.now()-start;
    BUS.emit('contextDOMready', { snapshot:{...ctx}, duration:dur, page:'customerDetails' });
    return dur;
  }

  // --------------  Kick‑off after DOM ready --------------
  let domDur = 0;
  function runDOM(){
    switch(ctx.pageType){
      case 'productDetail': domDur = parseProductDetail(); break;
      case 'cart': domDur = parseCart(); break;
      case 'billingAndShipping': domDur = parseBillingAndShipping(); break;
      case 'customerDetails': domDur = parseCustomerDetails(); break;
      default: /* nothing */;
    }

    // ---- console debug ----
    console.group('%c[CTX] Snapshot','color:#0A0;font-weight:bold;');
    console.table(ctx);
    console.groupEnd();
    console.info(`⏱️ DataLayer: ${Math.round(t1-t0)} ms   |   DOM: ${Math.round(domDur)} ms`);
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', runDOM, {once:true});
  } else {
    runDOM();
  }
})();
