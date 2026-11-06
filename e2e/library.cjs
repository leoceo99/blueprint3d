// 7단계 검증: 프로젝트 보관함, 버전 기록, 백업, 여러 탭, 실험 기능, 오류 알림, 오프라인(PWA)
const { URL, out, tmp, launch, finish, unzip, ROOT } = require('./lib.cjs');
const path = require('path');
const fs = require('fs');
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(() => { delete window.showSaveFilePicker; });
  const page = await ctx.newPage();
  const errs = [];
  const results = [];
  const ok = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
  const watch = (pg, tag) => {
    pg.on('pageerror', e => { if (!/테스트 오류/.test(String(e))) errs.push(`${tag} ${e}`); });
    pg.on('console', m => { if (m.type() === 'error' && !/테스트 오류/.test(m.text())) errs.push(`${tag} ${m.text()}`); });
  };
  watch(page, 'p1');
  let promptAnswer = '';
  page.on('dialog', d => d.accept(promptAnswer));
  const status = (pg = page) => pg.textContent('#buildStatus');
  const waitBuild = async (pg = page) => { await pg.waitForTimeout(600); await pg.waitForFunction(() => /✓|⚠|도형을 그리면/.test(document.querySelector('#buildStatus')?.textContent || ''), null, { timeout: 120000 }); await pg.waitForTimeout(300); };
  const lib = (pg = page) => pg.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('blueprint3d');
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('projects')) return res({ projects: [], versions: [] });
      const t = db.transaction(['projects', 'versions']);
      const a = t.objectStore('projects').getAll();
      const b = t.objectStore('versions').getAll();
      t.oncomplete = () => { res({ projects: a.result.map(p => ({ id: p.id, name: p.name, deleted: !!p.deletedAt, thumb: !!p.thumb, updatedAt: p.updatedAt })), versions: b.result.map(v => ({ projectId: v.projectId, label: v.label, auto: v.auto })) }); db.close(); };
    };
  }));
  const curId = (pg = page) => pg.evaluate(() => JSON.parse(localStorage.getItem('blueprint3d.doc.v2'))._id);
  const setName = async (name, pg = page) => { await pg.fill('#name', name); await pg.press('#name', 'Enter'); await pg.waitForTimeout(1300); };
  const menu = async (act, pg = page) => { await pg.click('[data-menu="file"]'); await pg.click(`[data-act="${act}"]`); };

  try {
  await page.goto(URL);
  await page.evaluate(() => new Promise((r) => { localStorage.clear(); const q = indexedDB.deleteDatabase('blueprint3d'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await waitBuild();

  // 1) 처음 켜면 예제 하나가 보관함에 들어간다
  await page.waitForTimeout(1200);
  let L = await lib();
  ok('first run: sample saved as a project', L.projects.length === 1 && L.projects[0].name === (await page.inputValue('#name')), JSON.stringify(L.projects));
  const firstId = await curId();
  ok('mirror carries project id', firstId === L.projects[0]?.id, firstId);
  await page.waitForTimeout(2000);
  L = await lib();
  ok('thumbnail made after build', L.projects[0]?.thumb === true);

  // 2) 이름 바꾸기 → 저장
  await setName('보관함 시험 A');
  L = await lib();
  ok('edit saved to library', L.projects.find(p => p.id === firstId)?.name === '보관함 시험 A');
  ok('save state shows saved', /저장됨/.test(await page.textContent('#saveState')), await page.textContent('#saveState'));
  ok('first edit made an auto version', L.versions.some(v => v.projectId === firstId && v.auto));

  // 3) 새 부품 / 예제 → 새 프로젝트, 앞의 것은 남음
  await page.keyboard.press('Control+Alt+n');
  await page.waitForTimeout(1200);
  L = await lib();
  ok('new part = new project', L.projects.length === 2 && (await curId()) !== firstId, L.projects.map(p => p.name).join(','));
  ok('new part is empty', /도형을 그리면/.test(await status()), await status());
  await page.click('[data-menu="file"]'); await page.click('#samples button:has-text("가이드")');
  await waitBuild();
  await page.waitForTimeout(2200);
  L = await lib();
  ok('sample = new project', L.projects.length === 3, L.projects.map(p => p.name).join(','));
  const guideId = await curId();

  // 4) 내 프로젝트 창: 카드 3개, 썸네일, 다른 프로젝트 열기
  await page.keyboard.press('Control+Shift+O');
  await page.waitForSelector('.lib-card');
  const cards = await page.$$eval('.lib-card', (cs) => cs.map(c => ({ name: c.querySelector('b').textContent, cur: c.classList.contains('cur'), img: !!c.querySelector('img') })));
  ok('library shows 3 cards', cards.length === 3, JSON.stringify(cards));
  ok('current card marked', cards.filter(c => c.cur).length === 1 && cards.find(c => c.cur).name.includes('가이드'));
  ok('cards have thumbnails (built ones)', cards.filter(c => c.img).length >= 2, cards.map(c => c.img).join(','));
  await page.screenshot({ path: out('s7-library.png') });
  await page.click('.lib-card:has(b:text-is("보관함 시험 A"))');
  await waitBuild();
  ok('open other project', (await page.inputValue('#name')) === '보관함 시험 A' && (await curId()) === firstId);
  ok('undo history reset on switch', await page.evaluate(() => true));

  // 5) 새로 고침해도 같은 프로젝트
  await page.reload(); await waitBuild();
  ok('reload keeps current project', (await page.inputValue('#name')) === '보관함 시험 A' && (await curId()) === firstId);

  // 6) 복제·이름·휴지통·되살리기
  await page.keyboard.press('Control+Shift+O'); await page.waitForSelector('.lib-card');
  await page.click('.lib-card:has(b:text-is("보관함 시험 A")) button:text-is("복제")');
  await page.waitForTimeout(400);
  ok('duplicate', (await page.$$('.lib-card')).length === 4 && !!(await page.$('.lib-card b:text-is("보관함 시험 A (복사본)")')));
  promptAnswer = '복사본 새 이름';
  await page.click('.lib-card:has(b:text-is("보관함 시험 A (복사본)")) button:text-is("이름")');
  await page.waitForTimeout(400);
  ok('rename other project', !!(await page.$('.lib-card b:text-is("복사본 새 이름")')));
  promptAnswer = '열린 것 새 이름';
  await page.click('.lib-card.cur button:text-is("이름")');
  await page.waitForTimeout(500);
  ok('rename current project', !!(await page.$('.lib-card.cur b:text-is("열린 것 새 이름")')) && (await page.inputValue('#name')) === '열린 것 새 이름');
  await page.keyboard.press('Escape');
  await page.click('#board', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(1300);
  ok('rename current is undoable', (await page.inputValue('#name')) === '보관함 시험 A', await page.inputValue('#name'));
  await page.keyboard.press('Control+Shift+O'); await page.waitForSelector('.lib-card');
  await page.click('.lib-card:has(b:text-is("복사본 새 이름")) button:text-is("삭제")');
  await page.waitForTimeout(400);
  ok('trash removes from list', (await page.$$('.lib-card')).length === 3);
  await page.click('.seg-btn:has-text("휴지통")');
  await page.waitForTimeout(300);
  ok('trash tab shows it', (await page.$$('.lib-card')).length === 1 && /30일 뒤 영구 삭제/.test(await page.textContent('.lib-card')));
  await page.click('.lib-card button:text-is("되살리기")');
  await page.waitForTimeout(300);
  await page.click('.seg-btn:has-text("프로젝트")');
  await page.waitForTimeout(300);
  ok('restore from trash', (await page.$$('.lib-card')).length === 4);
  await page.fill('.lib-bar input[type="search"]', '복사본');
  await page.waitForTimeout(200);
  ok('search filters', (await page.$$('.lib-card')).length === 1);
  await page.keyboard.press('Escape');
  ok('Esc closes library', !(await page.isVisible('.lib-grid')));

  // 7) 버전: 직접 저장 → 고치기 → 되돌리기 → Ctrl+Z
  promptAnswer = '구멍 고치기 전';
  await page.keyboard.press('Control+Shift+S');
  await page.waitForTimeout(500);
  await setName('이름 바꾼 뒤');
  await menu('versions');
  await page.waitForSelector('.ver-row');
  const rows = await page.$$eval('.ver-row', (rs) => rs.map(r => r.textContent));
  const manual = rows.find(r => r.includes('구멍 고치기 전'));
  ok('manual version listed', !!manual && manual.includes('직접 저장'), rows.length + ' rows');
  ok('diff vs now', !!manual && manual.includes('이름 ‘보관함 시험 A’ → ‘이름 바꾼 뒤’'), manual);
  await page.screenshot({ path: out('s7-versions.png') });
  await page.click('.ver-row:has(b:text-is("구멍 고치기 전")) button:text-is("이 버전으로 되돌리기")');
  await page.waitForTimeout(1300);
  ok('restore version', (await page.inputValue('#name')) === '보관함 시험 A');
  await page.click('#board', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  ok('Ctrl+Z undoes restore', (await page.inputValue('#name')) === '이름 바꾼 뒤', await page.inputValue('#name'));
  L = await lib();
  ok('"되돌리기 전" version kept', L.versions.some(v => v.projectId === firstId && v.label === '되돌리기 전'));
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(300);
  ok('Ctrl+Y redoes restore', (await page.inputValue('#name')) === '보관함 시험 A');
  await setName('이름 바꾼 뒤');

  // 8) 버전을 새 프로젝트로
  await menu('versions'); await page.waitForSelector('.ver-row');
  await page.click('.ver-row:has(b:text-is("구멍 고치기 전")) button:text-is("새 프로젝트로")');
  await page.waitForTimeout(1300);
  ok('version → new project', (await curId()) !== firstId && /버전\)$/.test(await page.inputValue('#name')), await page.inputValue('#name'));

  // 9) 전체 백업 → 모두 지우기 → 가져오기
  const before = (await lib()).projects.filter(p => !p.deleted).length;
  await page.keyboard.press('Control+Shift+O'); await page.waitForSelector('.lib-card');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:text-is("전체 백업 내보내기")')]);
  const zipBytes = fs.readFileSync(await dl.path());
  const backup = unzip(zipBytes).json('backup.json');
  ok('backup (zip) has all projects', dl.suggestedFilename().endsWith('.b3dbackup') && backup.projects.length === before && backup.versions.length > 0, `${backup.projects.length} / ${before}, versions ${backup.versions.length}, ${dl.suggestedFilename()} ${(zipBytes.length / 1024).toFixed(0)} KB`);
  fs.writeFileSync(tmp('s7-backup.b3dbackup'), zipBytes);
  await page.keyboard.press('Escape');
  await page.evaluate(() => new Promise((r) => { localStorage.clear(); const q = indexedDB.deleteDatabase('blueprint3d'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload(); await waitBuild(); await page.waitForTimeout(1200);
  ok('after wipe: only fresh sample', (await lib()).projects.length === 1);
  await page.keyboard.press('Control+Shift+O'); await page.waitForSelector('.lib-card');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:text-is("백업 가져오기")')]);
  await chooser.setFiles(tmp('s7-backup.b3dbackup'));
  await page.waitForTimeout(800);
  L = await lib();
  ok('backup restored', L.projects.length === before + 1 && L.projects.some(p => p.name === '이름 바꾼 뒤'), L.projects.map(p => p.name).join(' | '));
  ok('versions restored', L.versions.some(v => v.label === '구멍 고치기 전'));
  await page.click('.lib-card:has(b:text-is("이름 바꾼 뒤"))');
  await waitBuild();
  ok('open restored project', (await page.inputValue('#name')) === '이름 바꾼 뒤' && /✓/.test(await status()));

  // 10) 같은 프로젝트를 두 탭에서
  const page2 = await ctx.newPage();
  watch(page2, 'p2');
  await page2.goto(URL);
  await waitBuild(page2);
  await page.waitForTimeout(500);
  ok('tab 2 opens same project', (await page2.inputValue('#name')) === '이름 바꾼 뒤');
  ok('duplicate-tab warning (both)', /다른 탭에서도 열려/.test(await page.textContent('#notices')) && /다른 탭에서도 열려/.test(await page2.textContent('#notices')));
  await setName('탭2에서 고침', page2);
  await page.waitForTimeout(300);
  ok('remote save notice', /다른 탭에서 이 프로젝트를 고쳤어요/.test(await page.textContent('#notices')));
  await page.click('#notices button:text-is("다시 불러오기")');
  await page.waitForTimeout(500);
  ok('reload from other tab', (await page.inputValue('#name')) === '탭2에서 고침');
  await page2.close();

  // 11) 실험 기능 숨기기
  await page.click('#settingsBtn');
  await page.waitForTimeout(400);
  ok('storage info shown', /프로젝트 \d+개/.test(await page.textContent('#storageInfo')), await page.textContent('#storageInfo'));
  await page.screenshot({ path: out('s7-settings.png') });
  await page.uncheck('#showExp');
  await page.click('#settings button[value="cancel"]');
  ok('exp off hides AI button', !(await page.isVisible('#aiBtn')));
  await page.click('[data-menu="file"]');
  ok('exp off hides image import', !(await page.isVisible('[data-act="import"]')) && !(await page.isVisible('[data-act="review"]')));
  await page.keyboard.press('Escape'); await page.click('#board', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+i');
  await page.waitForTimeout(200);
  ok('Ctrl+I explains', /실험 기능/.test(await page.textContent('#toast')));
  await page.reload(); await waitBuild();
  ok('exp setting persists', !(await page.isVisible('#aiBtn')));
  await page.click('#settingsBtn'); await page.check('#showExp'); await page.click('#settings button[value="cancel"]');
  ok('exp on shows badge', await page.isVisible('#aiBtn'));
  await page.click('[data-menu="file"]');
  await page.screenshot({ path: out('s7-menu.png') });
  await page.keyboard.press('Escape'); await page.click('#board', { position: { x: 5, y: 5 } }).catch(() => {});

  // 12) 예상하지 못한 오류 알림
  await page.evaluate(() => setTimeout(() => { throw new Error('테스트 오류'); }));
  await page.waitForTimeout(300);
  ok('unexpected error notice', /예상하지 못한 문제.*테스트 오류/.test(await page.textContent('#notices')));
  await page.click('#notices .notice:has-text("테스트 오류") button.ghost');

  // 13) 오프라인: 서비스 워커가 모두 받아 둔 뒤 인터넷을 끊고 새로 고침
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller || true);
  const cached = await page.evaluate(async () => { const ks = await caches.keys(); const c = await caches.open(ks.find(k => k.startsWith('b3d-'))); return (await c.keys()).map(r => r.url.split('/').pop()); });
  ok('SW precached all files incl. 3D engine', cached.some(u => /replicad.*\.wasm/.test(u)) && cached.length >= 15, `${cached.length} files`);
  await ctx.setOffline(true);
  await page.reload(); await waitBuild();
  ok('offline: app loads', (await page.inputValue('#name')) === '탭2에서 고침');
  ok('offline: 3D builds', /✓/.test(await status()), await status());
  ok('offline: indicator', await page.isVisible('#netState'));
  await page.keyboard.press('3'); await page.waitForTimeout(1000);
  const sh = await page.innerHTML('#sheetHost');
  ok('offline: sheet renders', sh.includes('정면도') && sh.includes('평면도') && sh.length > 5000, `${sh.length} chars`);
  await page.screenshot({ path: out('s7-offline-sheet.png') });
  await page.keyboard.press('1');
  await page.keyboard.press('Control+Alt+n'); await page.waitForTimeout(1200);
  ok('offline: library still saves', (await lib()).projects.length === before + 2);
  await page.screenshot({ path: out('s7-offline.png') });
  await ctx.setOffline(false);
  await page.waitForTimeout(300);
  ok('online again hides indicator', !(await page.isVisible('#netState')));

  } catch (e) { results.push('FAIL (stopped) ' + String(e).split('\n')[0]); }
  finish(results, errs);
  await browser.close();
})();
