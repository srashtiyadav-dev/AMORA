'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const MAX_AGE = 120 * 24 * 60 * 60;
const E164 = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');
if (!DATABASE_URL) throw new Error('DATABASE_URL is required.');

const pool = new Pool({ connectionString: DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });
const app = express();
const server = http.createServer(app);
const allowedOrigins = new Set((process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (!origin || !allowedOrigins.size || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed.'));
    },
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 32_000,
});

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc: ["'self'", 'data:', 'https://images.unsplash.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      mediaSrc: ["'self'", 'blob:'],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '24kb', strict: true }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 45, standardHeaders: true, legacyHeaders: false });

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function cleanText(value, max, fallback = '') {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

function cleanList(value, maxItems = 12, maxLength = 40) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim().slice(0, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function preferencesAllow(preferences, gender) {
  return !preferences?.length || preferences.includes('Everyone') ||
    (gender === 'Woman' && preferences.includes('Women')) ||
    (gender === 'Man' && preferences.includes('Men')) || preferences.includes(gender);
}

function ageFromBirthDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const birth = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(birth.getTime()) || birth.toISOString().slice(0, 10) !== value) return null;
  const today = new Date();
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  if (today.getUTCMonth() < birth.getUTCMonth() || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function issueToken(userId) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: userId, iat: now, exp: now + MAX_AGE, iss: 'kindred' }));
  const content = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(content).digest('base64url');
  return `${content}.${signature}`;
}

function readToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const content = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(content).digest();
  let actual;
  try { actual = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!UUID.test(payload.sub) || payload.iss !== 'kindred' || payload.exp <= Date.now() / 1000) return null;
    return payload.sub;
  } catch { return null; }
}

function requireAuth(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const userId = match && readToken(match[1]);
  if (!userId) return jsonError(res, 401, 'Sign in again to continue.');
  req.userId = userId;
  return next();
}

function compareTwilioCredentials() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !process.env.TWILIO_VERIFY_SERVICE_SID) {
    const error = new Error('Phone sign-in is not configured. Add Twilio Verify credentials.');
    error.status = 503;
    throw error;
  }
  return `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')}`;
}

async function twilioVerify(pathPart, fields) {
  const auth = compareTwilioCredentials();
  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(process.env.TWILIO_VERIFY_SERVICE_SID)}/${pathPart}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 429 ? 'Too many verification attempts. Wait before trying again.' : 'Phone verification service could not complete the request.');
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }
  return body;
}

async function loadProfile(userId) {
  const { rows } = await pool.query(`
    SELECT user_id AS id, display_name AS "displayName", birth_date AS "birthDate",
      date_part('year', age(birth_date))::int AS age,
      gender, interested_in AS "interestedIn", relationship_goal AS "relationshipGoal",
      city, bio, interests, photo_url AS "photoUrl", updated_at AS "updatedAt"
    FROM profiles WHERE user_id = $1`, [userId]);
  return rows[0] || null;
}

async function matchMembership(matchId, userId) {
  if (!UUID.test(matchId)) return false;
  const { rowCount } = await pool.query(`
    SELECT 1 FROM matches m
    WHERE m.id = $1 AND (m.user_a = $2 OR m.user_b = $2)
      AND NOT EXISTS (
        SELECT 1 FROM blocks b WHERE
          (b.blocker_id = m.user_a AND b.blocked_id = m.user_b) OR
          (b.blocker_id = m.user_b AND b.blocked_id = m.user_a)
      )`, [matchId, userId]);
  return rowCount > 0;
}

async function runSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/start', authLimiter, async (req, res, next) => {
  const phone = cleanText(req.body?.phone, 24);
  if (!E164.test(phone)) return jsonError(res, 400, 'Use an international phone number such as +14155552671.');
  try {
    await twilioVerify('Verifications', { To: phone, Channel: 'sms' });
    return res.json({ ok: true, message: 'Verification code sent.' });
  } catch (error) { return next(error); }
});

