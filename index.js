const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'change-this-secret-key';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Browser management ---
let browser = null;
let browserLock = null;

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--headless=new',
      '--disable-blink-features=AutomationControlled',
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-sync',
      '--window-size=1920,1080',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-session-crashed-bubble',
      '--disable-search-engine-choice-screen',
      '--password-store=basic',
    ],
    timeout: 30000,
  });
}

const STEALTH = `
Object.defineProperty(navigator, 'webdriver', { get: () => false });
Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5].map(() => ({name:'Chrome PDF Plugin',filename:'internal-pdf-viewer'})) });
Object.defineProperty(navigator, 'languages', { get: () => ['en-GB','en-US','en'] });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
window.chrome = window.chrome || {}; window.chrome.runtime = window.chrome.runtime || {};
['loadTimes','csi','app'].forEach(p => { if (!window.chrome[p]) window.chrome[p] = {}; });
`;

async function getBrowser() {
  while (browserLock) await browserLock;
  if (browser) {
    try { if (await browser.isConnected()) return browser; } catch {}
    browser = null;
  }
  let resolveLock;
  browserLock = new Promise(r => resolveLock = r);
  try {
    browser = await launchBrowser();
    return browser;
  } finally {
    browserLock = null;
    resolveLock();
  }
}

async function resetBrowser() {
  try { if (browser) await browser.close().catch(() => {}); } catch {}
  browser = null;
}

function requireAuth(req, res, next) {
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Scrape product data ---
async function scrapeProduct(page) {
  const name = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    return h1 ? h1.textContent.trim() : '';
  });

  let price = '';
  try {
    price = await page.evaluate(() => {
      for (const sel of ['[class*="price"]', '[class*="Price"]', '[data-price]', '[data-testid*="price"]', '[itemprop="price"]', '[class*="sales-price"]', '[data-product-price]', '.pdp__price', 'meta[property="product:price:amount"]']) {
        const el = document.querySelector(sel);
        if (el) return el.getAttribute('content') || el.getAttribute('data-price') || el.getAttribute('data-value') || el.textContent.trim();
      }
      return '';
    });
  } catch {}
  if (!price) {
    try {
      price = await page.evaluate(() => {
        const m = document.body.innerText.match(/[£€]\s*[\d,]+\.?\d*/);
        return m ? m[0] : '';
      });
    } catch {}
  }

  const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
  let stock = 'Unknown';

  try {
    const stockEl = await page.evaluate(() => {
      const el = document.querySelector('[class*="stock"]') || document.querySelector('[class*="availability"]') || document.querySelector('[data-testid*="stock"]');
      return el ? el.textContent.trim().toLowerCase() : '';
    });
    if (stockEl) {
      if (stockEl.includes('out of stock') || stockEl.includes('sold out') || stockEl.includes('unavailable')) stock = 'Out of Stock';
      else if (stockEl.includes('in stock') || stockEl.includes('available')) stock = 'In Stock';
    }
  } catch {}
  if (stock === 'Unknown') {
    for (const p of ['out of stock', 'sold out', 'unavailable', 'temporarily out of stock', 'currently unavailable', 'notify me when in stock']) {
      if (bodyText.includes(p)) { stock = 'Out of Stock'; break; }
    }
  }
  if (stock === 'Unknown') {
    for (const p of ['in stock', 'add to basket', 'add to bag', 'buy now', 'add to trolley', 'add to basket', 'available to buy']) {
      if (bodyText.includes(p)) { stock = 'In Stock'; break; }
    }
  }

  const id = await page.evaluate(() => {
    const m = window.location.pathname.match(/\/p\/(\d+)/);
    return m ? m[1] : null;
  }).catch(() => null);

  const img = await page.evaluate(() => {
    const og = document.querySelector('meta[property="og:image"]');
    if (og) return og.getAttribute('content') || '';
    const img = document.querySelector('[class*="product-image"] img, [class*="pdp-image"] img, [class*="gallery"] img');
    return img ? img.getAttribute('src') || '' : '';
  }).catch(() => '');

  return { name, price, stock, id, img };
}

