/**
 * msrpChecker.js
 *
 * Scrapes the Pokemon Center website to build a local MSRP price database,
 * then provides fuzzy-matched lookups so the monitor can compare retailer
 * prices against the official MSRP.
 *
 * Pokemon Center uses Next.js server-side rendering. The primary extraction
 * strategy parses the __NEXT_DATA__ JSON blob embedded in every page; a
 * Cheerio HTML pass runs as a fallback when that path is absent or empty.
 *
 * Public API:
 *   updateMsrpDatabase(force?)  — scrape Pokemon Center, write msrp-database.json
 *   findMsrp(productName)       — fuzzy-match a product name, return price info
 *   loadDatabase()              — return the raw cached database object
 */

require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');
const config  = require('./config');

// ── Constants ─────────────────────────────────────────────────────────────────

const POKEMON_CENTER_BASE = 'https://www.pokemoncenter.com';
const DB_FILE = path.resolve('./data/msrp-database.json');
const DB_MAX_AGE_HOURS = 24;   // re-scrape if cache is older than this
const MIN_SIMILARITY    = 0.30; // Jaccard threshold below which we return null
const PAGE_PARAM        = 'page';
const PAGE_SIZE         = 60;   // products per page on Pokemon Center

// Sub-categories to crawl; main TCG page first, then specific product types
// for better coverage of items that might not surface on page 1 of the main listing.
const TCG_CATEGORIES = [
  '/category/trading-card-game',
  '/category/trading-card-game/booster-packs',
  '/category/trading-card-game/elite-trainer-boxes',
  '/category/trading-card-game/tins-and-collections',
];

// Product-type synonym groups used to boost similarity scoring.
// If both the query and candidate share a type keyword, score gets a bonus.
const PRODUCT_TYPE_GROUPS = [
  ['elite trainer box', 'etb'],
  ['booster pack', 'booster bundle', 'booster display'],
  ['tin', 'collector tin'],
  ['collection box', 'collection', 'box'],
  ['blister', 'blister pack'],
  ['bundle'],
  ['premium collection'],
  ['starter deck', 'battle deck', 'theme deck'],
];

// ── Network ───────────────────────────────────────────────────────────────────

