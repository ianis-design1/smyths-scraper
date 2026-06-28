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
      '--disable-blink-features=AutomationControlled',
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-sync',
      '--window-size=1920,1080',
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
      const el = document.querySelector('[class*="price"]') || document.querySelector('[class*="Price"]') || document.querySelector('[data-price]') || document.querySelector('[data-testid*="price"]') || document.querySelector('[itemprop="price"]');
      return el ? (el.getAttribute('content') || el.getAttribute('data-price') || el.textContent.trim()) : '';
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
  for (const p of ['out of stock', 'sold out', 'unavailable', 'temporarily out of stock', 'currently unavailable']) {
    if (bodyText.includes(p)) { stock = 'Out of Stock'; break; }
  }
  if (stock === 'Unknown') {
    for (const p of ['in stock', 'add to basket', 'add to bag', 'buy now', 'add to trolley']) {
      if (bodyText.includes(p)) { stock = 'In Stock'; break; }
    }
  }

  const id = await page.evaluate(() => window.location.pathname.match(/\/p\/(\d+)/)?.[1] || null).catch(() => null);
  const img = await page.evaluate(() => {
    const m = document.querySelector('meta[property="og:image"]');
    return m ? m.getAttribute('content') || '' : '';
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
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-GB',
        ignoreHTTPSErrors: true,
      });
      page = await context.newPage();
      page.setDefaultTimeout(45000);
      page.setDefaultNavigationTimeout(45000);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
      await dismissPopups(page);

      const product = await scrape(page);

      let stores = [];
      if (withStores) {
        const clicked = await page.evaluate(() => {
          const sels = ['button:has-text("Select Store")', 'a:has-text("Select Store")', '[data-testid*="store"] button', '[class*="store-cta"]', 'button:has-text("Check stock")', 'button:has-text("Store stock")'];
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (el) { el.click(); return true; }
          }
          return false;
        });

        if (clicked) {
          await page.waitForTimeout(2000);
          await page.evaluate(() => {
            const toggles = ['button:has-text("Only show stores")', 'label:has-text("Only show stores")', 'input[type="checkbox"][class*="stock"]', '[class*="stock-toggle"]', 'button:has-text("Available stores")'];
            for (const sel of toggles) {
              const el = document.querySelector(sel);
              if (el) { el.click(); return; }
            }
          });
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', browser: !!browser });
});

// Graceful shutdown
process.on('SIGTERM', async () => { await resetBrowser(); process.exit(0); });
process.on('SIGINT', async () => { await resetBrowser(); process.exit(0); });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Playwright service on port ${PORT}`);
});
