const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');

const COMMENTS_KEY = 'ca2026:session-posts';
const RATE_LIMIT = 40;
const RATE_WINDOW_SECONDS = 3600;
const VALID_DESTINATIONS = new Set(['gothenburg', 'gdansk', 'oslo', 'helsinki', 'stockholm', 'others']);

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

function postFromRecord(record) {
  const { ownerTokenHash, ...post } = record;
  return post;
}

function validatePost(input) {
  if (!input || typeof input !== 'object') return null;
  const author = typeof input.author === 'string' ? input.author.trim() : '';
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const destinationId = input.destinationId;
  const hotel = input.hotel;
  const type = input.type;
  const createdAt = typeof input.createdAt === 'string' ? new Date(input.createdAt) : new Date();
  const id = typeof input.id === 'string' ? input.id : randomUUID();
  const deleteToken = input.deleteToken;

  if (!author || author.length > 50 || !text || text.length > 800
    || !VALID_DESTINATIONS.has(destinationId)
    || !['general', '1', '2'].includes(hotel)
    || !['tip', 'comment'].includes(type)
    || Number.isNaN(createdAt.getTime())
    || !/^[a-zA-Z0-9._:-]{1,80}$/.test(id)
    || typeof deleteToken !== 'string' || !/^[a-f0-9]{64}$/i.test(deleteToken)) {
    return null;
  }

  return {
    post: {
      id,
      author,
      type,
      text,
      destinationId,
      hotel,
      createdAt: createdAt.toISOString()
    },
    ownerTokenHash: createHash('sha256').update(deleteToken).digest('hex')
  };
}

function safeTokenMatch(storedHash, deleteToken) {
  if (typeof storedHash !== 'string' || typeof deleteToken !== 'string') return false;
  const stored = Buffer.from(storedHash, 'hex');
  const supplied = createHash('sha256').update(deleteToken).digest();
  return stored.length === supplied.length && timingSafeEqual(stored, supplied);
}

async function redisCommand(...command) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Comment storage is not configured.');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error('Comment storage request failed.');
  const result = await response.json();
  if (result.error) throw new Error('Comment storage command failed.');
  return result.result;
}

async function rateLimit(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = typeof forwardedFor === 'string' ? forwardedFor.split(',').pop().trim() : 'unknown';
  const ipHash = createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 24);
  const key = `ca2026:comment-rate:${ipHash}`;
  const count = await redisCommand('INCR', key);
  if (count === 1) await redisCommand('EXPIRE', key, RATE_WINDOW_SECONDS);
  return count <= RATE_LIMIT;
}

async function readRecords() {
  const values = await redisCommand('LRANGE', COMMENTS_KEY, 0, -1);
  return values.map(value => {
    try { return { raw: value, record: JSON.parse(value) }; }
    catch { return null; }
  }).filter(Boolean);
}

module.exports = async function handler(req, res) {
  setHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const records = await readRecords();
      const posts = records
        .map(({ record }) => postFromRecord(record))
        .filter(post => VALID_DESTINATIONS.has(post.destinationId))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=20');
      return res.status(200).json({ posts });
    }

    if (req.method === 'POST') {
      if (!await rateLimit(req)) return sendError(res, 429, 'Too many posts. Please try again later.');
      const body = parseBody(req);
      if (!body || typeof body !== 'object') return sendError(res, 400, 'Invalid request body.');
      const inputs = Array.isArray(body.posts) ? body.posts : [body];
      if (!inputs.length || inputs.length > 50) return sendError(res, 400, 'Invalid number of posts.');

      const normalizedPosts = inputs.map(validatePost);
      if (normalizedPosts.some(post => !post)) return sendError(res, 400, 'One or more posts are invalid.');
      const existingIds = new Set((await readRecords()).map(({ record }) => record.id));
      const newRecords = normalizedPosts
        .filter(({ post }) => !existingIds.has(post.id))
        .map(({ post, ownerTokenHash }) => JSON.stringify({ ...post, ownerTokenHash }));
      if (newRecords.length) {
        await redisCommand('LPUSH', COMMENTS_KEY, ...newRecords);
      }
      return res.status(201).json({ posts: normalizedPosts.map(({ post }) => post) });
    }

    if (req.method === 'DELETE') {
      if (!await rateLimit(req)) return sendError(res, 429, 'Too many requests. Please try again later.');
      const body = parseBody(req);
      if (!body || typeof body !== 'object') return sendError(res, 400, 'Invalid request body.');
      if (typeof body.id !== 'string' || typeof body.deleteToken !== 'string') {
        return sendError(res, 400, 'A post ID and deletion token are required.');
      }
      const records = await readRecords();
      const target = records.find(({ record }) => record.id === body.id
        && safeTokenMatch(record.ownerTokenHash, body.deleteToken));
      if (!target) return sendError(res, 404, 'Post not found or deletion is not permitted.');
      await redisCommand('LREM', COMMENTS_KEY, 1, target.raw);
      return res.status(204).end();
    }

    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    return sendError(res, 405, 'Method not allowed.');
  } catch (error) {
    console.error('Shared comments API request failed.', {
      method: req.method,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    });
    return sendError(res, 500, 'Could not access shared comments.');
  }
};
