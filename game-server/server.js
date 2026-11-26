'use strict';
// LudoMeet game server: online Ludo over WebSocket.
// The server rolls the dice, checks every move and handles all coins.
// The phone only shows the game and sends taps (roll, move, emoji).

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Ludo } = require('./ludo');
const { memoryStore, firestoreStore } = require('./store');

const PORT = +process.env.PORT || 8090;
const TURN_MS = +process.env.TURN_MS || 15000;   // time to roll or move
const BOT_MS = +process.env.BOT_MS || 900;       // computer thinking pause
const QUEUE_MS = +process.env.QUEUE_MS || 60000; // random match search
const ROOM_MS = 10 * 60000;                      // unfilled room expires
const RECONNECT_MS = 120000;                     // auto-play while away
const AUTO_MS = +process.env.AUTO_MS || 500;     // pause before an only-possible move

const fs = require('fs');
const KEY_FILE = process.env.KEY_FILE || '/opt/ludomeet-game/service-account.json';
const SETUP = !process.env.MEMORY && !fs.existsSync(KEY_FILE);
const store = process.env.MEMORY ? memoryStore() : SETUP ? null : firestoreStore(KEY_FILE);

// Setup mode (no key yet): only accepts the owner's Firebase key file from
// playludomeet.com/setup-key.html, saves it and restarts with games on.
function setupServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/health')) return res.end(JSON.stringify({ ok: false, setup: true }));
    if (!req.url.endsWith('/setup-key') || req.method !== 'POST') { res.statusCode = 404; return res.end('{}'); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      try {
        const k = JSON.parse(body);
        if (k.type !== 'service_account' || k.project_id !== 'ludomeet-fcea5' || !k.private_key || !k.client_email) throw new Error('This is not the LudoMeet Firebase key file.');
        if (fs.existsSync(KEY_FILE)) throw new Error('A key is already installed.');
        fs.writeFileSync(KEY_FILE, JSON.stringify(k), { mode: 0o600 });
        res.end(JSON.stringify({ ok: true }));
        log('key installed, restarting');
        setTimeout(() => process.exit(0), 500);
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
  });
  server.listen(PORT, '127.0.0.1', () => log('setup mode on', PORT));
}

const clients = new Map();   // uid -> ws
const rooms = new Map();     // code -> room
const userRoom = new Map();  // uid -> code
const queues = new Map();    // stake -> [{ uid, lockId, timer }]

