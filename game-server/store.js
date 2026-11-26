'use strict';
// Coin bookkeeping. All coin changes for online games happen here, on the
// server, inside Firestore transactions. A stake is "locked" (taken from the
// player and written to gameLocks) when they join a game, and the lock is
// either settled at the end of the game or refunded.
//
// MEMORY=1 runs a fake in-memory store for local tests (token = uid).

const crypto = require('crypto');

const DEFAULTS = {
  enabled: true,
  feePct: 10,
  stakes: [500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000],
  split4: [70, 30],
  botMult: { easy: 1.4, normal: 1.6, hard: 2.0 },
  giftPct: 80, // share of a gift's price the receiver gets as diamonds
};

const id = () => crypto.randomBytes(10).toString('hex');

// Day key in Bangladesh time (UTC+6), day changes at 12 midnight BD.
function bdDay(t = Date.now()) {
  return new Date(t + 6 * 3600 * 1000).toISOString().slice(0, 10);
}

function memoryStore() {
  const users = new Map();
  const locks = new Map();
  const matches = [];
  const stats = {};
  const invites = [];
  let config = { ...DEFAULTS };
  const user = uid => { if (!users.has(uid)) users.set(uid, { coins: 100000, name: uid, userId: uid }); return users.get(uid); };
  return {
    kind: 'memory', users, locks, matches, stats, invites,
    setConfig(c) { config = { ...DEFAULTS, ...c }; },
    async verify(token) { if (!token) throw new Error('bad token'); return token; },
    async profile(uid) { const u = user(uid); return { name: u.name, photo: null, userId: u.userId }; },
    async coins(uid) { return user(uid).coins; },
    logs: [],
    async config() { return config; },
    async lock(uid, amount, matchId) {
      const u = user(uid);
      if (u.coins < amount) { const e = new Error('NO_COINS'); e.code = 'NO_COINS'; throw e; }
      u.coins -= amount;
      this.logs.push({ uid, type: 'game_stake', amount: -amount });
      const lockId = id();
      locks.set(lockId, { uid, amount, matchId, status: 'locked' });
      return lockId;
    },
    async refund(lockId) {
      const l = locks.get(lockId);
      if (!l || l.status !== 'locked') return;
      user(l.uid).coins += l.amount; l.status = 'refunded';
      this.logs.push({ uid: l.uid, type: 'game_refund', amount: l.amount });
    },
    async settle(lockIds, credits, record) {
      for (const lid of lockIds) { const l = locks.get(lid); if (l && l.status === 'locked') l.status = 'settled'; }
      for (const c of credits) if (c.amount > 0) user(c.uid).coins += c.amount;
      matches.push(record);
      const d = bdDay(); const s = stats[d] ||= { matches: 0, fees: 0, botIncome: 0, income: 0 };
      s.matches++; s.fees += record.fee || 0; s.botIncome += record.botIncome || 0; s.income += record.income;
    },
    async recover() {
      for (const [lid, l] of locks) if (l.status === 'locked') await this.refund(lid);
    },
    async invite(from, to, data) { invites.push({ from, to, ...data }); },
    blocks: new Set(),
    async blocked(a, b) { return this.blocks.has(a + '>' + b) || this.blocks.has(b + '>' + a); },
    roomDocs: new Map(),
    async roomUsed(code) { return this.roomDocs.has(code); },
    async roomStatus(code, data) { this.roomDocs.set(code, { ...(this.roomDocs.get(code) || {}), ...data }); },
    async room(code) { return this.roomDocs.get(code) || null; },
    gifts: { rose: { name: 'Rose', price: 100, active: true } },
    giftLog: [],
    async gift(from, to, giftId, ctx) {
      const g = this.gifts[giftId];
      if (!g || !g.active) { const e = new Error('NO_GIFT'); e.code = 'NO_GIFT'; throw e; }
      const u = user(from);
      if (u.coins < g.price) { const e = new Error('NO_COINS'); e.code = 'NO_COINS'; throw e; }
      u.coins -= g.price;
      const d = Math.floor(g.price * config.giftPct / 100);
      const r = user(to); r.diamonds = (r.diamonds || 0) + d;
      this.giftLog.push({ from, to, giftId, price: g.price, diamonds: d, ...ctx });
      return { name: g.name, price: g.price, diamonds: d };
    },
    async live() {},
  };
}

