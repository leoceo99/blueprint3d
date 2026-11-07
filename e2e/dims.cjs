// 11단계: 도면 치수 — 자동 치수 2.0, 빠짐 검사, 고르기·옮기기·숨기기·되살리기, 치수 직접 놓기(가로·지름), 글자 덧붙이기, 실행 취소, 저장, 터치
const { out, launch, finish, fresh, waitBuild } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  const results = [];
  const ok = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const B = (fn, arg) => page.evaluate(fn, arg);
  const run = (id) => B((i) => window.blueprint3d.commands.run(i), id);
  const sheetReady = async () => { await page.waitForFunction(() => document.querySelectorAll('#sheetHost svg g.dim').length > 3, null, { timeout: 60000 }); await page.waitForTimeout(300); };
  const edits = () => B(() => { const s = window.blueprint3d.store; const d = s.doc.drawings.find((x) => x.id === s.doc.view.drawing); return JSON.parse(JSON.stringify(d?.edits ?? {})); });
  const dimTexts = () => B(() => [...document.querySelectorAll('#sheetHost svg g.dim')].map((g) => g.textContent));
  /** 용지 좌표 → 화면 좌표 */
  const scr = (p) => B(([x, y]) => {
    const svg = document.querySelector('#sheetHost svg');
    const H = svg.viewBox.baseVal.height;
    const pt = svg.createSVGPoint(); pt.x = x; pt.y = H - y;
    const q = pt.matrixTransform(svg.getScreenCTM());
    return [q.x, q.y];
  }, p);
  const dimBox = (id) => B((i) => window.blueprint3d.app.lastSheet.dims.find((d) => d.id === i)?.box ?? null, id);
  const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  try {
    await fresh(page);
    await waitBuild(page);
    await run('sample.4'); // 가이드 블록
    await waitBuild(page);
    await page.keyboard.press('3');
    await sheetReady();
    const t0 = await dimTexts();
    ok('자동 치수 2.0: 모서리 R·참고 치수·구멍 지시', t0.includes('4×R3') && t0.includes('(17)') && t0.some((t) => t.startsWith('2×M6')), t0.join(' | '));
    ok('치수 검사: 빠진 것 없음', /모든 형상에 크기·위치 치수/.test(await page.textContent('#dimCheck')), await page.textContent('#dimCheck'));
    await page.screenshot({ path: out('dims-auto.png') });

    // ---- 고르기 → 끌어서 옮기기 ----
    const w0 = await dimBox('w:front');
    const [wx, wy] = await scr(center(w0));
    await page.mouse.move(wx, wy); await page.mouse.down(); await page.mouse.move(wx, wy + 40, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(400);
    const e1 = await edits();
    const w1 = await dimBox('w:front');
    ok('전체 폭 치수를 끌어 내리면 옮긴 자리 저장', e1.moved?.['w:front']?.off < -16 && w1[1] < w0[1] - 5, JSON.stringify(e1.moved));

    // ---- 지우기(숨기기) → 빠짐 검사 → 되살리기 ----
    const [sx, sy] = await scr(center(w1));
    await page.mouse.click(sx, sy); await page.waitForTimeout(150);
    await page.keyboard.press('Delete'); await page.waitForTimeout(500);
    ok('자동 치수 지우면 숨김 + 빠짐 검사 경고', (await edits()).hide?.includes('w:front') && /빠진 치수 1개/.test(await page.textContent('#dimCheck')), await page.textContent('#dimCheck'));
    await page.click('#dimRestore'); await page.waitForTimeout(500);
    ok('자동 치수 처음대로', !(await edits()).hide && !(await edits()).moved && /모든 형상/.test(await page.textContent('#dimCheck')));

    // ---- 치수 직접 놓기: 정면도 아래 두 꼭짓점 → 가로 80 ----
    await page.keyboard.press('d'); await page.waitForTimeout(200);
    const views = await B(() => window.blueprint3d.app.lastSheet.views);
    const fb = views.front.box; // [l, b, r, t]
    for (const p of [[fb[0], fb[3]], [fb[2], fb[3]]]) { const [x, y] = await scr(p); await page.mouse.click(x, y); await page.waitForTimeout(120); }
    const [px, py] = await scr([(fb[0] + fb[2]) / 2, fb[3] + 12]);
    await page.mouse.move(px, py, { steps: 3 }); await page.waitForTimeout(100);
    await page.mouse.click(px, py); await page.waitForTimeout(500);
    let e2 = await edits();
    ok('점 두 개 + 자리 → 직접 놓은 가로 치수 80', e2.dims?.length === 1 && e2.dims[0].dir === 'h' && (await dimTexts()).filter((t) => t === '80').length >= 2, JSON.stringify(e2.dims));

    // ---- 원 → 지름 (카운터보어 Ø11, 평면도) ----
    const tb = views.top.box;
    const sh = await B(() => window.blueprint3d.app.lastSheet.prims.filter((p) => p.t === 'arc' && Math.abs(p.r - 5.5 * window.blueprint3d.app.lastSheet.scale) < 0.01).map((p) => [p.c, p.r]));
    const [cc, rr] = sh[0];
    const [ex, ey] = await scr([cc[0] + rr * Math.cos(Math.PI / 4), cc[1] + rr * Math.sin(Math.PI / 4)]);
    await page.mouse.click(ex, ey); await page.waitForTimeout(120);
    const [qx, qy] = await scr([cc[0] + rr + 14, cc[1] + rr + 10]);
    await page.mouse.move(qx, qy, { steps: 3 }); await page.mouse.click(qx, qy); await page.waitForTimeout(500);
    e2 = await edits();
    ok('원 둘레 + 자리 → 지름 치수 Ø11', e2.dims?.length === 2 && e2.dims[1].kind === 'diameter' && (await dimTexts()).includes('Ø11'), JSON.stringify(e2.dims?.[1]));
    await page.screenshot({ path: out('dims-manual.png') });

    // ---- 실행 취소 ----
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z'); await page.waitForTimeout(500);
    ok('Ctrl+Z로 지름 치수 취소', (await edits()).dims?.length === 1);

    // ---- 두 번 눌러 글자 덧붙이기 ----
    await page.keyboard.press('v'); await page.waitForTimeout(200);
    const mid = (await edits()).dims[0].id;
    const mb = await dimBox(mid);
    const [mx, my] = await scr(center(mb));
    await page.mouse.dblclick(mx, my); await page.waitForTimeout(200);
    await page.fill('.dim-edit', '±0.1'); await page.press('.dim-edit', 'Enter'); await page.waitForTimeout(500);
    ok('글자 덧붙이기: 80 ±0.1', (await dimTexts()).includes('80 ±0.1'), (await dimTexts()).filter((t) => t.startsWith('80')).join(','));

    // ---- 터치(손가락)로 고르기: 마우스보다 넓게 잡힘 ----
    const hb = await dimBox('h:front');
    const [hx, hy] = await scr(center(hb));
    const picked = await B(([x, y]) => {
      const svg = document.querySelector('#sheetHost svg');
      const opt = { clientX: x + 12, clientY: y, pointerType: 'touch', pointerId: 7, bubbles: true, button: 0, isPrimary: true };
      svg.dispatchEvent(new PointerEvent('pointerdown', opt));
      svg.dispatchEvent(new PointerEvent('pointerup', opt));
      return document.querySelector('#sheetHost svg g.dim.sel')?.getAttribute('data-dim');
    }, [hx, hy]);
    ok('터치로 조금 비껴 눌러도 치수가 골라짐', picked === 'h:front', String(picked));

    // ---- 저장 → 새로 고침 ----
    await page.waitForTimeout(1200);
    await page.reload(); await waitBuild(page);
    await page.keyboard.press('3'); await sheetReady();
    ok('새로 고침 뒤에도 직접 놓은 치수와 덧붙인 글자', (await dimTexts()).includes('80 ±0.1'));
    await page.screenshot({ path: out('dims-reload.png') });
  } catch (e) {
    results.push('FAIL (stopped) ' + String(e).split('\n')[0]);
  }
  finish(results, errs);
  await browser.close();
})();
