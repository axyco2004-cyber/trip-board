const { createHash, timingSafeEqual } = require('node:crypto');

const BOARD_KEY = 'ca2026:destination-guides';
const DESTINATIONS_KEY = 'ca2026:destination-catalog';
const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 3600;
const DEFAULT_DESTINATIONS = [
  { id: 'gothenburg', name: 'Gothenburg', country: 'Sweden', photoUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/45/Karlatornet_along_with_Gothenburg_skyline..jpg/960px-Karlatornet_along_with_Gothenburg_skyline..jpg', photoCreditLabel: 'Axadem · CC BY-SA 4.0', photoCreditUrl: 'https://commons.wikimedia.org/wiki/File:Karlatornet_along_with_Gothenburg_skyline..jpg' },
  { id: 'gdansk', name: 'Gdansk', country: 'Poland', photoUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/21/Gdansk_Gora_Gradowa_2.jpg/960px-Gdansk_Gora_Gradowa_2.jpg', photoCreditLabel: 'Andrzej Otrębski · CC BY-SA 3.0', photoCreditUrl: 'https://commons.wikimedia.org/wiki/File:Gdansk_Gora_Gradowa_2.jpg' },
  { id: 'oslo', name: 'Oslo', country: 'Norway', photoUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/ce/Oslo_Skyline%2C_drone.jpg/960px-Oslo_Skyline%2C_drone.jpg', photoCreditLabel: 'Sunderland Renaissance · CC BY-SA 4.0', photoCreditUrl: 'https://commons.wikimedia.org/wiki/File:Oslo_Skyline,_drone.jpg' },
  { id: 'helsinki', name: 'Helsinki', country: 'Finland', photoUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/99/Helsinki_Cathedral_2019.jpg/960px-Helsinki_Cathedral_2019.jpg', photoCreditLabel: 'Farzad Abedi · CC BY-SA 4.0', photoCreditUrl: 'https://commons.wikimedia.org/wiki/File:Helsinki_Cathedral_2019.jpg' },
  { id: 'stockholm', name: 'Stockholm', country: 'Sweden', photoUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/14/Stockholm_city_skyline_and_waterfront_at_night_%28April_2016%29.jpg/960px-Stockholm_city_skyline_and_waterfront_at_night_%28April_2016%29.jpg', photoCreditLabel: 'Micael Widell · CC BY 3.0', photoCreditUrl: 'https://commons.wikimedia.org/wiki/File:Stockholm_city_skyline_and_waterfront_at_night_(April_2016).jpg' },
  { id: 'others', name: 'Other', country: '', photoUrl: '', photoCreditLabel: '', photoCreditUrl: '', mapSearch: 'Europe' }
];
const DESTINATION_IDS = DEFAULT_DESTINATIONS.map(destination => destination.id);
const GUIDE_CATEGORIES = ['eat', 'visit', 'shopping', 'tips'];
const MAX_DESTINATIONS = 100;

function isAdminPasswordValid(req) {
  const supplied = req.headers['x-admin-password'];
  if (typeof process.env.CA2026_ADMIN_PASSWORD !== 'string'
    || process.env.CA2026_ADMIN_PASSWORD.length < 16
    || typeof supplied !== 'string') return false;
  const expectedHash = createHash('sha256').update(process.env.CA2026_ADMIN_PASSWORD).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  res.setHeader('Cache-Control', 'no-store');
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); }
    catch { return null; }
  }
  return {};
}

async function redisCommand(...command) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Shared guide storage is not configured.');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error('Shared guide storage request failed.');
  const result = await response.json();
  if (result.error) throw new Error('Shared guide storage command failed.');
  return result.result;
}

async function rateLimit(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = typeof forwardedFor === 'string' ? forwardedFor.split(',').pop().trim() : 'unknown';
  const ipHash = createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 24);
  const key = `ca2026:guide-rate:${ipHash}`;
  const count = await redisCommand('INCR', key);
  if (count === 1) await redisCommand('EXPIRE', key, RATE_WINDOW_SECONDS);
  return count <= RATE_LIMIT;
}

