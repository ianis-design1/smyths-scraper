const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'change-this-secret-key';

// --- Browser management ---
let browser = null;
let browserLock = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const STEALTH_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => false });
Object.defineProperty(navigator, 'plugins', {
  get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' })),
});
Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en-US', 'en'] });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
window.chrome = window.chrome || {};
window.chrome.runtime = window.chrome.runtime || {};
['loadTimes', 'csi', 'app'].forEach(p => { if (!window.chrome[p]) window.chrome[p] = {}; });
if (navigator.permissions && navigator.permissions.query) {
  const orig = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (d) => {
    if (d.name === 'notifications' || d.name === 'clipboard-read') return Promise.resolve({ state: 'granted', onchange: null });
    return orig(d);
  };
}
`;

async function launchBrowser() {
  return puppeteer.launch({
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
  });
}

async function getBrowser() {
  while (browserLock) await browserLock;
  if (browser) {
    try { if (browser.connected) return browser; } catch {}
    browser = null;
  }
  let resolveLock;
  browserLock = new Promise(r => resolveLock = r);
  try {
    browser = await launchBrowser();
    return browser;
  } finally {
    browserLock = null;
    if (resolveLock) resolveLock();
  }
}

async function resetBrowser() {
  try { if (browser) await browser.close().catch(() => {}); } catch {}
  browser = null;
}

// --- Auth ---
function requireAuth(req, res, next) {
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Popup dismissal ---
async function dismissPopups(page) {
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button, a[role="button"], [onclick]');
    for (const btn of btns) {
      const t = (btn.textContent || '').toLowerCase().trim();
      if ((t.includes('accept') || t.includes('agree') || t.includes('allow') || t.includes('got it') || t.includes('ok') || t.includes('yes') || t.includes('continue') || t.includes('close') || t.includes('no thanks')) && btn.offsetParent !== null) {
        btn.click(); break;
      }
    }
  }).catch(() => {});
}

// --- Scrape ---
async function scrape(page) {
  const name = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    return h1 ? h1.textContent.trim() : '';
  });

  let price = '';
  try {
    price = await page.evaluate(() => {
      const el = document.querySelector('[class*="price"]') || document.querySelector('[class*="Price"]') || document.querySelector('[data-price]') || document.querySelector('[data-testid*="price"]') || document.querySelector('[itemprop="price"]') || document.querySelector('[class*="sales-price"]') || document.querySelector('[class*="offer-price"]') || document.querySelector('[data-product-price]') || document.querySelector('[data-testid*="product-price"]') || document.querySelector('.pdp__price') || document.querySelector('[class*="pdp-price"]');
      if (el) {
        return el.getAttribute('content') || el.getAttribute('data-price') || el.getAttribute('data-value') || el.textContent.trim();
      }
      const meta = document.querySelector('meta[property="product:price:amount"]');
      return meta ? meta.getAttribute('content') || '' : '';
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
      const el = document.querySelector('[class*="stock"]') || document.querySelector('[class*="availability"]') || document.querySelector('[data-testid*="stock"]') || document.querySelector('[class*="product-stock"]');
      return el ? el.textContent.trim().toLowerCase() : '';
    });
    if (stockEl) {
      if (stockEl.includes('out of stock') || stockEl.includes('sold out') || stockEl.includes('unavailable')) {
        stock = 'Out of Stock';
      } else if (stockEl.includes('in stock') || stockEl.includes('available')) {
        stock = 'In Stock';
      }
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
    if (m) return m[1];
    const idMatch = document.body.innerText.match(/product\s*(?:id|code|number)[:\s]*(\d{5,})/i);
    return idMatch ? idMatch[1] : null;
  }).catch(() => null);

  const img = await page.evaluate(() => {
    const og = document.querySelector('meta[property="og:image"]');
    if (og) return og.getAttribute('content') || '';
    const img = document.querySelector('[class*="product-image"] img, [class*="pdp-image"] img, [class*="gallery"] img, [data-testid*="image"] img');
    return img ? img.getAttribute('src') || '' : '';
  }).catch(() => '');

  return { name, price, stock, id, img };
}

// --- Scraping session ---
async function runSession(url, withStores) {
  const maxTries = 2;
  let lastErr;

  for (let i = 0; i <= maxTries; i++) {
    let page = null;
    try {
      const b = await getBrowser();
      page = await b.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1920, height: 1080 });
      await page.evaluateOnNewDocument(STEALTH_SCRIPT);
      page.setDefaultTimeout(45000);

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(3000);

      const pageTitle = await page.title().catch(() => '');
      const pageUrl = page.url();
      if (pageUrl.includes('Incapsula') || pageTitle.includes('Incapsula') || pageTitle.includes('Challenge')) {
        throw new Error('Blocked by Incapsula challenge page');
      }

      await dismissPopups(page);

      const product = await scrape(page);

      let stores = [];
      if (withStores) {
        try {
          async function clickByText(selectors, texts) {
            for (let i = 0; i < selectors.length; i++) {
              const found = await page.evaluate((sel, txt) => {
                const items = document.querySelectorAll(sel);
                for (const item of items) {
                  if (item.textContent.toLowerCase().includes(txt.toLowerCase())) {
                    item.click();
                    return true;
                  }
                }
                return false;
              }, selectors[i], texts[i]).catch(() => false);
              if (found) return true;
            }
            return false;
          }

          let clicked = false;
          const storeButtons = { selectors: ['button', 'a', '[data-testid*="store"] button', '[class*="store-cta"]'], texts: ['Select Store', 'Select Store', 'Select Store', 'Select Store'] };
          if (await clickByText(storeButtons.selectors, storeButtons.texts)) clicked = true;
          if (!clicked) {
            const stockButtons = { selectors: ['button', 'button'], texts: ['Check stock', 'Store stock'] };
            if (await clickByText(stockButtons.selectors, stockButtons.texts)) clicked = true;
          }

          if (clicked) {
            await sleep(2000);
            const toggleConfigs = [
              { sel: 'button', text: 'Only show stores' },
              { sel: 'label', text: 'Only show stores' },
              { sel: 'input[type="checkbox"][class*="stock"]', text: '' },
              { sel: '[class*="stock-toggle"]', text: '' },
              { sel: 'button', text: 'Available stores' },
            ];
            for (const cfg of toggleConfigs) {
              if (cfg.text) {
                if (await clickByText([cfg.sel], [cfg.text])) break;
              } else {
                const el = await page.$(cfg.sel).catch(() => null);
                if (el) { await el.click().catch(() => {}); break; }
              }
            }
            await sleep(1500);

            await page.waitForSelector('[class*="store-item"], [class*="storeItem"], [class*="store-result"], [class*="StoreLine"], [class*="store-card"]', { timeout: 8000 }).catch(() => {});

            stores = await page.evaluate(() => {
              const items = document.querySelectorAll('[class*="store-item"], [class*="storeItem"], [class*="store-result"], [class*="StoreLine"], [class*="store-card"], [class*="store-entry"]');
              return Array.from(items).map(el => {
                const n = el.querySelector('[class*="name"]') || el.querySelector('[class*="Name"]') || el.querySelector('[class*="title"]') || el.querySelector('h3, h4, strong');
                const s = el.querySelector('[class*="stock"]') || el.querySelector('[class*="Stock"]') || el.querySelector('[class*="availability"]');
                const name = n ? n.textContent.trim() : '';
                const stock = s ? s.textContent.trim() : '';
                return { storeName: name, stockText: stock, isInStock: stock.length > 0 && !stock.toLowerCase().includes('out of stock') && !stock.toLowerCase().includes('unavailable') };
              }).filter(x => x.storeName);
            });
          }
        } catch (e) {
          console.error('Store scraping failed (non-fatal):', e.message);
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
      if (i < maxTries) await new Promise(r => setTimeout(r, 2000));
    } finally {
      if (page) await page.close().catch(() => {});
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

// Graceful shutdown
process.on('SIGTERM', async () => { await resetBrowser(); process.exit(0); });
process.on('SIGINT', async () => { await resetBrowser(); process.exit(0); });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Playwright service on port ${PORT}`);
});
