import { test, expect, chromium } from '@playwright/test';
import { BASE, cleanSlate, config, engineAction, mockReset, waitConfirm, waitDone, waitStatus } from './helpers';

test.beforeEach(async ({ request }) => { await cleanSlate(request); });

test('CDP 모드: 이미 로그인된 내 Chrome 에 연결 → 로그인 세션 재사용, 종료해도 내 브라우저는 유지', async ({ request }) => {
  // 사용자가 직접 띄운 Chrome (원격 디버깅 포트) 을 흉내
  const userChrome = await chromium.launch({ args: ['--remote-debugging-port=9555'] });
  const ctx = await userChrome.newContext();
  const page = await ctx.newPage();
  const m = await mockReset(request, { requireLogin: true, openInMs: 5000 });
  // 사용자가 미리 로그인해 둔 상태
  await page.goto(`${BASE}/mock/login?next=/mock`);
  await page.locator('#mock-login-id').fill('me');
  await page.locator('#mock-login-submit').click();
  await expect(page.locator('#mock-user')).toHaveText('me');

  const r = await engineAction(request, { action: 'start', config: config(m.openAt, { browser: { mode: 'cdp', cdpUrl: 'http://127.0.0.1:9555' } }) });
  expect(r.body.ok).toBe(true);
  // CDP 로 붙으면 기본 컨텍스트를 쓴다 → 사용자의 로그인 쿠키가 있는 컨텍스트여야 세션 유지.
  // (launch() 로 만든 newContext 는 기본 컨텍스트가 아니므로, 엔진은 기존 탭이 열린 컨텍스트를 찾아 사용해야 한다)
  const s = await waitStatus(request, x => x.stage === 'countdown' || x.stage === 'awaiting-login' || (!x.running && !!x.result), 20_000, 'session');
  expect(s.stage).toBe('countdown');
  await waitConfirm(request, 'seats', 30_000);
  await engineAction(request, { action: 'stop' });
  expect((await waitDone(request)).result!.outcome).toBe('stopped');
  expect(userChrome.isConnected()).toBe(true);
  expect(page.isClosed()).toBe(false);
  await userChrome.close();
});
