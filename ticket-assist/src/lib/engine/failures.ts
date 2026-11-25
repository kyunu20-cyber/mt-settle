// 예매 실패 원인 기록 (JSON Lines + 스크린샷)
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

export interface FailureRecord { t: number; stage: string; reason: string; message: string; url?: string; screenshot?: string; adapter?: string }

export class FailureLog {
  constructor(private dir: string) {}
  get file() { return path.join(this.dir, 'failures.jsonl'); }

  async record(rec: Omit<FailureRecord, 't' | 'screenshot'>, page?: Page | null): Promise<FailureRecord> {
    fs.mkdirSync(this.dir, { recursive: true });
    const full: FailureRecord = { t: Date.now(), ...rec };
    if (page && !page.isClosed()) {
      const shot = path.join(this.dir, 'screenshots', `fail-${full.t}.png`);
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      await page.screenshot({ path: shot, timeout: 3000 }).then(() => { full.screenshot = shot; }).catch(() => {});
    }
    fs.appendFileSync(this.file, JSON.stringify(full) + '\n');
    return full;
  }

  list(limit = 50): FailureRecord[] {
    try {
      return fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-limit).reverse();
    } catch { return []; }
  }
}
