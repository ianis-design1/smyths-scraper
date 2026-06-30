const express = require('express');
let chromium;
try {
  chromium = require('playwright').chromium;
} catch {
  console.error('Playwright not installed');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'change-this-secret-key';

// --- Browser management ---
let browser = null;
let browserLock = null;
let launching = false;

const STEALTH_SCRIPT = `
// Override navigator.webdriver
Object.defineProperty(navigator, 'webdriver', { get: () => false });

// Override navigator.plugins
Object.defineProperty(navigator, 'plugins', {
  get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' })),
});

// Override navigator.languages
Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en-US', 'en'] });

// Override navigator.platform
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

// Override navigator.hardwareConcurrency
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

// Override navigator.deviceMemory
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

// Override chrome.runtime
window.chrome = window.chrome || {};
window.chrome.runtime = window.chrome.runtime || {};

// Add missing chrome properties
['loadTimes', 'csi', 'app'].forEach(prop => {
  if (!window.chrome[prop]) window.chrome[prop] = {};
});

// Override permissions
if (navigator.permissions && navigator.permissions.query) {
  const origQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (desc) => {
    if (desc.name === 'notifications') return Promise.resolve({ state: 'granted', onchange: null });
    if (desc.name === 'clipboard-read') return Promise.resolve({ state: 'granted', onchange: null });
    return origQuery(desc);
  };
}

// Override webdriver remove function
if (window.navigator.webdriver === undefined) {
  delete window.navigator.__proto__.webdriver;
}
`;

async function launchBrowser() {
  if (!chromium) throw new Error('Playwright not available');

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
      '--remote-allow-origins=*',
    ],
    timeout: 30000,
  });
}

async function getBrowser() {
  // Wait for any in-progress lock
  while (browserLock) await browserLock;

  // Already running
  if (browser) {
    try {
      const ok = await browser.isConnected();
      if (ok) return browser;
    } catch {}
    browser = null;
  }

  // Launch (one at a time)
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

// --- Auth ---
function requireAuth(req, res, next) {
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Popup dismissal ---
async function dismissPopups(page) {
  await page.waitForTimeout(2000);
  try {
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button, a[role="button"], [onclick]');
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase().trim();
        if ((t.includes('accept') || t.includes('agree') || t.includes('allow') || t.includes('got it') || t.includes('ok') || t.includes('yes') || t.includes('continue') || t.includes('close') || t.includes('no thanks')) && btn.offsetParent !== null) {
          btn.click(); break;
        }
      }
    });
    await page.waitForTimeout(500);
  } catch {}
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

  // Check for stock elements directly
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
    const body = document.body.innerText;
    const idMatch = body.match(/product\s*(?:id|code|number)[:\s]*(\d{5,})/i);
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
        reducedMotion: 'no-preference',
        colorScheme: 'light',
      });
      page = await context.newPage();
      await page.addInitScript(STEALTH_SCRIPT);
      page.setDefaultTimeout(45000);
      page.setDefaultNavigationTimeout(45000);

      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);

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
          const storeBtnSelectors = [
            page.locator('button', { hasText: 'Select Store' }).first(),
            page.locator('a', { hasText: 'Select Store' }).first(),
            page.locator('[data-testid*="store"] button').first(),
            page.locator('[class*="store-cta"]').first(),
            page.locator('button', { hasText: 'Check stock' }).first(),
            page.locator('button', { hasText: 'Store stock' }).first(),
          ];

          let clicked = false;
          for (const btn of storeBtnSelectors) {
            if (await btn.isVisible().catch(() => false)) {
              await btn.click().catch(() => {});
              clicked = true;
              break;
            }
          }

          if (clicked) {
            await page.waitForTimeout(2000);

            const toggleSelectors = [
              page.locator('button', { hasText: 'Only show stores' }).first(),
              page.locator('label', { hasText: 'Only show stores' }).first(),
              page.locator('input[type="checkbox"][class*="stock"]').first(),
              page.locator('[class*="stock-toggle"]').first(),
              page.locator('button', { hasText: 'Available stores' }).first(),
            ];
            for (const toggle of toggleSelectors) {
              if (await toggle.isVisible().catch(() => false)) {
                await toggle.click().catch(() => {});
                break;
              }
            }
            await page.waitForTimeout(1500);

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

app.post('/api/debug', requireAuth, async (req, res) => {
  const { url } = req.body;
  let context = null;
  let page = null;
  try {
    const b = await getBrowser();
    context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-GB',
    });
    page = await context.newPage();
    await page.addInitScript(STEALTH_SCRIPT);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const title = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 3000) || 'NO BODY').catch(() => 'EVAL ERROR');
    const html = await page.evaluate(() => document.documentElement?.outerHTML?.substring(0, 3000) || 'NO HTML').catch(() => 'EVAL ERROR');
    res.json({ title, bodyText, htmlSnippet: html.substring(0, 2000) });
  } catch (e) {
    res.json({ error: e.message });
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
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
