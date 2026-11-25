import { chromium } from 'playwright';
import { startLab } from '../../server/server.js';
import { TicketBot } from '../../bot/bot.js';
import { createLogger } from '../../bot/logger.js';

let browser;
export async function getBrowser() { return (browser ??= await chromium.launch()); }
export async function closeBrowser() { await browser?.close(); browser = null; }

export async function adminState(lab) { return (await fetch(lab.url + '/api/admin/state')).json(); }

/** 서버를 띄우고 봇 1회 실행. 로그는 실패 시 확인하도록 반환 */
export async function runScenario({ config = {}, bot = {} } = {}) {
  const lab = await startLab({ config: { openInMs: 1500, ...config } });
  const logger = createLogger({ quiet: !process.env.VERBOSE });
  try {
    const b = new TicketBot({ url: lab.url, browser: await getBrowser(), logger, count: 2, confirmPurchase: async () => true, ...bot });
    const result = await b.run();
    const state = await adminState(lab);
    return { lab, result, state, logs: logger.lines };
  } finally {
    await lab.close();
  }
}

/** 테스트용 "사람": 화면의 보안문자를 읽어 입력하는 행위를 흉내낸다 (서버 관리자 API로 정답 확인). */
export function simulatedHuman(labUrlRef, { delayMs = 300, wrongFirst = false } = {}) {
  return async ({ page }) => {
    await page.waitForTimeout(delayMs);
    const cookies = await page.context().cookies();
    const sid = cookies.find(c => c.name === 'sid')?.value;
    if (wrongFirst) {
      await page.locator('#captcha-input').fill('WRONG1');
      await page.locator('#captcha-submit').click();
      await page.locator('#captcha-error').filter({ hasText: '일치' }).waitFor();
      await page.waitForTimeout(200);
    }
    const { answer } = await (await fetch(`${labUrlRef.url}/api/admin/captcha-answer?sid=${sid}`)).json();
    await page.locator('#captcha-input').fill(answer);
    await page.locator('#captcha-submit').click();
  };
}