function isSafeUrl(value) {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isGoogleMapsUrl(value) {
  if (!isSafeUrl(value)) return false;
  try {
    const url = new URL(value);
    const supportedHost = url.hostname === 'google.com'
      || url.hostname.endsWith('.google.com')
      || url.hostname === 'goo.gl'
      || url.hostname === 'maps.app.goo.gl';
    return supportedHost
      && (url.hostname === 'maps.app.goo.gl' || url.pathname.startsWith('/maps'));
  } catch {
    return false;
  }
}

function validateGuide(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const country = typeof input.country === 'string' ? input.country.trim() : '';
  if (!name || name.length > 60 || country.length > 60) return null;
  if (!Array.isArray(input.hotels) || input.hotels.length !== 2) return null;

  const hotels = [];
  for (const hotel of input.hotels) {
    if (!hotel || typeof hotel !== 'object' || Array.isArray(hotel)) return null;
    const hotelName = typeof hotel.name === 'string' ? hotel.name.trim() : '';
    const location = typeof hotel.location === 'string' ? hotel.location.trim() : '';
    if (hotelName.length > 80 || location.length > 500) return null;
    if (location && !isGoogleMapsUrl(location)) return null;
    if (!hotel.lists || typeof hotel.lists !== 'object' || Array.isArray(hotel.lists)) return null;

    const lists = {};
    for (const category of GUIDE_CATEGORIES) {
      const items = hotel.lists[category];
      if (!Array.isArray(items) || items.length > 20
        || items.some(item => typeof item !== 'string' || item.trim().length > 2000)) return null;
      lists[category] = items.map(item => item.trim()).filter(Boolean);
    }
    hotels.push({ name: hotelName, location, lists });
  }

  const photoUrl = typeof input.photoUrl === 'string' ? input.photoUrl.trim() : '';
  const photoCreditLabel = typeof input.photoCreditLabel === 'string' ? input.photoCreditLabel.trim() : '';
  const photoCreditUrl = typeof input.photoCreditUrl === 'string' ? input.photoCreditUrl.trim() : '';
  const mapsUrl = typeof input.mapsUrl === 'string' ? input.mapsUrl.trim() : '';
  if (photoCreditLabel.length > 120 || !isSafeUrl(photoUrl) || !isSafeUrl(photoCreditUrl) || !isSafeUrl(mapsUrl)) return null;

  return { name, country, hotels, photoUrl, photoCreditLabel, photoCreditUrl, mapsUrl };
}

function parseSavedGuides(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !parsed.guides || typeof parsed.guides !== 'object') return {};
    return parsed.guides;
  } catch {
    return {};
  }
}

function parseDestinationCatalog(value) {
  if (typeof value !== 'string') return [...DEFAULT_DESTINATIONS];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.length) return [...DEFAULT_DESTINATIONS];
    if (parsed.some(destination => !destination
      || typeof destination.id !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(destination.id)
      || typeof destination.name !== 'string'
      || typeof destination.country !== 'string')) return [...DEFAULT_DESTINATIONS];
    return parsed;
  } catch {
    return [...DEFAULT_DESTINATIONS];
  }
}

function validateDestinationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const country = typeof input.country === 'string' ? input.country.trim() : '';
  const photoUrl = typeof input.photoUrl === 'string' ? input.photoUrl.trim() : '';
  const photoCreditLabel = typeof input.photoCreditLabel === 'string' ? input.photoCreditLabel.trim() : '';
  const photoCreditUrl = typeof input.photoCreditUrl === 'string' ? input.photoCreditUrl.trim() : '';
  if (!name || name.length > 60 || country.length > 60 || photoCreditLabel.length > 120
    || !isSafeUrl(photoUrl) || !isSafeUrl(photoCreditUrl)) return null;
  return { name, country, photoUrl, photoCreditLabel, photoCreditUrl };
}

function destinationIdForName(name, existingIds) {
  const base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'destination';
  let id = base;
  let suffix = 2;
  while (existingIds.has(id)) id = `${base}-${suffix++}`;
  return id;
}

function emptyGuide(destination) {
  return {
    name: destination.name,
    country: destination.country,
    hotels: [1, 2].map(index => ({
      name: `Hotel ${index}`,
      location: '',
      lists: Object.fromEntries(GUIDE_CATEGORIES.map(category => [category, []]))
    })),
    photoUrl: destination.photoUrl,
    photoCreditLabel: destination.photoCreditLabel,
    photoCreditUrl: destination.photoCreditUrl,
    mapsUrl: ''
  };
}

