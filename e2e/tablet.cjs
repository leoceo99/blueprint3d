// 12단계: 패드 준비 — 태블릿 가로 화면(1180×820)에서 손가락으로: 사각형 그리기, 두 손가락 확대·이동(그리던 것 취소),
// 도면 출력 확대(두 손가락·＋)·한 손가락 이동, 웹판 DWG 안내
const { out, launch, finish, fresh, waitBuild } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  const results = [];
  const ok = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const B = (fn, arg) => page.evaluate(fn, arg);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
  const drag1 = async (a, b, steps = 6) => {
    await touch('touchStart', [a]);
    for (let i = 1; i <= steps; i++) await touch('touchMove', [[a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]]);
    await touch('touchEnd', []);
    await page.waitForTimeout(250);
  };
  const pinch = async (c, d0, d1, shift = [0, 0], steps = 8) => {
    const at = (d, k) => [[c[0] - d / 2 + shift[0] * k, c[1] + shift[1] * k], [c[0] + d / 2 + shift[0] * k, c[1] + shift[1] * k]];
    await touch('touchStart', at(d0, 0).slice(0, 1));
    await touch('touchStart', at(d0, 0));
    for (let i = 1; i <= steps; i++) await touch('touchMove', at(d0 + ((d1 - d0) * i) / steps, i / steps));
    await touch('touchEnd', []);
    await page.waitForTimeout(250);
  };
  const shapes = () => B(() => ['front', 'top', 'side'].reduce((n, v) => n + window.blueprint3d.store.project.views[v].length, 0));
  const scr = (u, v, view = 'front') => B(([u, v, view]) => { const [x, y] = window.blueprint3d.board.panes[view].toScreen(u, v); const r = document.querySelector('#board').getBoundingClientRect(); return [r.x + x, r.y + y]; }, [u, v, view]);
  try {
    await fresh(page);
    await waitBuild(page);
    await page.keyboard.press('Control+Alt+n'); await waitBuild(page);
    // 리본이 화면 안에 들어오거나 옆으로 밀어 볼 수 있음
    const rib = await B(() => { const r = document.querySelector('#ribbon'); return { sw: r.scrollWidth, cw: r.clientWidth, ox: getComputedStyle(r).overflowX }; });
    ok('태블릿 가로 화면: 리본이 넘치면 옆으로 밀 수 있음', rib.sw <= rib.cw + 2 || /auto|scroll/.test(rib.ox), JSON.stringify(rib));
    await page.screenshot({ path: out('tablet-design.png') });

    // ---- 손가락으로 사각형 그리기 (정면도) ----
    await page.tap('[data-tool="rect"]'); await page.waitForTimeout(150);
    const a = await scr(0, 0); const b = await scr(40, 20);
    await drag1(a, b);
    const n1 = await shapes();
    ok('한 손가락 끌기로 사각형 그리기', n1 === 1, String(n1));

    // ---- 두 손가락 벌리기: 확대, 그리던 것은 없음 ----
    const w0 = await B(() => { const p = window.blueprint3d.board.panes.front; return p.toScreen(10, 0)[0] - p.toScreen(0, 0)[0]; });
    const c = await scr(60, 30);
    await pinch(c, 80, 240);
    const w1 = await B(() => { const p = window.blueprint3d.board.panes.front; return p.toScreen(10, 0)[0] - p.toScreen(0, 0)[0]; });
    ok('두 손가락 벌리면 확대 (사각형 도구여도 그려지지 않음)', w1 > w0 * 2 && (await shapes()) === 1, `${w0.toFixed(1)} → ${w1.toFixed(1)}, 도형 ${await shapes()}`);
    // 두 손가락 함께 끌기 = 이동
    const p0 = await scr(0, 0);
    await pinch(c, 150, 150, [0, -120]);
    const p1 = await scr(0, 0);
    ok('두 손가락 함께 끌면 화면 이동', Math.abs(p1[1] - p0[1] + 120) < 25 && (await shapes()) === 1, `${p0[1].toFixed(0)} → ${p1[1].toFixed(0)}`);

    // ---- 도면 출력: 두 손가락 확대, ＋, 한 손가락 이동 ----
    await page.waitForTimeout(900); // 손가락 끌기 직후의 탭은 미끄러짐만 멈추므로
    await page.tap('.ws-tabs button:nth-child(3)'); await page.waitForTimeout(400);
    await page.waitForFunction(() => document.querySelectorAll('#sheetHost svg g.dim').length > 1, null, { timeout: 60000 });
    const z0 = await page.textContent('#sheetZoomLabel');
    const hb = await B(() => { const r = document.querySelector('#sheetHost').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await pinch(hb, 100, 260);
    const z1 = await page.textContent('#sheetZoomLabel');
    ok('도면도 두 손가락으로 확대', parseInt(z1) > 150 && z0 === '100%', `${z0} → ${z1}`);
    const s0 = await B(() => [document.querySelector('#sheetHost').scrollLeft, document.querySelector('#sheetHost').scrollTop]);
    // 빈 곳(용지 바깥 여백 쪽)을 한 손가락으로 끌기
    const corner = await B(() => { const r = document.querySelector('#sheetHost svg').getBoundingClientRect(); const h = document.querySelector('#sheetHost').getBoundingClientRect(); return [Math.max(r.x, h.x) + 30, Math.max(r.y, h.y) + 30]; });
    await drag1(corner, [corner[0] + 120, corner[1] + 90]);
    const s1 = await B(() => [document.querySelector('#sheetHost').scrollLeft, document.querySelector('#sheetHost').scrollTop]);
    ok('한 손가락으로 빈 곳을 끌면 도면 이동', s1[0] < s0[0] - 50 || s1[1] < s0[1] - 50, `${s0} → ${s1}`);
    // 빠르게 끈 바로 뒤의 탭은 (휴대 기기처럼) 미끄러짐을 멈추기만 하므로 잠깐 쉬고 누른다
    await page.waitForTimeout(900);
    await page.tap('[data-cmd="sheet.zoomFit"]'); await page.waitForTimeout(300);
    const zf = await page.textContent('#sheetZoomLabel');
    await page.tap('[data-cmd="sheet.zoomIn"]'); await page.waitForTimeout(300);
    ok('맞춤 → ＋ 단추 = 125%', zf === '100%' && (await page.textContent('#sheetZoomLabel')) === '125%', `${zf} → ${await page.textContent('#sheetZoomLabel')}`);
    const tb = await B(() => { const t = document.querySelector('.sheet-toolbar'); return { sw: t.scrollWidth, cw: t.clientWidth, ox: getComputedStyle(t).overflowX }; });
    ok('도면 도구 줄이 넘치면 옆으로 밀 수 있음', tb.sw <= tb.cw + 2 || /auto|scroll/.test(tb.ox), JSON.stringify(tb));
    await page.screenshot({ path: out('tablet-sheet.png') });

    // ---- 웹판 DWG: 설치형 앱 안내 + DXF로 저장 ----
    await page.waitForTimeout(600);
    await page.tap('[data-menu="sheetexp"]'); await page.waitForTimeout(200);
    await page.tap('#expDwg'); await page.waitForTimeout(300);
    const nt = await page.textContent('#notices');
    ok('웹판 DWG 단추: 설치형 앱 안내와 DXF 저장', /설치형 앱/.test(nt) && /DXF로 저장/.test(nt), nt.slice(0, 80));
  } catch (e) {
    results.push('FAIL (stopped) ' + String(e).split('\n')[0]);
  }
  finish(results, errs);
  await browser.close();
})();
