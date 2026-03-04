const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── YOUR OXYLABS CREDENTIALS ───────────────────────────
const OXY_USER = process.env.OXY_USER;
const OXY_PASS = process.env.OXY_PASS;
// ────────────────────────────────────────────────────────

const OXY_URL = 'https://realtime.oxylabs.io/v1/queries';
const OXY_AUTH = { auth: { username: OXY_USER, password: OXY_PASS } };

// ─── DETECT PLATFORM FROM URL ───────────────────────────
function detectPlatform(url) {
  if (url.includes('amazon')) return 'amazon';
  if (url.includes('flipkart')) return 'flipkart';
  if (url.includes('myntra')) return 'myntra';
  if (url.includes('meesho')) return 'meesho';
  if (url.includes('nykaa')) return 'nykaa';
  if (url.includes('croma')) return 'croma';
  if (url.includes('reliancedigital')) return 'reliancedigital';
  if (url.includes('tatacliq')) return 'tatacliq';
  if (url.includes('ajio')) return 'ajio';
  if (url.includes('jiomart')) return 'jiomart';
  return 'unknown';
}

// ─── EXTRACT PRICE FROM RAW HTML ────────────────────────
function extractPrice(html) {
  const patterns = [
    /₹\s*([\d,]+(?:\.\d{2})?)/,
    /Rs\.?\s*([\d,]+(?:\.\d{2})?)/i,
    /"price"\s*:\s*"?([\d.]+)"?/,
    /class="[^"]*price[^"]*"[^>]*>\s*[₹Rs.]*\s*([\d,]+)/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ''));
      if (num > 1) return { display: `₹${num.toLocaleString('en-IN')}`, num };
    }
  }
  return { display: 'Check site', num: 999999 };
}

// ─── EXTRACT TITLE FROM RAW HTML ────────────────────────
function extractTitle(html) {
  const patterns = [
    /<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/i,
    /<h1[^>]*class="[^"]*yhB1nd[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]*class="[^"]*pdp-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]*class="[^"]*product[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
    /<title>([\s\S]*?)<\/title>/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) {
      const clean = m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
      if (clean.length > 5 && clean.length < 300) return clean;
    }
  }
  return '';
}

// ─── BUILD SEARCH QUERY FROM TITLE ──────────────────────
function buildQuery(title) {
  const stop = new Set(['with','for','the','and','new','buy','online','best','price','in','india','free','shipping','offer']);
  return title.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w))
    .slice(0, 7)
    .join(' ');
}

// ─── PRODUCT MATCHING: IS THIS THE SAME ITEM? ───────────
function isSameProduct(original, candidate) {
  if (!original || !candidate) return false;
  const orig = original.toLowerCase();
  const cand = candidate.toLowerCase();

  // Brand check — first word of original title
  const brand = orig.split(/\s+/)[0];
  if (brand.length > 2 && !cand.includes(brand)) return false;

  // Model number check — numbers+letters like "550", "XM5", "15 Pro", "M3"
  const models = orig.match(/\b([a-z]*\d+[a-z]*)\b/gi) || [];
  if (models.length > 0) {
    return models.some(m => cand.includes(m.toLowerCase()));
  }

  // Word overlap check as fallback
  const origWords = new Set(orig.split(/\s+/).filter(w => w.length > 3));
  const overlap = cand.split(/\s+/).filter(w => origWords.has(w)).length;
  return overlap >= 2;
}

// ─── SCRAPE: GET ORIGINAL PRODUCT PAGE ──────────────────
async function scrapeOriginalPage(url, platform) {
  try {
    // Amazon: use native structured parser
    if (platform === 'amazon') {
      const asin = url.match(/\/dp\/([A-Z0-9]{10})/)?.[1]
                || url.match(/\/gp\/product\/([A-Z0-9]{10})/)?.[1];
      if (asin) {
        const res = await axios.post(OXY_URL, {
          source: 'amazon_product',
          domain: 'in',
          asin,
          parse: true,
        }, OXY_AUTH);

        const p = res.data.results[0]?.content;
        if (p?.title) {
          return {
            title: p.title,
            price: p.price_upper
              ? { display: `₹${Number(p.price_upper).toLocaleString('en-IN')}`, num: p.price_upper }
              : { display: 'Check site', num: 999999 },
            success: true,
          };
        }
      }
    }

    // All other platforms: universal scraper
    const res = await axios.post(OXY_URL, {
      source: 'universal',
      url,
      render: 'html',
    }, OXY_AUTH);

    const html = res.data.results[0]?.content || '';
    const title = extractTitle(html);
    const price = extractPrice(html);

    if (!title) return { title: '', price: null, success: false };
    return { title, price, success: true };

  } catch (err) {
    console.error('❌ Scrape original page error:', err.message);
    return { title: '', price: null, success: false };
  }
}

