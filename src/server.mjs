import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Path resolver for Chromium on macOS
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
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(systemChrome)) return systemChrome;
  return null;
}

const CHROMIUM_PATH = getChromiumPath();
const USER_DATA_DIR = path.join(os.homedir(), '.config/mcp-amazon/browser_data');

let browserContext = null;

async function getBrowserContext() {
  if (browserContext) {
    try {
      if (browserContext.pages()) return browserContext;
    } catch {
      browserContext = null;
    }
  }
  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
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

  return browserContext;
}

// Ensure clean page and dismiss any Amazon interstitial
async function openPage(context, url) {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });

  // Handle "Click the button below to continue shopping" challenge if present
  const continueBtn = await page.$('button:has-text("Continue shopping"), a:has-text("Continue shopping"), input[value="Continue shopping"]');
  if (continueBtn) {
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      continueBtn.click()
    ]);
  }

  return page;
}

// Clean price strings to numbers
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

const server = new Server(
  {
    name: 'mcp-amazon',
    version: '1.0.0'
  },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'amazon_search',
        description: 'Search Amazon for products with delivery filters to Argentina, showing prices, Free Shipping eligibility on orders >= $99 USD, and delivery details.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search terms (e.g. "wireless mouse", "usb-c charger 65w", "funda notebook 15 pulgadas")'
            },
            free_shipping_99_only: {
              type: 'boolean',
              description: 'Filter only products eligible for Free Shipping to Argentina on orders of $99+ USD'
            },
            ships_to_argentina_only: {
              type: 'boolean',
              description: 'Filter only products that ship to Argentina (default: true)'
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results to return (default: 10, max: 20)'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'amazon_get_product',
        description: 'Get full product details from Amazon including exact item price, shipping fees, customs import taxes (depósito de tasas de importación), landed door-to-door cost to Argentina, and Free Shipping ($99+) applicability.',
        inputSchema: {
          type: 'object',
          properties: {
            asin_or_url: {
              type: 'string',
              description: 'Amazon ASIN (10 characters, e.g. B0XXXXXXXX) or product URL'
            }
          },
          required: ['asin_or_url']
        }
      },
      {
        name: 'amazon_landed_cost_calculator',
        description: 'Simulate an Amazon Argentina shopping cart with multiple products to test if total >= $99 USD for Free Shipping, calculate waived shipping fees, total import duties, and complete door-to-door landed cost.',
        inputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  asin_or_url: { type: 'string', description: 'Product ASIN or URL' },
                  quantity: { type: 'number', description: 'Quantity (default: 1)' }
                },
                required: ['asin_or_url']
              },
              description: 'List of products to combine in the cart'
            }
          },
          required: ['items']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const context = await getBrowserContext();

    if (name === 'amazon_search') {
      const query = args.query;
      const shipsOnly = args.ships_to_argentina_only !== false;
      const freeShippingOnly = Boolean(args.free_shipping_99_only);
      const limit = Math.min(Math.max(args.max_results || 10, 1), 20);

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

          const imageEl = card.querySelector('img.s-image');
          const imageUrl = imageEl ? imageEl.getAttribute('src') : null;

          return {
            asin,
            title,
            price_formatted: priceRaw,
            ships_to_argentina: shipsArgentina,
            is_free_shipping_99_eligible: isFreeShipping99,
            delivery_summary: deliveryLines.slice(0, 2).join(' | '),
            rating,
            url,
            image_url: imageUrl
          };
        }).filter(Boolean);
      });

      let filtered = items;
      if (shipsOnly) {
        filtered = filtered.filter(i => i.ships_to_argentina);
      }
      if (freeShippingOnly) {
        filtered = filtered.filter(i => i.is_free_shipping_99_eligible);
      }

      const results = filtered.slice(0, limit);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query,
              total_found: filtered.length,
              free_shipping_eligible_count: filtered.filter(i => i.is_free_shipping_99_eligible).length,
              results
            }, null, 2)
          }
        ]
      };
    }

    if (name === 'amazon_get_product') {
      const asin = extractAsin(args.asin_or_url);
      const productUrl = `https://www.amazon.com/dp/${asin}?language=es_US`;
      const page = await openPage(context, productUrl);
      await page.waitForTimeout(3000);

      const details = await page.evaluate((asin) => {
        const title = document.querySelector('#productTitle')?.innerText?.trim() || '';
        const brand = document.querySelector('#bylineInfo')?.innerText?.trim() || '';

        const buybox = document.querySelector('#desktop_qualifiedBuybox') || document.querySelector('#buybox');
        const buyboxText = buybox ? buybox.innerText : '';

        const lines = buyboxText.split('\n').map(l => l.trim()).filter(Boolean);

        // Price detection
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

        // Shipping & Import fees
        const shippingLine = lines.find(l => /cargos de envío|envío a argentina|entrega por/i.test(l)) || '';
        const importFeesLine = lines.find(l => /tasas de importación|cargos de envío e importación/i.test(l)) || '';
        const freeShippingLine = lines.find(l => /entrega gratis.*99|free shipping.*99/i.test(l)) || '';

        // Delivery date
        const deliveryDateLine = lines.find(l => /entrega el|entrega por|llega el/i.test(l)) || '';

        // Stock
        const availabilityLine = lines.find(l => /disponible|in stock|solo queda|sólo queda/i.test(l)) || 'Disponible';

        // Seller & Shipper
        const merchantLine = lines.find(l => /vendido por|ships from|vendedor/i.test(l)) || '';

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
          merchant_info: merchantLine,
          buybox_excerpt: lines.slice(0, 15)
        };
      }, asin);

      // Parse amounts
      const productPrice = parsePrice(details.price_formatted);

      // Parse shipping and import line
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
      const totalWithFreeShippingPromo = isFreeShippingEligible && shippingStandalone !== null
        ? (productPrice || 0) + (importDuties || 0)
        : totalStandalone;

      const responseData = {
        asin,
        url: productUrl,
        title: details.title,
        brand: details.brand,
        price: {
          formatted: details.price_formatted,
          amount: productPrice
        },
        fees: {
          total_shipping_and_import_fees: totalFees,
          shipping_standalone_fee: shippingStandalone,
          import_duties_deposit: importDuties,
          summary_text: details.import_fees_line
        },
        landed_cost: {
          standalone_total: totalStandalone,
          free_shipping_eligible: isFreeShippingEligible,
          total_if_free_shipping_applied: totalWithFreeShippingPromo,
          potential_savings: isFreeShippingEligible && shippingStandalone ? shippingStandalone : 0
        },
        delivery: {
          date_info: details.delivery_date_line,
          availability: details.availability
        }
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(responseData, null, 2)
          }
        ]
      };
    }

    if (name === 'amazon_landed_cost_calculator') {
      const itemsInput = args.items || [];
      const itemResults = [];

      let totalProductAmount = 0;
      let totalShippingFee = 0;
      let totalImportDuties = 0;
      let allEligibleForFreeShipping = true;

      for (const item of itemsInput) {
        const asin = extractAsin(item.asin_or_url);
        const qty = item.quantity || 1;

        const productUrl = `https://www.amazon.com/dp/${asin}?language=es_US`;
        const page = await openPage(context, productUrl);
        await page.waitForTimeout(2500);

        const details = await page.evaluate((asin) => {
          const title = document.querySelector('#productTitle')?.innerText?.trim() || '';
          const buybox = document.querySelector('#desktop_qualifiedBuybox') || document.querySelector('#buybox');
          const lines = buybox ? buybox.innerText.split('\n').map(l => l.trim()).filter(Boolean) : [];

          const priceEl = document.querySelector('#corePriceDisplay_desktop_feature_div .a-offscreen') ||
                          document.querySelector('#corePrice_desktop .a-offscreen') ||
                          document.querySelector('.a-price .a-offscreen');
          const priceFormatted = priceEl ? priceEl.innerText.trim() : (lines[0] || '');

          const shippingLine = lines.find(l => /cargos de envío|envío a argentina|entrega por/i.test(l)) || '';
          const importFeesLine = lines.find(l => /tasas de importación|cargos de envío e importación/i.test(l)) || '';
          const freeShippingLine = lines.find(l => /entrega gratis.*99|free shipping.*99/i.test(l)) || '';

          return { asin, title, priceFormatted, shippingLine, importFeesLine, freeShippingLine };
        }, asin);

        const unitPrice = parsePrice(details.priceFormatted) || 0;
        let unitFees = null;
        let unitShipping = null;

        if (details.importFeesLine) {
          const m = details.importFeesLine.match(/(?:US\$|ARS)\s*([\d,.]+)/i);
          if (m) unitFees = parsePrice(m[0]);
        }
        if (details.shippingLine && /entrega por/i.test(details.shippingLine)) {
          const m = details.shippingLine.match(/(?:US\$|ARS)\s*([\d,.]+)/i);
          if (m) unitShipping = parsePrice(m[0]);
        }

        const isEligible = Boolean(details.freeShippingLine) || /99/i.test(details.shippingLine);
        if (!isEligible) allEligibleForFreeShipping = false;

        const unitDuties = (unitFees !== null && unitShipping !== null) ? Math.max(0, unitFees - unitShipping) : (unitFees || 0);

        totalProductAmount += (unitPrice * qty);
        totalShippingFee += ((unitShipping || 0) * qty);
        totalImportDuties += (unitDuties * qty);

        itemResults.push({
          asin,
          title: details.title,
          quantity: qty,
          unit_price: unitPrice,
          unit_price_formatted: details.priceFormatted,
          shipping_fee_estimate: unitShipping,
          import_duties_estimate: unitDuties,
          is_free_shipping_eligible: isEligible
        });
      }

      // Threshold check for $99 USD promo (approx 149.143 ARS or 99 USD)
      const qualifiesThreshold = totalProductAmount >= 99; // If in USD or ARS >= 149000
      const qualifiesFreeShipping = (qualifiesThreshold || totalProductAmount >= 145000) && allEligibleForFreeShipping;

      const totalLandedCostStandalone = totalProductAmount + totalShippingFee + totalImportDuties;
      const totalLandedCostWithPromo = qualifiesFreeShipping
        ? totalProductAmount + totalImportDuties
        : totalLandedCostStandalone;

      const response = {
        cart_items: itemResults,
        subtotal_products: totalProductAmount,
        estimated_standalone_shipping: totalShippingFee,
        estimated_import_duties: totalImportDuties,
        free_shipping_promo_qualified: qualifiesFreeShipping,
        shipping_savings: qualifiesFreeShipping ? totalShippingFee : 0,
        total_door_to_door_landed_cost: totalLandedCostWithPromo
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2)
          }
        ]
      };
    }

    throw new Error(`Tool ${name} not found.`);
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: err.message, stack: err.stack }, null, 2)
        }
      ],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
