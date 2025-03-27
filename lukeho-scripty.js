



<!-- [KOŠÍK] -->
<!-- [K-přidání textu změnit zemi můžete v předešlém kroku a změna nadpisu zpět na Fakturační adresa] -->
document.addEventListener("DOMContentLoaded", function() {
  // Ověříme, zda je cesta URL přesně "/objednavka/krok-2/"
  if (window.location.pathname === '/objednavka/krok-2/') {
    // 1. Najdeme klíčové prvky
    var shippingAddressDiv = document.getElementById("shipping-address");
    var anotherShippingCheckbox = document.getElementById("another-shipping");
    var headerBilling = document.querySelector(".header-billing");
    var billCountrySelect = document.getElementById("billCountryId");

    // 2. Obalovací prvek, kam vložíme <label> a <em>
    var infoWrapper = null;

    // 3. Funkce: Vrací true/false, zda je "mobil"
    function isMobile() {
      // Zde si upravte breakpoint, 768 je jen příklad
      return window.innerWidth <= 768;
    }

    // 4. Vytvoření wrapperu, label a em
    function createInfoElements() {
      infoWrapper = document.createElement("div");
      infoWrapper.classList.add("form-group", "additional-info-wrapper");

      if (!isMobile()) {
        var label = document.createElement("label");
        // label.textContent = "Nějaký popisek, pokud chcete";
        infoWrapper.appendChild(label);
      }

      var em = document.createElement("em");
      em.innerHTML = 'Můžete změnit v <a href="/objednavka/krok-1/" style="color: #767676;">předchozím kroku</a>';
	  em.style.color = "#767676";
      infoWrapper.appendChild(em);

      // Vložíme wrapper za select
      if (billCountrySelect) {
        billCountrySelect.parentNode.insertBefore(infoWrapper, billCountrySelect.nextSibling);
      }
    }

    // 5. Odebrání wrapperu
    function removeInfoElements() {
      if (infoWrapper) {
        infoWrapper.remove();
        infoWrapper = null;
      }
    }

    // 6. Změna textu h4
    function setHeaderText(isChecked) {
      if (!headerBilling) return;
      headerBilling.textContent = isChecked
        ? "Fakturační adresa"
        : "Dodací a fakturační adresa";
    }

    // 7. Hlavní logika update
    function updateUI() {
      // Kdy chceme zobrazit <em>? -> KDYŽ: shipping je hidden a checkbox není zaškrtnutý
      if (!shippingAddressDiv || !anotherShippingCheckbox) return;

      var shippingIsHidden = shippingAddressDiv.classList.contains("js-hidden");
      var isChecked = anotherShippingCheckbox.checked;

      // Nastavíme text h4: je-li checkbox zaškrtnut, "Fakturační adresa"
      setHeaderText(isChecked);

      // Pokud NEzaškrtnuto a shipping je hidden => zobrazit <em>
      if (shippingIsHidden && !isChecked) {
        // Přidáme <label> i <em> (na mobilu bez <label>)
        removeInfoElements();
        createInfoElements();
      } else {
        // Jinak <em> nechceme zobrazovat
        removeInfoElements();
      }
    }

    // 8. Event: Změna stavu checkboxu
    if (anotherShippingCheckbox) {
      anotherShippingCheckbox.addEventListener("change", updateUI);
    }

    // 9. Event: Změna velikosti okna (kvůli mobilu)
    window.addEventListener("resize", function() {
      // Pokud wrapper existuje a jsme nově na mobilu, odebereme label
      // Nebo naopak
      if (infoWrapper) {
        var label = infoWrapper.querySelector("label");
        if (isMobile()) {
          if (label) label.remove();
        } else {
          if (!label) {
            var newLabel = document.createElement("label");
            // newLabel.textContent = "Nějaký popisek";
            infoWrapper.insertBefore(newLabel, infoWrapper.firstChild);
          }
        }
      }
    });

    // 10. Init
    updateUI();
  }
});