// --- Click button by text content ---
async function clickByText(page, tag, text) {
  return page.evaluate((t, txt) => {
    const items = document.querySelectorAll(t);
    for (const item of items) {
      if (item.textContent.toLowerCase().includes(txt.toLowerCase()) && item.offsetParent !== null) {
        item.click();
        return true;
      }
    }
    return false;
  }, tag, text);
}

// --- Run a scraping session ---
async function runSession(url, withStores) {
  const maxTries = 1;
  let lastErr;

  for (let i = 0; i <= maxTries; i++) {
    let context = null;
    let page = null;
    try {
      const b = await getBrowser();
      context = await b.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-GB',
        timezoneId: 'Europe/London',
        ignoreHTTPSErrors: true,
      });
      page = await context.newPage();
      await page.addInitScript(STEALTH);
      page.setDefaultTimeout(60000);

      // Navigate via Google referrer
      await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);
      await page.goto(url, { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 60000 });

      // Wait for real content (shorter timeout so Vercel fallback kicks in)
      let hasContent = false;
      for (let w = 0; w < 10; w++) {
        await sleep(1500);
        const has = await page.evaluate(() => {
          const h1 = document.querySelector('h1');
          return h1 && h1.textContent.trim().length > 3;
        }).catch(() => false);
        if (has) { hasContent = true; break; }
      }

      if (!hasContent) {
        throw new Error('Page content did not load');
      }

      const product = await scrapeProduct(page);

      let stores = [];
      if (withStores) {
        try {
          const clicked = await clickByText(page, 'button', 'Select store');
          if (clicked) {
            await sleep(2000);
            await clickByText(page, 'label', 'Only show stores with available stock');
            await sleep(2000);

            await page.waitForSelector('.ios-store-selector', { timeout: 10000 }).catch(() => {});

            stores = await page.evaluate(() => {
              const items = document.querySelectorAll('.ios-store-selector');
              return Array.from(items).map(el => {
                const nameEl = el.querySelector('h3');
                const stockBadge = el.querySelector('p.text-green-400');
                const outBadge = el.querySelector('p.text-red-400');
                const name = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent.trim()) : '';
                let isInStock = false;
                let stockText = '';
                if (stockBadge) { isInStock = true; stockText = stockBadge.textContent.trim(); }
                else if (outBadge) { isInStock = false; stockText = outBadge.textContent.trim(); }
                return { storeName: name, stockText, isInStock };
              }).filter(s => s.storeName);
            });
          }
        } catch (e) {
          console.error('Store scrape non-fatal:', e.message);
        }
      }

      return {
        product: {
          name: product.name.substring(0, 500),
          price: product.price.replace(/[^\d.,£€$]/g, '').trim().substring(0, 50),
          stockStatus: product.stock,
          productId: product.id,
          imageUrl: product.img,
        },
        stores,
      };
    } catch (e) {
      lastErr = e;
      await resetBrowser();
      if (i < maxTries) await sleep(3000);
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    }
  }
  throw lastErr || new Error('Scrape failed');
}

// --- Endpoints ---
app.post('/api/check-product', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url || (!url.includes('smyths') && !url.includes('smythstoys'))) {
    return res.status(400).json({ error: 'Smyths URL required' });
  }
  try {
    const data = await runSession(url, false);
    res.json({ success: true, product: data.product });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || 'Scrape error' });
  }
});

app.post('/api/store-stock', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url || (!url.includes('smyths') && !url.includes('smythstoys'))) {
    return res.status(400).json({ error: 'Smyths URL required' });
  }
  try {
    const data = await runSession(url, true);
    res.json({ success: true, product: data.product, stores: data.stores });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || 'Scrape error', stores: [], product: null });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', browser: !!browser });
});

process.on('SIGTERM', async () => { await resetBrowser(); process.exit(0); });
process.on('SIGINT', async () => { await resetBrowser(); process.exit(0); });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Service on port ${PORT}`);
});
