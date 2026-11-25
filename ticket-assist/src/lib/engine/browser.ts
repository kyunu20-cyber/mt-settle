// 브라우저 연결 관리: 전용 프로필(로그인 세션 유지) 실행 또는 실행 중인 Chrome 에 CDP 연결
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { BrowserOptions } from './types';

export const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.ticket-assist', 'chrome-profile');

export class BrowserManager {
  context: BrowserContext | null = null;
  private browser: Browser | null = null;
  mode: BrowserOptions['mode'] | null = null;
  private key = '';
  constructor(private onChange: (connected: boolean, detail: string) => void) {}

  get connected() { return !!this.context; }
  pages(): Page[] { return this.context?.pages() ?? []; }

  /** preferOrigin: CDP 모드에서 이 사이트 탭이 열려 있는 컨텍스트(=로그인 세션)를 우선 사용 */
  async connect(opts: BrowserOptions, preferOrigin?: string): Promise<BrowserContext> {
    const key = JSON.stringify(opts);
    if (this.context && this.key === key) return this.context; // 같은 설정이면 재사용 → 로그인 세션 유지
    await this.disconnect();
    this.key = key;
    this.mode = opts.mode;
    if (opts.mode === 'cdp') {
      const url = opts.cdpUrl || 'http://127.0.0.1:9222';
      this.browser = await chromium.connectOverCDP(url, { timeout: 10_000 });
      const ctxs = this.browser.contexts();
      this.context = (preferOrigin && ctxs.find(c => c.pages().some(p => p.url().startsWith(preferOrigin))))
        || ctxs.find(c => c.pages().length > 0) || ctxs[0] || await this.browser.newContext();
      this.browser.on('disconnected', () => this.lost('Chrome 연결 끊김'));
      this.onChange(true, `실행 중인 Chrome 에 연결 (${url})`);
    } else {
      const dir = opts.profileDir || DEFAULT_PROFILE_DIR;
      fs.mkdirSync(dir, { recursive: true });
      const args = opts.debugPort ? [`--remote-debugging-port=${opts.debugPort}`] : [];
      const channel = opts.channel === 'chrome' ? 'chrome' : undefined;
      this.context = await chromium.launchPersistentContext(dir, {
        headless: opts.headless ?? false, channel, args, viewport: opts.headless ? { width: 1280, height: 900 } : null,
      });
      this.onChange(true, `${channel ?? 'chromium'} 실행 (프로필: ${dir})`);
    }
    this.context.on('close', () => this.lost('브라우저가 닫힘'));
    return this.context;
  }

  private lost(why: string) {
    if (!this.context) return;
    this.context = null; this.browser = null; this.key = '';
    this.onChange(false, why);
  }

  async disconnect() {
    const ctx = this.context, br = this.browser, mode = this.mode;
    this.context = null; this.browser = null; this.key = '';
    if (mode === 'launch' && ctx) await ctx.close().catch(() => {});
    // CDP 모드: 사용자 Chrome 은 닫지 않는다 (연결 참조만 해제)
    void br;
    if (ctx) this.onChange(false, '연결 해제');
  }
}
