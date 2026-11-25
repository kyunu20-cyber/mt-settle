import { defineConfig } from '@playwright/test';

const PORT = 3210;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  workers: 1, // 엔진은 서버 프로세스 내 싱글톤
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  webServer: {
    command: `npx next build && npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/api/mock/time`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: { TICKET_ASSIST_DATA_DIR: 'data-test', TICKET_ASSIST_NO_OS_NOTIFY: '1', NEXT_TELEMETRY_DISABLED: '1' },
  },
});
