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
const GRACE_MS = +process.env.GRACE_MS || 60000; // time to come back after the net drops
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
const queues = new Map();    // stake -> [{ uid, timer }]

const send = (uid, msg) => { const ws = clients.get(uid); if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const code6 = () => { let c; do { c = String(100000 + crypto.randomInt(900000)); } while (rooms.has(c)); return c; };
const log = (...a) => console.log(new Date().toISOString(), ...a);
const err = code => Object.assign(new Error(code), { code });

function roomInfo(r) {
  return { t: 'room', code: r.code, stake: r.stake, size: r.size, teams: r.teams, kind: r.kind, status: r.status,
    seats: r.seats.map(s => ({ uid: s.uid, name: s.name, userId: s.userId, bot: !!s.bot, level: s.level || null, out: !!s.out })) };
}
const broadcast = (r, msg) => r.seats.forEach(s => !s.bot && send(s.uid, msg));
const seatOf = (r, uid) => r.seats.find(s => s.uid === uid);

function newRoom({ kind, stake, size, teams = false, level = null }) {
  const r = { code: code6(), matchId: crypto.randomUUID(), kind, stake, size, teams, level, seats: [], status: 'waiting', createdAt: Date.now() };
  rooms.set(r.code, r);
  r.expire = setTimeout(() => closeRoom(r, 'expired'), ROOM_MS);
  return r;
}

// Taking a seat costs nothing yet. Coins are taken only when the game starts.
async function addSeat(r, uid) {
  if ((await store.coins(uid)) < r.stake) throw err('NO_COINS');
  const p = await store.profile(uid).catch(() => ({ name: 'Player', userId: '' }));
  r.seats.push({ uid, name: p.name, userId: p.userId });
  userRoom.set(uid, r.code);
}

function dropSeat(r, uid) {
  r.seats = r.seats.filter(s => s.uid !== uid);
  if (userRoom.get(uid) === r.code) userRoom.delete(uid);
}

async function closeRoom(r, reason) {
  if (r.status === 'closed' || r.status === 'playing' || r.status === 'finishing') return;
  r.status = 'closed';
  clearTimeout(r.expire);
  for (const s of r.seats) if (s.lockId) await store.refund(s.lockId).catch(e => log('refund', e.message));
  broadcast(r, { t: 'closed', code: r.code, reason });
  r.seats.forEach(s => userRoom.get(s.uid) === r.code && userRoom.delete(s.uid));
  rooms.delete(r.code);
}

// Every seat is taken: take the stake from everyone, then start.
// Anyone without enough coins is removed and the room keeps waiting.
async function tryStart(r) {
  if (r.status !== 'waiting' || r.seats.length < r.size) return false;
  r.status = 'starting';
  const short = [];
  for (const s of r.seats) {
    if (s.bot) continue;
    try { s.lockId = await store.lock(s.uid, r.stake, r.matchId); }
    catch (e) { short.push(s); send(s.uid, { t: 'error', for: 'start', code: e.code || 'ERROR' }); }
  }
  if (short.length) {
    for (const s of r.seats) if (s.lockId) { await store.refund(s.lockId).catch(() => {}); s.lockId = null; }
    short.forEach(s => { dropSeat(r, s.uid); send(s.uid, { t: 'left', code: r.code }); });
    r.status = 'waiting';
    if (r.seats.length === 0 || !r.seats.some(s => s.uid === r.owner) && r.kind === 'private') { await closeRoom(r, 'owner_left'); return false; }
    broadcast(r, roomInfo(r));
    return false;
  }
  startGame(r);
  return true;
}

function startGame(r) {
  clearTimeout(r.expire);
  r.status = 'playing';
  const seats = r.seats.map((s, i) => ({ id: s.uid, team: r.teams ? i % 2 : null }));
  r.game = new Ludo(seats, { needed: r.size === 4 && !r.teams ? 2 : 1 });
  broadcast(r, { ...roomInfo(r), t: 'start', state: r.game.state() });
  nextTurn(r);
}

// Who taps for the current colour: its owner, or the team mate of a player who left.
function actorOf(r) {
  const s = seatOf(r, r.game.turn.id);
  if (s.out && r.teams) { const mate = r.seats.find(x => x !== s && !x.out && r.game.players.find(p => p.id === x.uid).team === r.game.turn.team); if (mate) return mate; }
  return s;
}

function nextTurn(r) {
  clearTimeout(r.timer);
  if (r.status !== 'playing') return;
  if (r.game.over) return finish(r);
  const a = actorOf(r);
  const away = !a.bot && (!clients.has(a.uid) || a.goneAt);
  const wait = a.bot ? BOT_MS : away ? Math.min(TURN_MS, 3000) : TURN_MS;
  r.timer = setTimeout(() => safe(r, () => autoAct(r, a)), wait);
  broadcast(r, { t: 'turn', uid: r.game.turn.id, actor: a.uid, phase: r.game.dice == null ? 'roll' : 'move', ms: wait });
}

// Timers must never crash the server; a broken game is cancelled and refunded.
function safe(r, fn) {
  try { fn(); } catch (e) {
    log('game error', r.code, e.message);
    r.status = 'waiting'; closeRoom(r, 'error');
  }
}

function autoAct(r, a) {
  if (r.status !== 'playing') return;
  if (r.game.dice == null) doRoll(r, a);
  else doMove(r, r.game.botMove(a.bot ? a.level : 'hard'));
}

function doRoll(r, a) {
  const res = r.game.roll();
  broadcast(r, { t: 'rolled', ...res, state: r.game.state() });
  if (res.moves.length === 1 && !a.bot) {
    clearTimeout(r.timer);
    r.timer = setTimeout(() => safe(r, () => r.game.dice != null && r.game.movable().includes(res.moves[0]) && doMove(r, res.moves[0])), AUTO_MS);
    return;
  }
  nextTurn(r);
}

function doMove(r, token) {
  const res = r.game.move(token);
  broadcast(r, { t: 'moved', ...res, state: r.game.state() });
  nextTurn(r);
}

// A player left on purpose, or did not come back in time: they lose.
function forfeit(r, uid, reason) {
  const s = seatOf(r, uid);
  if (!s || s.out || r.status !== 'playing') return;
  clearTimeout(s.grace);
  s.out = true;
  if (userRoom.get(uid) === r.code) userRoom.delete(uid);
  const mateLeft = r.teams && r.seats.some(x => x !== s && !x.out && r.game.players.find(p => p.id === x.uid).team === r.game.players.find(p => p.id === uid).team);
  if (!mateLeft) {
    if (r.teams) r.seats.filter(x => r.game.players.find(p => p.id === x.uid).team === r.game.players.find(p => p.id === uid).team).forEach(x => r.game.eliminate(x.uid));
    else r.game.eliminate(uid);
  }
  broadcast(r, { t: 'eliminated', uid, reason, state: r.game.state() });
  send(uid, { t: 'left', code: r.code });
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
  r.seats.forEach(s => clearTimeout(s.grace));
  const cfg = await store.config();
  const p = payouts(r, cfg);
  const record = { id: r.matchId, game: 'ludo', mode: r.kind === 'bot' ? `bot_${r.level}` : r.teams ? 'team' : `${r.size}p`,
    stake: r.stake, players: r.seats.map(s => s.bot ? `bot:${s.level}` : s.uid), ranking: p.ranking, credits: p.credits,
    fee: p.fee, botIncome: p.botIncome, income: p.income };
  try {
    await store.settle(r.seats.filter(s => s.lockId).map(s => s.lockId), p.credits, record);
  } catch (e) { log('settle failed', r.matchId, e.message); }
  r.seats.forEach(s => !s.bot && send(s.uid, { t: 'over', code: r.code, ranking: p.ranking, credits: p.credits, stake: r.stake }));
  r.status = 'closed';
  r.seats.forEach(s => userRoom.get(s.uid) === r.code && userRoom.delete(s.uid));
  rooms.delete(r.code);
  log('match', record.mode, record.stake, 'income', record.income);
}

async function checkStake(stake) {
  const cfg = await store.config();
  if (!cfg.enabled) throw err('GAMES_OFF');
  if (!cfg.stakes.includes(stake)) throw err('BAD_STAKE');
  return cfg;
}

function busy(uid) {
  if (userRoom.has(uid)) throw err('IN_GAME');
  for (const q of queues.values()) if (q.some(e => e.uid === uid)) throw err('IN_QUEUE');
}

function leaveQueue(uid) {
  for (const q of queues.values()) { const i = q.findIndex(e => e.uid === uid); if (i >= 0) { const [e] = q.splice(i, 1); clearTimeout(e.timer); return true; } }
  return false;
}

function queueUp(uid, stake, ms = QUEUE_MS) {
  const q = queues.get(stake) || []; queues.set(stake, q);
  const entry = { uid, timer: null };
  entry.timer = setTimeout(() => { const i = q.indexOf(entry); if (i < 0) return; q.splice(i, 1); send(uid, { t: 'noMatch', stake }); }, ms);
  q.push(entry);
}

const handlers = {
  async config(uid) { const c = await store.config(); send(uid, { t: 'config', feePct: c.feePct, stakes: c.stakes, split4: c.split4, botMult: c.botMult, enabled: c.enabled }); },

  // Private room: creator picks stake, 2/3/4 seats, or 2 vs 2 teams. No coins taken yet.
  async create(uid, m) {
    busy(uid); await checkStake(m.stake);
    const teams = !!m.teams, size = teams ? 4 : [2, 3, 4].includes(m.size) ? m.size : 2;
    const r = newRoom({ kind: 'private', stake: m.stake, size, teams });
    try { await addSeat(r, uid); } catch (e) { rooms.delete(r.code); clearTimeout(r.expire); throw e; }
    r.owner = uid;
    send(uid, roomInfo(r));
  },

  async join(uid, m) {
    busy(uid);
    const r = rooms.get(String(m.code));
    if (!r || r.kind !== 'private' || r.status !== 'waiting') throw err('NO_ROOM');
    if (r.seats.length >= r.size) throw err('ROOM_FULL');
    await addSeat(r, uid);
    if (r.seats.length === r.size) { if (await tryStart(r)) return; }
    else broadcast(r, roomInfo(r));
  },

  async invite(uid, m) {
    const r = rooms.get(userRoom.get(uid));
    if (!r || r.status !== 'waiting') throw err('NO_ROOM');
    const me = seatOf(r, uid);
    for (const to of (m.to || []).slice(0, 50)) {
      await store.invite(uid, to, { code: r.code, stake: r.stake, size: r.size, teams: r.teams, fromName: me.name, fromId: me.userId });
      send(to, { t: 'invite', code: r.code, stake: r.stake, size: r.size, teams: r.teams, fromName: me.name, fromId: me.userId });
    }
  },

  async leave(uid) {
    if (leaveQueue(uid)) { send(uid, { t: 'left' }); return; }
    const r = rooms.get(userRoom.get(uid));
    if (!r) { send(uid, { t: 'left' }); return; }
    if (r.status === 'waiting') {
      dropSeat(r, uid);
      send(uid, { t: 'left' });
      if (r.seats.length === 0 || uid === r.owner) return closeRoom(r, 'owner_left');
      broadcast(r, roomInfo(r));
    } else if (r.status === 'playing') {
      forfeit(r, uid, 'left');
    }
  },

  // Random 1 vs 1: search for 60 seconds at the same stake. Coins are taken when a player is found.
  async random(uid, m) {
    busy(uid); await checkStake(m.stake);
    if ((await store.coins(uid)) < m.stake) throw err('NO_COINS');
    const q = queues.get(m.stake) || [];
    queues.set(m.stake, q);
    const other = q.shift();
    if (!other) { queueUp(uid, m.stake); send(uid, { t: 'searching', stake: m.stake, ms: QUEUE_MS }); return; }
    clearTimeout(other.timer);
    const r = newRoom({ kind: 'random', stake: m.stake, size: 2 });
    for (const id of [other.uid, uid]) {
      const p = await store.profile(id).catch(() => ({ name: 'Player', userId: '' }));
      r.seats.push({ uid: id, name: p.name, userId: p.userId });
      userRoom.set(id, r.code);
    }
    if (await tryStart(r)) return;
    // Someone was short of coins: put the other back in the search.
    for (const s of [...r.seats]) { dropSeat(r, s.uid); queueUp(s.uid, m.stake, 30000); }
    rooms.delete(r.code); clearTimeout(r.expire);
  },

  // Play the computer. Shown clearly as a computer; payout set by level.
  async bot(uid, m) {
    busy(uid); await checkStake(m.stake);
    const level = ['easy', 'normal', 'hard'].includes(m.level) ? m.level : 'normal';
    const r = newRoom({ kind: 'bot', stake: m.stake, size: 2, level });
    try { await addSeat(r, uid); } catch (e) { rooms.delete(r.code); clearTimeout(r.expire); throw e; }
    r.seats.push({ uid: `bot-${r.code}`, bot: true, level, name: `Computer (${level})`, userId: '' });
    if (!(await tryStart(r))) throw err('NO_COINS');
  },

  async roll(uid) {
    const r = rooms.get(userRoom.get(uid));
    if (!r || r.status !== 'playing' || actorOf(r).uid !== uid || r.game.dice != null) throw err('NOT_YOUR_TURN');
    doRoll(r, seatOf(r, uid));
  },

  async move(uid, m) {
    const r = rooms.get(userRoom.get(uid));
    if (!r || r.status !== 'playing' || actorOf(r).uid !== uid || r.game.dice == null) throw err('NOT_YOUR_TURN');
    if (!r.game.movable().includes(m.token)) throw err('BAD_MOVE');
    doMove(r, m.token);
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
        if (r) {
          const s = seatOf(r, uid);
          if (s) { s.goneAt = null; clearTimeout(s.grace); }
          ws.send(JSON.stringify({ ...roomInfo(r), t: r.status === 'playing' ? 'resume' : 'room', state: r.game ? r.game.state() : null }));
          if (r.status === 'playing') broadcast(r, { t: 'back', uid });
        }
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
    if (r && r.status === 'playing') {
      // Net dropped or app closed: 60 seconds to come back, otherwise they lose.
      const s = seatOf(r, uid);
      if (s && !s.out) {
        s.goneAt = Date.now();
        s.grace = setTimeout(() => forfeit(r, uid, 'timeout'), GRACE_MS);
        broadcast(r, { t: 'away', uid, ms: GRACE_MS });
      }
    } else if (r && r.status === 'waiting') {
      handlers.leave(uid).catch(() => {});
    }
    leaveQueue(uid);
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
