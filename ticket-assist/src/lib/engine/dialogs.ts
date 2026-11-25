// 네이티브 dialog(alert/confirm/prompt/beforeunload) 처리
import type { Page } from 'playwright';

export interface DialogEvent { type: string; message: string; decision: 'accept' | 'dismiss'; at: number; url: string }
export type DialogPolicy = (d: { type: string; message: string }, intent: { cancel?: boolean }) => 'accept' | 'dismiss';

/**
 * 기본 정책
 * - alert: 확인 (내용은 기록 → Adapter 가 실패 원인 판단에 사용)
 * - confirm: 진행 확인은 수락 / 취소·반환 확인은 엔진이 취소를 의도한 경우만 수락 / 그 외는 거절
 * - prompt 등 알 수 없는 것: 거절
 */
export const defaultPolicy: DialogPolicy = ({ type, message }, intent) => {
  if (type === 'alert' || type === 'beforeunload') return 'accept';
  if (type === 'confirm') {
    if (/취소|반환|삭제/.test(message)) return intent.cancel ? 'accept' : 'dismiss';
    if (/진행|계속|선택하시겠|예매하시겠/.test(message)) return 'accept';
  }
  return 'dismiss';
};

export class DialogGuard {
  events: DialogEvent[] = [];
  intent: { cancel?: boolean } = {};
  private attached = new WeakSet<Page>();
  constructor(private onEvent: (e: DialogEvent) => void, private policy: DialogPolicy = defaultPolicy) {}

  attach(page: Page) {
    if (this.attached.has(page)) return;
    this.attached.add(page);
    page.on('dialog', async (dialog) => {
      const ev: DialogEvent = { type: dialog.type(), message: dialog.message(), decision: 'dismiss', at: Date.now(), url: page.url() };
      ev.decision = this.policy(ev, this.intent);
      this.events.push(ev);
      this.onEvent(ev);
      try { if (ev.decision === 'accept') await dialog.accept(); else await dialog.dismiss(); } catch { /* 페이지 종료 */ }
    });
  }

  since(t: number, pred: (e: DialogEvent) => boolean = () => true) { return this.events.find(e => e.at >= t && pred(e)) ?? null; }
}
