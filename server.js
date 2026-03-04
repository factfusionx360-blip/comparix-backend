require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const OXY_USER = process.env.OXY_USER;
const OXY_PASS = process.env.OXY_PASS;
const OXY_URL  = 'https://realtime.oxylabs.io/v1/queries';
const OXY_AUTH = { auth: { username: OXY_USER, password: OXY_PASS } };

function detectPlatform(url) {
  if (url.includes('amazon'))          return 'amazon';
  if (url.includes('flipkart'))        return 'flipkart';
  if (url.includes('myntra'))          return 'myntra';
  if (url.includes('meesho'))          return 'meesho';
  if (url.includes('nykaa'))           return 'nykaa';
  if (url.includes('croma'))           return 'croma';
  if (url.includes('reliancedigital')) return 'reliancedigital';
  if (url.includes('tatacliq'))        return 'tatacliq';
  if (url.includes('ajio'))            return 'ajio';
  if (url.includes('jiomart'))         return 'jiomart';
  return 'unknown';
}

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
      if (num > 100) return { display: `₹${num.toLocaleString('en-IN')}`, num };
    }
  }
  return { display: 'Check site', num: 999999 };
}

function extractTitle(html) {
  const patterns = [
    /<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/i,
    /<h1[^>]*class="[^"]*yhB1nd[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]*class="[^"]*pdp-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]*class="[^"]*product[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /<title>([\s\S]*?)<\/title>/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) {
      const clean = m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean.length > 5 && clean.length < 300) return clean;
    }
  }
  return '';
}

function extractFingerprint(title) {
  const t = title.toLowerCase();
  const modelTokens = t.match(/\b([a-z]*\d+[a-z0-9]*|gt|pro|ultra|plus|max|mini|lite|neo|fe|se)\b/gi) || [];
  const storageTokens = t.match(/\b(64|128|256|512|1tb|6|8|12|16|32)\s*gb\b/gi) || [];
  const words = t.split(/\s+/).filter(w => w.length > 1);
  const brand = words[0] || '';
  const colors = ['black','white','blue','red','green','gold','silver','grey','gray','purple','yellow','orange','pink','cyan','onyx','titanium','midnight','starlight','graphite','cobalt'];
  const colorFound = colors.filter(c => t.includes(c));
  return {
    brand,
    modelTokens: [...new Set(modelTokens.map(m => m.toLowerCase()))],
    storageTokens: [...new Set(storageTokens.map(s => s.toLowerCase().replace(/\s/g, '')))],
    colors: colorFound,
    full: t,
  };
}

function matchScore(original, candidate) {
  if (!original || !candidate) return 0;
  const orig = extractFingerprint(original);
  const cand = extractFingerprint(candidate);
  let score = 0;
  if (!cand.full.includes(orig.brand)) return 0;
  score += 30;
  const modelOverlap = orig.modelTokens.filter(t => cand.full.includes(t));
  score += Math.min(40, modelOverlap.length * 10);
  if (orig.storageTokens.length > 0) {
    const storageMatch = orig.storageTokens.some(s => cand.full.includes(s));
    if (storageMatch) score += 20;
    else score -= 20;
  }
  if (orig.colors.length > 0) {
    const colorMatch = orig.colors.some(c => cand.full.includes(c));
    if (colorMatch) score += 10;
  }
  return score;
}

function buildQuery(title) {
  const fp = extractFingerprint(title);
  let parts = [fp.brand];
  parts = parts.concat(fp.modelTokens.slice(0, 4));
  if (fp.storageTokens.length > 0) parts = parts.concat(fp.storageTokens.slice(0, 1));
  const query = [...new Set(parts)].join(' ').trim();
  console.log(`  🔎 Query: "${query}"`);
  return query;
}

async function scrapeOriginalPage(url, platform) {
  try {
    if (platform === 'amazon') {
      const asin = url.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || url.match(/\/gp\/product\/([A-Z0-9]{10})/)?.[1];
      if (asin) {
        const res = await axios.post(OXY_URL, { source: 'amazon_product', domain: 'in', asin, parse: true }, OXY_AUTH);
        const p = res.data.results[0]?.content;
        if (p?.title) {
          return {
            title: p.title,
            price: p.price_upper ? { display: `₹${Number(p.price_upper).toLocaleString('en-IN')}`, num: p.price_upper } : { display: 'Check site', num: 999999 },
            success: true,
          };
        }
      }
    }
    const res = await axios.post(OXY_URL, { source: 'universal', url, render: 'html' }, OXY_AUTH);
    const html = res.data.results[0]?.content || '';
    const title = extractTitle(html);
    const price = extractPrice(html);
    if (!title) return { title: '', price: null, success: false };
    return { title, price, success: true };
  } catch (err) {
    console.error('  ❌ Scrape error:', err.message);
    return { title: '', price: null, success: false };
  }
}

