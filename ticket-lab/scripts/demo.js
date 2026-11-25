// 데모: 모의 서버를 띄우고(5초 뒤 오픈, 경쟁 구매자 있음) 봇을 실행한다. 결제 확인은 터미널에서 직접 응답.
import { startLab } from '../server/server.js';
import { spawn } from 'node:child_process';

const lab = await startLab({ port: 4100, config: { openInMs: 5000, competitor: { soldPerSec: 8 }, queue: { enabled: process.env.QUEUE === '1' } } });
console.log(`[demo] 모의 사이트 ${lab.url} (5초 뒤 오픈)`);
const extra = process.argv.slice(2);
const child = spawn(process.execPath, ['bot/cli.js', '--url', lab.url, '--count', '2', '--sections', 'A,B', ...extra], { stdio: 'inherit' });
child.on('exit', async (code) => { await lab.close(); process.exit(code ?? 0); });
