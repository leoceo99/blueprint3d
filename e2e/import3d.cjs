// 3D 파일 가져오기: 예제를 STEP·STL로 저장 → 다시 가져오기 → 3D·도면·돌리기·프로젝트 저장/열기
const { URL, out, tmp, launch, finish, unzip, ROOT } = require('./lib.cjs');
const path = require('path');
const fs = require('fs');
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  const results = [];
  const ok = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const status = () => page.textContent('#buildStatus');
  const waitBuild = async () => { await page.waitForTimeout(600); await page.waitForFunction(() => /✓|⚠/.test(document.querySelector('#buildStatus')?.textContent||''), null, { timeout: 120000 }); await page.waitForTimeout(300); };
  await page.goto(URL);
  await page.evaluate(() => { localStorage.clear(); delete window.showSaveFilePicker; });
  await page.reload();
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  await waitBuild();
  await page.click('[data-menu="file"]'); await page.click('#samples button:has-text("가이드")');
  await waitBuild();
  const origStatus = await status();
  await page.keyboard.press('2'); await page.waitForTimeout(500);
  for (const [btn, file] of [['#expStep3d', tmp('guide.step')], ['#expStl3d', tmp('guide.stl')]]) {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click(btn)]);
    fs.copyFileSync(await d.path(), file);
  }
  await page.keyboard.press('1');
  const importFile = async (file) => {
    await page.click('[data-menu="file"]');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="import3d"]')]);
    await chooser.setFiles(file);
    await waitBuild();
  };
  // STEP
  await importFile(tmp('guide.step'));
  ok('STEP: 3D same size', (await status()) === origStatus, `${await status()} vs ${origStatus}`);
  ok('STEP: source bar', await page.isVisible('#sourceBar'), await page.textContent('#sourceBar'));
  await page.screenshot({ path: out('imp3d-3d.png') });
  await page.keyboard.press('3'); await page.waitForTimeout(800);
  const sheet = await page.innerHTML('#sheetHost');
  ok('STEP: sheet hole callout', sheet.includes('카운터보어 Ø11'), (sheet.match(/2×[^<]{0,60}/) || [''])[0]);
  await page.screenshot({ path: out('imp3d-sheet.png') });
  await page.keyboard.press('1'); await page.waitForTimeout(400);
  await page.screenshot({ path: out('imp3d-board.png') });
  // 돌리기 Z
  await page.click('[data-turn="2"]');
  await waitBuild();
  ok('STEP: rotate Z swaps X/Y', /✓ 3D 40×80×25/.test(await status()), await status());
  await page.click('[data-turn="2"]'); await waitBuild();
  await page.click('[data-turn="2"]'); await waitBuild();
  await page.click('[data-turn="2"]'); await waitBuild();
  ok('STEP: 4 turns = original', (await status()) === origStatus, await status());
  // 프로젝트 저장 → 새로 → 열기 (3D 파일이 들어 있어야)
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const b3d = fs.readFileSync(await dl.path());
  fs.writeFileSync(tmp('imp3d-doc.b3d'), b3d);
  const z = unzip(b3d);
  const key = z.json('document.json').parts[0].source?.key;
  ok('save .b3d embeds STEP', !!key && z.files['files/' + key]?.length > 1000, `${(b3d.length / 1024).toFixed(0)} KB (STEP ${(z.files['files/' + key]?.length / 1024).toFixed(0)} KB, 압축)`);
  await page.evaluate(() => indexedDB.deleteDatabase('blueprint3d'));
  await page.reload(); await page.waitForTimeout(1500);
  await page.keyboard.press('Control+Alt+n'); await page.waitForTimeout(400);
  const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
  await ch.setFiles(tmp('imp3d-doc.b3d'));
  await waitBuild();
  ok('reopen project with STEP', (await status()) === origStatus, await status());
  // STL
  await importFile(tmp('guide.stl'));
  ok('STL: 3D size', /✓ 3D 80×40×25/.test(await status()), await status());
  await page.keyboard.press('3'); await page.waitForTimeout(800);
  await page.screenshot({ path: out('imp3d-stl-sheet.png') });
  await page.keyboard.press('2'); await page.waitForTimeout(400);
  await page.click('#expStep3d'); await page.waitForTimeout(500);
  ok('STL: STEP export refused with message', /STEP으로 저장할 수 없/.test(await page.textContent('#toast')), await page.textContent('#toast'));
  // 닫기
  await page.click('#sourceClose'); await page.waitForTimeout(800);
  ok('close source', !(await page.isVisible('#sourceBar')), await status());
  // 잘못된 파일
  fs.writeFileSync(tmp('bad.step'), 'not a step file');
  await importFile(tmp('bad.step')).catch(() => {});
  ok('bad STEP → error message', /⚠/.test(await status()), await status());
  finish(results, errs);
  await browser.close();
})();
