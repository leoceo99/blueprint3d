// 기능 검토 1: 빈 상태, 그리기 도구, 편집, 실행 취소, 변수, 회전체, 저장/열기, 내보내기
const { URL, out, tmp, launch, finish, unzip, ROOT } = require('./lib.cjs');
const path = require('path');
const fs = require('fs');
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  const results = [];
  const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const status = () => page.textContent('#buildStatus');
  const waitBuild = async () => { await page.waitForTimeout(400); await page.waitForFunction(() => /✓|⚠|그려|비어|없/.test(document.querySelector('#buildStatus')?.textContent||''), null, { timeout: 60000 }); await page.waitForTimeout(300); };
  const proj = () => page.evaluate(() => JSON.parse(JSON.stringify(window.blueprint3d.store.project)));
  const toastText = async () => (await page.isVisible('#toast')) ? page.textContent('#toast') : '';
  await page.goto(URL);
  await page.evaluate(() => { localStorage.clear(); delete window.showSaveFilePicker; });
  await page.reload();
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  await page.waitForTimeout(1500);
  console.log('initial status:', await status());

  // ---- 빈 프로젝트 ----
  await page.keyboard.press('Control+Alt+n');
  await page.waitForTimeout(600);
  console.log('empty status:', await status());
  await page.keyboard.press('2'); await page.waitForTimeout(300);
  await page.click('#expStl3d'); await page.waitForTimeout(200);
  ok('empty: STL export shows toast', /먼저/.test(await toastText()), await toastText());
  await page.keyboard.press('3'); await page.waitForTimeout(300);
  ok('empty: sheet host has message', (await page.textContent('#sheetHost')).trim().length > 0, (await page.textContent('#sheetHost')).trim().slice(0, 60));
  await page.click('[data-menu="sheetexp"]');
  await page.click('#printBtn'); await page.waitForTimeout(200);
  ok('empty: print shows toast', /먼저/.test(await toastText()));
  await page.keyboard.press('1'); await page.waitForTimeout(300);

  const box = await page.locator('#board').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

  // ---- 사각형 (정면도) ----
  await page.keyboard.press('r');
  await page.mouse.click(...at(0.18, 0.82));
  await page.keyboard.type('60,30'); await page.keyboard.press('Enter');
  await waitBuild();
  let p = await proj();
  ok('rect in front 60×30', p.views.front.length === 1 && p.views.front[0].w === 60 && p.views.front[0].h === 30, JSON.stringify(p.views.front[0]));
  ok('single view builds', /✓/.test(await status()), await status());

  // 잘못된 입력: 글자, 0, 음수
  await page.mouse.click(...at(0.3, 0.9));
  await page.keyboard.type('abc'); await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  p = await proj();
  ok('dyn input "abc" ignored', p.views.front.length === 1, `front=${p.views.front.length} toast=${await toastText()}`);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.keyboard.press('r');
  await page.mouse.click(...at(0.3, 0.9));
  await page.keyboard.type('0,10'); await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  p = await proj();
  ok('dyn input "0,10" not added', p.views.front.length === 1, `front=${p.views.front.length} toast=${await toastText()}`);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');

  // ---- 평면도 사각형 → 두 뷰 교집합 ----
  await page.keyboard.press('r');
  await page.mouse.click(...at(0.18, 0.3));
  await page.keyboard.type('60,40'); await page.keyboard.press('Enter');
  await waitBuild();
  p = await proj();
  ok('rect in top', p.views.top.length === 1, JSON.stringify(p.views.top[0]));
  ok('two views build', /✓|⚠/.test(await status()), await status());

  // ---- 원 (평면도 몸체 안 → 자동 구멍) ----
  const t0 = p.views.top[0];
  await page.keyboard.press('c');
  // 몸체 가운데 찾기: 평면도 사각형 가운데 화면 좌표는 모르므로 #coords로 찾는다
  const findScreen = async (view, u, v, region) => {
    // region: [fx0, fy0, fx1, fy1]
    const [fx0, fy0, fx1, fy1] = region;
    let best = null;
    for (let fx = fx0; fx <= fx1; fx += 0.01) {
      await page.mouse.move(...at(fx, (fy0 + fy1) / 2));
      const t = await page.textContent('#coords');
      const m = t.match(/X\s+(-?[\d.]+)/);
      if (m && (!best || Math.abs(+m[1] - u) < best.d)) best = { fx, d: Math.abs(+m[1] - u) };
    }
    let bestY = null;
    for (let fy = fy0; fy <= fy1; fy += 0.01) {
      await page.mouse.move(...at(best.fx, fy));
      const t = await page.textContent('#coords');
      const m = t.match(view === 'top' ? /Y\s+(-?[\d.]+)/ : /Z\s+(-?[\d.]+)/);
      if (m && (!bestY || Math.abs(+m[1] - v) < bestY.d)) bestY = { fy, d: Math.abs(+m[1] - v) };
    }
    return [best.fx, bestY.fy];
  };
  const [cfx, cfy] = await findScreen('top', t0.x + 15, t0.y + 20, [0.02, 0.1, 0.5, 0.5]);
  await page.mouse.click(...at(cfx, cfy));
  await page.keyboard.type('8'); await page.keyboard.press('Enter');
  await waitBuild();
  p = await proj();
  const circ = p.views.top.find(s => s.kind === 'circle');
  ok('circle inside body becomes hole', circ && circ.hole === true && Math.abs(circ.r - 4) < 1e-9, JSON.stringify(circ));

  // ---- 구멍 도구 (평면도) ----
  const [hfx, hfy] = await findScreen('top', t0.x + 45, t0.y + 20, [0.02, 0.1, 0.5, 0.5]);
  await page.keyboard.press('d');
  await page.mouse.click(...at(hfx, hfy));
  await waitBuild();
  p = await proj();
  const hole = p.views.top.find(s => s.kind === 'circle' && s.spec);
  ok('hole tool makes spec hole', !!hole, JSON.stringify(hole?.spec));

  // ---- 장공 (평면도) ----
  await page.keyboard.press('s');
  const [sfx, sfy] = await findScreen('top', t0.x + 25, t0.y + 32, [0.02, 0.1, 0.5, 0.5]);
  await page.mouse.click(...at(sfx, sfy));
  await page.keyboard.type('10,5'); await page.keyboard.press('Enter');
  await waitBuild();
  p = await proj();
  ok('slot created', p.views.top.some(s => s.kind === 'slot'), JSON.stringify(p.views.top.find(s => s.kind === 'slot')));

  // ---- 다각형 (우측면도) ----
  await page.keyboard.press('l');
  await page.mouse.click(...at(0.75, 0.75));
  await page.keyboard.type('20<0'); await page.keyboard.press('Enter');
  await page.keyboard.type('20<90'); await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await waitBuild();
  p = await proj();
  const poly = p.views.side.find(s => s.kind === 'poly');
  ok('poly via length<angle', poly && poly.pts.length === 3, JSON.stringify(poly?.pts));
  console.log('status after side poly:', await status());

  // ---- 실행 취소 / 다시 실행 ----
  const before = JSON.stringify((await proj()).views);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const afterUndo = JSON.stringify((await proj()).views);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(300);
  const afterRedo = JSON.stringify((await proj()).views);
  ok('undo changes', before !== afterUndo);
  ok('redo restores', before === afterRedo);
  // 다각형 삭제 (선택 후 Delete)
  await page.keyboard.press('Control+z');
  await waitBuild();

  // ---- 선택 → 복제 → 삭제 ----
  await page.keyboard.press('v');
  const [rfx, rfy] = await findScreen('top', t0.x + 5, t0.y + 5, [0.02, 0.1, 0.5, 0.5]);
  await page.mouse.click(...at(rfx, rfy));
  await page.waitForTimeout(200);
  const nTop = (await proj()).views.top.length;
  await page.keyboard.press('Control+d');
  await page.waitForTimeout(300);
  ok('duplicate adds a shape', (await proj()).views.top.length === nTop + 1);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  ok('delete removes it', (await proj()).views.top.length === nTop);

  // ---- 모서리 도구 (정면도 사각형 왼쪽 아래 꼭짓점) ----
  const f0 = (await proj()).views.front[0];
  const [kfx, kfy] = await findScreen('front', f0.x, f0.y, [0.02, 0.6, 0.5, 0.98]);
  await page.keyboard.press('e');
  await page.mouse.click(...at(kfx, kfy));
  await waitBuild();
  p = await proj();
  ok('corner tool sets corner', (p.views.front[0].corners || []).some(c => c), JSON.stringify(p.views.front[0].corners));

  // ---- 측정 ----
  await page.keyboard.press('m');
  await page.mouse.click(...at(kfx, kfy));
  const [k2fx] = await findScreen('front', f0.x + 60, f0.y, [0.02, 0.6, 0.5, 0.98]);
  await page.mouse.move(...at(k2fx, kfy));
  await page.mouse.click(...at(k2fx, kfy));
  await page.waitForTimeout(200);
  console.log('measure hint:', await page.textContent('#toolHint'));
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');

  // ---- 변수 ----
  await page.click('#addParam');
  await page.waitForTimeout(200);
  await page.fill('#params .param-row:last-child .pexpr', '70');
  await page.press('#params .param-row:last-child .pexpr', 'Enter');
  await page.waitForTimeout(300);
  p = await proj();
  ok('param added', p.params?.length === 1 && p.params[0].expr === '70', JSON.stringify(p.params));
  // 정면도 사각형 선택 후 w에 L 입력
  await page.keyboard.press('v');
  const [mfx, mfy] = await findScreen('front', f0.x + 30, f0.y + 15, [0.02, 0.6, 0.5, 0.98]);
  await page.mouse.click(...at(mfx, mfy));
  await page.waitForTimeout(300);
  const inputs = await page.$$('#props .expr-field input');
  console.log('props expr fields:', inputs.length);
  // 가로(w)는 세 번째 칸 (x, y, w, h 순서 가정) → 라벨로 찾기
  const wInput = await page.evaluateHandle(() => {
    const ks = [...document.querySelectorAll('#props .k')];
    const k = ks.find(k => /가로|폭|w/i.test(k.textContent));
    return k?.nextElementSibling?.querySelector('input');
  });
  if (wInput.asElement()) {
    await wInput.asElement().fill('L');
    await wInput.asElement().press('Enter');
    await waitBuild();
    p = await proj();
    ok('bind width to L', p.views.front[0].w === 70 && p.views.front[0].exprs?.w === 'L', JSON.stringify({ w: p.views.front[0].w, exprs: p.views.front[0].exprs }));
    // 변수 바꾸면 따라 바뀜
    await page.fill('#params .param-row:last-child .pexpr', '80');
    await page.press('#params .param-row:last-child .pexpr', 'Enter');
    await waitBuild();
    p = await proj();
    ok('param change propagates', p.views.front[0].w === 80, `w=${p.views.front[0].w}`);
    // 순환 참조
    await page.click('#addParam');
    await page.waitForTimeout(200);
    await page.fill('#params .param-row:last-child .pexpr', 'L+W');
    await page.press('#params .param-row:last-child .pexpr', 'Enter');
    await page.fill('#params .param-row:first-child .pexpr', 'W');
    await page.press('#params .param-row:first-child .pexpr', 'Enter');
    await waitBuild();
    p = await proj();
    const errRows = await page.$$('#params .param-row.err');
    ok('cycle flagged', errRows.length >= 1, `err rows=${errRows.length} w=${p.views.front[0].w} status=${await status()}`);
    const findings = await page.textContent('#findings');
    ok('cycle shows in checks', /순환|식|변수/.test(findings), findings.slice(0, 120));
    await page.fill('#params .param-row:first-child .pexpr', '80');
    await page.press('#params .param-row:first-child .pexpr', 'Enter');
    await waitBuild();
  } else ok('find width input', false);

  // ---- 두께 식 ----
  await page.fill('#thickness', 'L/4');
  await page.press('#thickness', 'Enter');
  await waitBuild();
  p = await proj();
  console.log('thickness:', p.thickness, p.thicknessExpr);
  await page.fill('#thickness', 'foo');
  await page.press('#thickness', 'Enter');
  await page.waitForTimeout(300);
  p = await proj();
  ok('bad thickness rejected', p.thicknessExpr !== 'foo', `${p.thickness} ${p.thicknessExpr} toast=${await toastText()}`);

  // ---- 회전체 ----
  await page.selectOption('#mode', 'revolve');
  await waitBuild();
  console.log('revolve status:', await status());
  await page.selectOption('#mode', 'auto');
  await waitBuild();

  // ---- 저장 / 열기 ----
  const saved = await proj();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const b3d = fs.readFileSync(await dl.path());
  const z = unzip(b3d);
  ok('save .b3d', dl.suggestedFilename().endsWith('.b3d') && z.json('document.json').parts[0].views.front.length === saved.views.front.length, dl.suggestedFilename());
  await page.keyboard.press('Control+Alt+n');
  await page.waitForTimeout(500);
  const docFile = tmp('review-doc.b3d');
  fs.writeFileSync(docFile, b3d);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
  await chooser.setFiles(docFile);
  await waitBuild();
  p = await proj();
  ok('open .b3d restores', JSON.stringify(p.views) === JSON.stringify(saved.views));
  // 잘못된 파일
  fs.writeFileSync(tmp('bad.json'), '{"hello":1}');
  const [ch2] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
  await ch2.setFiles(tmp('bad.json'));
  await page.waitForTimeout(400);
  ok('bad json rejected', /읽을 수 없/.test(await toastText()), await toastText());

  // ---- 내보내기 ----
  for (const [btn, ws, ext] of [['#expStl3d', '2', 'stl'], ['#expStep3d', '2', 'step'], ['#expPdf', '3', 'pdf'], ['#expSvg', '3', 'svg'], ['#expDxf', '3', 'dxf'], ['#expPdfAll', '3', 'pdf']]) {
    await page.keyboard.press(ws); await page.waitForTimeout(500);
    // 도면의 SVG·DXF 등은 ‘내보내기 ▾’ 메뉴 안
    if (['#expSvg', '#expDxf', '#expPdfAll'].includes(btn)) await page.click('[data-menu="sheetexp"]');
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click(btn)]);
    const buf = fs.readFileSync(await d.path());
    const head = buf.slice(0, 60).toString('latin1').replace(/\s+/g, ' ');
    ok(`export ${ext}`, buf.length > 100 && d.suggestedFilename().endsWith('.' + ext), `${d.suggestedFilename()} ${buf.length}B head="${head.slice(0, 40)}"`);
  }
  await page.keyboard.press('1');

  // ---- AI 버튼 (키 없음) ----
  await page.click('#aiBtn');
  await page.waitForTimeout(400);
  const settingsOpen = await page.evaluate(() => document.querySelector('#settings')?.open ?? !document.querySelector('#settings')?.hidden);
  ok('AI without key opens settings', !!settingsOpen, String(settingsOpen));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await page.screenshot({ path: out('review1.png') });
  finish(results, errs);
  await browser.close();
})();
