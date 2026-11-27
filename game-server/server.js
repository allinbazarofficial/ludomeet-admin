'use strict';
// LudoMeet game server: online Ludo over WebSocket.
// The server rolls the dice, checks every move and handles all coins.
// The phone only shows the game and sends taps (roll, move, emoji).

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Ludo } = require('./ludo');
const { memoryStore, firestoreStore } = require('./store');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

const PORT = +process.env.PORT || 8090;
const TURN_MS = +process.env.TURN_MS || 15000;   // time to roll or move
const BOT_MS = +process.env.BOT_MS || 900;       // computer thinking pause
const QUEUE_MS = +process.env.QUEUE_MS || 60000; // random match search
const ROOM_MS = 10 * 60000;                      // unfilled room expires
const GRACE_MS = +process.env.GRACE_MS || 60000; // time to come back after the net drops
const AUTO_MS = +process.env.AUTO_MS || 500;     // pause before an only-possible move
const COUNT_MS = process.env.COUNT_MS != null ? +process.env.COUNT_MS : 3000; // 3-2-1 before the first turn
const WAIT_AWAY_MS = +process.env.WAIT_AWAY_MS || 180000; // a waiting player who switched apps (e.g. to share the link)

const fs = require('fs');
const KEY_FILE = process.env.KEY_FILE || '/opt/ludomeet-game/service-account.json';
const AGORA_FILE = process.env.AGORA_FILE || '/opt/ludomeet-game/agora.json';
const AGORA_APP_ID = '6a67d732e21f49d58fdda4a504f48b26';
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
// Room codes are never used twice: once a room is over, its link stays "over".
async function code6() {
  for (;;) {
    const c = String(100000 + crypto.randomInt(900000));
    if (!rooms.has(c) && !(await store.roomUsed(c).catch(() => false))) return c;
  }
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const err = code => Object.assign(new Error(code), { code });

function roomInfo(r) {
  return { t: 'room', code: r.code, stake: r.stake, size: r.size, teams: r.teams, kind: r.kind, status: r.status,
    seats: r.seats.map((s, i) => ({ uid: s.uid, name: s.name, userId: s.userId, bot: !!s.bot, level: s.level || null, out: !!s.out, vuid: i + 1 })) };
}
const broadcast = (r, msg) => r.seats.forEach(s => !s.bot && send(s.uid, msg));
const seatOf = (r, uid) => r.seats.find(s => s.uid === uid);

// ---- Phone notifications: only chat messages, game invites and "your turn".
// One short soft sound (the app's channel), never vibration. A second message
// from the same person within 2 minutes comes silently.
const recentOver = new Map(); // uid -> { msg, at }: result kept a few minutes for a player who was reconnecting
const chatPushAt = new Map(); // 'to|from' -> time of the last sounding chat notification
const pushRate = new Map();   // uid -> last chat push request time
const chatCount = new Map();  // 'to|from' -> messages in the current quiet run
async function pushTo(uid, { title, body, tag, data = {}, quiet = false, ttl = 3600 }) {
  if (!store || !store.sendPush) return;
  try {
    const token = await store.pushToken(uid);
    if (!token) return;
    const d = {}; for (const [k, v] of Object.entries(data)) d[k] = String(v);
    await store.sendPush(token, {
      notification: { title, body },
      data: d,
      android: {
        priority: 'high',
        ttl: ttl * 1000,
        collapseKey: tag,
        notification: { channelId: quiet ? 'lm_quiet' : 'lm_main', tag, icon: 'ic_notify', color: '#7C4DFF', defaultVibrateTimings: false },
      },
    });
  } catch (e) { log('push', uid, e.code || e.message); }
}

async function newRoom({ kind, stake, size, teams = false, level = null }) {
  const r = { code: await code6(), matchId: crypto.randomUUID(), kind, stake, size, teams, level, seats: [], status: 'waiting', createdAt: Date.now() };
  rooms.set(r.code, r);
  r.expire = setTimeout(() => closeRoom(r, 'expired'), ROOM_MS);
  return r;
}

const modeName = r => r.kind === 'bot' ? `vs computer (${r.level})` : r.teams ? 'team 2 vs 2' : `${r.size} players`;

// Public room status for links and invite cards.
function saveStatus(r, status) {
  if (r.kind !== 'private') return;
  const owner = seatOf(r, r.owner) || {};
  store.roomStatus(r.code, { code: r.code, status, stake: r.stake, size: r.size, teams: r.teams, filled: r.seats.length,
    owner: r.owner || '', ownerName: owner.name || '', ownerId: owner.userId || '' }).catch(e => log('roomStatus', e.message));
}

// Voice (Agora): each human gets a token for this game's channel.
const AGORA = () => { try { return JSON.parse(fs.readFileSync(AGORA_FILE, 'utf8')); } catch { return null; } };
function sendVoice(r, uid) {
  if (r.kind === 'bot') return;
  const a = AGORA(); if (!a) return;
  const i = r.seats.findIndex(s => s.uid === uid); if (i < 0) return;
  const channel = 'ludo_' + r.matchId.replace(/-/g, '').slice(0, 24);
  const token = RtcTokenBuilder.buildTokenWithUid(a.appId, a.cert, channel, i + 1, RtcRole.PUBLISHER, 3 * 3600, 3 * 3600);
  send(uid, { t: 'voice', appId: a.appId, channel, vuid: i + 1, token, blocks: r.blocks || [] });
}

// Taking a seat costs nothing yet. Coins are taken only when the game starts.
async function addSeat(r, uid) {
  if ((await store.coins(uid)) < r.stake) throw err('NO_COINS');
  for (const s of r.seats) if (!s.bot && await store.blocked(uid, s.uid).catch(() => false)) throw err('BLOCKED');
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
  r.seats.forEach(s => clearTimeout(s.awayTimer));
  saveStatus(r, 'cancelled');
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
    try { s.lockId = await store.lock(s.uid, r.stake, r.matchId, `Online Ludo · ${modeName(r)} · table ${r.stake.toLocaleString('en-US')}${r.kind === 'private' ? ' · room ' + r.code : ''}`); }
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
  await startGame(r);
  return true;
}

async function startGame(r) {
  clearTimeout(r.expire);
  r.status = 'playing';
  r.seats.forEach(s => clearTimeout(s.awayTimer));
  const seats = r.seats.map((s, i) => ({ id: s.uid, team: r.teams ? i % 2 : null }));
  const cfg = await store.config();
  const balance = cfg.balanceOn === false ? 0 : (r.kind === 'bot' && cfg.botBalance === false ? 0 : Number(cfg.balance) || 0);
  r.game = new Ludo(seats, { needed: r.size === 4 && !r.teams ? 2 : 1, balance });
  // Players who blocked each other never hear each other.
  r.blocks = [];
  const humans = r.seats.filter(s => !s.bot);
  for (let i = 0; i < humans.length; i++) for (let j = i + 1; j < humans.length; j++)
    if (await store.blocked(humans[i].uid, humans[j].uid).catch(() => false)) r.blocks.push([humans[i].uid, humans[j].uid]);
  saveStatus(r, 'playing');
  broadcast(r, { ...roomInfo(r), t: 'start', state: r.game.state(), countdown: COUNT_MS });
  humans.forEach(s => sendVoice(r, s.uid));
  clearTimeout(r.timer);
  r.timer = setTimeout(() => safe(r, () => nextTurn(r)), COUNT_MS);
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
  // Left the app during the game: one "your turn" notification, until they come back.
  if (!a.bot && (away || a.bg) && !a.turnPushed) {
    a.turnPushed = true;
    pushTo(a.uid, { title: '🎲 Your turn!', body: 'Come back to your Ludo game now, or you will miss your turn.', tag: 'turn_' + r.code, data: { kind: 'turn', code: r.code }, ttl: 60 });
  }
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
  else doMove(r, r.game.botMove(a.bot ? (a.skill ?? a.level) : 'hard'));
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
  if (r.mics && r.mics.delete(uid)) broadcast(r, { t: 'mic', uid, on: false, active: [...r.mics] });
  broadcast(r, { t: 'eliminated', uid, reason, state: r.game.state() });
  send(uid, { t: 'left', code: r.code });
  nextTurn(r);
}

// ---- Computer games: aim for the target computer win rate (config botTarget, %)
// across all players. One base skill for everyone moves slowly toward the
// target; a player who has just lost several in a row meets a softer computer
// next game, one who keeps winning meets a stronger one. If the recent income
// falls under botGuard %, the softening is paused and the computer plays its best.
async function botSkillFor(uid) {
  const cfg = await store.config();
  const st = await store.botState();
  let skill = st.skill;
  const streak = await store.botStreak(uid); // +n = n wins in a row, -n = n losses in a row
  const recentMargin = st.stake ? (st.stake - st.paid) / st.stake * 100 : 100;
  const guard = recentMargin < (Number(cfg.botGuard) || 10) && st.games >= 50;
  if (!guard) {
    if (streak <= -3) skill -= 0.3; else if (streak === -2) skill -= 0.15;
  }
  if (streak >= 2) skill += 0.2;
  if (guard) skill = 1;
  return Math.max(0.05, Math.min(1, skill));
}

async function botResult(uid, computerWon, stake, paid, cfg) {
  const st = await store.botState();
  const N = 300;
  st.recent = (st.recent || []).concat([[computerWon ? 1 : 0, stake, paid]]).slice(-N);
  st.games = st.recent.length;
  st.stake = st.recent.reduce((a, x) => a + x[1], 0);
  st.paid = st.recent.reduce((a, x) => a + x[2], 0);
  const rate = st.recent.reduce((a, x) => a + x[0], 0) / st.games * 100;
  const target = Number(cfg.botTarget) || 60;
  if (rate < target - 2) st.skill = Math.min(1, st.skill + 0.02);
  else if (rate > target + 2) st.skill = Math.max(0.3, st.skill - 0.02);
  await store.saveBotState(st);
  const prev = await store.botStreak(uid);
  const playerWon = !computerWon;
  const next = playerWon ? (prev > 0 ? prev + 1 : 1) : (prev < 0 ? prev - 1 : -1);
  await store.setBotStreak(uid, next);
}

// Prize rules (fee and splits come from config/games, set in the admin panel).
function payouts(r, cfg) {
  const ranking = r.game.ranking();
  const human = r.seats.filter(s => !s.bot);
  if (r.kind === 'bot') {
    const me = human[0];
    const won = ranking[0] === me.uid;
    const mult = r.level === 'auto' ? Number(cfg.botPayout) || 2 : cfg.botMult[r.level] || 1.6;
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
    note: `Won Online Ludo · ${modeName(r)} · table ${r.stake.toLocaleString('en-US')}${r.kind === 'private' ? ' · room ' + r.code : ''}`,
    stake: r.stake, players: r.seats.map(s => s.bot ? `bot:${s.level}` : s.uid), ranking: p.ranking, credits: p.credits,
    fee: p.fee, botIncome: p.botIncome, income: p.income };
  try {
    await store.settle(r.seats.filter(s => s.lockId).map(s => s.lockId), p.credits, record);
  } catch (e) { log('settle failed', r.matchId, e.message); }
  const overMsg = { t: 'over', code: r.code, ranking: p.ranking, credits: p.credits, stake: r.stake, left: r.seats.filter(s => s.out && !s.bot).map(s => s.uid) };
  r.seats.forEach(s => { if (s.bot) return; send(s.uid, overMsg); recentOver.set(s.uid, { msg: overMsg, at: Date.now() }); });
  for (const [k, v] of recentOver) if (Date.now() - v.at > 10 * 60000) recentOver.delete(k);
  saveStatus(r, 'over');
  r.status = 'closed';
  r.seats.forEach(s => userRoom.get(s.uid) === r.code && userRoom.delete(s.uid));
  rooms.delete(r.code);
  log('match', record.mode, record.stake, 'income', record.income);
  if (r.kind === 'bot') botResult(r.seats.find(s => !s.bot).uid, p.income > 0, r.stake, r.stake - p.income, cfg).catch(e => log('bot stats', e.message));
}

// Updating: no new games; the old server keeps running the games already
// being played and stops by itself once the last one is over.
let draining = false;
function drain() {
  if (draining) return;
  draining = true;
  log('update: waiting for running games to finish');
  for (const r of [...rooms.values()]) if (r.status === 'waiting') closeRoom(r, 'update').catch(() => {});
  for (const q of queues.values()) for (const e of q.splice(0)) { clearTimeout(e.timer); send(e.uid, { t: 'noMatch', stake: 0 }); }
  const check = () => {
    const busyRooms = [...rooms.values()].filter(r => r.status !== 'closed' && r.status !== 'waiting').length;
    if (busyRooms === 0) { log('update: no games left, restarting'); setTimeout(() => process.exit(0), 300); return true; }
    return false;
  };
  if (!check()) setInterval(check, 2000);
}
process.on('SIGTERM', drain);

async function checkStake(stake) {
  if (draining) throw err('UPDATING');
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
  async config(uid) { const c = await store.config(); send(uid, { t: 'config', feePct: c.feePct, stakes: c.stakes, split4: c.split4, botMult: c.botMult, enabled: c.enabled, giftPct: c.giftPct, voiceIdleSec: c.voiceIdleSec, botPayout: c.botPayout, exchangePer100k: c.exchangePer100k }); },

  // My mic on/off. Everyone at the table learns whose mic is on; phones join
  // the voice channel only while at least one mic is on.
  async mic(uid, m) {
    const r = rooms.get(userRoom.get(uid));
    if (!r || r.status !== 'playing' || r.kind === 'bot') return;
    r.mics = r.mics || new Set();
    if (m.on) r.mics.add(uid); else r.mics.delete(uid);
    broadcast(r, { t: 'mic', uid, on: !!m.on, active: [...r.mics] });
  },

  // Private room: creator picks stake, 2/3/4 seats, or 2 vs 2 teams. No coins taken yet.
  async create(uid, m) {
    busy(uid); await checkStake(m.stake);
    const teams = !!m.teams, size = teams ? 4 : [2, 3, 4].includes(m.size) ? m.size : 2;
    const r = await newRoom({ kind: 'private', stake: m.stake, size, teams });
    try { await addSeat(r, uid); } catch (e) { rooms.delete(r.code); clearTimeout(r.expire); throw e; }
    r.owner = uid;
    saveStatus(r, 'open');
    send(uid, roomInfo(r));
  },

  async join(uid, m) {
    busy(uid);
    const r = rooms.get(String(m.code));
    if (!r) {
      const old = await store.room(String(m.code)).catch(() => null);
      throw err(old && old.status === 'over' ? 'ROOM_OVER' : old && old.status === 'playing' ? 'ROOM_PLAYING' : old ? 'ROOM_CANCELLED' : 'NO_ROOM');
    }
    if (r.kind !== 'private') throw err('NO_ROOM');
    if (r.status === 'playing' || r.status === 'starting') throw err('ROOM_PLAYING');
    if (r.status !== 'waiting') throw err('NO_ROOM');
    if (r.seats.length >= r.size) throw err('ROOM_FULL');
    await addSeat(r, uid);
    if (r.seats.length === r.size) { if (await tryStart(r)) return; }
    else { saveStatus(r, 'open'); broadcast(r, roomInfo(r)); }
  },

  // What a link or invite card should show before joining.
  async peek(uid, m) {
    const code = String(m.code || '');
    const r = rooms.get(code);
    let info;
    if (r && r.kind === 'private') {
      const o = seatOf(r, r.owner) || r.seats[0] || {};
      const status = r.status === 'waiting' ? (r.seats.length >= r.size ? 'full' : 'open') : r.status === 'playing' || r.status === 'starting' ? 'playing' : 'over';
      info = { status, stake: r.stake, size: r.size, teams: r.teams, filled: r.seats.length, owner: r.owner, ownerName: o.name, ownerId: o.userId };
    } else {
      const d = await store.room(code).catch(() => null);
      info = d ? { ...d, status: d.status === 'open' ? 'cancelled' : d.status } : { status: 'none' };
      delete info.updatedAt;
    }
    send(uid, { t: 'peek', code, ...info });
  },

  // A gift during a game: the receiver gets 80% as diamonds.
  async gift(uid, m) {
    const r = rooms.get(userRoom.get(uid));
    if (!r || r.status !== 'playing') throw err('NO_ROOM');
    const from = seatOf(r, uid), to = seatOf(r, String(m.to || ''));
    if (!to || to.bot || to.uid === uid) throw err('BAD_GIFT');
    if (await store.blocked(uid, to.uid).catch(() => false)) throw err('BLOCKED');
    const g = await store.gift(uid, to.uid, String(m.giftId || ''), { fromName: from.name, fromId: from.userId, toName: to.name, toId: to.userId, where: 'Online Ludo · room ' + r.code });
    broadcast(r, { t: 'gift', from: uid, to: to.uid, giftId: String(m.giftId), name: g.name, price: g.price, diamonds: g.diamonds });
  },

  // Re-send my voice ticket (e.g. after the app was in the background).
  async voice(uid) {
    const r = rooms.get(userRoom.get(uid));
    if (r && r.status === 'playing') sendVoice(r, uid);
  },

  async invite(uid, m) {
    const r = rooms.get(userRoom.get(uid));
    if (!r || r.status !== 'waiting') throw err('NO_ROOM');
    const me = seatOf(r, uid);
    const cfg = await store.config();
    const keep = (100 - cfg.feePct) / 100;
    const pot = r.stake * r.size * keep;
    const prize = r.teams ? [Math.floor(pot / 2)] : r.size === 4 ? cfg.split4.map(x => Math.floor(pot * x / 100)) : [Math.floor(pot)];
    const data = { code: r.code, stake: r.stake, size: r.size, teams: r.teams, prize, fromUid: uid, fromName: me.name, fromId: me.userId };
    let sent = 0;
    for (const to of (m.to || []).slice(0, 50)) {
      if (typeof to !== 'string' || to === uid) continue;
      if (await store.blocked(uid, to).catch(() => false)) continue;
      await store.invite(uid, to, data).catch(e => log('invite', e.message));
      send(to, { t: 'invite', ...data });
      pushTo(to, { title: '🎲 Ludo invite', body: `${me.name} invited you to play Ludo · table ${r.stake.toLocaleString('en-US')} coins`, tag: 'invite_' + r.code, data: { kind: 'invite', code: r.code }, ttl: 60 });
      sent++;
    }
    send(uid, { t: 'invited', sent });
  },

  // Is this player still in a room or a running game? (Lets the app show "Return to game".)
  async active(uid) {
    const r = rooms.get(userRoom.get(uid));
    const s = r && seatOf(r, uid);
    if (r && s && !s.out && r.status === 'finishing') return send(uid, { ...roomInfo(r), t: 'active', status: 'finishing' });
    if (!r || !s || s.out || (r.status !== 'playing' && r.status !== 'waiting')) {
      const last = recentOver.get(uid);
      return send(uid, { t: 'active', none: true, ...(last && Date.now() - last.at < 10 * 60000 ? { over: last.msg } : {}) });
    }
    send(uid, { ...roomInfo(r), t: 'active', status: r.status });
  },

  // Go back into my running game (or my waiting room) after leaving its screen.
  async rejoin(uid) {
    const r = rooms.get(userRoom.get(uid));
    const s = r && seatOf(r, uid);
    if (!r || !s || s.out) throw err('NO_GAME');
    s.goneAt = null; s.bg = false; s.turnPushed = false; clearTimeout(s.grace); clearTimeout(s.awayTimer);
    if (r.status === 'playing') {
      send(uid, { ...roomInfo(r), t: 'resume', state: r.game ? r.game.state() : null });
      broadcast(r, { t: 'back', uid });
      sendVoice(r, uid);
    } else if (r.status === 'waiting') {
      send(uid, roomInfo(r));
    } else throw err('NO_GAME');
  },

  async leave(uid) {
    if (leaveQueue(uid)) { send(uid, { t: 'left' }); return; }
    const r = rooms.get(userRoom.get(uid));
    if (!r) { send(uid, { t: 'left' }); return; }
    if (r.status === 'waiting') {
      clearTimeout((seatOf(r, uid) || {}).awayTimer);
      dropSeat(r, uid);
      send(uid, { t: 'left' });
      if (r.seats.length === 0 || uid === r.owner) return closeRoom(r, 'owner_left');
      saveStatus(r, 'open');
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
    // Never pair two players where one blocked the other.
    let other = null;
    for (let i = 0; i < q.length; i++) {
      if (q[i].uid === uid) continue;
      if (await store.blocked(uid, q[i].uid).catch(() => false)) continue;
      [other] = q.splice(i, 1); break;
    }
    if (!other) { queueUp(uid, m.stake); send(uid, { t: 'searching', stake: m.stake, ms: QUEUE_MS }); return; }
    clearTimeout(other.timer);
    const r = await newRoom({ kind: 'random', stake: m.stake, size: 2 });
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
    // One computer that adapts its play (same rule for every player).
    const level = 'auto';
    const skill = await botSkillFor(uid);
    const r = await newRoom({ kind: 'bot', stake: m.stake, size: 2, level });
    try { await addSeat(r, uid); } catch (e) { rooms.delete(r.code); clearTimeout(r.expire); throw e; }
    r.seats.push({ uid: `bot-${r.code}`, bot: true, level, skill, name: 'Computer', userId: '' });
    if (!(await tryStart(r))) throw err('NO_COINS');
  },

  // Google Play coin purchase: the server checks it with Google and adds the coins once.
  async iapVerify(uid, m) {
    const product = String(m.product || ''), token = String(m.token || '');
    const res = await store.iapVerify(uid, product, token);
    send(uid, { t: 'iapOk', product, token, ...res });
  },

  // Diamonds -> coins (rate from the admin panel). toTrading: a seller's trading coins.
  async exchange(uid, m) {
    const d = Math.floor(Number(m.diamonds));
    const res = await store.exchange(uid, d, m.trading === true);
    send(uid, { t: 'exchanged', ...res, trading: m.trading === true });
  },

  // A coin seller sends trading coins to a user (wallet) or to another seller (trading).
  async tradeSend(uid, m) {
    const amount = Math.floor(Number(m.amount));
    if (!(amount >= 1 && amount <= 1e10)) throw err('BAD_AMOUNT');
    const res = await store.tradeSend(uid, String(m.to || ''), amount, m.target === 'trading' ? 'trading' : 'wallet');
    send(uid, { t: 'tradeSent', amount, ...res });
    send(res.to, { t: 'coinsReceived', amount, from: uid });
  },

  async sellerSetup(uid, m) {
    const country = String(m.country || '').toUpperCase();
    const wa = String(m.whatsapp || '').replace(/[^0-9+]/g, '');
    if (!/^[A-Z]{2}$/.test(country) || !/^\+[0-9]{6,16}$/.test(wa)) throw err('BAD_INPUT');
    await store.sellerSetup(uid, country, wa);
    send(uid, { t: 'sellerReady' });
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

  // The phone's notification token (sent by the app after sign-in).
  async pushToken(uid, m) {
    if (typeof m.token !== 'string' || m.token.length < 20 || m.token.length > 4096 || m.token.includes('/')) return;
    await store.savePushToken(uid, m.token);
  },

  // The app went to the background (on) or came back (off) during a game.
  async bg(uid, m) {
    const r = rooms.get(userRoom.get(uid));
    const s = r && seatOf(r, uid);
    if (!s) return;
    s.bg = m.on === true;
    if (!s.bg) s.turnPushed = false;
    else if (r.status === 'playing' && actorOf(r) === s && !s.turnPushed) {
      s.turnPushed = true;
      pushTo(uid, { title: '🎲 Your turn!', body: 'Come back to your Ludo game now, or you will miss your turn.', tag: 'turn_' + r.code, data: { kind: 'turn', code: r.code }, ttl: 60 });
    }
  },

  // I just sent a chat message: notify the other player (text comes from the saved message).
  async chatPush(uid, m) {
    const to = m.to;
    if (typeof to !== 'string' || !to || to === uid || to.length > 128) return;
    const now = Date.now();
    if (now - (pushRate.get(uid) || 0) < 800) return;
    pushRate.set(uid, now);
    const msg = await store.lastMessage(uid, to);
    if (!msg || now - msg.at > 2 * 60000) return;
    const name = (await store.profile(uid)).name || 'LudoMeet';
    const body = msg.type === 'image' ? '📷 Photo' : msg.type === 'voice' ? '🎤 Voice message' : msg.type === 'game_invite' ? '🎲 Ludo game invite' : String(msg.text).slice(0, 120);
    const key = to + '|' + uid;
    const quiet = now - (chatPushAt.get(key) || 0) < 2 * 60000;
    if (!quiet) { chatPushAt.set(key, now); chatCount.set(key, 0); }
    const count = (chatCount.get(key) || 0) + 1;
    chatCount.set(key, count);
    if (chatCount.size > 50000) chatCount.clear();
    if (chatPushAt.size > 50000) chatPushAt.clear();
    if (pushRate.size > 50000) pushRate.clear();
    await pushTo(to, { title: name, body: count > 1 ? `${count} new messages · ${body}` : body, tag: 'chat_' + uid, data: { kind: 'chat', uid }, quiet, ttl: 24 * 3600 });
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
          if (s) { s.goneAt = null; s.bg = false; s.turnPushed = false; clearTimeout(s.grace); clearTimeout(s.awayTimer); }
          ws.send(JSON.stringify({ ...roomInfo(r), t: r.status === 'playing' ? 'resume' : 'room', state: r.game ? r.game.state() : null }));
          if (r.status === 'playing') { broadcast(r, { t: 'back', uid }); sendVoice(r, uid); }
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
        if (r.mics && r.mics.delete(uid)) broadcast(r, { t: 'mic', uid, on: false, active: [...r.mics] });
      }
    } else if (r && r.status === 'waiting') {
      // Switching to WhatsApp to share the link must not close the room: wait a few minutes.
      const s = seatOf(r, uid);
      if (s) { clearTimeout(s.awayTimer); s.awayTimer = setTimeout(() => !clients.has(uid) && handlers.leave(uid).catch(() => {}), WAIT_AWAY_MS); }
    }
    leaveQueue(uid);
  });
}

