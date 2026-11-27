'use strict';
// Plays real games against the server (in-memory coins) and checks that no
// coins appear or disappear. Run: npm test
process.env.MEMORY = '1'; process.env.PORT = '18090';
process.env.TURN_MS = '60'; process.env.BOT_MS = '5'; process.env.QUEUE_MS = '300'; process.env.AUTO_MS = '5'; process.env.COUNT_MS = '0';
const WebSocket = require('ws');
const { main, store } = require('./server');
const assert = require('assert');

function client(uid) {
  const ws = new WebSocket('ws://127.0.0.1:18090');
  const c = { uid, ws, msgs: [], waiters: [] };
  ws.on('message', d => {
    const m = JSON.parse(d); c.msgs.push(m);
    // Play fast: roll and move as soon as it is our turn.
    if (m.t === 'turn' && m.uid === uid) {
      if (m.phase === 'roll') c.send({ t: 'roll' });
    }
    if (m.t === 'rolled' && m.by === uid && m.moves.length > 1) c.send({ t: 'move', token: m.moves[0] });
    c.waiters = c.waiters.filter(w => !(w.t === m.t && (w.resolve(m), true)));
  });
  c.send = m => ws.send(JSON.stringify(m));
  c.wait = (t, ms = 20000) => new Promise((resolve, reject) => { c.waiters.push({ t, resolve }); setTimeout(() => reject(new Error(uid + ' timeout ' + t)), ms); });
  c.open = new Promise(r => ws.on('open', r));
  return c;
}

const total = () => [...store.users.values()].reduce((s, u) => s + u.coins, 0);