<!-- [K-přidání upozornění na vyšší DPH v košíku] -->
document.addEventListener('DOMContentLoaded', function() {
    // Zkontrolujte, zda aktuální URL obsahuje '/objednavka/krok-1/'
    if (window.location.pathname.includes('/objednavka/krok-1/')) {
        // Získání prvku výběru země doručení
        var deliveryCountrySelect = document.getElementById('deliveryCountryId');
        
        // Pokud prvek neexistuje, skript se zastaví
        if (!deliveryCountrySelect) {
            return;
        }

        // Text, který se zobrazí v novém panelu
        var panelText = 'Celková cena objednávky byla upravena vzhledem k rozdílné sazbě DPH na Slovensku (23 %). Cena objednávky pro podnikatele plátce DPH bude v režimu reverse charge snížena o DPH v dalším kroku košíku po zadání IČ DPH.';
        
        // ID pro nový panel, aby se předešlo duplicitám
        var panelId = 'additional-info-panel';
        
        // Funkce pro kontrolu a vložení panelu
        function checkAndInsertPanel() {
            var selectedValue = deliveryCountrySelect.value;
            var existingPanel = document.getElementById(panelId);
            
            if (selectedValue === '151') { // 151 je hodnota pro Slovensko
                if (!existingPanel) {
                    // Vytvoření nového panelu
                    var panel = document.createElement('div');
                    panel.id = panelId;
                    panel.className = 'box box-sm box-bg-default co-box co-additional-info';
                    
                    // Přidání textu do panelu
                    var paragraph = document.createElement('p');
                    paragraph.textContent = panelText;
                    panel.appendChild(paragraph);
                    
                    // Najít místo pro vložení panelu (mezi první a druhý formulář)
                    var cartContent = document.querySelector('.cart-content');
                    var forms = cartContent.getElementsByTagName('form');
                    
                    if (forms.length >= 2) {
                        cartContent.insertBefore(panel, forms[1]);
                    } else {
                        // Pokud není očekávaná struktura, přidejte na konec
                        cartContent.appendChild(panel);
                    }
                }
            } else {
                if (existingPanel) {
                    // Odstranit panel, pokud již není podmínka splněna
                    existingPanel.parentNode.removeChild(existingPanel);
                }
            }
        }
        
        // Inicializace při načtení stránky
        checkAndInsertPanel();
        
        // Přidání posluchače na změnu výběru
        deliveryCountrySelect.addEventListener('change', checkAndInsertPanel);
    }
});





<!-- [DETAIL] -->
<!-- [DET-je detail?] -->
document.addEventListener('DOMContentLoaded', function() {
  var isProductDetail = false;

  if (typeof dataLayer !== 'undefined' && dataLayer.length > 0) {
    for (var i = 0; i < dataLayer.length; i++) {
      var item = dataLayer[i];
      if (item && item.shoptet && item.shoptet.pageType === 'productDetail') {
        isProductDetail = true;
        break;
      }
    }
  }

<!-- [DET-Skrytí prázdného dlouhého popisu] -->
  if (isProductDetail) {
    var descriptionParagraph = document.querySelector('.basic-description p');
    if (descriptionParagraph && descriptionParagraph.textContent.trim() === 'Popis produktu není dostupný') {
      descriptionParagraph.closest('.basic-description').style.display = 'none';
    }
  }

<!-- [DET-změna tooltipu dostupnosti u variantních produktů z krátkého popisku] -->
  if (isProductDetail) {
    // Najde element s novým tooltipem
    const upgradeTooltip = document.querySelector('.dtv-tooltip.acronym.fast-tip__text.variant-tooltip');
    // Najde element s původním tooltipem
    const availabilityTooltip = document.querySelector('.show-tooltip.acronym');

    if (upgradeTooltip && availabilityTooltip) {
      // z 'data-original-title' místo 'title'
      const newTooltipText = upgradeTooltip.getAttribute('data-original-title');
      if (newTooltipText) {
        availabilityTooltip.setAttribute('data-original-title', newTooltipText);

        // Aby se nativní “žlutý” tooltip nezobrazoval
        const originalTitle = availabilityTooltip.getAttribute('title') || '';
        availabilityTooltip.removeAttribute('title');

        availabilityTooltip.addEventListener('mouseenter', function() {
            availabilityTooltip.setAttribute('title', '');
        });
        availabilityTooltip.addEventListener('mouseleave', function() {
            availabilityTooltip.setAttribute('title', originalTitle);
        });
      }
    }
  }
});



