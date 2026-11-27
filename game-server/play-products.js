'use strict';
// One-off helper: creates (or updates) the 10 Google Play coin packs for
// com.ludomeet.app with USD prices; Google converts them to every currency.
// Run on the server:  cd /opt/ludomeet-game && node play-products.js
//   node play-products.js list   -> shows what exists
const { GoogleAuth } = require('google-auth-library');

const PKG = 'com.ludomeet.app';
const PACKS = [
  ['coins_10k', 10000, 500, '1.99'], ['coins_20k', 20000, 1000, '3.99'],
  ['coins_50k', 50000, 3000, '9.99'], ['coins_70k', 70000, 4200, '13.99'],
  ['coins_100k', 100000, 7000, '19.99'], ['coins_200k', 200000, 16000, '40.99'],
  ['coins_300k', 300000, 27000, '60.99'], ['coins_500k', 500000, 50000, '101.99'],
  ['coins_1m', 1000000, 120000, '205.99'], ['coins_1_5m', 1500000, 210000, '312.99'],
];
const fmt = n => n.toLocaleString('en-US');
const micros = usd => String(Math.round(Number(usd) * 1e6));

(async () => {
  const auth = new GoogleAuth({ keyFile: __dirname + '/service-account.json', scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
  const c = await auth.getClient();
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`;
  const call = async (url, opt = {}) => {
    try { return (await c.request({ url, ...opt })).data; }
    catch (e) { const d = e.response && e.response.data; throw new Error((e.response ? e.response.status + ' ' : '') + JSON.stringify(d && d.error ? d.error.message : e.message)); }
  };
  if (process.argv[2] === 'list') {
    const r = await call(`${base}/inappproducts`);
    for (const p of r.inappproduct || []) console.log(p.sku, p.status, p.defaultPrice && (p.defaultPrice.priceMicros / 1e6 + ' ' + p.defaultPrice.currency));
    if (!(r.inappproduct || []).length) console.log('NO_PRODUCTS');
    return;
  }
  let ok = 0;
  for (const [sku, coins, bonus, usd] of PACKS) {
    const body = {
      packageName: PKG, sku, status: 'active', purchaseType: 'managedUser', defaultLanguage: 'en-US',
      defaultPrice: { priceMicros: micros(usd), currency: 'USD' },
      listings: { 'en-US': {
        title: `${fmt(coins)} Coins + ${fmt(bonus)} Bonus`,
        description: `${fmt(coins)} LudoMeet coins plus ${fmt(bonus)} bonus coins. Use them for Ludo tables and gifts in voice rooms.`,
      } },
    };
    try {
      await call(`${base}/inappproducts/${sku}?autoConvertMissingPrices=true&allowMissing=true`, { method: 'PUT', data: body });
      console.log('OK', sku, '$' + usd); ok++;
    } catch (e) { console.log('FAIL', sku, e.message); }
  }
  console.log(ok === PACKS.length ? 'ALL_PRODUCTS_OK' : `DONE ${ok}/${PACKS.length}`);
})().catch(e => { console.log('ERROR', e.message); process.exit(1); });
