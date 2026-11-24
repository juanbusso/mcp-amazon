import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import os from 'os';

function getChromiumPath() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  const playwrightCache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (fs.existsSync(playwrightCache)) {
    const entries = fs.readdirSync(playwrightCache);
    for (const entry of entries) {
      const candidateApp = path.join(
        playwrightCache,
        entry,
        'chrome-mac-arm64',
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      );
      if (fs.existsSync(candidateApp)) return candidateApp;
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const CHROMIUM_PATH = getChromiumPath();
const USER_DATA_DIR = path.join(os.homedir(), '.config/mcp-amazon/browser_data');

async function getBrowserContext() {
  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }
  return await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ],
    viewport: { width: 1280, height: 800 },
    locale: 'es-US'
  });
}

async function openPage(context, url) {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  const continueBtn = await page.$('button:has-text("Continue shopping"), a:has-text("Continue shopping"), input[value="Continue shopping"]');
  if (continueBtn) {
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      continueBtn.click()
    ]);
  }
  return page;
}

function parsePrice(text) {
  if (!text) return null;
  const match = text.match(/[\d.,]+/);
  if (!match) return null;
  let clean = match[0].trim();
  if (clean.includes(",") && clean.includes(".")) {
    if (clean.indexOf(",") < clean.indexOf(".")) {
      clean = clean.replace(/,/g, "");
    } else {
      clean = clean.replace(/\./g, "").replace(",", ".");
    }
    return parseFloat(clean);
  }
  if (clean.includes(",")) {
    const parts = clean.split(",");
    if (parts[parts.length - 1].length === 3) {
      return parseFloat(clean.replace(/,/g, ""));
    } else {
      return parseFloat(clean.replace(",", "."));
    }
  }
  if (clean.includes(".")) {
    const parts = clean.split(".");
    if (parts[parts.length - 1].length === 3) {
      return parseFloat(clean.replace(/\./g, ""));
    } else {
      return parseFloat(clean);
    }
  }
  return parseFloat(clean);
}

function extractAsin(input) {
  if (!input) return '';
  const match = input.match(/(?:dp\/|gp\/product\/|asin=|\/)([A-Z0-9]{10})(?:[/?&]|$)/i);
  if (match) return match[1].toUpperCase();
  if (/^[A-Z0-9]{10}$/i.test(input.trim())) return input.trim().toUpperCase();
  return input.trim();
}

async function search(query, options = {}) {
  const context = await getBrowserContext();
  try {
    const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(query)}&language=es_US`;
    const page = await openPage(context, searchUrl);
    await page.waitForTimeout(2000);

    const items = await page.$$eval('[data-component-type="s-search-result"]', (cards) => {
      return cards.map(card => {
        const asin = card.getAttribute('data-asin') || '';
        if (!asin) return null;

        const titleEl = card.querySelector('h2');
        const title = titleEl ? titleEl.innerText.trim() : '';

        const linkEl = card.querySelector('h2 a') || card.querySelector('a.a-link-normal');
        const href = linkEl ? linkEl.getAttribute('href') : '';
        const url = href ? (href.startsWith('http') ? href.split('?')[0] : `https://www.amazon.com${href}`.split('?')[0]) : `https://www.amazon.com/dp/${asin}`;

        const priceEl = card.querySelector('.a-price .a-offscreen');
        const priceRaw = priceEl ? priceEl.innerText.trim() : '';

        const text = card.innerText;
        const isFreeShipping99 = /entrega gratis.*99|free shipping.*99/i.test(text);
        const shipsArgentina = /argentina/i.test(text) && !/no se envía a argentina|no disponible para argentina/i.test(text);

        const deliveryLines = text.split('\n')
          .map(l => l.trim())
          .filter(l => /(?:entrega|envío|argentina|us\$|ars|gratis)/i.test(l) && !l.includes(priceRaw));

        const ratingEl = card.querySelector('.a-icon-alt');
        const rating = ratingEl ? ratingEl.innerText.trim() : null;

        return {
          asin,
          title,
          price_formatted: priceRaw,
          ships_to_argentina: shipsArgentina,
          is_free_shipping_99_eligible: isFreeShipping99,
          delivery_summary: deliveryLines.slice(0, 2).join(' | '),
          rating,
          url
        };
      }).filter(Boolean);
    });

    let filtered = items;
    if (options.shipsOnly !== false) {
      filtered = filtered.filter(i => i.ships_to_argentina);
    }
    if (options.freeShippingOnly) {
      filtered = filtered.filter(i => i.is_free_shipping_99_eligible);
    }
    const limit = options.limit || 10;
    return filtered.slice(0, limit);
  } finally {
    await context.close();
  }
}

