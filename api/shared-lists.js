const { createHash } = require('node:crypto');

const PLACES_KEY = 'ca2026:places';
const CREW_KEY = 'ca2026:crew';
const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 3600;
const PLACE_CATEGORIES = new Set(['eat', 'shop', 'visit']);

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
  if (!url || !token) throw new Error('Shared list storage is not configured.');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `******`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error('Shared list storage request failed.');
  const result = await response.json();
  if (result.error) throw new Error('Shared list storage command failed.');
  return result.result;
}

async function rateLimit(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = typeof forwardedFor === 'string' ? forwardedFor.split(',').pop().trim() : 'unknown';
  const ipHash = createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 24);
  const key = `ca2026:shared-list-rate:${ipHash}`;
  const count = await redisCommand('INCR', key);
  if (count === 1) await redisCommand('EXPIRE', key, RATE_WINDOW_SECONDS);
  return count <= RATE_LIMIT;
}

function validatePlaces(input) {
  if (!Array.isArray(input) || input.length > 500) return null;
  const places = [];
  for (const place of input) {
    if (!place || typeof place !== 'object' || Array.isArray(place)) return null;
    const id = typeof place.id === 'string' ? place.id : '';
    const name = typeof place.name === 'string' ? place.name.trim() : '';
    const category = place.category;
    const area = typeof place.area === 'string' ? place.area.trim() : '';
    const note = typeof place.note === 'string' ? place.note.trim() : '';
    const map = typeof place.map === 'string' ? place.map.trim() : '';
    const by = typeof place.by === 'string' ? place.by.trim() : '';
    if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(id) || !name || name.length > 80
      || !PLACE_CATEGORIES.has(category) || area.length > 60 || note.length > 180 || by.length > 30) return null;
    if (map) {
      try {
        const url = new URL(map);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      } catch {
        return null;
      }
    }
    places.push({ id, name, category, area, note, map, by });
  }
  return places;
}

function validateCrew(input) {
  if (!Array.isArray(input) || input.length > 50
    || input.some(name => typeof name !== 'string' || !name.trim() || name.trim().length > 60)) return null;
  return [...new Map(input.map(name => {
    const trimmed = name.trim();
    return [trimmed.toLocaleLowerCase(), trimmed];
  })).values()];
}

function parseStoredList(value, validate) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Stored shared list was invalid.');
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('Stored shared list was invalid.'); }
  const validated = validate(parsed);
  if (!validated) throw new Error('Stored shared list did not pass validation.');
  return validated;
}

module.exports = async function handler(req, res) {
  setHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const [placesValue, crewValue] = await redisCommand('MGET', PLACES_KEY, CREW_KEY);
      return res.status(200).json({
        places: parseStoredList(placesValue, validatePlaces),
        crew: parseStoredList(crewValue, validateCrew)
      });
    }

    if (req.method === 'POST') {
      if (!await rateLimit(req)) return sendError(res, 429, 'Too many board edits. Please try again later.');
      const body = parseBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'Invalid request body.');
      const initialLists = {};
      if (Object.hasOwn(body, 'places')) {
        initialLists.places = validatePlaces(body.places);
        if (!initialLists.places) return sendError(res, 400, 'The places list is invalid.');
      }
      if (Object.hasOwn(body, 'crew')) {
        initialLists.crew = validateCrew(body.crew);
        if (!initialLists.crew) return sendError(res, 400, 'The crew list is invalid.');
      }
      if (!Object.keys(initialLists).length) return sendError(res, 400, 'At least one shared list is required.');

      const initialized = {};
      if (Object.hasOwn(initialLists, 'places')) {
        initialized.places = await redisCommand('SET', PLACES_KEY, JSON.stringify(initialLists.places), 'NX') === 'OK';
      }
      if (Object.hasOwn(initialLists, 'crew')) {
        initialized.crew = await redisCommand('SET', CREW_KEY, JSON.stringify(initialLists.crew), 'NX') === 'OK';
      }
      return res.status(200).json({ initialized });
    }

    if (req.method === 'PUT') {
      if (!await rateLimit(req)) return sendError(res, 429, 'Too many board edits. Please try again later.');
      const body = parseBody(req);
      if (!body || typeof body !== 'object' || !['places', 'crew'].includes(body.list)) {
        return sendError(res, 400, 'Choose a valid shared list.');
      }
      const validate = body.list === 'places' ? validatePlaces : validateCrew;
      const items = validate(body.items);
      if (!items) return sendError(res, 400, `The ${body.list} list is invalid.`);
      const key = body.list === 'places' ? PLACES_KEY : CREW_KEY;
      await redisCommand('SET', key, JSON.stringify(items));
      return res.status(200).json({ list: body.list, items });
    }

    res.setHeader('Allow', 'GET, POST, PUT, OPTIONS');
    return sendError(res, 405, 'Method not allowed.');
  } catch (error) {
    console.error('Shared list API request failed.', {
      method: req.method,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    });
    return sendError(res, 500, 'Could not access shared board lists.');
  }
};
