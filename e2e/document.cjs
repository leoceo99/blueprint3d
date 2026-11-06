// 9단계: 문서 모델 — 여러 부품·도면, 문서 트리, .b3d 저장·열기, 예전 .json, 부품으로 가져오기, 다듬기(다시 만들기 건너뜀·나중에 내려받기)
const { URL, out, tmp, launch, finish, unzip, fresh, waitBuild } = require('./lib.cjs');
const fs = require('fs');
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(() => { delete window.showSaveFilePicker; });
  const page = await ctx.newPage();
  const errs = [];
  const results = [];
  const ok = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  let promptAnswer = '';
  page.on('dialog', (d) => d.accept(promptAnswer));
  const requested = [];
  page.on('request', (r) => requested.push(r.url()));
  const B = (fn, arg) => page.evaluate(fn, arg);
  const doc = () => B(() => JSON.parse(JSON.stringify(window.blueprint3d.store.doc)));
  const run = (id) => B((i) => window.blueprint3d.commands.run(i), id);
  const status = () => page.textContent('#buildStatus');
  const partRows = () => page.$$eval('#docTree .doc-item[data-part]', (rs) => rs.map((r) => `${r.classList.contains('on') ? '*' : ''}${r.querySelector('.di-name').firstChild.textContent.trim()}`));
  try {
    await fresh(page);
    await waitBuild(page);

    // ---- 다듬기 ②: 실험 기능 코드는 처음에 내려받지 않음 ----
    const lazy = requested.filter((u) => /\/assets\/(zod|ai|reviewDialog|importDialog)-/.test(u));
    ok('AI SDK·실험 창은 시작할 때 안 내려받음', lazy.length === 0, lazy.join(', ') || `${requested.filter((u) => u.includes('/assets/')).length} assets`);

    // ---- 9.3 문서 트리 · 여러 부품 ----
    let d = await doc();
    ok('시작 문서: 부품 1 · 도면 1', d.parts.length === 1 && d.drawings.length === 1 && d.version === 2);
    await run('sample.doc');
    await waitBuild(page);
    ok('예제 문서: 부품 2개 + 도면 2장', JSON.stringify(await partRows()) === JSON.stringify(['*L 브래킷 (정면+평면+측면)', '플랜지 (회전체 + 볼트 구멍)']), (await partRows()).join(' | '));
    await page.screenshot({ path: out('doc-tree.png') });
    const s1 = await status();
    await page.click('#docTree .doc-item[data-part] >> nth=1');
    await waitBuild(page);
    ok('부품 바꾸면 그 부품의 3D', (await status()) !== s1 && /80×80×30/.test(await status()), `${s1} → ${await status()}`);
    // 부품 추가 → 새 빈 부품에 사각형
    await page.click('#docTree button:text-is("＋ 부품")');
    await page.waitForTimeout(400);
    ok('부품 추가', (await partRows()).length === 3 && (await partRows())[2] === '*부품 3', (await partRows()).join(' | '));
    await B(() => window.blueprint3d.store.update((p) => p.views.top.push({ id: 'n1', kind: 'rect', hole: false, x: 0, y: 0, w: 30, h: 20 }), '사각형 그리기'));
    await waitBuild(page);
    ok('새 부품의 3D', /30×20×10/.test(await status()), await status());
    // 다른 부품으로 갔다 와도 각자 그대로
    await page.click('#docTree .doc-item[data-part] >> nth=0');
    await waitBuild(page);
    const front0 = (await B(() => window.blueprint3d.store.project.views.front.length));
    await page.click('#docTree .doc-item[data-part] >> nth=2');
    await waitBuild(page);
    ok('부품마다 도형 따로', front0 === 1 && (await B(() => window.blueprint3d.store.project.views.top.length)) === 1);
    // 실행 취소가 부품 추가까지 되돌림
    await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
    await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
    d = await doc();
    ok('Ctrl+Z로 부품 추가 되돌림', d.parts.length === 2 && d.drawings.length === 2, `${d.parts.length} parts`);
    await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(300);
    ok('다시 실행으로 부품 돌아옴', (await doc()).parts.length === 3);
    // 이름 바꾸기 (✎), 복제, 지우기
    await page.click('#docTree .doc-item[data-part] >> nth=2');
    promptAnswer = '덮개';
    await page.dblclick('#docTree .doc-item[data-part] >> nth=2');
    await page.waitForTimeout(300);
    ok('부품 이름 바꾸기', (await partRows())[2] === '*덮개', (await partRows()).join(' | '));
    await run('doc.duplicatePart');
    await page.waitForTimeout(300);
    ok('부품 복제', (await partRows()).length === 4 && (await partRows())[3] === '*덮개 복사본');
    await run('doc.deletePart');
    await page.waitForTimeout(300);
    d = await doc();
    ok('부품 지우기 (그 도면도)', d.parts.length === 3 && d.drawings.every((x) => d.parts.some((p) => p.id === x.partId)), `${d.parts.length} parts, ${d.drawings.length} drawings`);
    // 다음/이전 부품 단축키
    await page.click('#coords');
    await page.keyboard.press('Control+Alt+BracketRight'); await page.waitForTimeout(300);
    ok('Ctrl+Alt+] 다음 부품', (await partRows())[0].startsWith('*'), (await partRows()).join(' | '));
    // 명령 찾기에서 부품 이름으로
    await page.keyboard.press('Control+k'); await page.fill('.pal-input', '덮개'); await page.waitForTimeout(150);
    const pr = await page.$$eval('.pal-row .pal-title', (r) => r.map((x) => x.textContent));
    ok('명령 찾기: “부품 열기: 덮개”', pr.includes('부품 열기: 덮개'), pr.slice(0, 3).join(' | '));
    await page.keyboard.press('Escape');

    // ---- 9.4 도면 ↔ 부품 ----
    await page.click('#docTree .doc-item[data-part] >> nth=1'); // 플랜지 편집
    await waitBuild(page);
    await page.keyboard.press('3'); await page.waitForTimeout(800);
    let opts = await page.$eval('#drawingSel', (s) => [...s.options].map((o) => o.textContent + (o.selected ? '*' : '')));
    ok('도면 고르기: 편집 중인 부품의 도면이 열림', opts.some((o) => o.startsWith('플랜지 도면') && o.endsWith('*')), opts.join(' | '));
    await page.selectOption('#drawingSel', { label: opts.find((o) => o.startsWith('브래킷 도면')).replace('*', '') });
    await page.waitForFunction(() => document.querySelector('#sheetHost svg'), null, { timeout: 60000 });
    let svg = await page.innerHTML('#sheetHost');
    ok('다른 부품(브래킷)의 도면도 그려짐', svg.includes('L 브래킷') && svg.includes('SS400') && /80×80×30/.test(await status()), (await page.textContent('#sheetInfo')));
    // 도면이 그릴 부품 바꾸기
    const pidFlange = (await doc()).parts[1].id;
    await page.selectOption('#drawingPart', pidFlange);
    await page.waitForTimeout(1500);
    svg = await page.innerHTML('#sheetHost');
    ok('도면의 부품 바꾸기 → 다시 그려짐', svg.includes('플랜지') && !svg.includes('L 브래킷'));
    await page.keyboard.press('Control+z'); await page.waitForTimeout(1500);
    ok('Ctrl+Z로 도면 부품 되돌림', (await page.innerHTML('#sheetHost')).includes('L 브래킷'));
    await page.click('#addDrawing'); await page.waitForTimeout(800);
    opts = await page.$eval('#drawingSel', (s) => [...s.options].map((o) => o.textContent));
    ok('도면 추가', opts.length === 4, opts.join(' | '));
    await page.fill('#drawingName', '조립용 도면'); await page.press('#drawingName', 'Enter'); await page.waitForTimeout(300);
    ok('도면 이름', (await page.$eval('#drawingSel', (s) => s.selectedOptions[0].textContent)).startsWith('조립용 도면'));
    await page.click('#delDrawing'); await page.waitForTimeout(500);
    ok('도면 지우기', (await page.$eval('#drawingSel', (s) => s.options.length)) === 3);
    await page.screenshot({ path: out('doc-sheet.png') });
    // 편집 중인 부품을 고치면 그 도면이 다시 그려짐
    await page.selectOption('#drawingSel', { label: (await page.$eval('#drawingSel', (s) => [...s.options].map((o) => o.textContent))).find((o) => o.startsWith('플랜지 도면')) });
    await page.waitForTimeout(800);
    const before = await page.innerHTML('#sheetHost');
    await page.keyboard.press('1');
    await B(() => window.blueprint3d.store.update((p) => { p.views.front[0].w = (p.views.front[0].w || 40) + 10; }, '치수'));
    await waitBuild(page);
    await page.keyboard.press('3'); await page.waitForTimeout(1200);
    ok('부품을 고치면 도면이 다시 만들어짐', (await page.innerHTML('#sheetHost')) !== before);
    await page.keyboard.press('1');

    // ---- 다듬기 ①: 모양이 안 바뀌면 3D를 다시 만들지 않음 ----
    await waitBuild(page);
    const r0 = await B(() => window.blueprint3d.buildStats.runs);
    await page.fill('#name', '이름만 바꿈'); await page.press('#name', 'Enter');
    await page.selectOption('#process', 'print3d');
    await B(() => window.blueprint3d.store.updateDoc((dd) => { dd.drawings[0].sheet = { material: 'SM45C' }; }, '표제란'));
    await page.waitForTimeout(800);
    const r1 = await B(() => window.blueprint3d.buildStats.runs);
    ok('이름·제조 방식·표제란만 바꾸면 3D 다시 안 만듦', r1 === r0, `runs ${r0} → ${r1}, skipped ${await B(() => window.blueprint3d.buildStats.skipped)}`);
    await B(() => window.blueprint3d.store.update((p) => { p.thickness = p.thickness + 1; }, '두께'));
    await page.waitForTimeout(900);
    ok('모양이 바뀌면 다시 만듦', (await B(() => window.blueprint3d.buildStats.runs)) === r1 + 1);

    // ---- 9.2 .b3d 저장 · 열기 ----
    await waitBuild(page);
    await page.waitForTimeout(1800); // 썸네일
    const saved = await doc();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
    const b3d = fs.readFileSync(await dl.path());
    const z = unzip(b3d);
    const dj = z.json('document.json');
    ok('.b3d 저장: zip 안에 문서·화면 상태·썸네일', dl.suggestedFilename() === '이름만_바꿈.b3d' && dj.parts.length === 3 && dj.drawings.length === 3 && !dj.view && !!z.json('view.json') && !!z.files['thumbnail.jpg'], `${Object.keys(z.files).join(', ')} ${(b3d.length / 1024).toFixed(1)} KB`);
    fs.writeFileSync(tmp('doc.b3d'), b3d);
    await page.keyboard.press('Control+Alt+n'); await waitBuild(page);
    ok('새 문서', (await doc()).parts.length === 1);
    const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
    await ch.setFiles(tmp('doc.b3d'));
    await waitBuild(page);
    const back = await doc();
    ok('.b3d 열기: 부품·도면·열린 부품 그대로', JSON.stringify(back.parts) === JSON.stringify(saved.parts) && JSON.stringify(back.drawings) === JSON.stringify(saved.drawings) && back.view.part === saved.view.part && back.name === saved.name);
    // 끌어다 놓기로도
    // 예전 .json 프로젝트 파일
    const legacy = { version: 1, name: '예전 파일', mode: 'auto', thickness: 6, sheet: { material: 'SUS304' }, views: { front: [], top: [{ id: 'a', kind: 'circle', hole: false, cx: 0, cy: 0, r: 20 }], side: [] } };
    fs.writeFileSync(tmp('old.json'), JSON.stringify(legacy));
    const [ch2] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
    await ch2.setFiles(tmp('old.json'));
    await waitBuild(page);
    d = await doc();
    ok('예전 .json 열림 → 부품 1 + 도면(표제란 옮겨짐)', d.name === '예전 파일' && d.parts.length === 1 && d.drawings[0].sheet?.material === 'SUS304' && /40×40×6/.test(await status()), await status());

    // ---- 3D 파일을 부품으로 가져오기 ----
    await page.keyboard.press('2'); await page.waitForTimeout(400);
    const [sd] = await Promise.all([page.waitForEvent('download'), page.click('#expStep3d')]);
    fs.copyFileSync(await sd.path(), tmp('disk.step'));
    await page.keyboard.press('1');
    const [ch3] = await Promise.all([page.waitForEvent('filechooser'), run('file.import3dAsPart')]);
    await ch3.setFiles(tmp('disk.step'));
    await waitBuild(page);
    d = await doc();
    ok('STEP을 이 문서의 부품으로', d.parts.length === 2 && !!d.parts[1].source && d.view.part === d.parts[1].id && /40×40×6/.test(await status()), `${d.parts.map((p) => p.name).join(', ')} · ${await status()}`);

    // ---- 9.5 보관함·버전 ----
    await page.waitForTimeout(1500);
    await page.keyboard.press('Control+Shift+O'); await page.waitForSelector('.lib-card');
    const cur = await page.$eval('.lib-card.cur', (c) => c.textContent);
    ok('보관함 카드 요약: 부품·도면 수', /부품 2 · 도면 2/.test(cur), cur.slice(0, 80));
    await page.keyboard.press('Escape');
    promptAnswer = '두 부품';
    await page.keyboard.press('Control+Shift+S'); await page.waitForTimeout(400);
    await run('doc.deletePart'); await page.waitForTimeout(400);
    await run('file.versions'); await page.waitForSelector('.ver-row');
    const row = await page.$eval('.ver-row:has(b:text-is("두 부품"))', (r) => r.textContent);
    ok('버전 비교: 부품 삭제가 보임', /부품 삭제/.test(row), row.slice(0, 120));
    await page.click('.ver-row:has(b:text-is("두 부품")) button:text-is("이 버전으로 되돌리기")');
    await page.waitForTimeout(600);
    ok('버전 되돌리기 → 부품 2개', (await doc()).parts.length === 2);
    await page.reload(); await waitBuild(page);
    ok('새로 고침 뒤에도 문서 그대로', (await doc()).parts.length === 2 && (await doc()).name === '예전 파일');

    // ---- 실험 창은 쓸 때 내려받음 ----
    await page.click('#coords');
    await page.keyboard.press('Control+i');
    await page.waitForTimeout(1500);
    ok('도면 이미지 가져오기 → 그때 내려받음', requested.some((u) => /\/assets\/importDialog-/.test(u)));
  } catch (e) {
    results.push('FAIL (stopped) ' + String(e).split('\n')[0]);
  }
  finish(results, errs);
  await browser.close();
})();