module.exports = async function handler(req, res) {
  setHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const catalogValue = await redisCommand('GET', DESTINATIONS_KEY);
      const destinations = parseDestinationCatalog(catalogValue);
      const extraIds = destinations.map(destination => destination.id).filter(id => !DESTINATION_IDS.includes(id));
      const keys = [BOARD_KEY, ...DESTINATION_IDS.map(id => `${BOARD_KEY}:${id}`), ...extraIds.map(id => `${BOARD_KEY}:${id}`)];
      const values = await redisCommand('MGET', ...keys);
      const guides = parseSavedGuides(values[0]);
      DESTINATION_IDS.forEach((id, index) => {
        if (typeof values[index + 1] !== 'string') return;
        try { guides[id] = JSON.parse(values[index + 1]); }
        catch { delete guides[id]; }
      });
      extraIds.forEach((id, index) => {
        const value = values[DESTINATION_IDS.length + 1 + index];
        if (typeof value !== 'string') return;
        try { guides[id] = JSON.parse(value); }
        catch { delete guides[id]; }
      });
      return res.status(200).json({ guides, destinations });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      if (body?.adminAction === 'verify') {
        if (!await rateLimit(req)) return sendError(res, 429, 'Too many admin attempts. Please try again later.');
        if (typeof process.env.CA2026_ADMIN_PASSWORD !== 'string'
          || process.env.CA2026_ADMIN_PASSWORD.length < 16) {
          return sendError(res, 503, 'Destination admin access is not configured.');
        }
        if (!isAdminPasswordValid(req)) return sendError(res, 401, 'Admin password is incorrect.');
        return res.status(200).json({ authorized: true });
      }
      if (['createDestination', 'renameDestination', 'deleteDestination'].includes(body?.adminAction)) {
        if (typeof process.env.CA2026_ADMIN_PASSWORD !== 'string'
          || process.env.CA2026_ADMIN_PASSWORD.length < 16) {
          return sendError(res, 503, 'Destination admin access is not configured.');
        }
        if (!isAdminPasswordValid(req)) return sendError(res, 401, 'Admin password is incorrect.');
        if (!await rateLimit(req)) return sendError(res, 429, 'Too many board edits. Please try again later.');

        const catalogValue = await redisCommand('GET', DESTINATIONS_KEY);
        const destinations = parseDestinationCatalog(catalogValue);
        if (body.adminAction === 'deleteDestination') {
          const destinationId = body.destinationId;
          if (typeof destinationId !== 'string' || !destinations.some(destination => destination.id === destinationId)) {
            return sendError(res, 400, 'Choose a valid destination.');
          }
          const script = [
            "local raw = redis.call('GET', KEYS[1])",
            "local destinations = raw and cjson.decode(raw) or cjson.decode(ARGV[1])",
            "if #destinations <= 1 then return -1 end",
            "for index, item in ipairs(destinations) do",
            "  if item.id == ARGV[2] then table.remove(destinations, index); redis.call('SET', KEYS[1], cjson.encode(destinations)); return 1 end",
            "end",
            "return 0"
          ].join('\n');
          const result = await redisCommand('EVAL', script, '1', DESTINATIONS_KEY,
            JSON.stringify(DEFAULT_DESTINATIONS), destinationId);
          if (result === -1) return sendError(res, 400, 'At least one destination must remain in the menu.');
          if (result !== 1) return sendError(res, 409, 'That destination is no longer in the menu. Refresh and try again.');
          return res.status(200).json({ destinationId, destinations: parseDestinationCatalog(await redisCommand('GET', DESTINATIONS_KEY)) });
        }
        if (body.adminAction === 'createDestination') {
          const input = validateDestinationInput(body.destination);
          if (!input) return sendError(res, 400, 'Enter a valid destination name and optional details.');
          if (destinations.length >= MAX_DESTINATIONS) return sendError(res, 400, 'The destination limit has been reached.');
          const reservedIds = new Set([...DESTINATION_IDS, ...destinations.map(destination => destination.id)]);
          let id = destinationIdForName(input.name, reservedIds);
          let suffix = 2;
          while (await redisCommand('EXISTS', `${BOARD_KEY}:${id}`)) {
            id = `${destinationIdForName(input.name, reservedIds)}-${suffix++}`;
          }
          const destination = { id, ...input, mapSearch: '' };
          const guide = emptyGuide(destination);
          const script = [
            "local raw = redis.call('GET', KEYS[1])",
            "local destinations = raw and cjson.decode(raw) or cjson.decode(ARGV[1])",
            "for _, item in ipairs(destinations) do if item.id == ARGV[2] then return 0 end end",
            "if #destinations >= tonumber(ARGV[4]) then return -1 end",
            "table.insert(destinations, cjson.decode(ARGV[3]))",
            "redis.call('SET', KEYS[1], cjson.encode(destinations))",
            "redis.call('SET', KEYS[2], ARGV[5])",
            "return 1"
          ].join('\n');
          const result = await redisCommand('EVAL', script, '2', DESTINATIONS_KEY, `${BOARD_KEY}:${id}`,
            JSON.stringify(DEFAULT_DESTINATIONS), id, JSON.stringify(destination), String(MAX_DESTINATIONS), JSON.stringify(guide));
          if (result !== 1) return sendError(res, result === -1 ? 400 : 409, 'Could not add that destination. Refresh and try again.');
          return res.status(201).json({ destination, guide });
        }

        const destinationId = body.destinationId;
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!destinations.some(destination => destination.id === destinationId)) {
          return sendError(res, 400, 'Choose a valid destination.');
        }
        if (!name || name.length > 60) return sendError(res, 400, 'Enter a destination name of up to 60 characters.');
        const guideValue = await redisCommand('GET', `${BOARD_KEY}:${destinationId}`);
        const legacyValue = guideValue === null ? await redisCommand('GET', BOARD_KEY) : null;
        const legacyGuides = parseSavedGuides(legacyValue);
        const currentGuide = guideValue === null ? legacyGuides[destinationId] : (() => {
          try { return JSON.parse(guideValue); } catch { return null; }
        })();
        const guide = validateGuide(currentGuide || emptyGuide(destinations.find(destination => destination.id === destinationId)));
        if (!guide) return sendError(res, 500, 'The destination guide cannot be renamed because its saved data is invalid.');
        guide.name = name;
        const renamedDestination = { ...destinations.find(destination => destination.id === destinationId), name };
        const script = [
          "local raw = redis.call('GET', KEYS[1])",
          "local destinations = raw and cjson.decode(raw) or cjson.decode(ARGV[1])",
          "local found = false",
          "for _, item in ipairs(destinations) do if item.id == ARGV[2] then item.name = ARGV[3]; found = true; break end end",
          "if not found then return 0 end",
          "redis.call('SET', KEYS[1], cjson.encode(destinations))",
          "redis.call('SET', KEYS[2], ARGV[4])",
          "return 1"
        ].join('\n');
        const result = await redisCommand('EVAL', script, '2', DESTINATIONS_KEY, `${BOARD_KEY}:${destinationId}`,
          JSON.stringify(DEFAULT_DESTINATIONS), destinationId, name, JSON.stringify(guide));
        if (result !== 1) return sendError(res, 409, 'Could not rename that destination. Refresh and try again.');
        return res.status(200).json({ destination: renamedDestination, guide });
      }

      if (!await rateLimit(req)) return sendError(res, 429, 'Too many board edits. Please try again later.');
      if (!body || typeof body !== 'object' || !body.guides || typeof body.guides !== 'object') {
        return sendError(res, 400, 'A complete destination guide set is required.');
      }
      const guides = {};
      for (const id of DESTINATION_IDS) {
        guides[id] = validateGuide(body.guides[id]);
        if (!guides[id]) return sendError(res, 400, `The ${id} destination guide is invalid.`);
      }
      const result = await redisCommand('SET', BOARD_KEY, JSON.stringify({ guides }), 'NX');
      return res.status(result === 'OK' ? 201 : 409).json({ created: result === 'OK' });
    }

    if (req.method === 'PUT') {
      if (!await rateLimit(req)) return sendError(res, 429, 'Too many board edits. Please try again later.');
      const body = parseBody(req);
      if (!body || typeof body !== 'object' || typeof body.destinationId !== 'string') {
        return sendError(res, 400, 'Choose a valid destination.');
      }
      const guide = validateGuide(body.guide);
      if (!guide) return sendError(res, 400, 'The destination guide is invalid.');
      const catalogValue = await redisCommand('GET', DESTINATIONS_KEY);
      const destination = parseDestinationCatalog(catalogValue).find(item => item.id === body.destinationId);
      if (!destination) return sendError(res, 400, 'Choose a valid destination.');
      guide.name = destination.name;
      await redisCommand('SET', `${BOARD_KEY}:${body.destinationId}`, JSON.stringify(guide));
      return res.status(200).json({ destinationId: body.destinationId, guide });
    }

    res.setHeader('Allow', 'GET, POST, PUT, OPTIONS');
    return sendError(res, 405, 'Method not allowed.');
  } catch (error) {
    console.error('Shared destination guide API request failed.', {
      method: req.method,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    });
    return sendError(res, 500, 'Could not access shared destination guides.');
  }
};
