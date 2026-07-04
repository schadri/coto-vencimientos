const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON parser for POST requests
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Constructor.io API key for Coto Digital
const CONSTRUCTOR_API_KEY = 'key_r6xzz4IAoTWcipni';

// Local storage fallback configurations
const CACHE_FILE = path.join(__dirname, 'products_cache.json');
const EXPIRATIONS_FILE = path.join(__dirname, 'expirations.json');
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');

let localCache = {};
let expirationsList = [];
let subscriptions = [];

// Determine if we should use serverless Upstash Redis or local filesystem fallback
const isRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
let redis = null;

if (isRedis) {
  redis = Redis.fromEnv();
  console.log('Database Mode: Serverless Upstash Redis');
} else {
  console.log('Database Mode: Local Filesystem JSON');
}

// ----------------------------------------------------
// DATABASE ABSTRACTION LAYERS (Redis vs Filesystem)
// ----------------------------------------------------

// Load local files if running locally
function loadLocalFiles() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      localCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
    if (fs.existsSync(EXPIRATIONS_FILE)) {
      expirationsList = JSON.parse(fs.readFileSync(EXPIRATIONS_FILE, 'utf8'));
    }
    if (fs.existsSync(SUBS_FILE)) {
      subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    }
    console.log('Local JSON databases loaded successfully.');
  } catch (err) {
    console.error('Failed to load local JSON databases:', err.message);
  }
}

if (!isRedis) {
  loadLocalFiles();
}

// Expirations
async function getExpirations() {
  if (isRedis) {
    return (await redis.get('coto_expirations')) || [];
  }
  return expirationsList;
}

async function saveExpirations(list) {
  if (isRedis) {
    await redis.set('coto_expirations', list);
  } else {
    expirationsList = list;
    try {
      fs.writeFileSync(EXPIRATIONS_FILE, JSON.stringify(expirationsList, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to write expirations file:', e.message);
    }
  }
}

// Subscriptions
async function getSubscriptions() {
  if (isRedis) {
    return (await redis.get('coto_subscriptions')) || [];
  }
  return subscriptions;
}

async function saveSubscriptions(list) {
  if (isRedis) {
    await redis.set('coto_subscriptions', list);
  } else {
    subscriptions = list;
    try {
      fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to write subscriptions file:', e.message);
    }
  }
}

// Product cache
async function getCachedProduct(queryKey) {
  if (isRedis) {
    return await redis.hget('coto_products_cache', queryKey);
  }
  return localCache[queryKey];
}

async function saveCachedProduct(plu, ean, cacheEntry) {
  if (isRedis) {
    const updates = {};
    if (plu) updates[plu] = cacheEntry;
    if (ean && ean !== 'No disponible') updates[ean] = cacheEntry;
    if (Object.keys(updates).length > 0) {
      await redis.hset('coto_products_cache', updates);
    }
  } else {
    if (plu) localCache[plu] = cacheEntry;
    if (ean && ean !== 'No disponible') localCache[ean] = cacheEntry;
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(localCache, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to write product cache to file:', e.message);
    }
  }
}

// Hardcoded stable VAPID keys for serverless compatibility
const vapidKeys = {
  publicKey: 'BJDD2husVmCHtp4SMfH4fcDUNy_k1S3yYIQZWUkj718kHXlQQ7bjzLDHNPNLHuj-hZRNNZIOv3eySRT8uxtN8iQ',
  privateKey: 'eQxG_efdb82c3gGZuMDtK8vr17My7KfIoxgkmXCNEKk'
};

webpush.setVapidDetails(
  'mailto:vencimientos-coto@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// No-op for serverless compatibility
async function ensureVapid() {
  return Promise.resolve();
}

// ----------------------------------------------------
// COTO WEB SCRAPERS / API HELPERS
// ----------------------------------------------------

async function fetchCotoCookies() {
  try {
    const mainResponse = await axios.get('https://www.cotodigital.com.ar/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 3000
    });
    const rawCookies = mainResponse.headers['set-cookie'] || [];
    const cookieMap = {};
    rawCookies.forEach(cookieStr => {
      const parts = cookieStr.split(';')[0].split('=');
      if (parts.length >= 2) cookieMap[parts[0].trim()] = parts.slice(1).join('=').trim();
    });
    return Object.entries(cookieMap).map(([n, v]) => `${n}=${v}`).join('; ');
  } catch (err) {
    console.error('Error fetching Coto cookies:', err.message);
    return '';
  }
}

async function fetchCotoAtgDetails(plu, cookies) {
  const url = 'https://www.cotodigital.com.ar/rest/model/atg/actors/cProfileActor/getDetailsProducts';
  try {
    const pluNum = parseInt(plu, 10);
    if (isNaN(pluNum)) return null;

    const response = await axios.post(url, {
      productIds: [pluNum]
    }, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Cookie': cookies,
        'Referer': 'https://www.cotodigital.com.ar/'
      },
      timeout: 4000
    });

    if (response.data && response.data.productos && response.data.productos.length > 0) {
      const prod = response.data.productos[0];
      if (prod.nombre) {
        let productUrl = null;
        if (prod.urlProducto) {
          productUrl = `https://www.cotodigital.com.ar/sitios/cdigi${prod.urlProducto}`;
        }
        return {
          title: prod.nombre,
          plu: String(pluNum),
          ean: 'No disponible',
          url: productUrl
        };
      }
    }
    return null;
  } catch (err) {
    console.error('Error querying Coto ATG details:', err.message);
    return null;
  }
}

