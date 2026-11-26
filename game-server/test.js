'use strict';
// Plays real games against the server (in-memory coins) and checks that no
// coins appear or disappear. Run: npm test
process.env.MEMORY = '1'; process.env.PORT = '18090';
process.env.TURN_MS = '60'; process.env.BOT_MS = '5'; process.env.QUEUE_MS = '300'; process.env.AUTO_MS = '5';
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

  // 8) no lock left open
  assert.equal([...store.locks.values()].filter(l => l.status === 'locked').length, 0);
  console.log('ALL TESTS PASSED; daily stats', JSON.stringify(store.stats));
  conns.forEach(x => x.ws.close()); srv.stop(); process.exit(0);
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
