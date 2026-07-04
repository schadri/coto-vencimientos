const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON parser for POST requests
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Constructor.io API key for Coto Digital
const CONSTRUCTOR_API_KEY = 'key_r6xzz4IAoTWcipni';

// Local cache configuration
const CACHE_FILE = path.join(__dirname, 'products_cache.json');
let localCache = {};

// Expirations storage file
const EXPIRATIONS_FILE = path.join(__dirname, 'expirations.json');
let expirationsList = [];

// VAPID keys setup for Web Push Notifications
const VAPID_FILE = path.join(__dirname, 'vapid_keys.json');
let vapidKeys = {};

if (fs.existsSync(VAPID_FILE)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to parse VAPID file, generating new keys');
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2), 'utf8');
  }
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2), 'utf8');
}

webpush.setVapidDetails(
  'mailto:vencimientos-coto@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// Subscriptions storage
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');
let subscriptions = [];

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    } else {
      subscriptions = [];
      fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2), 'utf8');
    }
  } catch (err) {
    console.error('Failed to load subscriptions:', err.message);
    subscriptions = [];
  }
}

function saveSubscriptions() {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save subscriptions:', err.message);
  }
}

// Load cache & lists
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      localCache = JSON.parse(data);
      console.log('Local product cache loaded successfully.');
    } else {
      localCache = {};
      fs.writeFileSync(CACHE_FILE, JSON.stringify(localCache, null, 2), 'utf8');
      console.log('Created new empty product cache.');
    }
  } catch (err) {
    console.error('Failed to read/write product cache file:', err.message);
    localCache = {};
  }
}

function loadExpirations() {
  try {
    if (fs.existsSync(EXPIRATIONS_FILE)) {
      const data = fs.readFileSync(EXPIRATIONS_FILE, 'utf8');
      expirationsList = JSON.parse(data);
      console.log('Expirations list loaded successfully.');
    } else {
      expirationsList = [];
      fs.writeFileSync(EXPIRATIONS_FILE, JSON.stringify(expirationsList, null, 2), 'utf8');
      console.log('Created new empty expirations list.');
    }
  } catch (err) {
    console.error('Failed to read/write expirations list:', err.message);
    expirationsList = [];
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(localCache, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save product cache to disk:', err.message);
  }
}

function saveExpirations() {
  try {
    fs.writeFileSync(EXPIRATIONS_FILE, JSON.stringify(expirationsList, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save expirations list to disk:', err.message);
  }
}

// Run storage loaders
loadCache();
loadExpirations();
loadSubscriptions();

// Helper to fetch Coto Digital session cookies
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

// Helper to fetch Coto ATG details (for out-of-stock fallback)
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

  // Clean the query:
  let cleanedQuery = rawQuery;
  if (/^\d+$/.test(rawQuery)) {
    if (rawQuery.length <= 8) {
      cleanedQuery = rawQuery.replace(/^0+/, '');
      if (cleanedQuery === '') {
        cleanedQuery = '0';
      }
    }
  }

  // 1. Check local cache first
  if (localCache[cleanedQuery]) {
    const cachedItem = localCache[cleanedQuery];
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

  // 2. Query Constructor.io (Coto active search index)
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
      // Try to find the exact match by PLU or EAN
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

      // Automatically store in cache for future offline / out-of-stock lookup
      if (plu !== 'No disponible') {
        const cacheEntry = { plu: String(plu), ean: String(ean), title, url: productUrl };
        localCache[String(plu)] = cacheEntry;
        if (ean !== 'No disponible') {
          localCache[String(ean)] = cacheEntry;
        }
        saveCache();
      }

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

  // 3. Fallback: Query Coto Digital's direct product details REST backend API
  if (/^\d+$/.test(cleanedQuery) && cleanedQuery.length <= 8) {
    console.log(`Attempting Coto ATG backend fallback for PLU [${cleanedQuery}]...`);
    const cookies = await fetchCotoCookies();
    const details = await fetchCotoAtgDetails(cleanedQuery, cookies);
    
    if (details) {
      console.log(`ATG fallback SUCCESS for PLU [${cleanedQuery}]:`, details.title);
      localCache[cleanedQuery] = details;
      saveCache();
      
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

  // 4. If everything fails
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
app.post('/api/register', (req, res) => {
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

  localCache[cleanedPlu] = cacheEntry;
  if (cleanedEan !== 'No disponible') {
    localCache[cleanedEan] = cacheEntry;
  }

  saveCache();
  console.log(`Manually registered product cache entry:`, cacheEntry);

  return res.json({ success: true, message: 'Producto registrado en la base de datos local' });
});

/**
 * GET all expirations
 */
app.get('/api/expirations', (req, res) => {
  res.json({ success: true, data: expirationsList });
});

/**
 * POST a new or updated expiration tracking
 */
app.post('/api/expirations', (req, res) => {
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

  if (id) {
    const index = expirationsList.findIndex(e => e.id === id);
    if (index !== -1) {
      item.createdAt = expirationsList[index].createdAt;
      expirationsList[index] = item;
    } else {
      expirationsList.push(item);
    }
  } else {
    expirationsList.push(item);
  }

  saveExpirations();
  res.json({ success: true, data: item });
});

/**
 * DELETE an expiration tracking
 */
app.delete('/api/expirations/:id', (req, res) => {
  const { id } = req.params;
  const initialCount = expirationsList.length;
  expirationsList = expirationsList.filter(e => e.id !== id);

  if (expirationsList.length < initialCount) {
    saveExpirations();
    res.json({ success: true, message: 'Vencimiento eliminado con éxito.' });
  } else {
    res.status(404).json({ success: false, error: 'No se encontró el registro.' });
  }
});

/**
 * WEB PUSH ENDPOINTS
 */

// Get public VAPID key
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Subscribe to push notifications
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ success: false, error: 'Objeto de suscripción inválido.' });
  }

  const exists = subscriptions.some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subscriptions.push(subscription);
    saveSubscriptions();
    console.log(`New client subscribed. Total subscriptions: ${subscriptions.length}`);
  }
  res.status(201).json({ success: true });
});

