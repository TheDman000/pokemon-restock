/**
 * Barnes & Noble scraper — uses their internal Shopify predictive-search JSON API.
 *
 * B&N runs on Shopify Oxygen, which exposes a product search endpoint at:
 *   /api/predictive-search?q={keyword}&resources[type]=product&resources[limit]=10
 *
 * Each call returns up to 10 products. We run multiple targeted Pokemon TCG
 * keyword searches and deduplicate by Shopify product ID to build full coverage.
 *
 * Availability note:
 *   The predictive-search API returns "IN_STOCK" for all listed products —
 *   it reflects catalog presence, not real-time warehouse stock. As a result
 *   this scraper is best at detecting NEW product listings (when a new set
 *   first appears in B&N's catalog) rather than stock transitions. Products
 *   that B&N stops carrying simply disappear from search results.
 *
 * B&N is a single-seller site (no third-party marketplace), so no seller filtering needed.
 *
 * Response fields used:
 *   results[].id                          → Shopify product ID
 *   results[].product.title               → product name
 *   results[].product.priceInfo.price     → current price (USD)
 *   results[].product.priceInfo.originalPrice → list price
 *   results[].product.availability        → "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" etc.
 *   results[].product.uri                 → product URL
 *   results[].product.attributes.mfield_bnb__ean.numbers[0] → EAN-13
 *   results[].product.attributes.mfield_bnb__publicationDate → release date
 *
 * If this endpoint breaks, open DevTools on barnesandnoble.com and look for
 * requests to /api/predictive-search in the Network tab.
 */

const axios  = require('axios');
const config = require('../config');
const { withRetry, sleep } = require('../utils/retry');

// ── Constants ─────────────────────────────────────────────────────────────────

const BN_BASE      = 'https://www.barnesandnoble.com';
const SEARCH_API   = `${BN_BASE}/api/predictive-search`;
const DELAY_MS     = 1000;
const MAX_RETRIES  = 3;

// 10 is the effective API cap; requesting more is ignored.
const RESULTS_PER_CALL = 10;

// Multiple targeted keywords maximise coverage (each call returns up to 10 unique items).
const SEARCH_KEYWORDS = [
  'pokemon trading card game',
  'pokemon booster pack',
  'pokemon elite trainer box',
  'pokemon tin',
  'pokemon collection box',
  'pokemon starter deck',
  'pokemon tcg scarlet violet',
  'pokemon tcg',
  'pokemon bundle box',
  'pokemon league battle deck',
];

// ── HTTP ──────────────────────────────────────────────────────────────────────

const BASE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         BN_BASE + '/',
};

async function fetchKeyword(keyword) {
  return withRetry(
    async () => {
      const res = await axios.get('https://www.barnesandnoble.com/search.data', {
        params: {
          q: keyword,
        },
        headers: BASE_HEADERS,
        timeout: 20000,
      });

      const body =
        typeof res.data === 'string'
          ? res.data
          : JSON.stringify(res.data);

 console.log(
  `[B&N SEARCH.DATA] "${keyword}" response length: ${body.length}`
);


try {
  const parsed = JSON.parse(res.data);

  console.log(
    `[B&N JSON PARSE] "${keyword}" success type=${Array.isArray(parsed) ? 'array' : typeof parsed}`
  );

  return [];
} catch (err) {
  console.log(
    `[B&N JSON PARSE] "${keyword}" failed: ${err.message}`
  );

  return [];
}

    },
    {
      maxAttempts: MAX_RETRIES,
      baseDelayMs: 1500,
      isRetryable(err) {
        const status = err.response?.status;
        return (
          status === 429 ||
          !status ||
          status >= 500 ||
          err.code === 'ECONNRESET'
        );
      },
      getDelay(err, attempt, baseDelayMs) {
        if (err.response?.status === 429) {
          return 5000 * (2 ** (attempt - 1));
        }
        return baseDelayMs * (2 ** (attempt - 1));
      },
      onRetry(err, attempt, delayMs) {
        console.warn(
          `[B&N] Attempt ${attempt} failed (${err.message}) → retrying in ${delayMs}ms`
        );
      },
    }
  );
}

// ── Stock status ──────────────────────────────────────────────────────────────

