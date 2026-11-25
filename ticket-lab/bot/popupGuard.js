// 팝업 처리
// 1) 네이티브 dialog(alert/confirm/prompt): 정책 함수로 수락/거절 결정, 메시지 기록
// 2) 레이어 팝업(공지·광고 모달): Playwright addLocatorHandler 로 나타나는 즉시 닫기
// 3) 새 창(window.open): 호출측에서 page.waitForEvent('popup') 로 전환

/**
 * 기본 dialog 정책.
 * - alert: 항상 확인(내용은 기록되어 봇 로직이 참고)
 * - confirm: 진행 의사 확인류는 수락, '취소/반환' 확인은 봇이 취소를 의도한 경우에만 수락
 * - 그 외 알 수 없는 confirm/prompt: 안전하게 거절
 */
export function defaultDialogPolicy({ type, message }, intent = {}) {
  if (type === 'alert') return 'accept';
  if (type === 'beforeunload') return 'accept';
  if (type === 'confirm') {
    if (/취소|반환/.test(message)) return intent.cancel ? 'accept' : 'dismiss';
    if (/진행|계속|예매하시겠습니까/.test(message)) return 'accept';
  }
  return 'dismiss';
}

export class DialogGuard {
  constructor({ logger, policy = defaultDialogPolicy } = {}) {
    this.logger = logger;
    this.policy = policy;
    this.intent = {};
    this.events = [];
    this.waiters = [];
  }

  attach(page) {
    page.on('dialog', async (dialog) => {
      const ev = { type: dialog.type(), message: dialog.message(), at: Date.now() };
      const decision = this.policy(ev, this.intent);
      ev.decision = decision;
      this.events.push(ev);
      this.logger?.info(`dialog[${ev.type}] "${ev.message}" → ${decision}`);
      try {
        if (decision === 'accept') await dialog.accept(); else await dialog.dismiss();
      } catch { /* 페이지가 이미 닫힌 경우 */ }
      this.waiters = this.waiters.filter(w => !w(ev));
    });
    return this;
  }

  /** 조건에 맞는 dialog 가 (since 이후) 뜰 때까지 대기 */
  waitFor(pred, { since = 0, timeout = 10_000 } = {}) {
    const hit = this.events.find(e => e.at >= since && pred(e));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter(w => w !== check); reject(new Error('dialog timeout')); }, timeout);
      timer.unref?.();
      const check = (e) => { if (e.at >= since && pred(e)) { clearTimeout(timer); resolve(e); return true; } return false; };
      this.waiters.push(check);
    });
  }
}

/** 모의 사이트의 레이어 팝업 닫기 규칙. 실제 사이트별로 이 목록만 교체하면 된다. */
export const DEFAULT_OVERLAYS = [
  { name: '공지 모달', locator: '#notice-modal:not([hidden])', close: '#notice-close' },
  { name: '광고 레이어', locator: '#ad-layer:not([hidden])', close: '#ad-close' },
];

export async function installOverlayHandlers(page, { overlays = DEFAULT_OVERLAYS, logger, stats } = {}) {
  for (const o of overlays) {
    await page.addLocatorHandler(page.locator(o.locator), async (overlay) => {
      logger?.info(`레이어 팝업 감지: ${o.name} → 닫기`);
      if (stats) stats[o.name] = (stats[o.name] || 0) + 1;
      await overlay.locator(o.close).click({ timeout: 2000 }).catch(() => {});
    }, { noWaitAfter: false });
  }
}