// Unsubscribe
app.post('/api/unsubscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ success: false, error: 'Suscripción inválida.' });
  }

  subscriptions = subscriptions.filter(s => s.endpoint !== subscription.endpoint);
  saveSubscriptions();
  console.log(`Client unsubscribed. Total subscriptions: ${subscriptions.length}`);
  res.json({ success: true });
});

// Test Push Notifications Endpoint (triggers a push in 10 seconds)
app.post('/api/test-push', (req, res) => {
  const delay = 10000;
  console.log(`Scheduling a test push to ${subscriptions.length} subscribers in ${delay / 1000}s...`);

  setTimeout(async () => {
    const payload = JSON.stringify({
      title: '🧪 Notificación de Prueba',
      body: '¡Funciona! Esta alerta se generó en segundo plano con la app cerrada.',
      url: '/'
    });

    const sendPromises = subscriptions.map(sub => {
      return webpush.sendNotification(sub, payload)
        .catch(err => {
          console.error('Failed to send push notification to subscription:', sub.endpoint.substring(0, 40) + '...', err.message);
          // If subscription has expired or is invalid, remove it
          if (err.statusCode === 410 || err.statusCode === 404) {
            subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
            saveSubscriptions();
          }
        });
    });

    await Promise.all(sendPromises);
    console.log('Test push notifications processing finished.');
  }, delay);

  res.json({ success: true, message: 'Notificación de prueba programada para dentro de 10 segundos. Ya puedes cerrar la app.' });
});

// Core Expiration checker function (sends push alerts for products expiring today)
async function checkAndSendPushNotifications() {
  console.log('Running daily expirations checker...');
  if (subscriptions.length === 0) {
    console.log('No active push subscriptions.');
    return;
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const expiringToday = expirationsList.filter(item => {
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

  for (const item of expiringToday) {
    const payload = JSON.stringify({
      title: '⚠️ Producto por Vencer Hoy',
      body: `"${item.title}" (PLU: ${item.plu || 'N/D'}) vence hoy. Consumir pronto.`,
      url: '/'
    });

    const sendPromises = subscriptions.map(sub => {
      return webpush.sendNotification(sub, payload)
        .catch(err => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
            saveSubscriptions();
          }
        });
    });

    await Promise.all(sendPromises);
  }
}

// Check every 12 hours
setInterval(checkAndSendPushNotifications, 12 * 60 * 60 * 1000);
// Check on startup after 15 seconds
setTimeout(checkAndSendPushNotifications, 15000);

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
