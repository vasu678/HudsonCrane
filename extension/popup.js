// The URL of your hosted Hudson & Crane web app
// Change this to the production URL when you deploy
const APP_URL = 'http://localhost:5173';

let selectedMode = 'single'; // 'single' or 'two'

// ── On load: show the current tab URL ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const urlEl = document.getElementById('currentUrl');
  if (tab?.url) {
    urlEl.textContent = tab.url.length > 60
      ? tab.url.substring(0, 57) + '...'
      : tab.url;
  } else {
    urlEl.textContent = 'Unknown';
  }

  // Mode toggle buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedMode = btn.dataset.mode;
      const btnText = document.getElementById('btnText');
      btnText.textContent = selectedMode === 'two'
        ? 'Send to Slide Generator (Slot A)'
        : 'Send to Slide Generator';
    });
  });

  // Main action button
  document.getElementById('sendBtn').addEventListener('click', handleSend);
});

// ── Main handler ───────────────────────────────────────────────────────────
async function handleSend() {
  const btn = document.getElementById('sendBtn');

  btn.disabled = true;
  document.getElementById('btnText').textContent = 'Extracting data...';
  showStatus('loading', '⏳ Reading product data from the page...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found.');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractProductData,
    });

    const data = results[0]?.result;
    if (!data || !data.name) {
      throw new Error('Could not extract product data from this page. Try scrolling to the product section first.');
    }

    const json = JSON.stringify(data);
    const encoded = btoa(encodeURIComponent(json));
    const targetUrl = selectedMode === 'two'
      ? `${APP_URL}/?ext_data=${encodeURIComponent(encoded)}&mode=two`
      : `${APP_URL}/?ext_data=${encodeURIComponent(encoded)}`;

    await chrome.tabs.create({ url: targetUrl });

    showStatus('success', `✅ Done! Extracted "${data.name}" with ${data.images.length} image(s).`);
    document.getElementById('btnText').textContent = 'Sent! ✓';
  } catch (err) {
    showStatus('error', `❌ ${err.message}`);
    btn.disabled = false;
    document.getElementById('btnText').textContent = 'Send to Slide Generator';
  }
}

