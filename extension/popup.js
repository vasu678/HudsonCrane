// The URL of your hosted Hudson & Crane web app
// Change this to the production URL when you deploy
const APP_URL = 'http://localhost:5173';

let selectedMode = 'single';

// ── On load ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const urlEl = document.getElementById('currentUrl');
  if (tab?.url) {
    urlEl.textContent = tab.url.length > 60 ? tab.url.substring(0, 57) + '...' : tab.url;
  } else {
    urlEl.textContent = 'Unknown';
  }

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedMode = btn.dataset.mode;
      document.getElementById('btnText').textContent = selectedMode === 'two'
        ? 'Send to Slide Generator (Slot A)'
        : 'Send to Slide Generator';
    });
  });

  document.getElementById('sendBtn').addEventListener('click', handleSend);
});

// ── Shopify Product JSON API (popup context — can fetch any URL) ──────────────
async function tryShopifyAPI(tabUrl) {
  try {
    const u = new URL(tabUrl);
    // Only Shopify stores we know about
    if (!['surya.com', 'safaviehhome.com'].includes(u.hostname.replace(/^www\./, ''))) return null;

    // Shopify product slug is the last path segment (strip query string)
    const slug = u.pathname.replace(/\/$/, '').split('/').pop().split('?')[0];
    if (!slug || slug === 'collections' || slug === 'products') return null;

    const apiUrl = `${u.protocol}//${u.host}/products/${slug}.json`;
    const resp = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) return null;

    const data = await resp.json();
    const product = data.product;
    if (!product?.title) return null;

    // Parse name
    const name = product.title.trim();

    // Parse description (strip HTML)
    const raw = product.body_html || '';
    const description = raw.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();

    // Try to extract dimensions from the body_html
    let dimensions = '';
    const dimMatch = raw.match(/Dimensions?:\s*([^<]{5,60})/i);
    if (dimMatch) {
      dimensions = dimMatch[1].split(/[\n\r]/)[0].trim();
    }

    // Try to extract dimensions from Shopify options (e.g. Size: 19" x 19" x 12")
    if (!dimensions && product.options) {
      const sizeOpt = product.options.find(o => o.name && /size|dimension/i.test(o.name));
      if (sizeOpt && Array.isArray(sizeOpt.values) && sizeOpt.values.length > 0) {
        const val = String(sizeOpt.values[0]).trim();
        if (/\d/.test(val)) dimensions = val;
      }
    }

    // Parse images — sorted by position, full-size URLs with no crop params
    const images = (product.images || [])
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map(img => img.src)
      .filter(src => src && src.startsWith('http'));

    return { name, description, dimensions, images: images.slice(0, 12), source_url: tabUrl };
  } catch (_) {
    return null;
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
async function handleSend() {
  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  document.getElementById('btnText').textContent = 'Extracting data...';
  showStatus('loading', '⏳ Reading product data from the page...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found.');

    // Fast path: for Shopify stores, call their product JSON API directly
    // This gives clean, full-size, uncropped image URLs — no DOM scraping needed
    let data = await tryShopifyAPI(tab.url || '');

    if (!data || !data.name) {
      // Fallback: inject content script into the page to scrape DOM
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractProductData,
      });
      data = results[0]?.result;
    }

    if (!data || !data.name) {
      throw new Error('Could not extract product data. Make sure you are on a product page and scroll down to fully load the page first.');
    }

    const json = JSON.stringify(data);
    const encoded = btoa(encodeURIComponent(json));
    const targetUrl = selectedMode === 'two'
      ? `${APP_URL}/?ext_data=${encodeURIComponent(encoded)}&mode=two`
      : `${APP_URL}/?ext_data=${encodeURIComponent(encoded)}`;

    const existingTabs = await chrome.tabs.query({ url: `${APP_URL}/*` });
    if (existingTabs && existingTabs.length > 0) {
      const tabId = existingTabs[0].id;
      await chrome.tabs.update(tabId, { url: targetUrl, active: true });
      if (existingTabs[0].windowId) {
        await chrome.windows.update(existingTabs[0].windowId, { focused: true }).catch(() => {});
      }
    } else {
      await chrome.tabs.create({ url: targetUrl });
    }

    showStatus('success', `✅ Done! Extracted "${data.name}" with ${data.images.length} image(s).`);
    document.getElementById('btnText').textContent = 'Sent! ✓';
  } catch (err) {
    showStatus('error', `❌ ${err.message}`);
    btn.disabled = false;
    document.getElementById('btnText').textContent = 'Send to Slide Generator';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT SCRIPT — runs inside the vendor page context.
// ALL helper functions MUST be defined inside this function.
// ─────────────────────────────────────────────────────────────────────────────
function extractProductData() {
  const hostname = window.location.hostname.replace(/^www\./, '');

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function commonName() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent || '');
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if ((item['@type'] === 'Product' || String(item['@type']).includes('Product')) && item.name)
            return String(item.name).trim();
        }
      } catch (_) {}
    }
    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content) return og.content.trim();
    const h1 = document.querySelector('h1');
    if (h1?.innerText?.trim()) return h1.innerText.trim();
    return document.title.replace(/\s*[-|].*$/, '').trim();
  }

  function commonDescription() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent || '');
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if ((item['@type'] === 'Product' || String(item['@type']).includes('Product')) && item.description) {
            const text = item.description.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
            if (text.length > 20) return text;
          }
        }
      } catch (_) {}
    }
    const og = document.querySelector('meta[property="og:description"]') || document.querySelector('meta[name="description"]');
    if (og?.content && og.content.length > 20) return og.content.trim();
    return '';
  }

  // Find the value element next to a label element
  function findAdjacentValue(labelEl) {
    function ok(v) {
      v = (v || '').replace(/\s+/g, ' ').trim();
      return (v && /\d/.test(v) && v.length > 1 && v.length < 100) ? v : '';
    }
    // 1. Next sibling element
    let val = ok(labelEl.nextElementSibling?.textContent);
    if (val) return val;
    // 2. Parent's next sibling
    const parent = labelEl.parentElement;
    if (parent) {
      val = ok(parent.nextElementSibling?.textContent);
      if (val) return val;
      // 3. Sibling columns inside same row (table layout)
      const siblings = Array.from(parent.children);
      const idx = siblings.indexOf(labelEl);
      if (idx !== -1 && idx + 1 < siblings.length) {
        val = ok(siblings[idx + 1].textContent);
        if (val) return val;
      }
      // 4. Grandparent's next sibling (dl > dt → dd pattern)
      const gp = parent.parentElement;
      if (gp) {
        val = ok(gp.nextElementSibling?.textContent);
        if (val) return val;
      }
    }
    return '';
  }

  // Is this URL a real product image (not an icon/swatch/etc.)?
  function isProductImg(src) {
    if (!src || !src.startsWith('http')) return false;
    if (/\.svg(\?|$)/i.test(src)) return false;
    if (/\/swatches?\//i.test(src)) return false;
    const s = src.toLowerCase();
    if (s.includes('logo') || s.includes('badge') || s.includes('icon') || 
        s.includes('spinner') || s.includes('loading') || s.includes('accessory') || s.includes('accessories')) {
      return false;
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERIC IMAGE EXTRACTOR (used as fallback for all sites)
  // ═══════════════════════════════════════════════════════════════════════════

  function genericImages() {
    const seen = new Set();
    const seenBaseUrls = new Set();
    const imgs = [];

    function addImg(src, el = null) {
      if (!src) return;
      if (src.startsWith('//')) src = 'https:' + src;
      if (!isProductImg(src)) return;
      
      // If we have the DOM element, ensure it's not a "Related Product" or "Mega Menu"
      if (el) {
        let isRelated = false;
        let p = el.parentElement;
        while (p && p.tagName !== 'BODY') {
          const clsId = ((p.className || '') + ' ' + (p.id || '')).toLowerCase();
          if (clsId.includes('related') || clsId.includes('recommend') || clsId.includes('upsell') || clsId.includes('cross-sell') ||
              clsId.includes('menu') || clsId.includes('nav') || clsId.includes('header') || clsId.includes('mega')) {
            isRelated = true;
            break;
          }
          p = p.parentElement;
        }
        if (isRelated) return;
      }
      
      // Extract just the filename to deduplicate across different CDNs or paths
      const baseFilename = src.split('?')[0].split('/').pop();
      // Remove common responsive size suffixes like -400x400.jpg, _800x.jpg, _large.jpg
      const normalizedBase = baseFilename.replace(/[-_](\d+x\d*|large|medium|small|grande|compact|original)(@\d+x)?(\.[a-zA-Z0-9]+)$/i, '$3');

      if (!seen.has(src) && !seenBaseUrls.has(normalizedBase)) { 
        seen.add(src); 
        seenBaseUrls.add(normalizedBase);
        imgs.push(src); 
      }
    }

    // 1. JSON-LD Product schema images (most reliable, structured data)
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try {
        const data = JSON.parse(script.textContent || '');
        const items = Array.isArray(data) ? data : [data];
        items.forEach(item => {
          if (item['@type'] === 'Product' || (Array.isArray(item['@type']) && item['@type'].includes('Product'))) {
            const raw = item.image;
            const urls = Array.isArray(raw) ? raw : (raw ? [raw] : []);
            urls.forEach(u => { if (typeof u === 'string') addImg(u); });
          }
        });
      } catch (_) {}
    });

    // 2. og:image meta tag
    const og = document.querySelector('meta[property="og:image"]');
    if (og?.content) addImg(og.content);

    // 3. High-res / Lazy-load data attributes (PRIORITY over regular img src)
    document.querySelectorAll('[data-src],[data-lazy-src],[data-original],[data-zoom-image],[data-high-res]').forEach(el => {
      const src = el.getAttribute('data-zoom-image') || el.getAttribute('data-high-res') ||
                  el.getAttribute('data-original') || el.getAttribute('data-src') ||
                  el.getAttribute('data-lazy-src') || '';
      addImg(src, el);
    });

    // 3. <source> srcset / <img> srcset
    document.querySelectorAll('source[srcset], img[srcset]').forEach(el => {
      const srcset = el.getAttribute('srcset') || '';
      srcset.split(',').forEach(part => addImg(part.trim().split(/\s+/)[0], el));
    });

    // 5. All <img> tags filtered by rendered size (< 50px = icon/thumbnail)
    document.querySelectorAll('img').forEach(img => {
      const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
      if (!src) return;
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.width < 50) return;
      if (rect.height > 0 && rect.height < 50) return;
      if (img.naturalWidth > 0 && img.naturalWidth < 50) return;
      addImg(src, img);
    });

    // Post-processing: deduplicate by stripping ALL size suffixes and keeping the
    // highest-resolution version when two URLs refer to the same image.
    function getResScore(url) {
      const path = url.split('?')[0];
      // Extract embedded WxH dimensions like -800x600 or _1200x900
      const m = path.match(/[-_](\d+)x(\d+)(?:\.\w+)?$/i);
      if (m) return parseInt(m[1]) * parseInt(m[2]);
      // No size suffix means it's the original/master → treat as very large
      return 99999999;
    }
    function stripSizeSuffix(url) {
      let u = url.split('?')[0];
      // Remove Four Hands / Cloudfront size directories like /-S1200x1200-FJPG/
      u = u.replace(/\/-S\d+x\d+-[A-Z]+\//gi, '/');
      return u
        .replace(/[-_]\d+x\d*(?:@\d+x)?(\.[a-zA-Z0-9]+)$/i, '$1')
        .replace(/[-_](large|medium|small|grande|compact|original|xlarge|thumbnail)(\.[a-zA-Z0-9]+)$/i, '$2')
        .toLowerCase();
    }

    // Group by stripped filename, keep highest-res URL per group
    const bestByBase = new Map();
    for (const url of imgs) {
      const base = stripSizeSuffix(url).split('/').pop();
      if (!bestByBase.has(base)) {
        bestByBase.set(base, url);
      } else {
        if (getResScore(url) > getResScore(bestByBase.get(base))) {
          bestByBase.set(base, url);
        }
      }
    }
    // Return in the original order of first appearance, using the winning URL for each base
    const seen2 = new Set();
    const result = [];
    for (const url of imgs) {
      const base = stripSizeSuffix(url).split('/').pop();
      if (!seen2.has(base)) {
        seen2.add(base);
        let finalUrl = bestByBase.get(base);
        // Special Four Hands Upscaler: remove the size directory to get the raw 2000px+ image
        if (finalUrl.includes('cloudfront.net') && finalUrl.includes('/image/')) {
          finalUrl = finalUrl.replace(/\/-S\d+x\d+-[a-zA-Z]+\//i, '/');
        }
        result.push(finalUrl); // push the best (possibly higher-res) version
      }
    }
    return result.slice(0, 16);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERIC DIMENSION EXTRACTOR (used as fallback for all sites)
  // ═══════════════════════════════════════════════════════════════════════════

  function genericDimensions() {
    // Check "Overall: ..." prefix — common on Pottery Barn and similar sites
    const fullText = document.body.textContent || '';
    const overallM = fullText.match(/overall\s*[:\-]\s*([^\n\r]{5,70})/i);
    if (overallM) {
      const v = overallM[1].replace(/\s+/g, ' ').trim();
      if (/\d/.test(v) && v.length < 70 && !/shipping|package|carton/.test(v.toLowerCase())) return v;
    }

    const pageText = document.body.innerText || '';
    const patterns = [
      // W NN" x D NN" x H NN"  (letter-first — e.g. Pottery Barn)
      /([wWlL]\s*\d{1,3}(?:\.\d{1,2})?\s*(?:"|'|”|″|in\.?|inches?)?\s*[x×]\s*[dD]\s*\d{1,3}(?:\.\d{1,2})?\s*(?:"|'|”|″|in\.?|inches?)?\s*[x×]\s*[hH]\s*\d{1,3}(?:\.\d{1,2})?\s*(?:"|'|”|″|in\.?|inches?)?)/,
      // NN" W x NN" D x NN" H  (digit-first)
      /(?:(?:king|queen|twin|full|cal(?:ifornia)? king|overall)\s*:?\s*)?(\d{1,3}(?:\.\d{1,2})?\s*(?:"|'|”|″|in\.?|inches?)?\s*[wWlL]\.?\s*[x×]\s*\d{1,3}(?:\.\d{1,2})?\s*(?:"|'|”|″|in\.?|inches?)?\s*[dD]\.?\s*[x×]\s*\d{1,3}(?:\.\d{1,2})?\s*(?:"|'|”|″|in\.?|inches?)?\s*[hH]\.?)/,
      // NN"W x NN"D x NN"H  (compact — no space before axis letter)
      /(\d{1,3}(?:\.\d{1,2})?["'”″][wWlL]\s*[x×]\s*\d{1,3}(?:\.\d{1,2})?["'”″][dD]\s*[x×]\s*\d{1,3}(?:\.\d{1,2})?["'”″][hH])/,
      // NN W x NN H x NN D (in)  — Uttermost style
      /(\d{1,3}(?:\.\d{1,2})?\s+[wWlL]\s*[xX×]\s*\d{1,3}(?:\.\d{1,2})?\s+[hH]\s*[xX×]\s*\d{1,3}(?:\.\d{1,2})?\s+[dD](?:\s*\(in\))?)/,
    ];

    const productMatches = [];
    const otherMatches = [];

    for (const pat of patterns) {
      const g = new RegExp(pat.source, 'gi');
      let m;
      while ((m = g.exec(pageText)) !== null) {
        const clean = m[0].replace(/\s+/g, ' ').trim();
        if (/\blbs?\b|\bkg\b/i.test(clean)) continue;
        if (clean.length > 70) continue;
        const before = pageText.substring(Math.max(0, m.index - 200), m.index).toLowerCase();
        if (/package|shipping|carton|crated|freight/.test(before)) continue;
        if (/overall|product|assembled|item dim|dimension/.test(before)) {
          if (!productMatches.includes(clean)) productMatches.push(clean);
        } else {
          if (!otherMatches.includes(clean)) otherMatches.push(clean);
        }
      }
    }

    const all = [...productMatches, ...otherMatches];
    if (all.length > 0) return all.slice(0, 2).join(' | ');

    // DOM spec table scan fallback
    let w = '', d = '', h = '';
    const otherSpecs = [];

    function findVal(labelEl) {
      function ok(v) {
        v = (v || '').replace(/\s+/g, ' ').trim();
        return (v && /\d/.test(v) && v.length < 30) ? v : '';
      }
      let val = ok(labelEl.nextElementSibling?.textContent);
      if (val) return val;
      const parent = labelEl.parentElement;
      if (parent) {
        val = ok(parent.nextElementSibling?.textContent);
        if (val) return val;
        const siblings = Array.from(parent.children);
        const idx = siblings.indexOf(labelEl);
        if (idx !== -1 && idx + 1 < siblings.length) {
          val = ok(siblings[idx + 1].textContent);
          if (val) return val;
        }
      }
      return '';
    }

    document.querySelectorAll('td, th, div, span, li, p, dt, dd').forEach(el => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (!text || text.length > 80) return;
      const tl = text.toLowerCase();
      if (!/\b(width|depth|height|length|diameter)\b/.test(tl)) return;
      if (/shipping|package|box|carton|weight|capacity|voltage/.test(tl)) return;
      const val = findVal(el);
      if (!val) return;
      const label = text.replace(/\(in\.?\)/i, '').replace(/:\s*$/, '').trim();
      if (/^(product width|width|assembled width)$/i.test(tl)) { if (!w) w = val; }
      else if (/^(product depth|depth|assembled depth)$/i.test(tl)) { if (!d) d = val; }
      else if (/^(product height|height|assembled height)$/i.test(tl)) { if (!h) h = val; }
      else if (/^(product length|length|assembled length)$/i.test(tl)) { if (!d) d = val; else otherSpecs.push({ label, val }); }
      else { otherSpecs.push({ label, val }); }
    });

    let result = '';
    const parts = [];
    if (w) parts.push(`W ${w}`);
    if (d) parts.push(`D ${d}`);
    if (h) parts.push(`H ${h}`);
    if (parts.length > 0) result = parts.join(' x ');

    if (otherSpecs.length > 0) {
      const unique = [];
      otherSpecs.forEach(s => { if (!unique.some(u => u.label.toLowerCase() === s.label.toLowerCase())) unique.push(s); });
      const extra = unique.slice(0, 3).map(s => `${s.label}: ${s.val}`).join(' | ');
      result = result ? result + ' | ' + extra : extra;
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SITE 1: FOUR HANDS  (fourhands.com)
  // Strategy: parse <fh-product-detail v-bind="..."> JSON directly
  // This is embedded in the HTML server-side — 100% reliable, no JS needed
  // ═══════════════════════════════════════════════════════════════════════════

  function extractFourHands() {
    try {
      const tag = document.querySelector('fh-product-detail');
      if (!tag) return null;
      const raw = tag.getAttribute('v-bind') || '';
      if (!raw) return null;

      // Decode HTML entities that BeautifulSoup / browser injects
      const decoded = raw
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

      const obj = JSON.parse(decoded);
      const product = obj.product || {};
      const name = (product.name || '').trim();
      if (!name) return null;

      // Find the active SKU (matching URL/page state), fall back to first
      const activeSku = obj.activeSku || '';
      const skus = product.skus || [];
      const sku = skus.find(s => s.skuNumber === activeSku) || skus[0] || {};

      // dimensionsImperial may have \u0022 (Unicode for ") — replace it
      const dimensions = (sku.dimensionsImperial || '')
        .replace(/\\u0022/g, '"')
        .replace(/\u0022/g, '"')
        .trim();

      const description = (sku.description || product.description || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

      // Only grab type=image media, use largeUrl for best quality
      const images = (sku.media || [])
        .filter(m => m.type === 'image' && m.largeUrl && m.largeUrl.startsWith('http'))
        .map(m => m.largeUrl)
        .slice(0, 12);

      return { name, dimensions, description, images, source_url: window.location.href };
    } catch (_) {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SITE 2: MOE'S HOME  (moeshome.com)
  // Strategy: read rendered DOM spec table for "General Dimensions" label
  // Images from product media gallery containers
  // ═══════════════════════════════════════════════════════════════════════════

  function extractMoesHome() {
    try {
      const name = commonName();
      const description = commonDescription();
      const dimensions = moesDimensions();
      const images = moesImages();
      return { name, dimensions, description, images, source_url: window.location.href };
    } catch (_) {
      return null;
    }
  }

  function moesDimensions() {
    // Strategy 1: Direct regex — MoesHome uses NN.N" W X NN.N" D X NN.N" H
    const pageText = document.body.innerText || '';
    const moesPat = /\d{1,3}(?:\.\d{1,2})?\s*(?:"|in\.?|inches?)?\s*[WwLl]\s+[Xx×]\s+\d{1,3}(?:\.\d{1,2})?\s*(?:"|in\.?|inches?)?\s*[Dd]\s+[Xx×]\s+\d{1,3}(?:\.\d{1,2})?\s*(?:"|in\.?|inches?)?\s*[Hh]/;
    const m = pageText.match(moesPat);
    if (m) return m[0].trim();

    // Strategy 2: Label-based DOM scan (fallback)
    const targetLabels = ['general dimensions', 'overall dimensions', 'dimensions', 'product dimensions'];
    const allEls = Array.from(document.querySelectorAll('*'));
    for (const el of allEls) {
      if (el.children.length > 0) continue; 
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/:$/, '');
      if (targetLabels.includes(t)) {
        const val = findAdjacentValue(el);
        // Ensure it looks like a real dimension, not a concatenated string of weight + box dims
        if (val && /\d/.test(val) && val.length < 50 && !/weight|lbs|kg/i.test(val)) return val;
      }
    }
    return genericDimensions();
  }

  function moesImages() {
    const imgs = [];
    const seenBaseUrls = new Set();
    const allImages = Array.from(document.querySelectorAll('img'));
    
    // Extract SKU from Moe's Home URL (it's always the last segment after the hyphen)
    // e.g. /abi-nesting-coffee-table-beige-cosmos-marble-bz1169340 -> bz1169340
    let urlPath = window.location.pathname.replace(/\/$/, '');
    let urlSku = urlPath.split('-').pop().toLowerCase();
    
    for (const img of allImages) {
      let src = img.getAttribute('data-zoom-image') || img.getAttribute('data-full-size') ||
                img.getAttribute('data-src') || img.currentSrc || img.src || '';
      if (src.startsWith('//')) src = 'https:' + src;
      
      if (src.startsWith('http') && isProductImg(src)) {
        let filename = src.split('?')[0].split('/').pop().toLowerCase();
        let strippedFilename = filename.replace(/[-_]/g, '');
        
        // If the URL SKU is found in the image filename (ignoring dashes), it's a guaranteed match
        if (urlSku && urlSku.length > 4 && strippedFilename.includes(urlSku)) {
          const baseUrl = src.split('?')[0];
          const normalizedBase = baseUrl.replace(/[-_]\d+x\d+(\.[a-zA-Z0-9]+)$/i, '$1');

          if (!seenBaseUrls.has(normalizedBase)) {
            seenBaseUrls.add(normalizedBase);
            imgs.push(src);
          }
        }
      }
    }
    
    if (imgs.length > 0) return imgs.slice(0, 12);
    return genericImages();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SITE 3: UTTERMOST  (uttermost.com)
  // Strategy: read rendered DOM spec table for "Dimensions" label
  // That value comes from the GraphQL `size_desc` custom attribute
  // Images from Venia PWA (Magento) carousel containers
  // ═══════════════════════════════════════════════════════════════════════════

  function extractUttermost() {
    try {
      const name = commonName();
      const description = commonDescription();
      const dimensions = uttermostDimensions();
      const images = uttermostImages();
      return { name, dimensions, description, images, source_url: window.location.href };
    } catch (_) {
      return null;
    }
  }

  function uttermostDimensions() {
    // Strategy 1: Direct regex — Uttermost always uses "NN W X NN H X NN D (in)" format
    // This is the most reliable approach and avoids label/DOM traversal issues entirely
    const pageText = document.body.innerText || '';
    const uttPat = /\d{1,3}(?:\.\d{1,2})?\s+[WwLl]\s+[Xx×]\s+\d{1,3}(?:\.\d{1,2})?\s+[Hh]\s+[Xx×]\s+\d{1,3}(?:\.\d{1,2})?\s+[Dd](?:\s*\(in\))?/;
    const m = pageText.match(uttPat);
    if (m) return m[0].trim();

    // Strategy 2: Label-based DOM scan with stricter value validation
    const dimensionLabels = ['dimensions', 'size', 'size description', 'overall dimensions'];
    const allEls = Array.from(document.querySelectorAll('*'));
    for (const el of allEls) {
      if (el.children.length > 0) continue;
      // Strip trailing colon so "Dimensions:" also matches "dimensions"
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/:$/, '');
      if (dimensionLabels.includes(t)) {
        const val = findAdjacentValue(el);
        if (!val) continue;
        // Reject pure-numeric strings — UPC codes (e.g. "792977045190") are all digits
        // Real dimensions always have letters (W, H, D, in, cm, ", etc.)
        if (/^\d+$/.test(val.trim())) continue;
        if (val.length < 100) return val;
      }
    }
    return genericDimensions();
  }


  function uttermostImages() {
    const rawImgs = [];
    const seen = new Set();

    // Venia / Magento PWA gallery selectors — prefer highest-res available
    const selectors = [
      '[class*="ProductImageCarousel"] img',
      '[class*="productFullDetail"] img',
      '[class*="Carousel-root"] img',
      '[class*="carousel"] img',
      '[class*="Gallery"] img',
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(img => {
        // 1. Try explicit high-res data attributes first
        let src = img.getAttribute('data-zoom-image') || img.getAttribute('data-high-res') ||
                  img.getAttribute('data-original') || img.getAttribute('data-full') ||
                  img.getAttribute('data-src') || '';

        // 2. If no data attr, parse srcset and pick the LARGEST width descriptor
        if (!src) {
          const srcset = img.getAttribute('srcset') || '';
          if (srcset) {
            let bestW = 0, bestUrl = '';
            srcset.split(',').forEach(part => {
              const trimmed = part.trim();
              const [pUrl, wDesc] = trimmed.split(/\s+/);
              const w = parseInt((wDesc || '').replace(/[^\d]/g, '')) || 0;
              if (w > bestW) { bestW = w; bestUrl = pUrl; }
            });
            if (bestUrl) src = bestUrl;
          }
        }

        // 3. Final fallback to whatever the browser rendered
        if (!src) src = img.currentSrc || img.src || '';
        if (src.startsWith('//')) src = 'https:' + src;
        if (src.startsWith('http') && !seen.has(src) && isProductImg(src)) {
          const rect = img.getBoundingClientRect();
          if (rect.width > 0 && rect.width < 40) return;
          seen.add(src);
          rawImgs.push(src);
        }
      });
    }

    const source = rawImgs.length > 0 ? rawImgs : null;
    if (!source) return genericImages();

    // Score by path size suffix OR ?width=/?w= query param — whichever is higher
    function getResScore(url) {
      const path = url.split('?')[0];
      const m = path.match(/[-_](\d+)x(\d+)(?:\.\w+)?$/i);
      if (m) return parseInt(m[1]) * parseInt(m[2]);
      // Check query string for CDN width params (e.g. Uttermost uses ?width=1600)
      try {
        const params = new URL(url).searchParams;
        const w = parseInt(params.get('width') || params.get('w') || params.get('size') || '0');
        if (w > 0) return w * w;
      } catch (_) {}
      return 99999999; // no size info = original/master
    }
    function stripSizeSuffix(url) {
      return url.split('?')[0]
        .replace(/[-_]\d+x\d*(?:@\d+x)?(\.[a-zA-Z0-9]+)$/i, '$1')
        .replace(/[-_](large|medium|small|grande|compact|original|xlarge|thumbnail)(\.[a-zA-Z0-9]+)$/i, '$2')
        .toLowerCase();
    }

    const bestByBase = new Map();
    for (const url of source) {
      const base = stripSizeSuffix(url).split('/').pop();
      if (!bestByBase.has(base) || getResScore(url) > getResScore(bestByBase.get(base))) {
        bestByBase.set(base, url);
      }
    }
    const seen2 = new Set();
    const result = [];
    for (const url of source) {
      const base = stripSizeSuffix(url).split('/').pop();
      if (!seen2.has(base)) {
        seen2.add(base);
        result.push(bestByBase.get(base));
      }
    }
    return result.slice(0, 12);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SITE 4: SURYA  (surya.com)
  // Strategy: Shopify store — JSON-LD Product schema + Shopify global state
  // Images from Shopify product media gallery
  // ═══════════════════════════════════════════════════════════════════════════

  function extractSurya() {
    try {
      // Shopify exposes window.ShopifyAnalytics.meta.product
      const meta = (window.ShopifyAnalytics || {}).meta || {};
      const shopProduct = meta.product;

      let name = '';
      let images = [];

      if (shopProduct) {
        name = (shopProduct.title || '').trim();
      }

      // JSON-LD is always present on Shopify, get name + images from it
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(script.textContent || '');
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            if (item['@type'] === 'Product' && item.name) {
              if (!name) name = String(item.name).trim();
              const raw = item.image;
              const urls = Array.isArray(raw) ? raw : (raw ? [raw] : []);
              urls.forEach(u => {
                if (typeof u === 'string' && u.startsWith('http') && isProductImg(u)) images.push(u);
              });
              break;
            }
          }
        } catch (_) {}
      }

      if (!name) name = commonName();

      // Get images from gallery as backup/supplement
      const galleryImgs = suryaImages();
      // Merge JSON-LD images first, then gallery images
      const merged = [...images, ...galleryImgs];
      const unique = [];
      const bases = new Set();
      for (const url of merged) {
        if (!url) continue;
        const base = url.split('?')[0].split('/').pop();
        if (!bases.has(base)) {
          bases.add(base);
          unique.push(url);
        }
      }
      images = unique;

      let description = '';
      
      // Look for bullet points (Surya's main description format) anywhere on the page
      // that isn't a navigation menu or footer list.
      for (const ul of document.querySelectorAll('ul')) {
        const cName = (ul.className || '').toLowerCase();
        const cId = (ul.id || '').toLowerCase();
        if (ul.textContent.length > 20 && 
            !cName.includes('nav') && !cName.includes('menu') && !cName.includes('tab') &&
            !cId.includes('nav') && !cId.includes('menu') && !cId.includes('footer')) {
            
          const lis = Array.from(ul.querySelectorAll('li'));
          // Only process lists that aren't mostly links
          const links = ul.querySelectorAll('a');
          if (links.length < lis.length / 2) {
            const textBullets = lis.map(li => '- ' + li.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 5);
            if (textBullets.length > 0 && textBullets.length < 15) {
              description = textBullets.join('\n');
              break;
            }
          }
        }
      }
      
      if (!description) {
        description = commonDescription();
      }
      description = (description || '').substring(0, 300);

      const dimensions = suryaDimensions();

      return { name, dimensions, description, images: images.slice(0, 12), source_url: window.location.href };
    } catch (_) {
      return null;
    }
  }

  function suryaDimensions() {
    // Surya (Shopify) often puts dimensions in a tab/accordion section
    // Look for "Overall" or "Dimensions" in spec table
    const targetLabels = ['overall', 'overall dimensions', 'dimensions', 'product dimensions', 'size'];
    const allEls = Array.from(document.querySelectorAll('*'));
    for (const el of allEls) {
      if (el.children.length > 0) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (targetLabels.includes(t)) {
        const val = findAdjacentValue(el);
        if (val && /\d/.test(val) && val.length < 100) return val;
      }
    }
    return genericDimensions();
  }

  function suryaImages() {
    const rawImgs = [];
    const seen = new Set();
    
    // Get product prefix from URL to filter out related products and other variants
    let productPrefix = '';
    try {
      const u = new URL(window.location.href);
      const option = u.searchParams.get('option') || u.pathname.split('/').pop();
      if (option) {
        // Remove non-alphanumeric chars (AGA-057 -> aga057) to match filenames robustly
        productPrefix = option.replace(/[^a-z0-9]/gi, '').toLowerCase();
        // If it has a size suffix like -3248, just take the base model (e.g. ANIS001)
        const baseMatch = option.split('-')[0];
        if (baseMatch.length > 3) productPrefix = baseMatch.replace(/[^a-z0-9]/gi, '').toLowerCase();
      }
    } catch(e) {}

    document.querySelectorAll('img').forEach(img => {
      let src = img.getAttribute('data-src') || img.currentSrc || img.src || '';
      if (!src) return;
      if (src.startsWith('//')) src = 'https:' + src;
      if (src.includes('blank.png')) return; // ignore placeholder

      // Filter out related products and wrong color variants using the prefix
      if (productPrefix) {
        const filename = src.split('?')[0].split('/').pop().toLowerCase();
        const cleanFilename = filename.replace(/[^a-z0-9]/gi, '');
        if (!cleanFilename.includes(productPrefix)) {
          return;
        }
      }

      // Azure CDN conversion for Surya:
      // Turn /Thumbnail/...webp into /Preview/...jpg
      if (src.includes('azurefd.net') || src.includes('/prod/Resources/')) {
        src = src.replace('/Thumbnail/', '/Original/').replace(/\.webp$/i, '.jpg');
      }

      // Fallback for Shopify if they still use it on some pages
      if (src.includes('shopify')) {
        src = src.replace(/_([\d]+x[\d]*)(_crop_\w+)?(\.[a-zA-Z0-9]+)(\?|$)/i, '$3$4');
        try {
          const u = new URL(src);
          u.searchParams.delete('crop');
          u.searchParams.delete('height');
          if (u.searchParams.has('width')) u.searchParams.set('width', '2000');
          src = u.toString();
        } catch (_) {}
      }

      if (src.startsWith('http') && !seen.has(src) && isProductImg(src)) {
        seen.add(src);
        rawImgs.push(src);
      }
    });

    // Deduplicate any images that map to the same file name (like anis001-3248.jpg appearing multiple times)
    const unique = [];
    const bases = new Set();
    for (const url of rawImgs) {
      const base = url.split('?')[0].split('/').pop();
      if (!bases.has(base)) {
        bases.add(base);
        unique.push(url);
      }
    }

    return unique.slice(0, 12);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SITE 5: HVL GROUP  (hvlgroup.com)
  // Strategy: fully JS-rendered custom ASP.NET app
  // No JSON-LD — rely on rendered DOM, CDN images from cdnbf.hvlgroup.com
  // ═══════════════════════════════════════════════════════════════════════════

  function extractHvlGroup() {
    try {
      const name = commonName();
      const description = hvlDescription();
      const dimensions = hvlDimensions();
      const images = hvlImages();
      return { name, dimensions, description, images, source_url: window.location.href };
    } catch (_) {
      return null;
    }
  }

  function hvlDescription() {
    const directEl = document.getElementById('productinfo-family-description');
    if (directEl && directEl.textContent.trim()) {
      return directEl.textContent.replace(/\s+/g, ' ').trim();
    }

    let bestText = '';
    let maxLen = 0;
    
    // HVL Group uses a generic SEO meta tag for all pages, so we must scan the DOM for the real description.
    document.querySelectorAll('p, div, span').forEach(el => {
      // Ignore layout wrappers (which have many children)
      if (el.children.length > 5) return;
      
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const sText = text.toLowerCase();
      // Ignore the generic SEO string and huge wrappers that contain other sections
      if (sText.includes('the official webpage of hudson')) return;
      if (sText.includes('customize color') || sText.includes('specifications') || sText.includes('sku:')) return;
      
      // Ignore site-wide announcement banners, footers, and accessibility widgets
      if (sText.includes('sonneman has joined') || sText.includes('ce-certified') || 
          sText.includes('accessibility') || sText.includes('wcag') || 
          sText.includes('dyslexic font') || sText.includes('reading mask')) return;
          
      // Ignore mega menus
      if (sText.includes('architectural lighting') || sText.includes('csl collections') || 
          sText.includes('textiles & furnishings') || sText.includes('decorative lighting')) return;
          
      if (text.length < 50 || text.length > 2000) return;
      
      if (text.length > maxLen) {
        maxLen = text.length;
        bestText = text;
      }
    });
    
    if (bestText) return bestText.substring(0, 500);
    
    const common = commonDescription();
    if (common && !common.includes('The official webpage of Hudson Valley Lighting')) return common;
    return '';
  }

  function hvlDimensions() {
    // HVL Group spec tables: look for W/H/D/L labels or combined "Overall" row
    const allEls = Array.from(document.querySelectorAll('*'));
    let w = '', h = '', d = '', l = '';

    for (const el of allEls) {
      if (el.children.length > 0) continue;
      const text = (el.textContent || '').trim();
      const tl = text.toLowerCase().replace(/:$/, '');
      if (tl.length > 50) continue;

      if (/^(overall|dimensions?|product size)$/i.test(tl)) {
        const val = findAdjacentValue(el);
        if (val && /\d/.test(val) && val.length < 50) return val;
      } else if (/^width(\/diameter)?$/i.test(tl)) {
        const val = findAdjacentValue(el);
        if (val && /\d/.test(val) && val.length < 15 && !w) w = val;
      } else if (/^height$/i.test(tl)) {
        const val = findAdjacentValue(el);
        if (val && /\d/.test(val) && val.length < 15 && !h) h = val;
      } else if (/^depth$/i.test(tl)) {
        const val = findAdjacentValue(el);
        if (val && /\d/.test(val) && val.length < 15 && !d) d = val;
      } else if (/^length$/i.test(tl)) {
        const val = findAdjacentValue(el);
        if (val && /\d/.test(val) && val.length < 15 && !l) l = val;
      }
    }

    if (w || h || d || l) {
      const parts = [];
      if (w) parts.push(`W ${w}`);
      if (l) parts.push(`L ${l}`);
      if (d) parts.push(`D ${d}`);
      if (h) parts.push(`H ${h}`);
      if (parts.length > 0) return parts.join(' x ');
    }

    return genericDimensions();
  }

  function hvlImages() {
    const imgs = [];
    const seen = new Set();
    
    // HVL serves all product images from cdnbf.hvlgroup.com
    document.querySelectorAll('img').forEach(img => {
      let src = img.currentSrc || img.src || '';
      if (!src.includes('cdnbf.hvlgroup.com')) return;
      if (!isProductImg(src)) return;
      
      // Only accept images physically located inside the main product gallery container
      let isGallery = false;
      let p = img.parentElement;
      while (p && p.tagName !== 'BODY') {
        const clsId = ((p.className || '') + ' ' + (p.id || '')).toLowerCase();
        if (clsId.includes('pdp-image-carousel') || clsId.includes('product-image-carousel')) {
          isGallery = true;
          break;
        }
        p = p.parentElement;
      }
      if (!isGallery) return;

      const rect = img.getBoundingClientRect();
      // Require at least 40px rendered size to avoid tiny UI swatches and hidden images
      if (rect.width < 40 || rect.height < 40) return;
      
      // Get highest resolution version of the image
      src = src.replace(/width=\d+(&height=\d+)?/i, 'width=1920');
      if (!seen.has(src)) { seen.add(src); imgs.push(src); }
    });

    if (imgs.length > 0) return imgs.slice(0, 12);
    return genericImages();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SITE 6: SAFAVIEH  (safavieh.com)
  // Strategy: JSON-LD Product schema + spec table for dimensions
  // ═══════════════════════════════════════════════════════════════════════════

  function extractSafavieh() {
    try {
      let name = '';
      let imgList = [];

      // JSON-LD is present on Safavieh
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(script.textContent || '');
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            if (item['@type'] === 'Product' && item.name) {
              name = String(item.name).trim();
              const raw = item.image;
              const urls = Array.isArray(raw) ? raw : (raw ? [raw] : []);
              
              const seenBase = new Set();
              for (const u of urls) {
                if (typeof u === 'string' && u.startsWith('http') && isProductImg(u)) {
                  const baseFn = u.split('?')[0].split('/').pop();
                  const base = baseFn.replace(/[-_](\d+x\d*|large|medium|small|grande|compact|original)(@\d+x)?(\.[a-zA-Z0-9]+)$/i, '$3');
                  if (!seenBase.has(base)) {
                    seenBase.add(base);
                    imgList.push(u);
                  }
                }
              }
              break;
            }
          }
        } catch (_) {}
        if (name) break;
      }

      if (!name) name = commonName();

      const description = commonDescription();
      const dimensions = safaviehDimensions();

      // If JSON-LD didn't give us enough images, supplement from gallery
      if (imgList.length < 2) {
        const galleryImgs = safaviehImages();
        const combined = [...imgList, ...galleryImgs.filter(u => !imgList.includes(u))];
        imgList = combined;
      }

      return { name, dimensions, description, images: imgList.slice(0, 12), source_url: window.location.href };
    } catch (_) {
      return null;
    }
  }

  function safaviehDimensions() {
    const targetLabels = ['overall dimensions', 'overall', 'dimensions', 'product dimensions', 'size'];
    const allEls = Array.from(document.querySelectorAll('*'));
    for (const el of allEls) {
      if (el.children.length > 0) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (targetLabels.includes(t)) {
        const val = findAdjacentValue(el);
        if (val && /\d/.test(val)) return val;
      }
    }
    return genericDimensions();
  }

  function safaviehImages() {
    const imgs = [];
    const seen = new Set();
    const seenBaseUrls = new Set();
    const selectors = [
      '[class*="product-image"] img',
      '[class*="product-gallery"] img',
      '[class*="ProductGallery"] img',
      '[class*="carousel"] img',
      '[id*="product-image"] img',
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(img => {
        let src = img.getAttribute('data-src') || img.currentSrc || img.src || '';
        if (src.startsWith('//')) src = 'https:' + src;
        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 60) return;
        if (rect.height > 0 && rect.height < 60) return;
        if (src.startsWith('http') && isProductImg(src)) {
          const baseFn = src.split('?')[0].split('/').pop();
          const base = baseFn.replace(/[-_](\d+x\d*|large|medium|small|grande|compact|original)(@\d+x)?(\.[a-zA-Z0-9]+)$/i, '$3');
          if (!seenBaseUrls.has(base) && !seen.has(src)) {
            seenBaseUrls.add(base);
            seen.add(src);
            imgs.push(src);
          }
        }
      });
    }
    return imgs.slice(0, 12);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SITE 7: SAFAVIEH HOME (safaviehhome.com) - Shopify Retail Site
  // Strategy: Strict DOM scraping for images to avoid messy Shopify JSON-LD duplicates
  // ═══════════════════════════════════════════════════════════════════════════

  function extractSafaviehHome() {
    try {
      const name = commonName();
      const description = commonDescription();
      let dimensions = '';
      const m = (document.body.innerText || '').match(/Dimensions?:\s*([^\n\r]{5,60})/i);
      if (m) {
        dimensions = m[1].trim();
      } else {
        dimensions = genericDimensions();
      }
      
      const imgs = [];
      const seenBaseUrls = new Set();
      
      // Only scrape the actual gallery slider/thumbnails to avoid hidden JSON-LD duplicates
      document.querySelectorAll('[class*="gallery"] img, [class*="thumbnail"] img, [class*="carousel"] img, .product-single__photos img').forEach(img => {
        let src = img.getAttribute('data-src') || img.currentSrc || img.src || '';
        if (!src) return;
        if (src.startsWith('//')) src = 'https:' + src;
        
        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 40) return;
        if (rect.height > 0 && rect.height < 40) return;
        
        if (src.startsWith('http') && isProductImg(src)) {
          const baseFn = src.split('?')[0].split('/').pop();
          const base = baseFn.replace(/[-_](\d+x\d*|large|medium|small|grande|compact|original)(@\d+x)?(\.[a-zA-Z0-9]+)$/i, '$3');
          if (!seenBaseUrls.has(base)) {
            seenBaseUrls.add(base);
            imgs.push(src.split('?')[0]); // Use clean URL without query params
          }
        }
      });

      return { name, dimensions, description, images: imgs.slice(0, 12), source_url: window.location.href };
    } catch (_) {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ROUTER — pick the right extractor based on domain
  // ═══════════════════════════════════════════════════════════════════════════

  let result = null;

  if (hostname === 'fourhands.com') {
    result = extractFourHands();
  } else if (hostname === 'moeshome.com') {
    result = extractMoesHome();
  } else if (hostname === 'uttermost.com') {
    result = extractUttermost();
  } else if (hostname === 'surya.com') {
    result = extractSurya();
  } else if (hostname === 'hvlgroup.com') {
    result = extractHvlGroup();
  } else if (hostname === 'safavieh.com') {
    result = extractSafavieh();
  } else if (hostname === 'safaviehhome.com') {
    result = extractSafaviehHome();
  }

  // If site-specific extractor succeeded, return it
  if (result && result.name && result.name.length > 0) return result;

  // Fallback: generic extractor for all other sites (or if specific one failed)
  return {
    name: commonName(),
    description: commonDescription(),
    dimensions: genericDimensions(),
    images: genericImages(),
    source_url: window.location.href,
  };
}

// ── Utility ──────────────────────────────────────────────────────────────────
function showStatus(type, message) {
  const el = document.getElementById('status');
  el.className = `status ${type}`;
  el.textContent = message;
}
