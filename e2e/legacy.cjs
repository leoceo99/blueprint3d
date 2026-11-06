const { URL, out, tmp, launch, finish, unzip, ROOT } = require('./lib.cjs');
const path = require('path');
(async () => {
  const browser = await launch();
  const page = await (await browser.newContext()).newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  const results = [];
  const ok = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
  await page.goto(URL);
  await page.waitForTimeout(2500);
  await page.evaluate(() => new Promise((r) => { localStorage.clear(); const q = indexedDB.deleteDatabase('blueprint3d'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  // 6단계까지의 자동 저장 형식 (id 없음)
  await page.evaluate(() => localStorage.setItem('blueprint3d.project.v1', JSON.stringify({ version: 1, name: '예전 작업', mode: 'auto', process: 'cnc', thickness: 8, views: { front: [], top: [{ id: 'a', kind: 'rect', hole: false, x: 0, y: 0, w: 50, h: 30 }], side: [] } })));
  await page.reload();
  await page.waitForFunction(() => /✓|⚠/.test(document.querySelector('#buildStatus')?.textContent || ''), null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  const name = await page.inputValue('#name');
  const recs = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('blueprint3d'); r.onsuccess = () => { const g = r.result.transaction('projects').objectStore('projects').getAll(); g.onsuccess = () => res(g.result.map(p => [p.id, p.name, !!p.thumb])); }; }));
  const mirror = await page.evaluate(() => JSON.parse(localStorage.getItem('blueprint3d.doc.v2'))._id);
  ok('legacy autosave kept', name === '예전 작업', name);
  ok('migrated into library (as document)', recs.length === 1 && recs[0][1] === '예전 작업' && recs[0][0] === mirror, JSON.stringify(recs) + ' ' + mirror);
  ok('old mirror key removed', await page.evaluate(() => localStorage.getItem('blueprint3d.project.v1') === null));
  // 비어 있는 새 부품을 새로 고쳐도 예제로 바뀌지 않는다 (예전 버그)
  await page.keyboard.press('Control+Alt+n'); await page.waitForTimeout(1200);
  await page.reload(); await page.waitForTimeout(2500);
  ok('empty new document survives reload', (await page.inputValue('#name')) === '새 부품', await page.inputValue('#name'));
  finish(results, errs);
  await browser.close();
})();
