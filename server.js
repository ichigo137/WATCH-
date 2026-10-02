import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
let Pool = null;
if (process.env.DATABASE_URL) {
  try { ({ Pool } = await import('pg')); }
  catch (error) { console.error('pg package unavailable; using in-memory rooms:', error.message); }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const ROOM_TTL_MS = 30 * 60 * 1000;
const ROOM_DB_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VIDEO_SOURCE_URL = 'https://savedly.net/f/5xky73v6';
const SAVEDLY_CACHE_TTL_MS = 60_000;
const savedlyStreamCache = new Map();
const rooms = new Map();

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
    })
  : null;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

function json(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function ebmlVint(buffer, offset, stripMarker = true) {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > buffer.length) return null;
  let value = stripMarker ? (first & (mask - 1)) : first;
  for (let i = 1; i < length; i += 1) value = value * 256 + buffer[offset + i];
  return { length, value };
}

function ebmlId(buffer, offset) {
  const first = buffer[offset];
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && !(first & mask)) {
    length += 1;
    mask >>= 1;
  }
  if (length > 4 || offset + length > buffer.length) return null;
  let value = first;
  for (let i = 1; i < length; i += 1) value = value * 256 + buffer[offset + i];
  return { length, value };
}

function readEbmlElements(buffer, start, end, callback) {
  let offset = start;
  while (offset + 2 <= end) {
    const id = ebmlId(buffer, offset);
    if (!id) break;
    const size = ebmlVint(buffer, offset + id.length, true);
    if (!size) break;
    const dataStart = offset + id.length + size.length;
    if (dataStart > end) break;
    const dataEnd = Math.min(end, dataStart + size.value);
    callback(id.value, dataStart, dataEnd, {
      idLength: id.length,
      sizeOffset: offset + id.length,
      sizeLength: size.length,
      sizeValue: size.value,
      elementStart: offset,
    });
    if (dataEnd <= offset) break;
    offset = dataEnd;
  }
}

function findSavedlyHindiAudioPatch(buffer) {
  let tracksStart = -1;
  let tracksEnd = -1;
  let tracksMeta = null;
  readEbmlElements(buffer, 0, buffer.length, (id, dataStart, dataEnd) => {
    if (id !== 0x18538067 || tracksStart >= 0) return;
    readEbmlElements(buffer, dataStart, dataEnd, (childId, childStart, childEnd, childMeta) => {
      if (childId === 0x1654AE6B && tracksStart < 0) {
        tracksStart = childStart;
        tracksEnd = childEnd;
        tracksMeta = childMeta;
      }
    });
  });
  if (tracksStart < 0) return null;

  const audioTracks = [];
  readEbmlElements(buffer, tracksStart, tracksEnd, (id, dataStart, dataEnd, meta) => {
    if (id !== 0xAE) return;
    let type = null;
    let language = '';
    let name = '';
    let defaultFlag = null;
    readEbmlElements(buffer, dataStart, dataEnd, (childId, childStart, childEnd) => {
      if (childId === 0x83 && childEnd > childStart) type = buffer[childStart];
      if (childId === 0x22B59C || childId === 0x22B59D) language = buffer.subarray(childStart, childEnd).toString('utf8').toLowerCase();
      if (childId === 0x536E) name = buffer.subarray(childStart, childEnd).toString('utf8').toLowerCase();
      if (childId === 0x88 && childEnd > childStart) defaultFlag = { offset: childStart, length: childEnd - childStart };
    });
    if (type === 2) audioTracks.push({ language, name, defaultFlag, meta, dataStart, dataEnd });
  });

  const hindi = audioTracks.find(track => /^(hin|hi)([-_]|$)/i.test(track.language) || /(^|[^a-z])hindi([^a-z]|$)/i.test(track.name));
  if (!hindi) return null;

  return {
    flags: audioTracks.filter(track => track.defaultFlag).map(track => ({ offset: track.defaultFlag.offset, length: track.defaultFlag.length, value: track === hindi ? 1 : 0 })),
  };
}

