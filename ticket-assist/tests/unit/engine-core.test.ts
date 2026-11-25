import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, MinInterval, assertAllowedUrl, findSecretKeys } from '@/lib/engine/guards';
import { estimateOffset, offsetFromDateHeader, syncByDateBoundary, syncClock, waitUntil } from '@/lib/engine/timing';
import { defaultPolicy } from '@/lib/engine/dialogs';
import { resolveAdapter, ADAPTERS } from '@/lib/adapters/registry';
import { NotSupportedError } from '@/lib/adapters/types';
import { normalizeConfig } from '@/lib/engine/engine';
import type { BookingConfig } from '@/lib/engine/types';

const fake = (t = 0) => ({ now: () => t, sleep: async (ms: number) => { t += ms; }, adv: (ms: number) => { t += ms; } });

describe('timing', () => {
  it('RTT 가 가장 짧은 샘플로 오프셋 추정', () => {
    expect(estimateOffset([{ t0: 0, t1: 200, server: 5000 }, { t0: 300, t1: 310, server: 5305 }])).toEqual({ offsetMs: 5000, rttMs: 10 });
  });
  it('syncClock: 서버가 +2s 앞섬', async () => {
    const c = fake(1000);
    const r = await syncClock(async () => { c.adv(5); const s = c.now() + 2000; c.adv(5); return s; }, 3, c.now, 0);
    expect(r.offsetMs).toBe(2000);
  });
  it('HTTP Date 헤더(초 단위) 대안', () => {
    const r = offsetFromDateHeader('Wed, 25 Nov 2026 10:00:00 GMT', Date.parse('2026-11-25T10:00:00Z') - 50, Date.parse('2026-11-25T10:00:00Z') + 50);
    expect(r.offsetMs).toBe(500);
    expect(r.rttMs).toBeGreaterThan(1000); // 불확실성 반영
  });
  it('Date 헤더 초 경계 포착: 실제 오프셋을 ±(간격/2) 안으로 추정', async () => {
    for (const trueOffset of [0, 337, -1234, 5999]) {
      let local = 1_000_000_123;
      const head = async () => {
        const t0 = local; local += 10; // 왕복 20ms, 서버는 중간에 처리
        const server = local + trueOffset; local += 10;
        return { date: new Date(Math.floor(server / 1000) * 1000).toUTCString(), t0, t1: local };
      };
      const r = await syncByDateBoundary(head, { intervalMs: 100, maxSamples: 15, sleepFn: async (ms) => { local += ms; } });
      expect(r).not.toBeNull();
      expect(Math.abs(r!.offsetMs - trueOffset)).toBeLessThanOrEqual(65);
    }
  });
  it('waitUntil: 목표 시각 도달, 대기 중 checkpoint 호출', async () => {
    const c = fake(0); let cps = 0;
    const late = await waitUntil(10_000, 0, { now: c.now, sleepFn: c.sleep, checkpoint: async () => { cps++; } });
    expect(c.now()).toBeGreaterThanOrEqual(10_000);
    expect(late).toBeLessThan(5);
    expect(cps).toBeGreaterThan(3);
  });
});

describe('guards', () => {
  it('허용 호스트 밖 이동 차단', () => {
    expect(() => assertAllowedUrl('http://127.0.0.1:3100/mock', ['127.0.0.1'])).not.toThrow();
    expect(() => assertAllowedUrl('https://evil.example/', ['127.0.0.1'])).toThrow(/허용 범위 밖/);
    expect(() => assertAllowedUrl('file:///etc/passwd', ['127.0.0.1'])).toThrow(/프로토콜/);
  });
  it('민감정보 키 탐지 (중첩 포함)', () => {
    expect(findSecretKeys({ url: 'x', browser: { mode: 'launch' } })).toEqual([]);
    expect(findSecretKeys({ login: { password: 'x' }, cardNumber: '1', 비밀번호: 'y' })).toEqual(['login.password', 'cardNumber', '비밀번호']);
  });
  it('MinInterval', async () => {
    const c = fake(0); const m = new MinInterval(500, c.now, c.sleep);
    await m.wait(); const a = c.now(); await m.wait();
    expect(c.now() - a).toBe(500);
  });
  it('Ledger: completed/held 차단, cancelled/failed 허용, 파일 영속', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'l.json');
    const l = new Ledger(file);
    const k = Ledger.keyOf('mock', 'http://127.0.0.1:3100/mock?x=1', '2026-12-20', '19:00');
    expect(k).toBe('mock|http://127.0.0.1:3100/mock|2026-12-20|19:00');
    expect(l.check(k).ok).toBe(true);
    l.set(k, 'held'); expect(l.check(k).ok).toBe(false);
    l.set(k, 'failed'); expect(l.check(k).ok).toBe(true);
    l.set(k, 'completed', { orderId: 'MOCK-1' });
    expect(new Ledger(file).check(k)).toMatchObject({ ok: false, reason: expect.stringMatching(/MOCK-1/) });
    l.remove(k); expect(l.check(k).ok).toBe(true);
  });
});