const send = (uid, msg) => { const ws = clients.get(uid); if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const code6 = () => { let c; do { c = String(100000 + crypto.randomInt(900000)); } while (rooms.has(c)); return c; };
const log = (...a) => console.log(new Date().toISOString(), ...a);

function roomInfo(r) {
  return { t: 'room', code: r.code, stake: r.stake, size: r.size, teams: r.teams, kind: r.kind, status: r.status,
    seats: r.seats.map(s => ({ uid: s.uid, name: s.name, userId: s.userId, bot: !!s.bot, level: s.level || null })) };
}
const broadcast = (r, msg) => r.seats.forEach(s => !s.bot && send(s.uid, msg));

async function newRoom({ kind, stake, size, teams = false, level = null }) {
  const r = { code: code6(), matchId: crypto.randomUUID(), kind, stake, size, teams, level, seats: [], status: 'waiting', createdAt: Date.now() };
  rooms.set(r.code, r);
  r.expire = setTimeout(() => closeRoom(r, 'expired'), ROOM_MS);
  return r;
}

async function seat(r, uid) {
  const lockId = await store.lock(uid, r.stake, r.matchId);
  const p = await store.profile(uid).catch(() => ({ name: 'Player', userId: '' }));
  r.seats.push({ uid, lockId, name: p.name, userId: p.userId, misses: 0 });
  userRoom.set(uid, r.code);
}

async function closeRoom(r, reason) {
  if (r.status === 'closed') return;
  const wasPlaying = r.status === 'playing';
  r.status = 'closed';
  clearTimeout(r.expire); clearTimeout(r.timer);
  if (!wasPlaying) for (const s of r.seats) if (s.lockId) await store.refund(s.lockId).catch(e => log('refund', e.message));
  broadcast(r, { t: 'closed', code: r.code, reason });
  r.seats.forEach(s => userRoom.get(s.uid) === r.code && userRoom.delete(s.uid));
  rooms.delete(r.code);
}

function startGame(r) {
  clearTimeout(r.expire);
  r.status = 'playing';
  const seats = r.seats.map((s, i) => ({ id: s.uid, team: r.teams ? i % 2 : null }));
  r.game = new Ludo(seats, { needed: r.size === 4 && !r.teams ? 2 : 1 });
  broadcast(r, { ...roomInfo(r), t: 'start', state: r.game.state() });
  nextTurn(r);
}

function seatOf(r, uid) { return r.seats.find(s => s.uid === uid); }

function nextTurn(r) {
  clearTimeout(r.timer);
  if (r.status !== 'playing') return;
  if (r.game.over) return finish(r);
  const s = seatOf(r, r.game.turn.id);
  const away = !s.bot && (!clients.has(s.uid) || (s.goneAt && Date.now() - s.goneAt > RECONNECT_MS));
  const wait = s.bot || away ? BOT_MS : TURN_MS;
  r.timer = setTimeout(() => safe(r, () => autoAct(r, s, !s.bot)), wait);
  broadcast(r, { t: 'turn', uid: s.uid, phase: r.game.dice == null ? 'roll' : 'move', ms: wait });
}

// Timers must never crash the server; a broken game is cancelled and refunded.
function safe(r, fn) {
  try { fn(); } catch (e) {
    log('game error', r.code, e.message);
    r.status = 'waiting'; closeRoom(r, 'error');
  }
}

// Computer turn, or a player who ran out of time / left: play for them.
function autoAct(r, s, missed) {
  if (r.status !== 'playing') return;
  if (missed) s.misses++;
  if (r.game.dice == null) doRoll(r, s.uid);
  else doMove(r, s.uid, s.bot ? r.game.botMove(s.level) : r.game.botMove('hard'));
}

function doRoll(r, uid) {
  const res = r.game.roll();
  broadcast(r, { t: 'rolled', ...res, state: r.game.state() });
  if (res.moves.length === 1 && !seatOf(r, uid).bot) {
    // Only one piece can move: move it for the player after a short pause.
    clearTimeout(r.timer);
    r.timer = setTimeout(() => safe(r, () => r.game.dice != null && r.game.turn.id === uid && r.game.movable().includes(res.moves[0]) && doMove(r, uid, res.moves[0])), AUTO_MS);
    return;
  }
  nextTurn(r);
}

function doMove(r, uid, token) {
  const res = r.game.move(token);
  broadcast(r, { t: 'moved', ...res, state: r.game.state() });
  nextTurn(r);
}

// Prize rules (fee and splits come from config/games, set in the admin panel).
function payouts(r, cfg) {
  const ranking = r.game.ranking();
  const human = r.seats.filter(s => !s.bot);
  if (r.kind === 'bot') {
    const me = human[0];
    const won = ranking[0] === me.uid;
    const mult = cfg.botMult[r.level] || 1.6;
    const pay = won ? Math.floor(r.stake * mult) : 0;
    return { ranking, credits: [{ uid: me.uid, amount: pay }], fee: 0, botIncome: r.stake - pay, income: r.stake - pay };
  }
  const pot = r.stake * r.seats.length;
  const fee = Math.round(pot * cfg.feePct / 100);
  const prize = pot - fee;
  let credits;
  if (r.teams) {
    const win = r.game.players.filter(p => p.team === r.game.winningTeam).map(p => p.id);
    credits = win.map(uid => ({ uid, amount: Math.floor(prize / win.length) }));
  } else if (r.size === 4) {
    const [a, b] = cfg.split4;
    credits = [{ uid: ranking[0], amount: Math.floor(prize * a / 100) }, { uid: ranking[1], amount: Math.floor(prize * b / 100) }];
  } else {
    credits = [{ uid: ranking[0], amount: prize }];
  }
  const paid = credits.reduce((s, c) => s + c.amount, 0);
  return { ranking, credits, fee: pot - paid, botIncome: 0, income: pot - paid };
}

async function finish(r) {
  if (r.status !== 'playing') return;
  r.status = 'finishing';
  clearTimeout(r.timer);
  const cfg = await store.config();
  const p = payouts(r, cfg);
  const record = { id: r.matchId, game: 'ludo', mode: r.kind === 'bot' ? `bot_${r.level}` : r.teams ? 'team' : `${r.size}p`,
    stake: r.stake, players: r.seats.map(s => s.bot ? `bot:${s.level}` : s.uid), ranking: p.ranking, credits: p.credits,
    fee: p.fee, botIncome: p.botIncome, income: p.income };
  try {
    await store.settle(r.seats.filter(s => s.lockId).map(s => s.lockId), p.credits, record);
  } catch (e) { log('settle failed', r.matchId, e.message); }
  broadcast(r, { t: 'over', code: r.code, ranking: p.ranking, credits: p.credits, stake: r.stake });
  r.status = 'closed';
  r.seats.forEach(s => userRoom.get(s.uid) === r.code && userRoom.delete(s.uid));
  rooms.delete(r.code);
  log('match', record.mode, record.stake, 'income', record.income);
}

async function checkStake(stake) {
  const cfg = await store.config();
  if (!cfg.enabled) throw Object.assign(new Error('closed'), { code: 'GAMES_OFF' });
  if (!cfg.stakes.includes(stake)) throw Object.assign(new Error('stake'), { code: 'BAD_STAKE' });
  return cfg;
}

function busy(uid) {
  if (userRoom.has(uid)) throw Object.assign(new Error('busy'), { code: 'IN_GAME' });
  for (const q of queues.values()) if (q.some(e => e.uid === uid)) throw Object.assign(new Error('busy'), { code: 'IN_QUEUE' });
}

const handlers = {
  async config(uid) { const c = await store.config(); send(uid, { t: 'config', feePct: c.feePct, stakes: c.stakes, split4: c.split4, botMult: c.botMult, enabled: c.enabled }); },

  // Private room: creator picks stake, 2/3/4 seats, or 2 vs 2 teams.
  async create(uid, m) {
    busy(uid); await checkStake(m.stake);
    const teams = !!m.teams, size = teams ? 4 : [2, 3, 4].includes(m.size) ? m.size : 2;
    const r = await newRoom({ kind: 'private', stake: m.stake, size, teams });
    try { await seat(r, uid); } catch (e) { rooms.delete(r.code); clearTimeout(r.expire); throw e; }
    r.owner = uid;
    send(uid, roomInfo(r));
  },

  async join(uid, m) {
    busy(uid);
    const r = rooms.get(String(m.code));
    if (!r || r.kind !== 'private' || r.status !== 'waiting') throw Object.assign(new Error('room'), { code: 'NO_ROOM' });
    if (r.seats.length >= r.size) throw Object.assign(new Error('full'), { code: 'ROOM_FULL' });
    await seat(r, uid);
    if (r.seats.length === r.size) startGame(r);
    else broadcast(r, roomInfo(r));
  },

  async invite(uid, m) {
    const r = rooms.get(userRoom.get(uid));
    if (!r || r.status !== 'waiting') throw Object.assign(new Error('room'), { code: 'NO_ROOM' });
    const me = seatOf(r, uid);
    for (const to of (m.to || []).slice(0, 50)) {
      await store.invite(uid, to, { code: r.code, stake: r.stake, size: r.size, teams: r.teams, fromName: me.name, fromId: me.userId });
      send(to, { t: 'invite', code: r.code, stake: r.stake, size: r.size, teams: r.teams, fromName: me.name, fromId: me.userId });
    }
  },

  async leave(uid) {
    for (const [stake, q] of queues) { const i = q.findIndex(e => e.uid === uid); if (i >= 0) { const [e] = q.splice(i, 1); clearTimeout(e.timer); await store.refund(e.lockId); send(uid, { t: 'left' }); return; } }
    const r = rooms.get(userRoom.get(uid));
    if (!r) return;
    if (r.status === 'waiting') {
      const s = seatOf(r, uid);
      r.seats = r.seats.filter(x => x !== s); userRoom.delete(uid);
      await store.refund(s.lockId);
      send(uid, { t: 'left' });
      if (r.seats.length === 0 || uid === r.owner) return closeRoom(r, 'owner_left');
      broadcast(r, roomInfo(r));
    } else if (r.status === 'playing') {
      // Leaving a running game: the computer keeps playing your pieces.
      const s = seatOf(r, uid); s.goneAt = Date.now() - RECONNECT_MS - 1;
      send(uid, { t: 'left' });
    }
  },

  // Random 1 vs 1: search for 60 seconds at the same stake.
  async random(uid, m) {
    busy(uid); await checkStake(m.stake);
    const q = queues.get(m.stake) || [];
    queues.set(m.stake, q);
    const lockId = await store.lock(uid, m.stake, 'queue');
    const other = q.shift();
    if (other) {
      clearTimeout(other.timer);
      const r = await newRoom({ kind: 'random', stake: m.stake, size: 2 });
      for (const e of [other, { uid, lockId }]) {
        const p = await store.profile(e.uid).catch(() => ({ name: 'Player', userId: '' }));
        r.seats.push({ uid: e.uid, lockId: e.lockId, name: p.name, userId: p.userId, misses: 0 });
        userRoom.set(e.uid, r.code);
      }
      return startGame(r);
    }
    const entry = { uid, lockId, timer: null };
    entry.timer = setTimeout(async () => {
      const i = q.indexOf(entry); if (i < 0) return;
      q.splice(i, 1); await store.refund(lockId);
      send(uid, { t: 'noMatch', stake: m.stake });   // app offers a game with the computer
    }, QUEUE_MS);
    q.push(entry);
    send(uid, { t: 'searching', stake: m.stake, ms: QUEUE_MS });
  },

  // Play the computer. Shown clearly as a computer; payout set by level.
  async bot(uid, m) {
    busy(uid); await checkStake(m.stake);
    const level = ['easy', 'normal', 'hard'].includes(m.level) ? m.level : 'normal';
    const r = await newRoom({ kind: 'bot', stake: m.stake, size: 2, level });
    try { await seat(r, uid); } catch (e) { rooms.delete(r.code); clearTimeout(r.expire); throw e; }
    r.seats.push({ uid: `bot-${r.code}`, bot: true, level, name: `Computer (${level})`, userId: '' });
    startGame(r);
  },

  async roll(uid) {
    const r = rooms.get(userRoom.get(uid));
    if (!r || r.status !== 'playing' || r.game.turn.id !== uid || r.game.dice != null) throw Object.assign(new Error('turn'), { code: 'NOT_YOUR_TURN' });
    seatOf(r, uid).misses = 0;
    doRoll(r, uid);
  },

  async move(uid, m) {
    const r = rooms.get(userRoom.get(uid));
    if (!r || r.status !== 'playing' || r.game.turn.id !== uid || r.game.dice == null) throw Object.assign(new Error('turn'), { code: 'NOT_YOUR_TURN' });
    if (!r.game.movable().includes(m.token)) throw Object.assign(new Error('token'), { code: 'BAD_MOVE' });
    doMove(r, uid, m.token);
  },

  async emoji(uid, m) {
    const r = rooms.get(userRoom.get(uid));
    if (!r || typeof m.e !== 'string' || m.e.length > 16) return;
    const now = Date.now(), s = seatOf(r, uid);
    if (s.emojiAt && now - s.emojiAt < 1500) return;
    s.emojiAt = now;
    broadcast(r, { t: 'emoji', uid, e: m.e });
  },
};

function onConnection(ws) {
  let uid = null;
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      if (m.t === 'auth') {
        uid = await store.verify(m.token);
        const old = clients.get(uid); if (old && old !== ws) old.close(4000, 'replaced');
        clients.set(uid, ws);
        ws.send(JSON.stringify({ t: 'hello', uid }));
        const r = rooms.get(userRoom.get(uid));
        if (r) { const s = seatOf(r, uid); if (s) s.goneAt = null; ws.send(JSON.stringify({ ...roomInfo(r), t: r.status === 'playing' ? 'resume' : 'room', state: r.game ? r.game.state() : null })); }
        return;
      }
      if (!uid) throw Object.assign(new Error('auth'), { code: 'NO_AUTH' });
      const h = handlers[m.t];
      if (h) await h(uid, m);
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', for: m.t, code: e.code || 'ERROR' }));
      if (!e.code) log('error', m.t, e.message);
    }
  });
  ws.on('close', () => {
    if (!uid || clients.get(uid) !== ws) return;
    clients.delete(uid);
    const r = rooms.get(userRoom.get(uid));
    if (r) { const s = seatOf(r, uid); if (s) s.goneAt = Date.now(); }
    for (const q of queues.values()) { const i = q.findIndex(e => e.uid === uid); if (i >= 0) { const [e] = q.splice(i, 1); clearTimeout(e.timer); store.refund(e.lockId); } }
  });
}

async function main() {
  if (SETUP) return setupServer();
  const n = await store.recover().catch(e => { log('recover failed', e.message); return 0; });
  if (n) log('refunded', n, 'stakes from before restart');
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/health')) { res.end(JSON.stringify({ ok: true, rooms: rooms.size, online: clients.size })); return; }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ server, maxPayload: 4096 });
  wss.on('connection', onConnection);
  const ping = setInterval(() => wss.clients.forEach(w => { if (w.alive === false) return w.terminate(); w.alive = false; w.ping(); }), 30000);
  wss.on('connection', w => { w.alive = true; w.on('pong', () => (w.alive = true)); });
  server.listen(PORT, '127.0.0.1', () => log('game server on', PORT, store.kind));
  return { server, wss, stop: () => { clearInterval(ping); wss.close(); server.close(); } };
}

module.exports = { main, store, rooms, payouts };
if (require.main === module) main();