async function resolveSavedlyStream(id, { force = false } = {}) {
  const key = String(id);
  const cached = savedlyStreamCache.get(key);
  if (!force && cached && now() - cached.at < SAVEDLY_CACHE_TTL_MS) return cached.url;
  const streamUrl = `https://cdn.savedly.net/${encodeURIComponent(key)}`;
  savedlyStreamCache.set(key, { url: streamUrl, at: now() });
  return streamUrl;
}

const savedlyAudioPatchCache = new Map();

async function getSavedlyAudioPatch(id, streamUrl) {
  const key = String(id);
  const cached = savedlyAudioPatchCache.get(key);
  if (cached) return cached;
  const response = await fetch(streamUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://savedly.net/', Range: 'bytes=0-2097151' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok && response.status !== 206) return null;
  const prefix = Buffer.from(await response.arrayBuffer());
  const patch = findSavedlyHindiAudioPatch(prefix);
  savedlyAudioPatchCache.set(key, patch);
  return patch;
}

function invalidateSavedlyStream(id) {
  savedlyStreamCache.delete(String(id));
}

async function resolveVideoUrl(inputUrl) {
  const url = String(inputUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Use an http(s) video URL.');
  const streamable = url.match(/^https?:\/\/(?:www\.)?streamable\.com\/(?:e\/|t\/)?([A-Za-z0-9]+)/i);
  if (streamable) {
    const shortcode = streamable[1];
    const apiUrl = `https://api-f.streamable.com/api/v1/videos/${shortcode}/mp4`;
    const response = await fetch(apiUrl, { method: 'HEAD', redirect: 'manual' });
    const location = response.headers.get('location');
    if (!location) throw new Error('Could not resolve the Streamable video.');
    return { url: location.startsWith('//') ? `https:${location}` : location, provider: 'streamable' };
  }
  const savedly = url.match(/^https?:\/\/(?:www\.)?savedly\.net\/f\/([A-Za-z0-9]+)/i);
  if (savedly) {
    await resolveSavedlyStream(savedly[1]);
    return { url: `/media/savedly/${savedly[1]}`, provider: 'savedly' };
  }
  const drive = url.match(/^https?:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/i) || url.match(/^https?:\/\/drive\.google\.com\/open\?id=([A-Za-z0-9_-]+)/i);
  if (drive) return { url: `https://drive.google.com/uc?export=download&id=${drive[1]}`, provider: 'google_drive' };
  return { url, provider: 'direct' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 256_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function makeToken() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token;
  do {
    token = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(token));
  return token;
}

function now() {
  return Date.now();
}

function currentPosition(room) {
  return room.playing ? room.position + (now() - room.updatedAt) / 1000 : room.position;
}

function publicRoom(room) {
  return {
    token: room.token,
    hostId: room.hostId,
    allowControl: room.allowControl,
    videoUrl: room.videoUrl,
    videoSourceUrl: room.videoSourceUrl,
    videoProvider: room.videoProvider,
    videoTitle: room.videoTitle,
    playing: room.playing,
    position: Math.max(0, currentPosition(room)),
    updatedAt: room.updatedAt,
    members: [...room.clients.values()].map(c => ({
      id: c.id,
      name: c.name,
      isHost: c.id === room.hostId,
    })),
    messages: room.messages.slice(-100),
    persisted: Boolean(pool),
  };
}

function createRoomInMemory(token = makeToken()) {
  const timestamp = now();
  const room = {
    token,
    createdAt: timestamp,
    lastActive: timestamp,
    hostId: null,
    allowControl: false,
    videoUrl: '',
    videoSourceUrl: DEFAULT_VIDEO_SOURCE_URL,
    videoProvider: 'savedly',
    videoTitle: 'Inception (2010) — Savedly',
    playing: false,
    position: 0,
    updatedAt: timestamp,
    clients: new Map(),
    messages: [],
    streams: new Map(),
    disconnectTimers: new Map(),
  };
  rooms.set(token, room);
  return room;
}

async function dbQuery(text, values = []) {
  if (!pool) return null;
  return pool.query(text, values);
}

async function ensureSchema() {
  if (!pool) {
    console.log('No DATABASE_URL configured; using in-memory rooms.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wt_rooms (
      token VARCHAR(6) PRIMARY KEY,
      created_at BIGINT NOT NULL,
      last_active BIGINT NOT NULL,
      host_id TEXT,
      allow_control BOOLEAN NOT NULL DEFAULT FALSE,
      video_url TEXT NOT NULL DEFAULT '',
      video_source_url TEXT NOT NULL DEFAULT '',
      video_provider TEXT NOT NULL DEFAULT 'direct',
      video_title TEXT NOT NULL DEFAULT 'No video selected',
      playing BOOLEAN NOT NULL DEFAULT FALSE,
      position DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wt_messages (
      id UUID PRIMARY KEY,
      room_token VARCHAR(6) NOT NULL REFERENCES wt_rooms(token) ON DELETE CASCADE,
      sender_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wt_messages_room_idx ON wt_messages(room_token, at DESC);
    ALTER TABLE wt_rooms ADD COLUMN IF NOT EXISTS video_source_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE wt_rooms ADD COLUMN IF NOT EXISTS video_provider TEXT NOT NULL DEFAULT 'direct';
  `);
  console.log('PostgreSQL persistence enabled.');
}

async function persistRoom(room) {
  await dbQuery(
    `INSERT INTO wt_rooms (token, created_at, last_active, host_id, allow_control, video_url, video_source_url, video_provider, video_title, playing, position, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (token) DO UPDATE SET
       last_active=EXCLUDED.last_active,
       host_id=EXCLUDED.host_id,
       allow_control=EXCLUDED.allow_control,
       video_url=EXCLUDED.video_url,
       video_source_url=EXCLUDED.video_source_url,
       video_provider=EXCLUDED.video_provider,
       video_title=EXCLUDED.video_title,
       playing=EXCLUDED.playing,
       position=EXCLUDED.position,
       updated_at=EXCLUDED.updated_at`,
    [
      room.token,
      room.createdAt,
      room.lastActive,
      room.hostId,
      room.allowControl,
      room.videoUrl,
      room.videoSourceUrl,
      room.videoProvider,
      room.videoTitle,
      room.playing,
      room.position,
      room.updatedAt,
    ],
  );
}

async function persistMessage(room, message) {
  await dbQuery(
    `INSERT INTO wt_messages (id, room_token, sender_id, sender, text, at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [message.id, room.token, message.senderId, message.sender, message.text, message.at],
  );
}

async function loadRoom(token) {
  if (rooms.has(token)) return rooms.get(token);
  if (!pool) return null;
  const roomResult = await dbQuery('SELECT * FROM wt_rooms WHERE token = $1', [token]);
  if (!roomResult?.rowCount) return null;
  const row = roomResult.rows[0];
  if (now() - Number(row.last_active) > ROOM_DB_TTL_MS) {
    await dbQuery('DELETE FROM wt_rooms WHERE token = $1', [token]);
    return null;
  }
  const room = createRoomInMemory(token);
  room.createdAt = Number(row.created_at);
  room.lastActive = Number(row.last_active);
  room.hostId = row.host_id;
  room.allowControl = Boolean(row.allow_control);
  room.videoUrl = row.video_url || '';
  room.videoSourceUrl = row.video_source_url || row.video_url || '';
  room.videoProvider = row.video_provider || 'direct';
  room.videoTitle = row.video_title || 'No video selected';
  room.playing = Boolean(row.playing);
  room.position = Number(row.position) || 0;
  room.updatedAt = Number(row.updated_at) || now();
  const messages = await dbQuery(
    'SELECT id, sender_id, sender, text, at FROM wt_messages WHERE room_token = $1 ORDER BY at DESC LIMIT 100',
    [token],
  );
  room.messages = (messages?.rows || []).reverse().map(row => ({
    id: row.id,
    senderId: row.sender_id,
    sender: row.sender,
    text: row.text,
    at: Number(row.at),
  }));
  return room;
}

function emit(room, event, data) {
  const packet = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const stream of room.streams.values()) {
    try {
      stream.res.write(packet);
    } catch {}
  }
}

function emitState(room) {
  emit(room, 'state', publicRoom(room));
}

async function refreshVideoSource(room) {
  if (!room.videoSourceUrl || !['streamable', 'savedly'].includes(room.videoProvider)) return false;
  try {
    const resolved = await resolveVideoUrl(room.videoSourceUrl);
    if (resolved.url !== room.videoUrl) {
      room.videoUrl = resolved.url;
      await persistRoom(room);
      return true;
    }
  } catch (error) {
    console.error(`${room.videoProvider} refresh failed:`, error.message);
  }
  return false;
}

function canControl(room, id) {
  return room.allowControl || room.hostId === id;
}

function touch(room) {
  room.lastActive = now();
}

async function saveRoomAndEmit(room) {
  try {
    await persistRoom(room);
  } catch (error) {
    console.error('DB room save failed:', error.message);
  }
  emitState(room);
}

async function removeClient(room, id) {
  room.clients.delete(id);
  const stream = room.streams.get(id);
  if (stream) {
    try { stream.res.end(); } catch {}
    room.streams.delete(id);
  }
  if (room.hostId === id) room.hostId = room.clients.values().next().value?.id || null;
  touch(room);
  await saveRoomAndEmit(room);
}

async function main() {
  try {
    await ensureSchema();
  } catch (error) {
    console.error('Database unavailable; continuing in memory:', error.message);
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { ok: true, database: Boolean(pool), uptime: process.uptime() });
    }
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = u.pathname;

    try {
      if (req.method === 'GET' && pathname.match(/^\/media\/savedly\/[A-Za-z0-9]+$/)) {
        const id = pathname.split('/').pop();
        const requestHeaders = {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://savedly.net/',
          'Accept': '*/*',
        };
        const requestedRange = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/i);
        if (req.headers.range) requestHeaders.Range = req.headers.range;

        const controller = new AbortController();
        res.on('close', () => controller.abort());

        let upstream;
        let streamUrl;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          streamUrl = await resolveSavedlyStream(id, { force: attempt === 1 });
          upstream = await fetch(streamUrl, { headers: requestHeaders, signal: controller.signal });
          if (upstream.ok || upstream.status === 206) break;
          if (upstream.status === 401 || upstream.status === 403 || upstream.status === 404) {
            invalidateSavedlyStream(id);
            savedlyAudioPatchCache.delete(String(id));
          }
          if (attempt === 1) return json(res, upstream.status, { error: `Savedly stream returned ${upstream.status}` });
        }

        const responseHeaders = {
          'Content-Type': upstream.headers.get('content-type') || 'video/x-matroska',
          'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
          'Cache-Control': 'no-store',
        };
        for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) {
          const value = upstream.headers.get(name);
          if (value) responseHeaders[name] = value;
        }
        res.writeHead(upstream.status, responseHeaders);
        if (upstream.body) {
          const contentRange = upstream.headers.get('content-range');
          const rangeStart = contentRange
            ? Number(contentRange.match(/^bytes (\d+)-/i)?.[1] || 0)
            : Number(requestedRange?.[1] || 0);
          const audioPatch = rangeStart <= 2_097_151
            ? await getSavedlyAudioPatch(id, streamUrl).catch(() => null)
            : null;
          let responseOffset = rangeStart;
          for await (const chunk of upstream.body) {
            const body = Buffer.from(chunk);
            if (audioPatch?.flags?.length) {
              for (const flag of audioPatch.flags) {
                const local = flag.offset - responseOffset;
                if (local < body.length && local + flag.length > 0) {
                  const start = Math.max(0, local);
                  const end = Math.min(body.length, local + flag.length);
                  for (let i = start; i < end; i += 1) body[i] = flag.value;
                }
              }
            }
            if (!res.write(body)) await new Promise(resolve => res.once('drain', resolve));
            responseOffset += body.length;
          }
        }
        res.end();
        return;
      }

      if (req.method === 'POST' && pathname === '/api/rooms') {
        const room = createRoomInMemory();
        await refreshVideoSource(room);
        await persistRoom(room);
        return json(res, 201, { token: room.token });
      }

      if (req.method === 'GET' && pathname.startsWith('/api/rooms/')) {
        const token = pathname.split('/').pop().toUpperCase();
        const room = await loadRoom(token);
        if (!room) return json(res, 404, { error: 'Room not found' });
        touch(room);
        await refreshVideoSource(room);
        await persistRoom(room);
        return json(res, 200, publicRoom(room));
      }

      if (req.method === 'GET' && pathname === '/events') {
        const token = String(u.searchParams.get('token') || '').toUpperCase();
        const clientId = String(u.searchParams.get('clientId') || '');
        const room = await loadRoom(token);
        if (!room) return json(res, 404, { error: 'Room not found' });
        if (!clientId || !room.clients.has(clientId)) return json(res, 403, { error: 'Join the room before opening realtime events' });
        await refreshVideoSource(room);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`retry: 1500\n\n`);
        room.streams.set(clientId, { res });
        sendStateSoon(room, clientId);
        touch(room);
        await persistRoom(room);

        const heartbeat = setInterval(() => {
          try { res.write(': heartbeat\n\n'); } catch {}
        }, 20_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          room.streams.delete(clientId);
          const existingTimer = room.disconnectTimers.get(clientId);
          if (existingTimer) clearTimeout(existingTimer);
          const timer = setTimeout(async () => {
            room.disconnectTimers.delete(clientId);
            if (room.streams.has(clientId) || !room.clients.has(clientId)) return;
            room.clients.delete(clientId);
            if (room.hostId === clientId) room.hostId = room.clients.values().next().value?.id || null;
            touch(room);
            await saveRoomAndEmit(room);
          }, 15_000);
          room.disconnectTimers.set(clientId, timer);
        });
        return;
      }

      if (req.method === 'POST' && pathname.match(/^\/api\/rooms\/[A-Z0-9]{6}\/action$/)) {
        const token = pathname.split('/')[3].toUpperCase();
        const room = await loadRoom(token);
        if (!room) return json(res, 404, { error: 'Room not found' });
        let body;
        try {
          body = await readBody(req);
        } catch {
          return json(res, 400, { error: 'Invalid JSON' });
        }
        const clientId = String(body.clientId || '');
        const client = room.clients.get(clientId);
        if (!client) return json(res, 403, { error: 'Not a room member' });
        touch(room);

        if (body.type === 'rename') {
          client.name = String(body.name || 'Guest').trim().slice(0, 24) || 'Guest';
          emitState(room);
          return json(res, 200, { ok: true });
        }

        if (body.type === 'chat') {
          const text = String(body.text || '').trim().slice(0, 500);
          if (!text) return json(res, 400, { error: 'Empty message' });
          const message = {
            id: crypto.randomUUID(),
            senderId: clientId,
            sender: client.name,
            text,
            at: now(),
          };
          room.messages.push(message);
          room.messages = room.messages.slice(-100);
          try { await persistMessage(room, message); } catch (error) { console.error('DB message save failed:', error.message); }
          emit(room, 'chat', message);
          return json(res, 200, { ok: true });
        }

        if (body.type === 'set_control') {
          if (room.hostId !== clientId) return json(res, 403, { error: 'Host only' });
          room.allowControl = Boolean(body.allowControl);
          await saveRoomAndEmit(room);
          return json(res, 200, { ok: true });
        }

        if (body.type === 'set_video') {
          if (!canControl(room, clientId)) return json(res, 403, { error: 'Playback control not allowed' });
          const url = String(body.url || '').trim() || DEFAULT_VIDEO_SOURCE_URL;
          let resolved;
          try {
            resolved = await resolveVideoUrl(url);
          } catch (error) {
            return json(res, 400, { error: error.message || 'Could not resolve video URL.' });
          }
          room.videoUrl = resolved.url.slice(0, 4000);
          room.videoSourceUrl = url.slice(0, 4000);
          room.videoProvider = resolved.provider;
          const defaultTitle = resolved.provider === 'streamable'
            ? 'Streamable video'
            : resolved.provider === 'savedly'
              ? 'Savedly video'
              : 'Video';
          room.videoTitle = String(body.title || '').trim().slice(0, 120) || defaultTitle;
          room.playing = false;
          room.position = 0;
          room.updatedAt = now();
          await saveRoomAndEmit(room);
          return json(res, 200, { ok: true });
        }

        if (body.type === 'playback') {
          if (!canControl(room, clientId)) return json(res, 403, { error: 'Playback control not allowed' });
          const position = Number(body.position);
          if (!Number.isFinite(position) || position < 0) return json(res, 400, { error: 'Invalid position' });
          room.position = position;
          room.playing = body.action === 'play';
          room.updatedAt = now();
          await saveRoomAndEmit(room);
          return json(res, 200, { ok: true });
        }

        if (body.type === 'leave') {
          await removeClient(room, clientId);
          return json(res, 200, { ok: true });
        }

        return json(res, 400, { error: 'Unknown action' });
      }

      if (req.method === 'POST' && pathname.match(/^\/api\/rooms\/[A-Z0-9]{6}\/join$/)) {
        const token = pathname.split('/')[3].toUpperCase();
        const room = await loadRoom(token);
        if (!room) return json(res, 404, { error: 'Room not found' });
        let body;
        try {
          body = await readBody(req);
        } catch {
          return json(res, 400, { error: 'Invalid JSON' });
        }
        const id = String(body.clientId || crypto.randomUUID()).slice(0, 128);
        const name = String(body.name || 'Guest').trim().slice(0, 24) || 'Guest';
        const disconnectTimer = room.disconnectTimers.get(id);
        if (disconnectTimer) {
          clearTimeout(disconnectTimer);
          room.disconnectTimers.delete(id);
        }
        room.clients.set(id, { id, name });
        if (!room.hostId || !room.clients.has(room.hostId)) room.hostId = id;
        touch(room);
        await saveRoomAndEmit(room);
        return json(res, 200, { clientId: id, room: publicRoom(room) });
      }

      if (req.method === 'GET') {
        let filePath = pathname === '/'
          ? path.join(publicDir, 'index.html')
          : path.resolve(publicDir, pathname.replace(/^\/+/, ''));
        const relativePath = path.relative(publicDir, filePath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return json(res, 403, { error: 'Forbidden' });
        if (!path.extname(filePath)) filePath = path.join(publicDir, 'index.html');
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) throw new Error('Not file');
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
          fs.createReadStream(filePath).pipe(res);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
        }
        return;
      }

      res.writeHead(405);
      res.end();
    } catch (error) {
      console.error('Request error:', error);
      if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
      else res.end();
    }
  });

  setInterval(() => {
    const t = now();
    for (const [token, room] of rooms) {
      if (room.clients.size === 0 && t - room.lastActive > ROOM_TTL_MS) {
        rooms.delete(token);
      }
    }
  }, 60_000).unref();

  server.listen(PORT, () => console.log(`WatchTogether running on port ${PORT}`));
}

function sendStateSoon(room, clientId) {
  setTimeout(() => {
    const stream = room.streams.get(clientId);
    if (!stream) return;
    try {
      stream.res.write(`event: state\ndata: ${JSON.stringify(publicRoom(room))}\n\n`);
    } catch {}
  }, 50);
}

main();