<!-- [KATEGORIE] -->
<!-- [KAT+VYHL změna tooltipu dostupnosti u variantních produktů z krátkého popisku] -->
// Funkce pro úpravu tooltipů v kategoriích
function applyCategoryTooltips() {
    const productCards = document.querySelectorAll('#products .product');
    productCards.forEach(card => {
        const upgradeTooltip = card.querySelector('.dtv-tooltip.acronym.fast-tip__text.variant-tooltip');
        const availabilityTooltip = card.querySelector('.show-tooltip');

        if (upgradeTooltip && availabilityTooltip) {
            const newTooltipText = upgradeTooltip.getAttribute('data-original-title');
            if (newTooltipText) {
                availabilityTooltip.setAttribute('data-original-title', newTooltipText);
                availabilityTooltip.removeAttribute('title'); // zabrání nativnímu tooltipu

                if (availabilityTooltip.textContent.trim() === "Skladem") {
                    availabilityTooltip.textContent = "Skladem*";
                }
            }
        }
    });
}

// Funkce pro úpravu (přidání) tooltipu ve výsledcích vyhledávání
function applySearchTooltips() {
    const searchResults = document.querySelectorAll('.fv-cart-wrapper');
    searchResults.forEach(wrapper => {
        const availability = wrapper.querySelector('.availability');
        if (availability) {
            // Předpokládáme, že text "Skladem" je ve vnořeném <span> (podle struktury, kterou jsi poskytl)
            const textSpan = availability.querySelector('span span');
            if (textSpan && textSpan.textContent.trim() === "Skladem") {
                textSpan.textContent = "Skladem*";
                textSpan.setAttribute('data-original-title', "Skladem*");
                textSpan.removeAttribute('title'); // odstraní nativní title
            }
        }
    });
}

// Spustíme úpravu kategorií ihned, jakmile je DOM načteno a po každém AJAX načtení
document.addEventListener("DOMContentLoaded", applyCategoryTooltips);
document.addEventListener('ShoptetDOMPageContentLoaded', applyCategoryTooltips);

// Pro vyhledávání počkáme na načtení všech skriptů a poté s krátkým zpožděním
window.addEventListener("load", function() {
    setTimeout(applySearchTooltips, 2000);
});

function applyVyprodejHighlights() {
  // 1. Zobrazit .flag-vyprodej
  document.querySelectorAll(".flag.flag-vyprodej").forEach(el => {
    el.style.display = "flex";
  });

  // 2. Zobrazit .flag-custom1, pokud obsahuje "výprodej"
  document.querySelectorAll(".flag.flag-custom1").forEach(el => {
    if (el.textContent.trim().toLowerCase().includes("výprodej")) {
      el.style.display = "flex";
    }
  });

  // 3. Zvýraznit všechny karty .product, které obsahují výprodejový štítek
  document.querySelectorAll(".product").forEach(card => {
    const vyprodejFlag = card.querySelector(".flag.flag-vyprodej, .flag.flag-custom1");
    if (vyprodejFlag && vyprodejFlag.textContent.trim().toLowerCase().includes("výprodej")) {
      console.log("🎯 Výprodej nalezen v kartě:", card);
      card.style.background = "rgba(255, 255, 0, 0.25)";
    }
  });
}

<!-- [KAT zvýraznění výprodejových] -->
document.addEventListener("DOMContentLoaded", function () {
  const body = document.body;

  if (body.classList.contains("admin-logged")) {

    applyVyprodejHighlights(); // ← nahrazuje původní vnořený kód

    // MutationObserver pro nové produkty a filtrování
    const container = document.querySelector("#products") || document.body;

    const observer = new MutationObserver((mutationsList) => {
      for (const mutation of mutationsList) {
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          applyVyprodejHighlights();
          break;
        }
      }
    });

    observer.observe(container, { childList: true, subtree: true });

  } else {
  }
});