async function getProduct(asinOrUrl) {
  const asin = extractAsin(asinOrUrl);
  const context = await getBrowserContext();
  try {
    const productUrl = `https://www.amazon.com/dp/${asin}?language=es_US`;
    const page = await openPage(context, productUrl);
    await page.waitForTimeout(3000);

    const details = await page.evaluate((asin) => {
      const title = document.querySelector('#productTitle')?.innerText?.trim() || '';
      const brand = document.querySelector('#bylineInfo')?.innerText?.trim() || '';
      const buybox = document.querySelector('#desktop_qualifiedBuybox') || document.querySelector('#buybox');
      const lines = buybox ? buybox.innerText.split('\n').map(l => l.trim()).filter(Boolean) : [];

      let priceFormatted = "";
      const whole = document.querySelector(".a-price-whole")?.innerText?.replace(/[,.]/g, "");
      const frac = document.querySelector(".a-price-fraction")?.innerText?.trim();
      const sym = document.querySelector(".a-price-symbol")?.innerText?.trim() || "$";
      if (whole) {
        priceFormatted = `${sym} ${whole}${frac ? "." + frac : ""}`;
      } else {
        const off = document.querySelector(".a-price .a-offscreen") || document.querySelector("#priceblock_ourprice");
        priceFormatted = off ? off.innerText.trim() : (lines[0] || "");
      }

      const shippingLine = lines.find(l => /cargos de envío|envío a argentina|entrega por/i.test(l)) || '';
      const importFeesLine = lines.find(l => /tasas de importación|cargos de envío e importación/i.test(l)) || '';
      const freeShippingLine = lines.find(l => /entrega gratis.*99|free shipping.*99/i.test(l)) || '';
      const deliveryDateLine = lines.find(l => /entrega el|entrega por|llega el/i.test(l)) || '';
      const availabilityLine = lines.find(l => /disponible|in stock|solo queda|sólo queda/i.test(l)) || 'Disponible';

      return {
        asin,
        title,
        brand,
        price_formatted: priceFormatted,
        shipping_line: shippingLine,
        import_fees_line: importFeesLine,
        free_shipping_line: freeShippingLine,
        delivery_date_line: deliveryDateLine,
        availability: availabilityLine,
        buybox_lines: lines.slice(0, 10)
      };
    }, asin);

    const productPrice = parsePrice(details.price_formatted);
    let totalFees = null;
    let shippingStandalone = null;
    let importDuties = null;

    if (details.import_fees_line) {
      const feeMatch = details.import_fees_line.match(/(?:US\$|ARS)\s*([\d,.]+)/i);
      if (feeMatch) totalFees = parsePrice(feeMatch[0]);
    }
    if (details.shipping_line && /entrega por/i.test(details.shipping_line)) {
      const shipMatch = details.shipping_line.match(/(?:US\$|ARS)\s*([\d,.]+)/i);
      if (shipMatch) shippingStandalone = parsePrice(shipMatch[0]);
    }

    if (totalFees !== null && shippingStandalone !== null) {
      importDuties = Math.max(0, totalFees - shippingStandalone);
    } else if (totalFees !== null) {
      importDuties = totalFees;
    }

    const isFreeShippingEligible = Boolean(details.free_shipping_line) || /99/i.test(details.shipping_line);
    const totalStandalone = (productPrice || 0) + (totalFees || 0);
    const totalWithPromo = isFreeShippingEligible && shippingStandalone !== null
      ? (productPrice || 0) + (importDuties || 0)
      : totalStandalone;

    return {
      asin,
      url: productUrl,
      title: details.title,
      brand: details.brand,
      price: {
        formatted: details.price_formatted,
        amount: productPrice
      },
      fees: {
        total_shipping_and_import: totalFees,
        shipping_standalone: shippingStandalone,
        import_duties: importDuties,
        raw_text: details.import_fees_line
      },
      landed_cost: {
        standalone: totalStandalone,
        free_shipping_eligible: isFreeShippingEligible,
        with_free_shipping_promo: totalWithPromo,
        shipping_savings: isFreeShippingEligible && shippingStandalone ? shippingStandalone : 0
      },
      delivery_date: details.delivery_date_line,
      availability: details.availability
    };
  } finally {
    await context.close();
  }
}

// CLI handler
const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'search') {
  const query = args[0] || 'wireless mouse';
  const freeShippingOnly = args.includes('--free-shipping');
  const results = await search(query, { freeShippingOnly });
  console.log(JSON.stringify(results, null, 2));
} else if (cmd === 'product') {
  const asin = args[0];
  const prod = await getProduct(asin);
  console.log(JSON.stringify(prod, null, 2));
} else {
  console.log('Usage: node cli.mjs search <query> [--free-shipping] | product <asin>');
}