async function searchAmazon(query, originalTitle) {
  try {
    const res = await axios.post(OXY_URL, { source: 'amazon_search', domain: 'in', query, parse: true, pages: 1 }, OXY_AUTH);
    const organic = res.data.results[0]?.content?.results?.organic || [];
    const scored = organic.map(r => ({ ...r, score: matchScore(originalTitle, r.title || '') })).filter(r => r.score >= 50).sort((a, b) => b.score - a.score);
    if (scored.length === 0) { console.log('  ⚠ Amazon: no match'); return []; }
    const best = scored[0];
    console.log(`  ✅ Amazon (score ${best.score}): ${best.title?.substring(0, 55)}`);
    return [{
      platform: 'Amazon.in', logo: '🛒', title: best.title,
      price: best.price ? { display: `₹${Number(best.price).toLocaleString('en-IN')}`, num: Number(best.price) } : { display: 'Check site', num: 999999 },
      rating: best.rating ? `${best.rating}` : null,
      url: `https://www.amazon.in/dp/${best.asin}`,
    }];
  } catch (err) { console.error('  ❌ Amazon:', err.message); return []; }
}

async function searchFlipkart(query, originalTitle) {
  try {
    const res = await axios.post(OXY_URL, { source: 'flipkart_search', query, parse: true }, OXY_AUTH);
    const items = res.data.results[0]?.content?.results || [];
    const scored = items.map(r => ({ ...r, score: matchScore(originalTitle, r.title || r.name || '') })).filter(r => r.score >= 50).sort((a, b) => b.score - a.score);
    if (scored.length === 0) { console.log('  ⚠ Flipkart: no match'); return []; }
    const best = scored[0];
    const rawPrice = parseFloat(String(best.price || best.price_from || '0').replace(/[^0-9.]/g, '')) || 999999;
    console.log(`  ✅ Flipkart (score ${best.score}): ${(best.title || best.name || '').substring(0, 55)}`);
    return [{
      platform: 'Flipkart', logo: '🏬', title: best.title || best.name,
      price: rawPrice < 999999 ? { display: `₹${rawPrice.toLocaleString('en-IN')}`, num: rawPrice } : { display: 'Check site', num: 999999 },
      rating: best.rating ? `${best.rating}` : null,
      url: best.url?.startsWith('http') ? best.url : `https://www.flipkart.com${best.url || ''}`,
    }];
  } catch (err) { console.error('  ❌ Flipkart:', err.message); return []; }
}

async function searchUniversal(platformName, logo, searchUrl, originalTitle) {
  try {
    const res = await axios.post(OXY_URL, { source: 'universal', url: searchUrl, render: 'html' }, OXY_AUTH);
    const html = res.data.results[0]?.content || '';
    const title = extractTitle(html);
    const price = extractPrice(html);
    const score = matchScore(originalTitle, title);
    if (score < 50) { console.log(`  ⚠ ${platformName}: poor match (score ${score})`); return []; }
    console.log(`  ✅ ${platformName} (score ${score}): ${title?.substring(0, 55)}`);
    return [{ platform: platformName, logo, title, price, rating: null, url: searchUrl }];
  } catch (err) { console.error(`  ❌ ${platformName}:`, err.message); return []; }
}

app.post('/compare', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Please provide a valid product URL' });

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`🔍 ${url.substring(0, 75)}`);

  try {
    const platform = detectPlatform(url);
    console.log(`📌 Platform: ${platform}`);

    const original = await scrapeOriginalPage(url, platform);
    if (!original.success || !original.title) {
      return res.status(422).json({ error: 'Could not read product details. Please use a direct product page URL.' });
    }

    console.log(`📦 Title: ${original.title}`);
    const query = buildQuery(original.title);
    const encoded = encodeURIComponent(query);

    console.log(`\n🚀 Searching all platforms...`);
    const [amazon, flipkart, croma, reliance, tatacliq] = await Promise.allSettled([
      searchAmazon(query, original.title),
      searchFlipkart(query, original.title),
      searchUniversal('Croma', '🔌', `https://www.croma.com/searchB?q=${encoded}&inStockFilter=false&start=0`, original.title),
      searchUniversal('Reliance Digital', '📱', `https://www.reliancedigital.in/search?q=${encoded}:relevance`, original.title),
      searchUniversal('Tata Cliq', '🛍️', `https://www.tatacliq.com/search/?searchCategory=all&text=${encoded}`, original.title),
    ]);

    const allResults = [
      ...(amazon.value || []), ...(flipkart.value || []),
      ...(croma.value || []),  ...(reliance.value || []), ...(tatacliq.value || []),
    ];

    const seen = new Set();
    const unique = allResults
      .filter(r => { if (seen.has(r.platform)) return false; seen.add(r.platform); return true; })
      .sort((a, b) => a.price.num - b.price.num);

    console.log(`\n✅ ${unique.length} platforms found this product`);
    unique.forEach(r => console.log(`   ${r.logo} ${r.platform}: ${r.price.display}`));

    res.json({
      product: { title: original.title, originalPrice: original.price?.display || 'N/A', originalPlatform: platform, searchQuery: query },
      results: unique,
      totalFound: unique.length,
    });

  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/', (req, res) => res.json({ status: 'Comparix API is running ✅', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { console.log(`\n✅ Comparix backend running on port ${PORT}`); });
