import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanSlate, mockState } from './helpers';

test.use({ viewport: { width: 1440, height: 1100 } });
test.beforeEach(async ({ request }) => { await cleanSlate(request); });

test('대시보드 UI: 설정 → 시작 → ms 카운트다운 → 좌석 확인 패널 → 결제 승인 → 완료', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('#cfg-adapter')).toContainText('모의 예매 사이트');
  await expect(page.locator('#cfg-adapter')).toContainText('자동화 지원');

  // 실제 사이트 URL 을 넣으면 보조 모드로 표시
  await page.locator('#cfg-url').fill('https://ticket.yes24.com/Perf/12345');
  await expect(page.locator('#cfg-adapter')).toContainText('YES24 티켓');
  await expect(page.locator('#cfg-adapter')).toContainText('보조 모드');
  await page.locator('#cfg-url').fill('http://127.0.0.1:3210/mock');

  // 모의 사이트 시나리오: 8초 뒤 오픈, SVG 좌석맵, 로그인 불필요
  await page.locator('#mock-open-in').fill('8');
  await page.locator('#mock-render').selectOption('svg');
  await page.locator('#mock-requireLogin').uncheck();
  await page.locator('#mock-reset').click();
  await page.locator('#cfg-time').fill('14:00');
  await page.locator('#cfg-headless').check();
  await page.locator('#cfg-profile').fill(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-ui-')));

  await page.locator('#btn-start').click();
  await expect(page.locator('#browser-status')).toContainText('브라우저 연결됨', { timeout: 15_000 });
  await expect(page.locator('#stage')).toHaveAttribute('data-stage', 'countdown', { timeout: 15_000 });
  // 밀리초 단위 카운트다운이 실제로 흐르는지
  const a = await page.locator('#countdown').textContent();
  await page.waitForTimeout(137);
  const b = await page.locator('#countdown').textContent();
  expect(a).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  expect(a).not.toBe(b);

  await expect(page.locator('#confirm-panel')).toHaveAttribute('data-kind', 'seats', { timeout: 30_000 });
  await expect(page.locator('#seat-panel')).toContainText('(svg)');
  await expect(page.locator('#seat-recs li').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-seat-confirm.png' });
  await page.locator('.confirm-option').nth(1).check();
  await page.locator('#btn-approve').click();

  await expect(page.locator('#confirm-panel')).toHaveAttribute('data-kind', 'payment', { timeout: 30_000 });
  await expect(page.locator('#confirm-order')).toContainText('합계');
  await page.locator('#btn-approve').click();

  await expect(page.locator('#result')).toHaveAttribute('data-outcome', 'done', { timeout: 30_000 });
  await expect(page.locator('#event-log')).toContainText('예매 버튼 활성화 감지');
  await expect(page.locator('#event-log')).toContainText('좌석 선점 성공');
  await expect(page.locator('#ledger')).toContainText('completed');
  await page.screenshot({ path: 'test-results/dashboard-done.png' });
  expect((await mockState(request)).orders).toHaveLength(1);

  // 같은 회차 재시작 → 중복 예매 방지 메시지
  await page.locator('#btn-start').click();
  await expect(page.locator('#dash-error')).toContainText('중복 예매 방지');
});
