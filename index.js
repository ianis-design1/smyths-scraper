const express = require('express');
const { chromium } = require('playwright-core');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'change-this-secret-key';

// --- Browser management with mutex ---
let browser = null;
let browserLock = null;
let browserBusy = false;

async function acquireBrowser() {
  // Wait for any in-progress launch
  while (browserLock) {
    await browserLock;
  }

  // If browser exists and is connected, return it
  if (browser) {
    try {
      const connected = await browser.isConnected();
      if (connected && !browserBusy) return browser;
    } catch {
      // Browser disconnected, fall through to relaunch
    }
  }

  // Launch browser (only one at a time)
  let resolveLock;
  browserLock = new Promise(r => resolveLock = r);

  try {
    const chromiumPath = process.env.CHROMIUM_PATH || undefined;

    if (browser) {
      try { await browser.close().catch(() => {}); } catch {}
      browser = null;
    }

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-blink-features=AutomationControlled',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-breakpad',
        '--disable-component-extensions-with-browser-startup',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-sync',
        '--window-size=1920,1080',
        '--start-maximized',
      ],
      executablePath: chromiumPath,
      timeout: 60000,
    });

    return browser;
  } finally {
    browserLock = null;
    resolveLock();
  }
}

function markBusy() { browserBusy = true; }
function markFree() { browserBusy = false; }

async function closeBrowser() {
  if (browser) {
    try { await browser.close().catch(() => {}); } catch {}
    browser = null;
  }
  browserBusy = false;
}

// --- Auth middleware ---
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Popup/consent dismissal ---
const CONSENT_BUTTONS = [
  'button:has-text("Accept All Cookies")',
  'button:has-text("Accept All")',
  'button:has-text("Accept cookies")',
  'button:has-text("I Agree")',
  'button:has-text("Agree")',
  'button:has-text("Got it")',
  'button:has-text("Allow All")',
  'button:has-text("Allow cookies")',
  'button:has-text("OK")',
  'button:has-text("Continue")',
  'button:has-text("Yes")',
  'button:has-text("I am over 18")',
  'button:has-text("Confirm")',
  'button:has-text("No thanks")',
  'button:has-text("Not now")',
  'button:has-text("Skip")',
  'button:has-text("Close")',
  '#cookies-accept',
  '#cookie-accept',
  '[data-testid*="cookie"] button',
  '[class*="cookie"] button',
  '[id*="cookie"] button',
  '[class*="close"] button',
  '[class*="dismiss"] button',
  '[aria-label*="Close"]',
  '[aria-label*="close"]',
  '[class*="accept"] button, button[class*="accept"]',
  '[class*="consent"] button, button[class*="consent"]',
  '.modal button.close, .modal-close, [class*="modal-close"]',
];

async function dismissPopups(page) {
  await page.waitForTimeout(2000);

  for (const selector of CONSENT_BUTTONS) {
    try {
      const btn = await page.$(selector);
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
    } catch {}
  }

  // DOM fallback
  try {
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button, a[role="button"], [onclick]');
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase().trim();
        if ((t.includes('accept') || t.includes('agree') || t.includes('allow') || t.includes('got it') || t.includes('ok') || (t.includes('yes') && !t.includes('cancel')) || t.includes('continue') || t.includes('close') || t.includes('no thanks')) && btn.offsetParent !== null) {
          btn.click(); break;
        }
      }
    });
  } catch {}

  await page.waitForTimeout(500);
}

// --- Shared scraping ---
async function scrapeProduct(page) {
  const name = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    return h1 ? h1.textContent.trim() : '';
  });

  let price = await page.evaluate(() => {
    const el = document.querySelector('[class*="price"]') || document.querySelector('[class*="Price"]') || document.querySelector('[data-price]') || document.querySelector('[data-testid*="price"]') || document.querySelector('[itemprop="price"]') || document.querySelector('meta[property="product:price:amount"]');
    if (!el) return '';
    return el.getAttribute('content') || el.getAttribute('data-price') || el.textContent.trim() || '';
  });
  if (!price) {
    price = await page.evaluate(() => {
      const m = document.body.innerText.match(/[£€]\s*[\d,]+\.?\d*/);
      return m ? m[0] : '';
    });
  }

  const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
  let stockStatus = 'Unknown';
  const outOfStock = ['out of stock', 'sold out', 'unavailable', 'notify me when in stock', 'temporarily out of stock', 'currently unavailable'];
  const inStock = ['in stock', 'add to basket', 'add to bag', 'buy now', 'add to trolley'];
  for (const p of outOfStock) { if (bodyText.includes(p)) { stockStatus = 'Out of Stock'; break; } }
  if (stockStatus === 'Unknown') { for (const p of inStock) { if (bodyText.includes(p)) { stockStatus = 'In Stock'; break; } } }

  const productId = await page.evaluate(() => window.location.pathname.match(/\/p\/(\d+)/)?.[1] || null);
  const imageUrl = await page.evaluate(() => {
    const meta = document.querySelector('meta[property="og:image"]');
    return meta ? meta.getAttribute('content') || '' : '';
  });

  return { name, price, stockStatus, productId, imageUrl };
}