// ─── SEARCH: AMAZON.IN ───────────────────────────────────
async function searchAmazon(query, originalTitle) {
  try {
    const res = await axios.post(OXY_URL, {
      source: 'amazon_search',
      domain: 'in',
      query,
      parse: true,
      pages: 1,
    }, OXY_AUTH);

    const organic = res.data.results[0]?.content?.results?.organic || [];

    return organic
      .filter(r => isSameProduct(originalTitle, r.title))
      .slice(0, 2)
      .map(r => ({
        platform: 'Amazon.in',
        logo: '🛒',
        title: r.title,
        price: r.price
          ? { display: `₹${Number(r.price).toLocaleString('en-IN')}`, num: Number(r.price) }
          : { display: 'Check site', num: 999999 },
        rating: r.rating ? `${r.rating}` : null,
        url: `https://www.amazon.in/dp/${r.asin}`,
      }));
  } catch (err) {
    console.error('❌ Amazon search error:', err.message);
    return [];
  }
}

// ─── SEARCH: FLIPKART ────────────────────────────────────
async function searchFlipkart(query, originalTitle) {
  try {
    const res = await axios.post(OXY_URL, {
      source: 'flipkart_search',
      query,
      parse: true,
    }, OXY_AUTH);

    const items = res.data.results[0]?.content?.results || [];

    return items
      .filter(r => isSameProduct(originalTitle, r.title || r.name))
      .slice(0, 2)
      .map(r => {
        const raw = parseFloat(String(r.price || r.price_from || '0').replace(/[^0-9.]/g, '')) || 999999;
        return {
          platform: 'Flipkart',
          logo: '🏬',
          title: r.title || r.name,
          price: raw < 999999
            ? { display: `₹${raw.toLocaleString('en-IN')}`, num: raw }
            : { display: 'Check site', num: 999999 },
          rating: r.rating ? `${r.rating}` : null,
          url: r.url?.startsWith('http') ? r.url : `https://www.flipkart.com${r.url || ''}`,
        };
      });
  } catch (err) {
    console.error('❌ Flipkart search error:', err.message);
    return [];
  }
}

// ─── SEARCH: UNIVERSAL (Croma, Reliance etc.) ────────────
async function searchUniversal(platformName, logo, searchUrl, originalTitle) {
  try {
    const res = await axios.post(OXY_URL, {
      source: 'universal',
      url: searchUrl,
      render: 'html',
    }, OXY_AUTH);

    const html = res.data.results[0]?.content || '';
    const title = extractTitle(html);
    const price = extractPrice(html);

    if (!title || !isSameProduct(originalTitle, title)) return [];

    return [{
      platform: platformName,
      logo,
      title,
      price,
      rating: null,
      url: searchUrl,
    }];
  } catch (err) {
    console.error(`❌ ${platformName} error:`, err.message);
    return [];
  }
}

// ─── MAIN COMPARE ENDPOINT ───────────────────────────────
app.post('/compare', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Please provide a valid product URL starting with http' });
  }

  console.log(`\n🔍 New comparison request`);
  console.log(`🔗 URL: ${url}`);

  try {
    const platform = detectPlatform(url);
    console.log(`📌 Platform detected: ${platform}`);

    // Step 1: Scrape original page
    const original = await scrapeOriginalPage(url, platform);

    if (!original.success || !original.title) {
      return res.status(422).json({
        error: 'Could not read product details from that link. Please try a direct product page URL.'
      });
    }

    console.log(`📦 Product: ${original.title}`);

    const query = buildQuery(original.title);
    const encoded = encodeURIComponent(query);
    console.log(`🔎 Search query: "${query}"`);

    // Step 2: Search all platforms at the same time
    const [amazon, flipkart, croma, reliance, tatacliq] = await Promise.allSettled([
      searchAmazon(query, original.title),
      searchFlipkart(query, original.title),
      searchUniversal('Croma', '🔌', `https://www.croma.com/searchB?q=${encoded}&inStockFilter=false&start=0&No=0`, original.title),
      searchUniversal('Reliance Digital', '📱', `https://www.reliancedigital.in/search?q=${encoded}:relevance`, original.title),
      searchUniversal('Tata Cliq', '🛍️', `https://www.tatacliq.com/search/?searchCategory=all&text=${encoded}`, original.title),
    ]);

    // Step 3: Merge and deduplicate
    const allResults = [
      ...(amazon.value || []),
      ...(flipkart.value || []),
      ...(croma.value || []),
      ...(reliance.value || []),
      ...(tatacliq.value || []),
    ];

    // One result per platform, sorted cheapest first
    const seen = new Set();
    const unique = allResults
      .filter(r => { if (seen.has(r.platform)) return false; seen.add(r.platform); return true; })
      .sort((a, b) => a.price.num - b.price.num);

    console.log(`✅ Done — ${unique.length} platforms found this product`);

    res.json({
      product: {
        title: original.title,
        originalPrice: original.price?.display || 'N/A',
        originalPlatform: platform,
        searchQuery: query,
      },
      results: unique,
      totalFound: unique.length,
    });

  } catch (err) {
    console.error('❌ Compare route error:', err);
    res.status(500).json({ error: 'Server error. Please try again in a moment.' });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Comparix API is running ✅', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Comparix backend running`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
});