// ----------------------------------------------------
// ROUTE ENDPOINTS
// ----------------------------------------------------

/**
 * Searches for a product by PLU or EAN
 */
app.get('/api/search', async (req, res) => {
  const query = req.query.plu;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ success: false, error: 'Código PLU/EAN no provisto' });
  }

  const rawQuery = query.trim();
  if (rawQuery.length === 0) {
    return res.status(400).json({ success: false, error: 'Código PLU/EAN no válido' });
  }

  let cleanedQuery = rawQuery;
  if (/^\d+$/.test(rawQuery)) {
    if (rawQuery.length <= 8) {
      cleanedQuery = rawQuery.replace(/^0+/, '');
      if (cleanedQuery === '') {
        cleanedQuery = '0';
      }
    }
  }

  // 1. Check database cache
  const cachedItem = await getCachedProduct(cleanedQuery);
  if (cachedItem) {
    console.log(`Cache HIT for query [${cleanedQuery}]:`, cachedItem.title);
    return res.json({
      success: true,
      title: cachedItem.title,
      ean: cachedItem.ean,
      plu: cachedItem.plu,
      isCached: true,
      url: cachedItem.url
    });
  }

  // 2. Query Constructor.io
  try {
    const url = `https://ac.cnstrc.com/search/${encodeURIComponent(cleanedQuery)}?key=${CONSTRUCTOR_API_KEY}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      timeout: 5000
    });

    const searchResponse = response.data.response;
    const results = searchResponse.results || [];

    if (results.length > 0) {
      let matchedProduct = null;
      const queryAsInt = parseInt(cleanedQuery, 10);

      for (const item of results) {
        const itemPlu = item.data.sku_plu;
        const itemEan = item.data.product_main_ean ? String(item.data.product_main_ean) : '';
        const itemId = item.data.id ? String(item.data.id) : '';

        const matchesPlu = (itemPlu !== undefined && (itemPlu === queryAsInt || String(itemPlu) === cleanedQuery || String(itemPlu) === rawQuery));
        const matchesEan = (itemEan === rawQuery || itemEan === cleanedQuery);
        const matchesId = (itemId.toLowerCase().endsWith(rawQuery.toLowerCase()) || itemId.toLowerCase().endsWith(cleanedQuery.toLowerCase()));

        if (matchesPlu || matchesEan || matchesId) {
          matchedProduct = item;
          break;
        }
      }

      if (!matchedProduct) {
        matchedProduct = results[0];
      }

      const title = matchedProduct.value || matchedProduct.data.sku_description || 'Sin título';
      const ean = matchedProduct.data.product_main_ean || 'No disponible';
      const plu = matchedProduct.data.sku_plu || 'No disponible';

      let productUrl = null;
      if (matchedProduct.data.url) {
        productUrl = `https://www.cotodigital.com.ar/sitios/cdigi/producto/${matchedProduct.data.url}`;
      }

      const cacheEntry = { plu: String(plu), ean: String(ean), title, url: productUrl };
      await saveCachedProduct(String(plu), String(ean), cacheEntry);

      return res.json({
        success: true,
        title,
        ean,
        plu,
        isCached: false,
        url: productUrl
      });
    }
  } catch (error) {
    console.error('Constructor.io query failed, trying fallback...', error.message);
  }

  // 3. Fallback: Query Coto Digital ATG details
  if (/^\d+$/.test(cleanedQuery) && cleanedQuery.length <= 8) {
    console.log(`Attempting Coto ATG backend fallback for PLU [${cleanedQuery}]...`);
    const cookies = await fetchCotoCookies();
    const details = await fetchCotoAtgDetails(cleanedQuery, cookies);
    
    if (details) {
      console.log(`ATG fallback SUCCESS for PLU [${cleanedQuery}]:`, details.title);
      await saveCachedProduct(cleanedQuery, 'No disponible', details);
      
      return res.json({
        success: true,
        title: details.title,
        ean: details.ean,
        plu: details.plu,
        isCached: false,
        needsEanRegistration: true,
        url: details.url
      });
    }
  }

  return res.status(404).json({ 
    success: false, 
    error: 'Producto no encontrado en el catálogo de Coto',
    canRegister: true, 
    plu: cleanedQuery
  });
});