// --- Helper to run a scraping session with auto-retry ---
async function runSession(url, withStoreStock) {
  const maxRetries = 2;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let context = null;
    let page = null;

    try {
      const b = await acquireBrowser();
      markBusy();

      context = await b.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-GB',
        geolocation: { latitude: 53.5, longitude: -2.5 },
        permissions: ['geolocation'],
        ignoreHTTPSErrors: true,
      });

      page = await context.newPage();
      page.setDefaultTimeout(60000);
      page.setDefaultNavigationTimeout(60000);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Wait a bit then dismiss popups
      await page.waitForTimeout(3000);
      await dismissPopups(page);

      // Make sure page actually loaded real content
      const pageUrl = page.url();
      const hasContent = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        return h1 && h1.textContent.trim().length > 2;
      }).catch(() => false);

      if (!hasContent) {
        await page.waitForTimeout(3000);
      }

      const product = await scrapeProduct(page);

      let stores = [];

      if (withStoreStock) {
        const btnClicked = await page.evaluate(() => {
          const sels = ['button:has-text("Select Store")', 'a:has-text("Select Store")', '[data-testid*="store"] button', '[class*="store-cta"]', '[class*="store-select"]', 'button:has-text("Check store stock")', 'a:has-text("Check store stock")', 'button:has-text("Store stock")', 'a:has-text("Store stock")', '[class*="store"] a:has-text("stock")'];
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (el) { el.click(); return true; }
          }
          return false;
        });

        if (btnClicked) {
          await page.waitForTimeout(2500);

          await page.evaluate(() => {
            const toggles = ['button:has-text("Only show stores")', 'label:has-text("Only show stores")', 'input[type="checkbox"][class*="stock"]', '[class*="stock-toggle"]', '[class*="stockFilter"]', 'button:has-text("Available stores")', 'label:has-text("Available")', '[class*="toggle"][class*="stock"]'];
            for (const sel of toggles) {
              const el = document.querySelector(sel);
              if (el) { el.click(); return; }
            }
          });
          await page.waitForTimeout(2000);

          await page.waitForSelector('[class*="store-item"], [class*="storeItem"], [class*="store-result"], [class*="storeResult"], [class*="StoreLine"], [class*="store-card"], [class*="store-entry"]', { timeout: 10000 }).catch(() => {});

          stores = await page.evaluate(() => {
            const items = document.querySelectorAll('[class*="store-item"], [class*="storeItem"], [class*="store-result"], [class*="storeResult"], [class*="StoreLine"], [class*="store-card"], [class*="store-entry"], [class*="store-row"], [class*="store-list"] > div, [class*="StoreList"] > div');
            return Array.from(items).map(el => {
              const nameEl = el.querySelector('[class*="name"]') || el.querySelector('[class*="Name"]') || el.querySelector('[class*="title"]') || el.querySelector('[class*="Title"]') || el.querySelector('[class*="storeName"]') || el.querySelector('h3, h4, strong');
              const stockEl = el.querySelector('[class*="stock"]') || el.querySelector('[class*="Stock"]') || el.querySelector('[class*="availability"]') || el.querySelector('[class*="Availability"]') || el.querySelector('[class*="status"]');
              const name = nameEl ? nameEl.textContent.trim() : '';
              const stock = stockEl ? stockEl.textContent.trim() : '';
              return {
                storeName: name,
                stockText: stock,
                isInStock: stock.length > 0 && !stock.toLowerCase().includes('out of stock') && !stock.toLowerCase().includes('unavailable') && !stock.toLowerCase().includes('no stock'),
              };
            }).filter(s => s.storeName);
          });
        }
      }

      return {
        product: {
          name: product.name.substring(0, 500),
          price: product.price.replace(/[^\d.,£€$]/g, '').trim().substring(0, 50),
          stockStatus: product.stockStatus,
          productId: product.productId,
          imageUrl: product.imageUrl,
        },
        stores,
        storeModalFound: withStoreStock ? stores.length > 0 : undefined,
      };
    } catch (error) {
      lastError = error;

      // Browser crashed — force relaunch on next attempt
      if (browser) {
        try { await browser.close().catch(() => {}); } catch {}
        browser = null;
      }

      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      markFree();
    }
  }

  throw lastError || new Error('Scraping failed after retries');
}

// --- Endpoints ---
app.post('/api/check-product', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url || (!url.includes('smyths') && !url.includes('smythstoys'))) {
    return res.status(400).json({ error: 'Valid Smyths URL required' });
  }
  try {
    const result = await runSession(url, false);
    return res.json({ success: true, product: result.product });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Scraping failed: ' + (error.message || String(error)) });
  }
});

app.post('/api/store-stock', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url || (!url.includes('smyths') && !url.includes('smythstoys'))) {
    return res.status(400).json({ error: 'Valid Smyths URL required' });
  }
  try {
    const result = await runSession(url, true);
    return res.json({ success: true, product: result.product, stores: result.stores, storeModalFound: result.storeModalFound });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Store stock check failed: ' + (error.message || String(error)), storeModalFound: false, stores: [], product: null });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', browserConnected: browser ? true : false });
});

// --- Cleanup ---
process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
process.on('SIGINT', async () => { await closeBrowser(); process.exit(0); });
process.on('uncaughtException', async (e) => { console.error('Uncaught:', e.message); await closeBrowser(); process.exit(1); });

app.listen(PORT, () => {
  console.log(`Smyths Playwright Service running on port ${PORT}`);
});