// ── Content script injected into vendor page ───────────────────────────────
function extractProductData() {

  // ── Images ──────────────────────────────────────────────────────────────
  function getImages() {
    const seen = new Set();
    const imgs = [];

    // Simple URL blacklist — only patterns that are definitively NOT product photos
    const BAD_URL = /\/swatches?\/|swatch-|icon-|\bsprite\b|placeholder|blank\.(gif|png)|pixel\.(gif|png)|tracking-pixel|qr[-_]?code|barcode|augmented[-_]?reality|view-in-room|marxent|cylindo|threekit|allaway|spin-?360|\.svg(\?|$)/i;

    function addImg(src) {
      if (!src) return;
      if (src.startsWith('//')) src = 'https:' + src;
      if (!src.startsWith('http')) return;
      if (BAD_URL.test(src)) return;
      if (!seen.has(src)) { seen.add(src); imgs.push(src); }
    }

    // 1. JSON-LD Product schema images
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

    // 2. og:image
    const og = document.querySelector('meta[property="og:image"]');
    if (og?.content) addImg(og.content);

    // 3. srcset on <source> and <img> elements
    document.querySelectorAll('source[srcset], img[srcset]').forEach(el => {
      const srcset = el.getAttribute('srcset') || '';
      srcset.split(',').forEach(part => {
        const url = part.trim().split(/\s+/)[0];
        if (url) addImg(url);
      });
    });

    // 4. All <img> tags — filter by visual size to skip tiny UI icons
    document.querySelectorAll('img').forEach(img => {
      const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
      if (!src) return;
      // Skip images that are visually tiny (icons < 50px)
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.width < 50) return;
      if (rect.height > 0 && rect.height < 50) return;
      if (img.naturalWidth > 0 && img.naturalWidth < 50) return;
      addImg(src);
    });

    // 5. Lazy-loaded data attributes
    document.querySelectorAll('[data-src],[data-lazy-src],[data-original],[data-zoom-image],[data-high-res]').forEach(el => {
      const src = el.getAttribute('data-zoom-image') || el.getAttribute('data-high-res') ||
                  el.getAttribute('data-original') || el.getAttribute('data-src') ||
                  el.getAttribute('data-lazy-src') || '';
      addImg(src);
    });

    return imgs.slice(0, 16);
  }

  // ── Name ────────────────────────────────────────────────────────────────
  function getName() {
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
    if (h1?.innerText) return h1.innerText.trim();
    return document.title.trim();
  }

  // ── Description ─────────────────────────────────────────────────────────
  function getDescription() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent || '');
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if ((item['@type'] === 'Product' || String(item['@type']).includes('Product')) && item.description) {
            const text = item.description.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
            if (text.length > 20) return text.substring(0, 250);
          }
        }
      } catch (_) {}
    }
    const og = document.querySelector('meta[property="og:description"]') || document.querySelector('meta[name="description"]');
    if (og?.content && og.content.length > 20) return og.content.trim().substring(0, 250);
    const desc = document.querySelector('[itemprop="description"]');
    if (desc?.innerText?.trim()) return desc.innerText.trim().substring(0, 250);
    return '';
  }

  // ── Dimensions ──────────────────────────────────────────────────────────
  function getDimensions() {
    const pageText = document.body.innerText;

    // Patterns for inline dimension strings like "82" W x 90" D x 57" H"
    const patterns = [
      // NN" W x NN" D x NN" H  (or L instead of W)
      /(?:(?:king|queen|twin|full|cal(?:ifornia)? king|overall)\s*:?\s*)?(\d{1,3}(?:\.\d{1,2})?\s*(?:"|in\.?|inches?)?\s*[wWlL]\.?\s*[x×]\s*\d{1,3}(?:\.\d{1,2})?\s*(?:"|in\.?|inches?)?\s*[dD]\.?\s*[x×]\s*\d{1,3}(?:\.\d{1,2})?\s*(?:"|in\.?|inches?)?\s*[hH]\.?)/,
      // NN"W x NN"D x NN"H  (compact no space)
      /(\d{1,3}(?:\.\d{1,2})?"[wWlL]\s*[x×]\s*\d{1,3}(?:\.\d{1,2})?"[dD]\s*[x×]\s*\d{1,3}(?:\.\d{1,2})?"[hH])/,
    ];

    const productMatches = [];
    const otherMatches = [];

    for (const pat of patterns) {
      const g = new RegExp(pat.source, 'gi');
      let m;
      while ((m = g.exec(pageText)) !== null) {
        const clean = m[0].replace(/\s+/g, ' ').trim();
        // Must not contain weight units
        if (/\blbs?\b|\bkg\b/i.test(clean)) continue;
        // Must not be too long (cross-cell concatenation)
        if (clean.length > 60) continue;

        // Check 200 chars before for context
        const before = pageText.substring(Math.max(0, m.index - 200), m.index).toLowerCase();
        // Skip shipping/package dimensions
        if (/package|shipping|carton|crated|freight/.test(before)) continue;

        if (/overall|product|assembled|item dim/.test(before)) {
          if (!productMatches.includes(clean)) productMatches.push(clean);
        } else {
          if (!otherMatches.includes(clean)) otherMatches.push(clean);
        }
      }
    }

    const all = [...productMatches, ...otherMatches];
    if (all.length > 0) return all.slice(0, 2).join(' | ');

    // Fallback: scan spec table / DOM labels
    let w = '', d = '', h = '';
    const otherSpecs = [];

    function findVal(labelEl) {
      function ok(v) {
        v = (v || '').replace(/\s+/g, ' ').trim();
        return (v && /\d/.test(v) && v.length < 30) ? v : '';
      }
      let next = labelEl.nextElementSibling;
      let val = ok(next?.textContent);
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
      else if (/^(product length|length|assembled length)$/i.test(tl)) { if (!d) d = val; else otherSpecs.push({label, val}); }
      else { otherSpecs.push({label, val}); }
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

  return {
    name: getName(),
    description: getDescription(),
    dimensions: getDimensions(),
    images: getImages(),
    source_url: window.location.href,
  };
}

// ── Utility ────────────────────────────────────────────────────────────────
function showStatus(type, message) {
  const el = document.getElementById('status');
  el.className = `status ${type}`;
  el.textContent = message;
}
