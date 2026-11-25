// macOS 데스크톱 알림 (osascript). 다른 OS 에서는 대시보드(브라우저 Notification API)만 사용.
import { execFile } from 'node:child_process';

export function desktopNotify(title: string, body: string, enabled = true): Promise<boolean> {
  if (!enabled || process.platform !== 'darwin' || process.env.TICKET_ASSIST_NO_OS_NOTIFY === '1') return Promise.resolve(false);
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`;
  return new Promise(resolve => execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 }, err => resolve(!err)));
}