/**
 * Manually registers/links a PLU and EAN code to cache
 */
app.post('/api/register', async (req, res) => {
  const { plu, title, ean, url } = req.body;

  if (!plu || !title) {
    return res.status(400).json({ success: false, error: 'PLU y Título son requeridos' });
  }

  const cleanedPlu = String(plu).trim().replace(/^0+/, '');
  const cleanedTitle = String(title).trim();
  const cleanedEan = ean ? String(ean).trim() : 'No disponible';

  if (cleanedPlu === '') {
    return res.status(400).json({ success: false, error: 'PLU no válido' });
  }

  const cacheEntry = {
    plu: cleanedPlu,
    ean: cleanedEan,
    title: cleanedTitle,
    url: url || null
  };

  await saveCachedProduct(cleanedPlu, cleanedEan, cacheEntry);
  res.json({ success: true, message: 'Producto registrado en la base de datos' });
});

/**
 * GET all expirations
 */
app.get('/api/expirations', async (req, res) => {
  const list = await getExpirations();
  res.json({ success: true, data: list });
});

/**
 * POST a new or updated expiration tracking
 */
app.post('/api/expirations', async (req, res) => {
  const { id, plu, ean, title, expirationDate, url } = req.body;

  if (!title || !expirationDate) {
    return res.status(400).json({ success: false, error: 'El título y la fecha de vencimiento son obligatorios.' });
  }

  const cleanPlu = plu ? String(plu).trim() : '';
  const cleanEan = ean ? String(ean).trim() : '';
  const cleanTitle = String(title).trim();
  const cleanExpiration = String(expirationDate).trim();

  const item = {
    id: id || `exp-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    plu: cleanPlu,
    ean: cleanEan,
    title: cleanTitle,
    expirationDate: cleanExpiration,
    url: url || null,
    createdAt: req.body.createdAt || new Date().toISOString()
  };

  const list = await getExpirations();

  if (id) {
    const index = list.findIndex(e => e.id === id);
    if (index !== -1) {
      item.createdAt = list[index].createdAt;
      list[index] = item;
    } else {
      list.push(item);
    }
  } else {
    list.push(item);
  }

  await saveExpirations(list);
  res.json({ success: true, data: item });
});

/**
 * DELETE an expiration tracking
 */
app.delete('/api/expirations/:id', async (req, res) => {
  const { id } = req.params;
  const list = await getExpirations();
  const initialCount = list.length;
  const filtered = list.filter(e => e.id !== id);

  if (filtered.length < initialCount) {
    await saveExpirations(filtered);
    res.json({ success: true, message: 'Vencimiento eliminado con éxito.' });
  } else {
    res.status(404).json({ success: false, error: 'No se encontró el registro.' });
  }
});

/**
 * WEB PUSH ENDPOINTS
 */

app.get('/api/vapid-public-key', async (req, res) => {
  await ensureVapid();
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', async (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ success: false, error: 'Objeto de suscripción inválido.' });
  }

  const list = await getSubscriptions();
  const exists = list.some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    list.push(subscription);
    await saveSubscriptions(list);
    console.log(`New client subscribed. Total subscriptions: ${list.length}`);
  }
  res.status(201).json({ success: true });
});

app.post('/api/unsubscribe', async (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ success: false, error: 'Suscripción inválida.' });
  }

  const list = await getSubscriptions();
  const filtered = list.filter(s => s.endpoint !== subscription.endpoint);
  await saveSubscriptions(filtered);
  console.log(`Client unsubscribed. Total subscriptions: ${filtered.length}`);
  res.json({ success: true });
});

/**
 * Test Push Notifications Endpoint
 * Note: Keeps serverless connection open for 10s before resolving and pushing,
 * ensuring it stays alive inside Serverless Functions.
 */
app.post('/api/test-push', async (req, res) => {
  await ensureVapid();
  const list = await getSubscriptions();
  
  const delay = 10000;
  console.log(`Holding serverless container for ${delay / 1000}s, then triggering push to ${list.length} devices...`);

  // Wait synchronously inside serverless function execution
  await new Promise(resolve => setTimeout(resolve, delay));

  const payload = JSON.stringify({
    title: '🧪 Notificación de Prueba',
    body: '¡Funciona! Esta alerta se generó en segundo plano con la app cerrada.',
    url: '/'
  });

  let activeSubs = [...list];
  let changed = false;

  const sendPromises = list.map(sub => {
    return webpush.sendNotification(sub, payload)
      .catch(err => {
        console.error('Failed test push to endpoint:', sub.endpoint.substring(0, 40) + '...', err.message);
        if (err.statusCode === 410 || err.statusCode === 404) {
          activeSubs = activeSubs.filter(s => s.endpoint !== sub.endpoint);
          changed = true;
        }
      });
  });

  await Promise.all(sendPromises);

  if (changed) {
    await saveSubscriptions(activeSubs);
  }

  res.json({ success: true, message: 'Push sent.' });
});

/**
 * Daily checker function (handles push broadcasts)
 */
async function checkAndSendPushNotifications() {
  console.log('Running expirations checker...');
  await ensureVapid();
  const subs = await getSubscriptions();
  if (subs.length === 0) {
    console.log('No active push subscriptions.');
    return;
  }

  const list = await getExpirations();
  const expiringToday = list.filter(item => {
    const [year, month, day] = item.expirationDate.split('-').map(Number);
    const expDate = new Date(year, month - 1, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffTime = expDate - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays === 0;
  });

  if (expiringToday.length === 0) {
    console.log('No products expiring today.');
    return;
  }

  console.log(`Found ${expiringToday.length} items expiring today. Sending push notifications...`);

  let activeSubs = [...subs];
  let changed = false;

  for (const item of expiringToday) {
    const payload = JSON.stringify({
      title: '⚠️ Producto por Vencer Hoy',
      body: `"${item.title}" (PLU: ${item.plu || 'N/D'}) vence hoy. Consumir pronto.`,
      url: '/'
    });

    const sendPromises = subs.map(sub => {
      return webpush.sendNotification(sub, payload)
        .catch(err => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            activeSubs = activeSubs.filter(s => s.endpoint !== sub.endpoint);
            changed = true;
          }
        });
    });

    await Promise.all(sendPromises);
  }

  if (changed) {
    await saveSubscriptions(activeSubs);
  }
  console.log('Expirations checker finished.');
}

/**
 * VERCEL CRON JOB ENDPOINT
 * Hits this endpoint once a day to run background notifications in Serverless.
 */
app.get('/api/cron-check', async (req, res) => {
  try {
    await checkAndSendPushNotifications();
    res.json({ success: true, message: 'Cron checked successfully.' });
  } catch (err) {
    console.error('Cron check failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Run checker locally on startup (only if not serverless Vercel)
if (!process.env.VERCEL) {
  setInterval(checkAndSendPushNotifications, 12 * 60 * 60 * 1000);
  setTimeout(checkAndSendPushNotifications, 15000);
}

// Start server (only if run locally, Vercel will export app)
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