function getStockStatus(availability) {
  const av = (availability ?? '').toUpperCase();
  if (av === 'IN_STOCK' || av === 'AVAILABLE')   return 'in_stock';
  if (av === 'PREORDER' || av === 'PRE_ORDER')   return 'pre_order';
  // OUT_OF_STOCK, UNAVAILABLE, COMING_SOON, etc.
  return 'out_of_stock';
}

// ── Normalisation ─────────────────────────────────────────────────────────────

function isPokemonProduct(name) {
  const lower = (name ?? '').toLowerCase();
  return lower.includes('pokemon') || lower.includes('pokémon');
}

/**
 * Filter out items that are clearly not TCG products (books, manga, video games).
 * We want physical card game products, not Pokémon-themed books.
 */
function isTcgProduct(raw) {
  const title = (raw?.product?.title ?? '').toLowerCase();
  const categories = (raw?.product?.categories ?? []).join(' ').toLowerCase();

  // Must actually be Pokemon.
  if (!title.includes('pokemon') && !title.includes('pokémon')) {
    return false;
  }

  // Strong signals that this is a physical Pokemon TCG product.
  const tcgSignals = [
    'trading card',
    'booster pack',
    'booster bundle',
    'booster box',
    'elite trainer box',
    'etb',
    'sleeved booster',
    'collection box',
    'collector chest',
    'tin',
    'blister',
    'starter deck',
    'theme deck',
    'battle deck',
    'ex box',
    'ex collection',
    'premium collection',
    'poster collection',
    'binder collection',
    'tech sticker collection',
    'build & battle',
    'build and battle'
  ];

  const hasTcgSignal = tcgSignals.some(signal => title.includes(signal));

  // Reject obvious non-TCG merchandise unless the title has a strong
  // TCG-product signal.
  const nonTcgSignals = [
    'figure',
    'figurine',
    'plush',
    'manga',
    'novel',
    'handbook',
    'guidebook',
    'coloring book',
    'activity book',
    'video game',
    'dvd',
    'blu-ray',
    'calendar',
    'video genre',
    'cards to invest in',
    'how to find a worthwhile card',
    'volumes 1-'
  ];

  if (nonTcgSignals.some(signal => title.includes(signal))) {
    return false;
  }

  // B&N book/media categories need positive TCG evidence.
  if (categories.includes('books') || categories.includes('media')) {
    return hasTcgSignal;
  }

  // For every other category, require positive TCG evidence too.
  return hasTcgSignal;
}

function extractEan(raw) {
  return raw?.product?.attributes?.mfield_bnb__ean?.numbers?.[0] ?? null;
}

function extractReleaseDate(raw) {
  const dateStr = raw?.product?.attributes?.mfield_bnb__publicationDate?.text?.[0];
  if (!dateStr) return null;
  // Convert "2025-01-15T05:00:00Z" → "2025-01-15"
  return dateStr.split('T')[0] ?? null;
}

function normalizeResult(raw) {
  const shopifyId   = raw.id;
  const product     = raw.product ?? {};
  const name        = product.title ?? '';
  const stockStatus = getStockStatus(product.availability);

  const priceNumeric = product.priceInfo?.price != null ? Number(product.priceInfo.price) : null;
  const origNumeric  = product.priceInfo?.originalPrice != null ? Number(product.priceInfo.originalPrice) : null;
  const regularPrice = (origNumeric != null && origNumeric !== priceNumeric)
    ? `$${origNumeric.toFixed(2)}` : null;

  const ean = extractEan(raw);
  // Use EAN as unique ID when available (more stable than Shopify product ID across catalog updates)
  const productId = ean ? String(ean) : shopifyId;
  const url = product.uri ?? (ean ? `${BN_BASE}/products/${ean}` : `${BN_BASE}/search?q=${encodeURIComponent(name)}`);

  return {
    id:           `bn-${productId}`,
    retailer:     'barnesandnoble',
    ean:          ean ? String(ean) : null,
    shopifyId,
    name,
    brand:        null,
    price:        priceNumeric != null ? `$${priceNumeric.toFixed(2)}` : 'N/A',
    priceNumeric,
    regularPrice,
    url,
    inStock:      stockStatus === 'in_stock',
    stockStatus,
    releaseDate:  extractReleaseDate(raw),
  };
}

