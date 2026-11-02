const { createHash } = require('node:crypto');

const BOARD_KEY = 'ca2026:destination-guides';
const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 3600;
const DESTINATION_IDS = ['gothenburg', 'gdansk', 'oslo', 'helsinki', 'stockholm', 'others'];
const GUIDE_CATEGORIES = ['eat', 'visit', 'shopping', 'tips'];

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    if (location && !isSafeUrl(location) && !/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(location)) return null;
    if (!hotel.lists || typeof hotel.lists !== 'object' || Array.isArray(hotel.lists)) return null;

    const lists = {};
    for (const category of GUIDE_CATEGORIES) {
      const items = hotel.lists[category];
      if (!Array.isArray(items) || items.length > 20
        || items.some(item => typeof item !== 'string' || item.trim().length > 200)) return null;
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

module.exports = async function handler(req, res) {
  setHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const keys = [BOARD_KEY, ...DESTINATION_IDS.map(id => `${BOARD_KEY}:${id}`)];
      const values = await redisCommand('MGET', ...keys);
      const guides = parseSavedGuides(values[0]);
      DESTINATION_IDS.forEach((id, index) => {
        if (typeof values[index + 1] !== 'string') return;
        try { guides[id] = JSON.parse(values[index + 1]); }
        catch { delete guides[id]; }
      });
      return res.status(200).json({ guides });
    }

    if (req.method === 'POST') {
      if (!await rateLimit(req)) return sendError(res, 429, 'Too many board edits. Please try again later.');
      const body = parseBody(req);
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
      if (!body || typeof body !== 'object' || !DESTINATION_IDS.includes(body.destinationId)) {
        return sendError(res, 400, 'Choose a valid destination.');
      }
      const guide = validateGuide(body.guide);
      if (!guide) return sendError(res, 400, 'The destination guide is invalid.');
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