(async () => {
  const srv = await main();
  const conns = [];
  const make = async uid => { const c = client(uid); await c.open; c.send({ t: 'auth', token: uid }); await c.wait('hello'); conns.push(c); return c; };
  const [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map(make));
  for (const u of ['a', 'b', 'c', 'd']) await store.profile(u);
  const start = total();

  // 1) private 2-player room
  a.send({ t: 'create', stake: 1000, size: 2 });
  const room = await a.wait('room');
  b.send({ t: 'join', code: room.code });
  let over = await a.wait('over', 60000);
  assert.equal(over.credits[0].amount, 1800, '2p prize is pot minus 10%');
  let houseIncome = 200;
  assert.equal(total(), start - houseIncome);
  console.log('2-player ok, winner', over.ranking[0]);

  // 2) four players: 70/30
  a.send({ t: 'create', stake: 5000, size: 4 });
  const r4 = await a.wait('room');
  for (const x of [b, c, d]) x.send({ t: 'join', code: r4.code });
  over = await a.wait('over', 120000);
  assert.deepEqual(over.credits.map(x => x.amount), [12600, 5400]);
  houseIncome += 2000;
  assert.equal(total(), start - houseIncome);
  console.log('4-player ok', over.ranking.slice(0, 2));

  // 3) 2 vs 2 teams
  a.send({ t: 'create', stake: 500, teams: true });
  const rt = await a.wait('room');
  for (const x of [b, c, d]) x.send({ t: 'join', code: rt.code });
  over = await a.wait('over', 120000);
  assert.equal(over.credits.length, 2); assert.equal(over.credits[0].amount, 900);
  houseIncome += 200;
  assert.equal(total(), start - houseIncome);
  console.log('teams ok');

  // 4) random match pairs two people
  a.send({ t: 'random', stake: 500 }); b.send({ t: 'random', stake: 500 });
  over = await a.wait('over', 60000);
  houseIncome += 100;
  assert.equal(total(), start - houseIncome);
  console.log('random ok');

  // 5) random with nobody: refund + noMatch
  const before = store.users.get('c').coins;
  c.send({ t: 'random', stake: 1000 });
  await c.wait('noMatch');
  assert.equal(store.users.get('c').coins, before);
  console.log('no match refund ok');

  // 6) computer games at each level, many times: income = stake - payout
  let botNet = 0, wins = 0, n = 0;
  for (const level of ['easy', 'normal', 'hard']) {
    for (let i = 0; i < 20; i++) {
      d.send({ t: 'bot', stake: 1000, level });
      const o = await d.wait('over', 60000);
      const won = o.ranking[0] === 'd'; wins += won; n++;
      botNet += 1000 - o.credits[0].amount;
    }
  }
  houseIncome += botNet;
  assert.equal(total(), start - houseIncome);
  console.log(`computer games ok: player won ${wins}/${n}, house net ${botNet}`);

  // 7) not enough coins, bad stake, leaving a waiting room refunds
  store.users.get('a').coins = 100;
  a.send({ t: 'create', stake: 1000, size: 2 }); let e = await a.wait('error'); assert.equal(e.code, 'NO_COINS');
  a.send({ t: 'create', stake: 777, size: 2 }); e = await a.wait('error'); assert.equal(e.code, 'BAD_STAKE');
  store.users.get('a').coins = 5000;
  a.send({ t: 'create', stake: 1000, size: 3 }); await a.wait('room');
  assert.equal(store.users.get('a').coins, 5000, 'no coins taken while waiting');
  a.send({ t: 'leave' }); await a.wait('left');
  assert.equal(store.users.get('a').coins, 5000);
  console.log('errors and free leave ok');

  // 9) leaving a running game = lose at once; the other wins
  const s0 = total();
  a.send({ t: 'create', stake: 1000, size: 2 });
  const rl = await a.wait('room');
  b.send({ t: 'join', code: rl.code });
  await a.wait('start');
  a.send({ t: 'leave' });
  over = await b.wait('over', 10000);
  assert.equal(over.ranking[0], 'b'); assert.equal(over.credits[0].amount, 1800);
  assert.equal(total(), s0 - 200);
  houseIncome += 200;
  console.log('leave = lose ok');

  // 10) room links: over after a game, never reusable; full rooms refuse
  const s1 = total();
  a.send({ t: 'peek', code: rl.code }); let pk = await a.wait('peek'); assert.equal(pk.status, 'over');
  c.send({ t: 'join', code: rl.code }); e = await c.wait('error'); assert.equal(e.code, 'ROOM_OVER');
  a.send({ t: 'create', stake: 500, size: 2 }); const rp = await a.wait('room');
  a.send({ t: 'peek', code: rp.code }); pk = await a.wait('peek'); assert.equal(pk.status, 'open'); assert.equal(pk.ownerName, 'a');
  a.send({ t: 'invite', to: ['c', 'd'] }); const inv = await c.wait('invite'); assert.equal(inv.prize[0], 900); await a.wait('invited');
  b.send({ t: 'join', code: rp.code }); await a.wait('start');
  c.send({ t: 'join', code: rp.code }); e = await c.wait('error'); assert.equal(e.code, 'ROOM_PLAYING');

  // 11) gifts in a game: 80% to the receiver as diamonds
  const ac = store.users.get('a').coins;
  a.send({ t: 'gift', to: 'b', giftId: 'rose' }); const gm = await b.wait('gift');
  assert.equal(gm.diamonds, 80); assert.equal(store.users.get('a').coins, ac - 100); assert.equal(store.users.get('b').diamonds, 80);
  await a.wait('over', 60000);
  assert.equal(total(), s1 - 100 - 100, 'gift coins + match fee left the pool');
  console.log('links, full rooms and gifts ok');

  // 12) blocked players are never matched together
  store.blocks.add('a>b');
  a.send({ t: 'random', stake: 1000 }); b.send({ t: 'random', stake: 1000 });
  await a.wait('noMatch'); await b.wait('noMatch');
  a.send({ t: 'create', stake: 500, size: 2 }); const rb = await a.wait('room');
  b.send({ t: 'join', code: rb.code }); e = await b.wait('error'); assert.equal(e.code, 'BLOCKED');
  a.send({ t: 'leave' }); await a.wait('left');
  console.log('blocks ok');

  // 8) left the game screen: the app can see the running game and go back into it
  a.send({ t: 'active' }); let act = await a.wait('active'); assert.equal(act.none, true);
  a.send({ t: 'rejoin' }); e = await a.wait('error'); assert.equal(e.code, 'NO_GAME');
  a.send({ t: 'bot', stake: 500, level: 'easy' }); await a.wait('start');
  a.send({ t: 'active' }); act = await a.wait('active'); assert.equal(act.status, 'playing'); assert.equal(act.stake, 500);
  a.send({ t: 'rejoin' }); const rs = await a.wait('resume'); assert.ok(rs.state && rs.seats.length === 2);
  a.send({ t: 'bot', stake: 500, level: 'easy' }); e = await a.wait('error'); assert.equal(e.code, 'IN_GAME');
  a.send({ t: 'leave' }); await a.wait('over', 60000);
  a.send({ t: 'active' }); act = await a.wait('active'); assert.equal(act.none, true);
  console.log('return to game ok');

  // 9) exchange and coin trading
  store.users.get('a').diamonds = 200000; store.setConfig({ exchangePer100k: 90000 });
  a.send({ t: 'exchange', diamonds: 100000 }); let ex = await a.wait('exchanged'); assert.equal(ex.coins, 90000); assert.equal(store.users.get('a').diamonds, 100000);
  a.send({ t: 'exchange', diamonds: 100000, trading: true }); e = await a.wait('error'); assert.equal(e.code, 'NOT_SELLER');
  store.users.get('a').roles = ['coinSeller']; store.users.get('a').tradingCoins = 500000;
  const bCoins = store.users.get('b').coins;
  a.send({ t: 'tradeSend', to: store.users.get('b').userId, amount: 100000 }); let ts = await a.wait('tradeSent'); assert.equal(ts.balance, 400000);
  assert.equal(store.users.get('b').coins, bCoins + 100000); await b.wait('coinsReceived');
  a.send({ t: 'tradeSend', to: store.users.get('b').userId, amount: 1000, target: 'trading' }); e = await a.wait('error'); assert.equal(e.code, 'NOT_SELLER');
  a.send({ t: 'tradeSend', to: store.users.get('b').userId, amount: 9999999 }); e = await a.wait('error'); assert.equal(e.code, 'NO_COINS');
  b.send({ t: 'tradeSend', to: 'a', amount: 10 }); e = await b.wait('error'); assert.equal(e.code, 'NOT_SELLER');
  a.send({ t: 'sellerSetup', country: 'BD', whatsapp: '+8801711000000' }); await a.wait('sellerReady');
  a.send({ t: 'sellerSetup', country: 'BD', whatsapp: '+8801711000001' }); e = await a.wait('error'); assert.equal(e.code, 'ALREADY_SET');
  console.log('exchange and trading ok');
  store.setConfig({});

  // 10) no lock left open
  assert.equal([...store.locks.values()].filter(l => l.status === 'locked').length, 0);
  console.log('ALL TESTS PASSED; daily stats', JSON.stringify(store.stats));
  conns.forEach(x => x.ws.close()); srv.stop(); process.exit(0);
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