async function fetchPage(url, retries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: {
          ...config.requestHeaders,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: POKEMON_CENTER_BASE + '/',
        },
        timeout: 25000,
        // Decompress gzip/br automatically
        decompress: true,
      }); console.log('[MSRP DEBUG] Response length:', typeof res.data === 'string' ? res.data.length : 'not a string', '| Has product links:', typeof res.data === 'string' && res.data.includes('/product/'), '| Has NEXT_DATA:', typeof res.data === 'string' && res.data.includes('__NEXT_DATA__'));
      console.log('[MSRP DEBUG] Page title:', typeof res.data === 'string' ? (res.data.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'No title found') : 'Response is not a string');
      return res.data;
    } catch (err) {
      lastErr = err;
      if (err.response?.status === 404) throw err; // not retryable
      if (attempt < retries) {
        const delay = 1500 * attempt;
        console.warn(`[MSRP] Fetch failed (attempt ${attempt}/${retries}) — retrying in ${delay}ms: ${err.message}`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// ── Product Extraction — Strategy 1: __NEXT_DATA__ ────────────────────────────

/**
 * Recursively walk a parsed __NEXT_DATA__ object to find the largest array
 * whose elements look like product records (have a name-like field and a
 * price-like field). Returns [] if nothing plausible is found.
 */
function findProductArraysInObject(obj, depth = 0, candidates = []) {
  if (depth > 12 || obj === null || typeof obj !== 'object') return candidates;

  if (Array.isArray(obj)) {
    if (obj.length > 0 && looksLikeProductArray(obj)) {
      candidates.push(obj);
    }
    for (const el of obj.slice(0, 5)) {
      findProductArraysInObject(el, depth + 1, candidates);
    }
  } else {
    for (const val of Object.values(obj)) {
      findProductArraysInObject(val, depth + 1, candidates);
    }
  }

  return candidates;
}

function looksLikeProductArray(arr) {
  const sample = arr.slice(0, 3);
  return sample.every(el =>
    el && typeof el === 'object' &&
    !Array.isArray(el) &&
    extractName(el) !== null &&
    extractPrice(el) !== null,
  );
}

function extractName(el) {
  for (const key of ['name', 'title', 'productName', 'displayName', 'longName']) {
    if (typeof el[key] === 'string' && el[key].length > 3) return el[key];
  }
  return null;
}

function extractPrice(el) {
  // Direct numeric price
  for (const key of ['price', 'salePrice', 'regularPrice', 'listPrice', 'msrp', 'amount']) {
    const v = el[key];
    if (typeof v === 'number' && v > 0) return v;
    if (typeof v === 'string') {
      const parsed = parseFloat(v.replace(/[^0-9.]/g, ''));
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  }
  // Nested price objects: { price: { value: 49.99 } }
  for (const key of ['price', 'pricing', 'priceInfo', 'priceRange']) {
    const obj = el[key];
    if (obj && typeof obj === 'object') {
      const inner = extractPrice(obj);
      if (inner !== null) return inner;
    }
  }
  return null;
}

function extractUrl(el) {
  for (const key of ['url', 'pdpUrl', 'productUrl', 'canonicalUrl', 'href', 'slug', 'id']) {
    const v = el[key];
    if (typeof v === 'string' && v.length > 0) {
      if (v.startsWith('http')) return v;
      if (v.startsWith('/')) return POKEMON_CENTER_BASE + v;
    }
  }
  return null;
}

function extractProductsFromNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return [];

  let nextData;
  try {
    nextData = JSON.parse(match[1]);
  } catch {
    return [];
  }

  const candidates = findProductArraysInObject(nextData);
  if (candidates.length === 0) return [];

  // Pick the candidate array with the most entries
  const best = candidates.sort((a, b) => b.length - a.length)[0];

  return best.map(el => {
    const name  = extractName(el);
    const price = extractPrice(el);
    if (!name || !price) return null;

    return {
      name,
      price,
      priceFormatted: formatPrice(price),
      url: extractUrl(el) ?? null,
    };
  }).filter(Boolean);
}

// ── Product Extraction — Strategy 2: Cheerio HTML parse ───────────────────────

function extractProductsFromHtml(html) {
  const $ = cheerio.load(html);
  const products = [];

  // Try progressively broader selectors; stop at the first that yields results.
  const selectorStrategies = [
    // Pokemon Center-specific patterns observed in their React markup
    '[data-testid="product-grid-item"]',
    '[data-testid*="product-card"]',
    '[class*="ProductCard"]',
    '[class*="product-card"]',
    '[class*="product-tile"]',
    // Generic e-commerce patterns
    'li[class*="grid"] a[href*="/product/"]',
    'article:has(a[href*="/product/"])',
  ];

  for (const selector of selectorStrategies) {
    $(selector).each((_, el) => {
      const $el = $(el);

      const name = (
        $el.find('[class*="name"], [class*="title"], h2, h3, h4').first().text() ||
        $el.find('a').first().attr('aria-label') ||
        $el.find('img').first().attr('alt')
      )?.trim();

      const priceText = $el.find('[class*="price"], [class*="Price"]').first().text().trim();
      const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));

      const href = $el.find('a[href*="/product/"]').first().attr('href');

      if (name && name.length > 3 && !isNaN(price) && price > 0) {
        products.push({
          name,
          price,
          priceFormatted: formatPrice(price),
          url: href ? (href.startsWith('http') ? href : POKEMON_CENTER_BASE + href) : null,
        });
      }
    });

    if (products.length > 0) break; // found enough, stop trying selectors
  }

  return products;
}

// ── Pagination + Category Scraping ────────────────────────────────────────────

async function scrapeCategory(categoryPath) {
  const products = [];
  const seen = new Set();
  let page = 1;

  while (true) {
    const url = `${POKEMON_CENTER_BASE}${categoryPath}?${PAGE_PARAM}=${page}`;
    console.log(`[MSRP] Fetching ${url}`);

    let html;
    try {
      html = await fetchPage(url);
    } catch (err) {
      if (err.response?.status === 404) {
        console.warn(`[MSRP] Category not found (404): ${categoryPath}`);
        break;
      }
      console.error(`[MSRP] Network error on ${url}: ${err.message}`);
      break;
    }

    let pageProducts = extractProductsFromNextData(html);
    if (pageProducts.length === 0) {
      console.warn(`[MSRP] __NEXT_DATA__ strategy empty for ${url} — trying HTML parser`);
      pageProducts = extractProductsFromHtml(html);
    }

    if (pageProducts.length === 0) {
      console.warn(`[MSRP] No products found on ${url} — stopping pagination`);
      break;
    }

    let newCount = 0;
    for (const p of pageProducts) {
      const key = p.name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        products.push(p);
        newCount++;
      }
    }

    console.log(`[MSRP] Page ${page}: ${pageProducts.length} products (${newCount} new)`);

    // Stop if this looks like the last page
    if (pageProducts.length < PAGE_SIZE) break;
    page++;
    await sleep(1500); // polite crawl delay
  }

  return products;
}

