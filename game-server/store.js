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
  feePct: 5,
  stakes: [500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000],
  split4: [70, 30],
  botMult: { easy: 1.4, normal: 1.6, hard: 2.0 },
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
    async config() { return config; },
    async lock(uid, amount, matchId) {
      const u = user(uid);
      if (u.coins < amount) { const e = new Error('NO_COINS'); e.code = 'NO_COINS'; throw e; }
      u.coins -= amount;
      const lockId = id();
      locks.set(lockId, { uid, amount, matchId, status: 'locked' });
      return lockId;
    },
    async refund(lockId) {
      const l = locks.get(lockId);
      if (!l || l.status !== 'locked') return;
      user(l.uid).coins += l.amount; l.status = 'refunded';
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

    async lock(uid, amount, matchId) {
      const lockRef = db.collection('gameLocks').doc();
      await db.runTransaction(async tx => {
        const uref = db.collection('users').doc(uid);
        const u = await tx.get(uref);
        const coins = (u.data() || {}).coins || 0;
        if (coins < amount) { const e = new Error('NO_COINS'); e.code = 'NO_COINS'; throw e; }
        tx.update(uref, { coins: FV.increment(-amount), updatedAt: FV.serverTimestamp() });
        tx.set(lockRef, { uid, amount, matchId, status: 'locked', at: FV.serverTimestamp() });
      });
      return lockRef.id;
    },

    async refund(lockId) {
      await db.runTransaction(async tx => {
        const ref = db.collection('gameLocks').doc(lockId);
        const l = await tx.get(ref);
        if (!l.exists || l.data().status !== 'locked') return;
        const { uid, amount } = l.data();
        tx.update(db.collection('users').doc(uid), { coins: FV.increment(amount), updatedAt: FV.serverTimestamp() });
        tx.update(ref, { status: 'refunded', doneAt: FV.serverTimestamp() });
      });
    },

    async settle(lockIds, credits, record) {
      await db.runTransaction(async tx => {
        const refs = lockIds.map(l => db.collection('gameLocks').doc(l));
        const snaps = await Promise.all(refs.map(r => tx.get(r)));
        if (snaps.some(s => !s.exists || s.data().status !== 'locked')) throw new Error('lock already closed');
        refs.forEach(r => tx.update(r, { status: 'settled', doneAt: FV.serverTimestamp() }));
        for (const c of credits) {
          if (c.amount > 0) tx.update(db.collection('users').doc(c.uid), { coins: FV.increment(c.amount), updatedAt: FV.serverTimestamp() });
        }
        tx.set(db.collection('matches').doc(record.id), { ...record, at: FV.serverTimestamp() });
        const day = bdDay();
        const st = String(record.stake);
        tx.set(db.collection('gameStats').doc(day), {
          day,
          matches: FV.increment(1),
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
      await db.collection('users').doc(to).collection('gameInvites').add({ from, ...data, at: FV.serverTimestamp() });
    },
  };
}

module.exports = { memoryStore, firestoreStore, DEFAULTS, bdDay };