function firestoreStore(keyFile) {
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(require(keyFile)) });
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;
  let cache = null, cacheAt = 0;

  return {
    kind: 'firestore',
    async verify(token) { return (await admin.auth().verifyIdToken(token)).uid; },

    async profile(uid) {
      const d = (await db.collection('profiles').doc(uid).get()).data() || {};
      const vip = d.vipId && d.vipUntil && d.vipUntil.toMillis() > Date.now();
      return { name: d.name || 'Player', photo: null, userId: (vip ? d.vipId : d.userId) || '' };
    },

    async config() {
      if (cache && Date.now() - cacheAt < 30000) return cache;
      const d = (await db.collection('config').doc('games').get()).data() || {};
      cache = { ...DEFAULTS, ...d, botMult: { ...DEFAULTS.botMult, ...(d.botMult || {}) } };
      cacheAt = Date.now();
      return cache;
    },

    async coins(uid) {
      return ((await db.collection('users').doc(uid).get()).data() || {}).coins || 0;
    },

    async lock(uid, amount, matchId, note = 'Online Ludo stake') {
      const lockRef = db.collection('gameLocks').doc();
      await db.runTransaction(async tx => {
        const uref = db.collection('users').doc(uid);
        const u = await tx.get(uref);
        const coins = (u.data() || {}).coins || 0;
        if ((u.data() || {}).banned) { const e = new Error('BANNED'); e.code = 'BANNED'; throw e; }
        if (coins < amount) { const e = new Error('NO_COINS'); e.code = 'NO_COINS'; throw e; }
        tx.update(uref, { coins: FV.increment(-amount), updatedAt: FV.serverTimestamp() });
        tx.set(lockRef, { uid, amount, matchId, status: 'locked', at: FV.serverTimestamp() });
        tx.set(uref.collection('coinLog').doc(), { type: 'game_stake', amount: -amount, balance: coins - amount, note, ref: matchId, at: FV.serverTimestamp() });
      });
      return lockRef.id;
    },

    async refund(lockId) {
      await db.runTransaction(async tx => {
        const ref = db.collection('gameLocks').doc(lockId);
        const l = await tx.get(ref);
        if (!l.exists || l.data().status !== 'locked') return;
        const { uid, amount, matchId } = l.data();
        const uref = db.collection('users').doc(uid);
        const u = await tx.get(uref);
        const coins = (u.data() || {}).coins || 0;
        tx.update(uref, { coins: FV.increment(amount), updatedAt: FV.serverTimestamp() });
        tx.update(ref, { status: 'refunded', doneAt: FV.serverTimestamp() });
        tx.set(uref.collection('coinLog').doc(), { type: 'game_refund', amount, balance: coins + amount, note: 'Online Ludo stake returned', ref: matchId, at: FV.serverTimestamp() });
      });
    },

    async settle(lockIds, credits, record) {
      await db.runTransaction(async tx => {
        const refs = lockIds.map(l => db.collection('gameLocks').doc(l));
        const snaps = await Promise.all(refs.map(r => tx.get(r)));
        if (snaps.some(s => !s.exists || s.data().status !== 'locked')) throw new Error('lock already closed');
        const paid = credits.filter(c => c.amount > 0);
        const users = await Promise.all(paid.map(c => tx.get(db.collection('users').doc(c.uid))));
        refs.forEach(r => tx.update(r, { status: 'settled', doneAt: FV.serverTimestamp() }));
        paid.forEach((c, i) => {
          const uref = db.collection('users').doc(c.uid);
          const before = (users[i].data() || {}).coins || 0;
          tx.update(uref, { coins: FV.increment(c.amount), updatedAt: FV.serverTimestamp() });
          tx.set(uref.collection('coinLog').doc(), { type: 'game_win', amount: c.amount, balance: before + c.amount,
            note: record.note || (record.mode.startsWith('bot') ? 'Won vs computer (' + record.mode.slice(4) + ')' : 'Won online Ludo (' + record.mode + ')'), ref: record.id, at: FV.serverTimestamp() });
        });
        tx.set(db.collection('matches').doc(record.id), { ...record, at: FV.serverTimestamp() });
        const day = bdDay();
        const st = String(record.stake);
        tx.set(db.collection('gameStats').doc(day), {
          day,
          matches: FV.increment(1),
          players: FV.increment(record.players.filter(p => !String(p).startsWith('bot')).length),
          fees: FV.increment(record.fee || 0),
          botIncome: FV.increment(record.botIncome || 0),
          income: FV.increment(record.income),
          byStake: { [st]: { matches: FV.increment(1), income: FV.increment(record.income) } },
          byMode: { [record.mode]: { matches: FV.increment(1), income: FV.increment(record.income) } },
        }, { merge: true });
      });
    },

    // After a restart, games in memory are gone: give every open stake back.
    async recover() {
      const open = await db.collection('gameLocks').where('status', '==', 'locked').get();
      for (const d of open.docs) await this.refund(d.id).catch(() => {});
      return open.size;
    },

    async invite(from, to, data) {
      const b = db.batch();
      b.set(db.collection('users').doc(to).collection('gameInvites').doc(), { from, ...data, at: FV.serverTimestamp() });
      // The invite also shows in their chat as a Ludo room card, every time it is sent.
      const chatId = from < to ? `${from}_${to}` : `${to}_${from}`;
      const chat = db.collection('chats').doc(chatId);
      const msg = chat.collection('messages').doc();
      b.set(msg, { from, to, type: 'game_invite', text: '', game: data, at: FV.serverTimestamp(), seen: false });
      b.set(chat, { members: chatId.split('_'), last: { type: 'game_invite', text: '', from, mid: msg.id }, updatedAt: FV.serverTimestamp(), unread: { [to]: FV.increment(1) } }, { merge: true });
      await b.commit();
    },

    async blocked(a, b) {
      const [x, y] = await Promise.all([
        db.collection('users').doc(a).collection('blocked').doc(b).get(),
        db.collection('users').doc(b).collection('blocked').doc(a).get(),
      ]);
      return x.exists || y.exists;
    },

    // rooms/{code}: lets invite cards and links show if a room is open, full, playing, over or cancelled.
    async roomUsed(code) { return (await db.collection('rooms').doc(code).get()).exists; },
    async roomStatus(code, data) { await db.collection('rooms').doc(code).set({ ...data, updatedAt: FV.serverTimestamp() }, { merge: true }); },
    async room(code) { const d = await db.collection('rooms').doc(code).get(); return d.exists ? d.data() : null; },

    // A gift in a game: the sender pays coins, the receiver gets giftPct% as diamonds, the rest is income.
    async gift(from, to, giftId, ctx) {
      const cfg = await this.config();
      return db.runTransaction(async tx => {
        const gref = db.collection('gifts').doc(String(giftId));
        const fref = db.collection('users').doc(from), tref = db.collection('users').doc(to);
        const [g, f, t] = await Promise.all([tx.get(gref), tx.get(fref), tx.get(tref)]);
        const gd = g.data();
        if (!g.exists || gd.active === false) { const e = new Error('NO_GIFT'); e.code = 'NO_GIFT'; throw e; }
        if (!t.exists) { const e = new Error('NO_USER'); e.code = 'NO_USER'; throw e; }
        const price = Math.floor(gd.price || 0);
        const fc = (f.data() || {}).coins || 0;
        if (fc < price) { const e = new Error('NO_COINS'); e.code = 'NO_COINS'; throw e; }
        const dia = Math.floor(price * (cfg.giftPct ?? 80) / 100);
        const td = (t.data() || {}).diamonds || 0;
        tx.update(fref, { coins: FV.increment(-price), levelCoins: FV.increment(price), updatedAt: FV.serverTimestamp() });
        tx.update(tref, { diamonds: FV.increment(dia), lifetimeDiamonds: FV.increment(dia), levelCoins: FV.increment(price), updatedAt: FV.serverTimestamp() });
        tx.set(db.collection('profiles').doc(from), { levelCoins: FV.increment(price) }, { merge: true });
        tx.set(db.collection('profiles').doc(to), { levelCoins: FV.increment(price) }, { merge: true });
        tx.set(fref.collection('coinLog').doc(), { type: 'gift_sent', amount: -price, balance: fc - price,
          note: `${gd.name || 'Gift'} to ${ctx.toName} (ID ${ctx.toId})`, ref: ctx.where, at: FV.serverTimestamp() });
        tx.set(tref.collection('diamondLog').doc(), { type: 'gift_received', amount: dia, balance: td + dia,
          note: `${gd.name || 'Gift'} from ${ctx.fromName} (ID ${ctx.fromId})`, fromUid: from, fromName: ctx.fromName, fromId: ctx.fromId,
          gift: gd.name || '', price, ref: ctx.where, at: FV.serverTimestamp() });
        const day = bdDay();
        tx.set(db.collection('giftStats').doc(day), { day, count: FV.increment(1), coins: FV.increment(price), diamonds: FV.increment(dia), income: FV.increment(price - dia) }, { merge: true });
        tx.set(db.collection('giftLog').doc(), { from, to, fromName: ctx.fromName, fromId: ctx.fromId, toName: ctx.toName, toId: ctx.toId,
          gift: gd.name || '', giftId: String(giftId), price, diamonds: dia, income: price - dia, where: ctx.where, day, at: FV.serverTimestamp() });
        return { name: gd.name || 'Gift', price, diamonds: dia };
      });
    },

    // Live numbers for the admin panel, written every few seconds.
    async live(data) { await db.collection('gameLive').doc('now').set({ ...data, at: FV.serverTimestamp() }); },
  };
}

module.exports = { memoryStore, firestoreStore, DEFAULTS, bdDay };