app.post('/api/auth/verify', authLimiter, async (req, res, next) => {
  const phone = cleanText(req.body?.phone, 24);
  const code = cleanText(req.body?.code, 10);
  if (!E164.test(phone) || !/^\d{4,10}$/.test(code)) return jsonError(res, 400, 'Enter a valid phone number and verification code.');
  try {
    const result = await twilioVerify('VerificationCheck', { To: phone, Code: code });
    if (result.status !== 'approved') return jsonError(res, 401, 'That code is invalid or has expired.');
    const { rows } = await pool.query(`
      INSERT INTO users (phone_e164) VALUES ($1)
      ON CONFLICT (phone_e164) DO UPDATE SET last_seen_at = now()
      RETURNING id`, [phone]);
    const userId = rows[0].id;
    return res.json({ token: issueToken(userId), profile: await loadProfile(userId) });
  } catch (error) { return next(error); }
});

app.get('/api/me', requireAuth, async (req, res, next) => {
  try {
    const profile = await loadProfile(req.userId);
    return res.json({ profile });
  } catch (error) { return next(error); }
});

app.put('/api/profile', requireAuth, writeLimiter, async (req, res, next) => {
  const body = req.body || {};
  const displayName = cleanText(body.displayName, 40);
  const birthDate = cleanText(body.birthDate, 10);
  const age = ageFromBirthDate(birthDate);
  const gender = cleanText(body.gender, 40);
  const relationshipGoal = cleanText(body.relationshipGoal, 80);
  const interestedIn = cleanList(body.interestedIn, 8, 40);
  const city = cleanText(body.city, 100);
  const bio = cleanText(body.bio, 500);
  const interests = cleanList(body.interests, 12, 40);
  const photoUrl = cleanText(body.photoUrl, 2048);
  if (displayName.length < 1 || !age || age < 18 || age > 120) return jsonError(res, 400, 'Profiles are for adults 18 and older. Enter a valid date of birth.');
  if (!gender || !relationshipGoal) return jsonError(res, 400, 'Choose a gender and relationship goal.');
  if (photoUrl && !/^https:\/\/images\.unsplash\.com\//i.test(photoUrl)) return jsonError(res, 400, 'Profile photos must use the approved HTTPS image host.');
  try {
    await pool.query(`
      INSERT INTO profiles (user_id, display_name, birth_date, gender, interested_in, relationship_goal, city, bio, interests, photo_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (user_id) DO UPDATE SET
        display_name=EXCLUDED.display_name, birth_date=EXCLUDED.birth_date,
        gender=EXCLUDED.gender, interested_in=EXCLUDED.interested_in,
        relationship_goal=EXCLUDED.relationship_goal, city=EXCLUDED.city,
        bio=EXCLUDED.bio, interests=EXCLUDED.interests, photo_url=EXCLUDED.photo_url,
        updated_at=now()`, [req.userId, displayName, birthDate, gender, interestedIn, relationshipGoal, city, bio, interests, photoUrl]);
    return res.json({ profile: await loadProfile(req.userId) });
  } catch (error) { return next(error); }
});

app.get('/api/profiles', requireAuth, async (req, res, next) => {
  const search = cleanText(req.query.search, 100);
  const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 50);
  try {
    const me = await loadProfile(req.userId);
    if (!me) return jsonError(res, 409, 'Complete your profile before discovering people.');
    const { rows } = await pool.query(`
      SELECT p.user_id AS id, p.display_name AS "displayName",
        date_part('year', age(p.birth_date))::int AS age,
        p.gender, p.relationship_goal AS "relationshipGoal", p.city, p.bio,
        p.interests, p.photo_url AS "photoUrl"
      FROM profiles p
      WHERE p.user_id <> $1
        AND (cardinality($2::text[]) = 0 OR 'Everyone' = ANY($2::text[]) OR
          (p.gender='Woman' AND 'Women' = ANY($2::text[])) OR (p.gender='Man' AND 'Men' = ANY($2::text[])) OR p.gender=ANY($2::text[]))
        AND (cardinality(p.interested_in) = 0 OR 'Everyone' = ANY(p.interested_in) OR
          ($3='Woman' AND 'Women'=ANY(p.interested_in)) OR ($3='Man' AND 'Men'=ANY(p.interested_in)) OR $3=ANY(p.interested_in))
        AND NOT EXISTS (SELECT 1 FROM likes l WHERE l.from_user = $1 AND l.to_user = p.user_id)
        AND NOT EXISTS (SELECT 1 FROM passes x WHERE x.from_user = $1 AND x.to_user = p.user_id)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=p.user_id) OR (b.blocker_id=p.user_id AND b.blocked_id=$1))
        AND NOT EXISTS (SELECT 1 FROM matches m WHERE (m.user_a=$1 AND m.user_b=p.user_id) OR (m.user_a=p.user_id AND m.user_b=$1))
        AND ($4 = '' OR concat_ws(' ', p.display_name, p.city, p.relationship_goal, p.bio, array_to_string(p.interests, ' ')) ILIKE '%' || $4 || '%')
      ORDER BY p.updated_at DESC LIMIT $5`, [req.userId, me.interestedIn, me.gender, search, limit]);
    return res.json({ profiles: rows });
  } catch (error) { return next(error); }
});