describe('dialog 정책', () => {
  it('진행 확인 수락, 취소 확인은 의도할 때만, 미상 거절', () => {
    expect(defaultPolicy({ type: 'alert', message: '이미 선택된 좌석' }, {})).toBe('accept');
    expect(defaultPolicy({ type: 'confirm', message: '선택한 좌석으로 진행하시겠습니까?' }, {})).toBe('accept');
    expect(defaultPolicy({ type: 'confirm', message: '예매를 취소하고 좌석을 반환하시겠습니까?' }, {})).toBe('dismiss');
    expect(defaultPolicy({ type: 'confirm', message: '예매를 취소하고 좌석을 반환하시겠습니까?' }, { cancel: true })).toBe('accept');
    expect(defaultPolicy({ type: 'confirm', message: '회원 탈퇴?' }, {})).toBe('dismiss');
    expect(defaultPolicy({ type: 'prompt', message: '입력' }, {})).toBe('dismiss');
  });
});

describe('Adapter 레지스트리', () => {
  it('URL 로 사이트 식별', () => {
    expect(resolveAdapter('http://localhost:3100/mock').id).toBe('mock');
    expect(resolveAdapter('http://localhost:3100/mock?mode=assist').id).toBe('mock-assist');
    expect(resolveAdapter('https://ticket.yes24.com/Perf/1').id).toBe('yes24');
    expect(resolveAdapter('https://ticket.melon.com/performance/index.htm?prodId=1').id).toBe('melon');
    expect(resolveAdapter('https://www.ticketlink.co.kr/product/1').id).toBe('ticketlink');
    expect(resolveAdapter('https://tickets.interpark.com/goods/1').id).toBe('nol');
    expect(resolveAdapter('https://www.coupangplay.com/some/page').id).toBe('coupangplay');
    expect(() => resolveAdapter('https://unknown.example/')).toThrow(/지원하지 않는/);
    expect(() => resolveAdapter('http://localhost:3100/other')).toThrow();
    expect(() => resolveAdapter('https://ticket.yes24.com/', 'melon')).toThrow(/도메인이 아닙니다/);
  });
  it('실제 사이트 Adapter 는 보조 모드이며 화면 조작 메서드는 미지원 예외', async () => {
    const real = ADAPTERS.filter(a => !a.id.startsWith('mock'));
    expect(real.map(a => a.id)).toEqual(['nol', 'yes24', 'melon', 'ticketlink', 'coupangplay']);
    for (const a of real) {
      expect(a.support).toMatchObject({ status: 'assist-only', automatedPayment: false });
      expect(a.completePayment).toBeUndefined();
      await expect(a.readSeatMap(null as never, null as never)).rejects.toBeInstanceOf(NotSupportedError);
      await expect(a.selectSeats(null as never, [], null as never)).rejects.toBeInstanceOf(NotSupportedError);
    }
  });
});

describe('설정 검증', () => {
  const base: BookingConfig = { url: 'http://localhost:3100/mock', openAt: '2026-12-01T20:00:00+09:00', performanceDate: '2026-12-20', performanceTime: '19:00', quantity: 2, sections: [' A ', '', 'B'], grades: [], weights: { stage: 1, center: 0, section: 0 }, allowSplit: false, browser: { mode: 'launch' } };
  it('정규화', () => {
    const c = normalizeConfig(base);
    expect(c.sections).toEqual(['A', 'B']);
    expect(c.browser.mode).toBe('launch');
    expect(c.notifications?.desktop).toBe(true);
  });
  it('잘못된 입력 거부', () => {
    expect(() => normalizeConfig({ ...base, quantity: 0 })).toThrow(/매수/);
    expect(() => normalizeConfig({ ...base, performanceDate: '12/20' })).toThrow(/날짜/);
    expect(() => normalizeConfig({ ...base, performanceTime: '7pm' })).toThrow(/시간/);
    expect(() => normalizeConfig({ ...base, openAt: 'tomorrow' })).toThrow(/오픈/);
    expect(() => normalizeConfig({ ...base, url: 'nope' })).toThrow();
  });
});