async function main() {
  if (SETUP) return setupServer();
  const n = await store.recover().catch(e => { log('recover failed', e.message); return 0; });
  if (n) log('refunded', n, 'stakes from before restart');
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/health')) { res.end(JSON.stringify({ ok: true, rooms: rooms.size, online: clients.size, voice: fs.existsSync(AGORA_FILE) })); return; }
    // One-time: the owner pastes the Agora App Certificate from
    // playludomeet.com/setup-agora.html. It is kept only on this server.
    if (req.url.endsWith('/setup-agora') && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        try {
          const cert = String(JSON.parse(body).cert || '').trim().toLowerCase();
          if (!/^[0-9a-f]{32}$/.test(cert)) throw new Error('bad');
          if (cert === AGORA_APP_ID) throw new Error('appid');
          if (fs.existsSync(AGORA_FILE)) throw new Error('exists');
          fs.writeFileSync(AGORA_FILE, JSON.stringify({ appId: AGORA_APP_ID, cert }), { mode: 0o600 });
          log('agora certificate installed');
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: e.message })); }
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ server, maxPayload: 4096 });
  // Live numbers for the admin panel.
  const liveTimer = setInterval(() => {
    let waiting = 0, playing = 0, inGames = 0; const byMode = {};
    for (const r of rooms.values()) {
      if (r.status === 'waiting') waiting++;
      if (r.status === 'playing') { playing++; inGames += r.seats.filter(s => !s.bot && !s.out).length; const k = modeName(r); byMode[k] = (byMode[k] || 0) + 1; }
    }
    let searching = 0; for (const q of queues.values()) searching += q.length;
    store.live({ online: clients.size, waitingRooms: waiting, playing, playersInGames: inGames, searching, byMode }).catch(() => {});
  }, +process.env.LIVE_MS || 60000);
  wss.on('connection', onConnection);
  const ping = setInterval(() => wss.clients.forEach(w => { if (w.alive === false) return w.terminate(); w.alive = false; w.ping(); }), 30000);
  wss.on('connection', w => { w.alive = true; w.on('pong', () => (w.alive = true)); });
  server.listen(PORT, '127.0.0.1', () => log('game server on', PORT, store.kind));
  return { server, wss, stop: () => { clearInterval(ping); clearInterval(liveTimer); wss.close(); server.close(); } };
}

module.exports = { main, store, rooms, payouts };
if (require.main === module) main();