// ── Main scraper ──────────────────────────────────────────────────────────────

async function scrapeBarnesAndNoble() {
  console.log('[B&N] Starting Pokemon TCG search via predictive-search API');

  const products  = [];
  const seen      = new Set();
  let   bookCount = 0;

  for (const keyword of SEARCH_KEYWORDS) {
    let results;
    try {
      results = await fetchKeyword(keyword);
    } catch (err) {
      console.error(`[B&N] Failed on "${keyword}": ${err.message}`);
      continue;
    }

    let newCount  = 0;
    let skipCount = 0;

    for (const raw of results) {
      const shopifyId = raw.id;
      const name      = raw?.product?.title ?? '';
      
      console.log('[B&N DEBUG RAW]', JSON.stringify(raw, null, 2));

      if (!shopifyId || !isPokemonProduct(name)) { skipCount++; continue; }

      // Deduplicate by EAN first, then Shopify ID
      const ean = extractEan(raw);
      const key = ean ? `ean-${ean}` : `id-${shopifyId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!isTcgProduct(raw)) { bookCount++; skipCount++; continue; }

      products.push(normalizeResult(raw));
      newCount++;
    }

    console.log(
      `[B&N] "${keyword}": ${results.length} results → ${newCount} added, ${skipCount} skipped`,
    );

    if (SEARCH_KEYWORDS.indexOf(keyword) < SEARCH_KEYWORDS.length - 1) await sleep(DELAY_MS);
  }

  const inStock    = products.filter(p => p.stockStatus === 'in_stock').length;
  const outOfStock = products.filter(p => p.stockStatus === 'out_of_stock').length;
  const preOrder   = products.filter(p => p.stockStatus === 'pre_order').length;

  console.log(
    `[B&N] Done: ${products.length} products ` +
    `(${inStock} in-stock, ${outOfStock} OOS, ${preOrder} pre-order, ${bookCount} books filtered)`,
  );

  return products;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// node scrapers/barnesandnoble.js            → run and show 5 sample products
// node scrapers/barnesandnoble.js --all      → show all products
// node scrapers/barnesandnoble.js --json     → output raw JSON

if (require.main === module) {
  require('dotenv').config();
  const args    = process.argv.slice(2);
  const showAll = args.includes('--all');
  const asJson  = args.includes('--json');

  scrapeBarnesAndNoble()
    .then(products => {
      if (asJson) {
        console.log(JSON.stringify(products, null, 2));
        return;
      }

      const sample = showAll ? products : products.slice(0, 5);

      console.log(`\n${'─'.repeat(70)}`);
      console.log(`Barnes & Noble Pokemon TCG — ${sample.length} of ${products.length} products shown`);
      console.log(`  In-stock:     ${products.filter(p => p.stockStatus === 'in_stock').length}`);
      console.log(`  Out-of-stock: ${products.filter(p => p.stockStatus === 'out_of_stock').length}`);
      console.log(`  Pre-order:    ${products.filter(p => p.stockStatus === 'pre_order').length}`);
      console.log('─'.repeat(70));

      if (!sample.length) {
        console.log('\nNo products found.');
        console.log('Check if /api/predictive-search is still the correct endpoint (see file header).');
        return;
      }

      sample.forEach((p, i) => {
        const statusLabel = {
          in_stock:     '✅ In Stock',
          out_of_stock: '❌ OOS',
          pre_order:    '🔜 Pre-order',
        }[p.stockStatus] ?? p.stockStatus;

        console.log(`\n[${i + 1}] ${p.name}`);
        if (p.ean) console.log(`    EAN:    ${p.ean}`);
        console.log(`    Price:  ${p.price}${p.regularPrice ? ` (was ${p.regularPrice})` : ''}`);
        console.log(`    Status: ${statusLabel}`);
        if (p.releaseDate) console.log(`    Release: ${p.releaseDate}`);
        console.log(`    URL:    ${p.url}`);
      });
      console.log(`\n${'─'.repeat(70)}`);
    })
    .catch(err => {
      console.error('[B&N] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = {
  scrapeBarnesAndNoble,
  normalizeResult,
  getStockStatus,
  isPokemonProduct,
  isTcgProduct,
};