app.post('/api/profiles/:profileId/pass', requireAuth, writeLimiter, async (req, res, next) => {
  const targetId = req.params.profileId.toLowerCase();
  if (!UUID.test(targetId) || targetId === req.userId) return jsonError(res, 400, 'Choose another profile.');
  try {
    const { rowCount } = await pool.query('SELECT 1 FROM profiles WHERE user_id=$1', [targetId]);
    if (!rowCount) return jsonError(res, 404, 'Profile not found.');
    await pool.query('INSERT INTO passes (from_user,to_user) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, targetId]);
    return res.status(204).end();
  } catch (error) { return next(error); }
});

app.post('/api/likes/:profileId', requireAuth, writeLimiter, async (req, res, next) => {
  const targetId = req.params.profileId.toLowerCase();
  if (!UUID.test(targetId) || targetId === req.userId) return jsonError(res, 400, 'Choose another profile.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount: targetExists } = await client.query('SELECT 1 FROM profiles WHERE user_id=$1', [targetId]);
    if (!targetExists) { await client.query('ROLLBACK'); return jsonError(res, 404, 'Profile not found.'); }
    const { rows: preferences } = await client.query(`SELECT me.gender AS my_gender, me.interested_in AS my_preferences,
      other.gender AS other_gender, other.interested_in AS other_preferences
      FROM profiles me CROSS JOIN profiles other WHERE me.user_id=$1 AND other.user_id=$2`, [req.userId,targetId]);
    if (!preferences.length || !preferencesAllow(preferences[0].my_preferences, preferences[0].other_gender) || !preferencesAllow(preferences[0].other_preferences, preferences[0].my_gender)) {
      await client.query('ROLLBACK'); return jsonError(res, 403, 'This profile does not match both users’ preferences.');
    }
    const { rowCount: blocked } = await client.query('SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)', [req.userId, targetId]);
    if (blocked) { await client.query('ROLLBACK'); return jsonError(res, 403, 'This profile is unavailable.'); }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [[req.userId,targetId].sort().join(':')]);
    await client.query('INSERT INTO likes (from_user,to_user) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, targetId]);
    const { rowCount: mutual } = await client.query('SELECT 1 FROM likes WHERE from_user=$1 AND to_user=$2', [targetId, req.userId]);
    let match = null;
    if (mutual) {
      const [userA, userB] = [req.userId, targetId].sort();
      const { rows } = await client.query(`INSERT INTO matches (user_a,user_b) VALUES ($1,$2)
        ON CONFLICT (user_a,user_b) DO UPDATE SET user_a=EXCLUDED.user_a RETURNING id`, [userA, userB]);
      match = { id: rows[0].id };
    }
    await client.query('COMMIT');
    return res.status(201).json({ liked: true, matched: Boolean(match), match });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return next(error);
  } finally { client.release(); }
});

app.get('/api/matches', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.created_at AS "createdAt", p.user_id AS "profileId",
        p.display_name AS "displayName", date_part('year', age(p.birth_date))::int AS age,
        p.city, p.photo_url AS "photoUrl", p.relationship_goal AS "relationshipGoal",
        (SELECT json_build_object('body', msg.body, 'createdAt', msg.created_at, 'senderId', msg.sender_id)
         FROM messages msg WHERE msg.match_id=m.id ORDER BY msg.created_at DESC LIMIT 1) AS "lastMessage"
      FROM matches m
      JOIN profiles p ON p.user_id = CASE WHEN m.user_a=$1 THEN m.user_b ELSE m.user_a END
      WHERE (m.user_a=$1 OR m.user_b=$1)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=m.user_a AND b.blocked_id=m.user_b) OR (b.blocker_id=m.user_b AND b.blocked_id=m.user_a))
      ORDER BY COALESCE((SELECT max(msg.created_at) FROM messages msg WHERE msg.match_id=m.id),m.created_at) DESC`, [req.userId]);
    return res.json({ matches: rows });
  } catch (error) { return next(error); }
});

app.get('/api/matches/:matchId/messages', requireAuth, async (req, res, next) => {
  if (!await matchMembership(req.params.matchId, req.userId)) return jsonError(res, 404, 'Conversation not found.');
  const before = req.query.before ? new Date(req.query.before) : null;
  if (before && Number.isNaN(before.getTime())) return jsonError(res, 400, 'Invalid message cursor.');
  try {
    const { rows } = await pool.query(`SELECT id, match_id AS "matchId", sender_id AS "senderId", body, created_at AS "createdAt"
      FROM messages WHERE match_id=$1 AND ($2::timestamptz IS NULL OR created_at<$2)
      ORDER BY created_at DESC LIMIT 50`, [req.params.matchId, before]);
    return res.json({ messages: rows.reverse() });
  } catch (error) { return next(error); }
});

async function saveMessage(matchId, senderId, body) {
  const { rows } = await pool.query(`INSERT INTO messages (match_id,sender_id,body) VALUES ($1,$2,$3)
    RETURNING id,match_id AS "matchId",sender_id AS "senderId",body,created_at AS "createdAt"`, [matchId, senderId, body]);
  return rows[0];
}

app.post('/api/matches/:matchId/messages', requireAuth, writeLimiter, async (req, res, next) => {
  const body = cleanText(req.body?.body, 2000);
  if (!body) return jsonError(res, 400, 'Write a message first.');
  try {
    if (!await matchMembership(req.params.matchId, req.userId)) return jsonError(res, 404, 'Conversation not found.');
    const message = await saveMessage(req.params.matchId, req.userId, body);
    io.to(`match:${req.params.matchId}`).emit('message:new', message);
    return res.status(201).json({ message });
  } catch (error) { return next(error); }
});

app.post('/api/profiles/:profileId/block', requireAuth, writeLimiter, async (req, res, next) => {
  const targetId = req.params.profileId.toLowerCase();
  if (!UUID.test(targetId) || targetId === req.userId) return jsonError(res, 400, 'Choose another profile.');
  try {
    const { rowCount } = await pool.query('SELECT 1 FROM users WHERE id=$1', [targetId]);
    if (!rowCount) return jsonError(res, 404, 'Profile not found.');
    await pool.query('INSERT INTO blocks (blocker_id,blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, targetId]);
    return res.status(204).end();
  } catch (error) { return next(error); }
});

app.post('/api/profiles/:profileId/report', requireAuth, writeLimiter, async (req, res, next) => {
  const targetId = req.params.profileId.toLowerCase();
  const reason = cleanText(req.body?.reason, 80);
  const details = cleanText(req.body?.details, 1000);
  if (!UUID.test(targetId) || targetId === req.userId) return jsonError(res, 400, 'Choose another profile.');
  if (reason.length < 2) return jsonError(res, 400, 'Choose a reason for the report.');
  try {
    const { rowCount } = await pool.query('SELECT 1 FROM users WHERE id=$1', [targetId]);
    if (!rowCount) return jsonError(res, 404, 'Profile not found.');
    await pool.query('INSERT INTO reports (reporter_id,reported_id,reason,details) VALUES ($1,$2,$3,$4)', [req.userId, targetId, reason, details]);
    return res.status(201).json({ received: true });
  } catch (error) { return next(error); }
});

app.get('/config.js', (_req, res) => res.type('application/javascript').send('window.KINDRED_CONFIG={backend:true};'));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(ROOT, 'app.js')));
app.get('/styles.css', (_req, res) => res.sendFile(path.join(ROOT, 'styles.css')));
app.use('/api', (_req, res) => jsonError(res, 404, 'API route not found.'));
app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error.status) return jsonError(res, error.status, error.message);
  if (error.type === 'entity.too.large') return jsonError(res, 413, 'Request is too large.');
  console.error('Request failed:', error.message);
  return jsonError(res, 500, 'Something went wrong. Try again.');
});

io.use((socket, next) => {
  const userId = readToken(socket.handshake.auth?.token);
  if (!userId) return next(new Error('Sign in required.'));
  socket.data.userId = userId;
  return next();
});

io.on('connection', (socket) => {
  socket.on('match:join', async (matchId, acknowledge = () => {}) => {
    try {
      if (!await matchMembership(matchId, socket.data.userId)) return acknowledge({ ok: false, error: 'Conversation not found.' });
      await socket.join(`match:${matchId}`);
      return acknowledge({ ok: true });
    } catch { return acknowledge({ ok: false, error: 'Could not join conversation.' }); }
  });

  socket.on('match:message', async (payload, acknowledge = () => {}) => {
    const matchId = payload?.matchId;
    const body = cleanText(payload?.body, 2000);
    const last = socket.data.lastMessageAt || 0;
    if (Date.now() - last < 500) return acknowledge({ ok: false, error: 'Please slow down.' });
    if (!body || !await matchMembership(matchId, socket.data.userId)) return acknowledge({ ok: false, error: 'Conversation not found.' });
    try {
      socket.data.lastMessageAt = Date.now();
      const message = await saveMessage(matchId, socket.data.userId, body);
      io.to(`match:${matchId}`).emit('message:new', message);
      return acknowledge({ ok: true, message });
    } catch { return acknowledge({ ok: false, error: 'Message could not be sent.' }); }
  });

  socket.on('call:signal', async (payload, acknowledge = () => {}) => {
    const matchId = payload?.matchId;
    const type = payload?.type;
    const data = payload?.data;
    if (!['offer', 'answer', 'ice', 'start', 'ready', 'end'].includes(type) || !await matchMembership(matchId, socket.data.userId)) {
      return acknowledge({ ok: false, error: 'Call signaling is not allowed.' });
    }
    if (JSON.stringify(data ?? null).length > 20_000) return acknowledge({ ok: false, error: 'Signal payload is too large.' });
    socket.to(`match:${matchId}`).emit('call:signal', { matchId, type, data, from: socket.data.userId });
    return acknowledge({ ok: true });
  });
});

async function start() {
  await runSchema();
  await pool.query('SELECT 1');
  server.listen(PORT, '0.0.0.0', () => console.log(`Kindred listening on ${PORT}`));
}

start().catch((error) => {
  console.error('Kindred could not start:', error.message);
  process.exitCode = 1;
});

async function shutdown() {
  io.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