async function scrapePokemonCenter() {
  const all = [];
  const globalSeen = new Set();

  for (const categoryPath of TCG_CATEGORIES) {
    let categoryProducts;
    try {
      categoryProducts = await scrapeCategory(categoryPath);
    } catch (err) {
      console.error(`[MSRP] Failed to scrape ${categoryPath}: ${err.message}`);
      continue;
    }

    for (const p of categoryProducts) {
      const key = p.name.toLowerCase();
      if (!globalSeen.has(key)) {
        globalSeen.add(key);
        all.push(p);
      }
    }

    await sleep(2000); // pause between categories
  }

  return all;
}

// ── Database ──────────────────────────────────────────────────────────────────

function loadDatabase() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { products: [], lastUpdated: null, count: 0 };
  }
}

function saveDatabase(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function isDatabaseStale(db) {
  if (!db.lastUpdated) return true;
  const ageMs = Date.now() - new Date(db.lastUpdated).getTime();
  return ageMs > DB_MAX_AGE_HOURS * 60 * 60 * 1000;
}

// ── Fuzzy Matching ────────────────────────────────────────────────────────────

// Noise words stripped before tokenizing so they don't dilute scores.
const NOISE_RE = /\b(pokemon|pokémon|tcg|trading card game|the|a|an|and|or|of|in|with|for|official|game|card|cards)\b/gi;

function normalizeProductName(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, "'")       // curly → straight apostrophe
    .replace(/[^a-z0-9\s&'-]/g, ' ') // remove most punctuation
    .replace(NOISE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(name) {
  return new Set(normalizeProductName(name).split(' ').filter(s => s.length > 1));
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Bonus score [0, 0.2] when both names belong to the same product-type group.
 * Prevents "Booster Pack" from matching "Elite Trainer Box" at a high score
 * even if they share a set name.
 */
function productTypeBonus(queryNorm, candidateNorm) {
  for (const group of PRODUCT_TYPE_GROUPS) {
    const qMatch  = group.some(kw => queryNorm.includes(kw));
    const cMatch  = group.some(kw => candidateNorm.includes(kw));
    if (qMatch && cMatch) return 0.2;
    // Penalty when one matches a type group but the other doesn't
    if (qMatch !== cMatch) return -0.1;
  }
  return 0;
}

/**
 * Combined similarity score in [0, 1].
 * Exact-normalized match short-circuits to 1.0.
 */
function calculateSimilarity(queryName, candidateName) {
  const qNorm = normalizeProductName(queryName);
  const cNorm = normalizeProductName(candidateName);

  if (qNorm === cNorm) return 1.0;

  // Substring containment — one is a prefix/suffix of the other
  const containment = (qNorm.includes(cNorm) || cNorm.includes(qNorm)) ? 0.15 : 0;

  const jaccard = jaccardSimilarity(tokenize(queryName), tokenize(candidateName));
  const bonus   = productTypeBonus(qNorm, cNorm);

  return Math.max(0, Math.min(1, jaccard + bonus + containment));
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Scrape Pokemon Center and write/update data/msrp-database.json.
 *
 * @param {boolean} force  If true, re-scrape even if the cache is fresh.
 * @returns {object} The database object { products, lastUpdated, count }.
 */
async function updateMsrpDatabase(force = false) {
  const existing = loadDatabase();

  if (!force && !isDatabaseStale(existing) && existing.products.length > 0) {
    console.log(`[MSRP] Database is fresh (${existing.count} products, updated ${existing.lastUpdated}). Skipping scrape.`);
    return existing;
  }

  console.log('[MSRP] Scraping Pokemon Center for MSRP data…');
  const products = await scrapePokemonCenter();

  if (products.length === 0) {
    const msg =
      '[MSRP] No products extracted from Pokemon Center. ' +
      'The site may have changed its HTML/JSON structure or is blocking requests. ' +
      'Check the selector strategies in extractProductsFromHtml() and ' +
      'the recursive search in findProductArraysInObject().';
    console.error(msg);
    // Return stale data if we have it, rather than wiping the cache.
    if (existing.products.length > 0) {
      console.warn('[MSRP] Returning stale database to avoid data loss.');
      return existing;
    }
    throw new Error(msg);
  }

  const db = {
    products,
    lastUpdated: new Date().toISOString(),
    count: products.length,
  };

  saveDatabase(db);
  console.log(`[MSRP] Database saved: ${products.length} products → ${DB_FILE}`);
  return db;
}

/**
 * Look up the MSRP for a product by name using fuzzy matching.
 *
 * @param {string} productName  The product name from a retailer scraper.
 * @param {number} threshold    Minimum similarity score (default 0.30).
 * @returns {object|null}
 *   {
 *     name: string,            — matched Pokemon Center product name
 *     msrp: number,            — numeric price in USD
 *     msrpFormatted: string,   — "$49.99"
 *     url: string|null,        — Pokemon Center product URL
 *     similarity: number,      — match confidence 0–1
 *     exact: boolean,          — true if similarity === 1.0
 *   }
 *   or null if no match above threshold.
 */
function findMsrp(productName, threshold = MIN_SIMILARITY) {
  if (!productName || typeof productName !== 'string') return null;

  const db = loadDatabase();
  if (!db.products?.length) {
    console.warn('[MSRP] Database is empty — run updateMsrpDatabase() first.');
    return null;
  }

  let bestScore = -Infinity;
  let bestProduct = null;

  for (const product of db.products) {
    const score = calculateSimilarity(productName, product.name);
    if (score > bestScore) {
      bestScore = score;
      bestProduct = product;
    }
  }

  if (bestScore < threshold || !bestProduct) {
    return null;
  }

  return {
    name:         bestProduct.name,
    msrp:         bestProduct.price,
    msrpFormatted: bestProduct.priceFormatted,
    url:          bestProduct.url ?? null,
    similarity:   Math.round(bestScore * 1000) / 1000,
    exact:        bestScore === 1.0,
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatPrice(num) {
  return `$${Number(num).toFixed(2)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// Run directly:  node msrpChecker.js [--force] [--lookup "Product Name"]

if (require.main === module) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const lookupIdx = args.indexOf('--lookup');
  const lookupName = lookupIdx !== -1 ? args[lookupIdx + 1] : null;

  (async () => {
    if (lookupName) {
      const result = findMsrp(lookupName);
      if (result) {
        console.log('\nMatch found:');
        console.log(`  Name:       ${result.name}`);
        console.log(`  MSRP:       ${result.msrpFormatted}`);
        console.log(`  Similarity: ${(result.similarity * 100).toFixed(1)}%`);
        console.log(`  URL:        ${result.url ?? 'N/A'}`);
      } else {
        console.log(`No MSRP match found for: "${lookupName}"`);
        console.log('(Run without --lookup first to populate the database)');
      }
      return;
    }

    try {
      const db = await updateMsrpDatabase(force);
      console.log(`\nDatabase summary:`);
      console.log(`  Products:     ${db.count}`);
      console.log(`  Last updated: ${db.lastUpdated}`);
      console.log(`  File:         ${DB_FILE}`);

      // Sample a few entries
      const sample = db.products.slice(0, 5);
      console.log('\nSample products:');
      sample.forEach(p => console.log(`  ${p.priceFormatted}  ${p.name}`));
    } catch (err) {
      console.error('[MSRP] Fatal:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = { findMsrp, updateMsrpDatabase, loadDatabase, normalizeProductName, calculateSimilarity };
