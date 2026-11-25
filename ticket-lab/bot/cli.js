#!/usr/bin/env node
// 사용 예:
//   node bot/cli.js --url http://127.0.0.1:4100 --count 2 --sections A,B --headed
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TicketBot } from './bot.js';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    a[key] = v;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.url) {
  console.log(`사용법: node bot/cli.js --url <모의사이트 URL> [옵션]
  --count N            매수 (기본 2)
  --sections A,B       선호 구역 순서 (미지정 시 전체)
  --max-price N        1매당 최대 가격
  --max-row N          최대 열 번호
  --allow-split        연석이 없을 때 분산석 허용
  --headed             브라우저 창 표시 (CAPTCHA 직접 입력 시 필요)
  --state-file PATH    상태 기록 파일 (기본 ./state/last-run.json)
  --allow-host HOST    loopback 외 대상 호스트 허용 (해당 서비스가 자동화를 허용하는 경우만)`);
  process.exit(args.help ? 0 : 1);
}

const ask = async (q) => {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
};

const bot = new TicketBot({
  url: args.url,
  count: Number(args.count || 2),
  prefs: {
    sections: args.sections ? String(args.sections).split(',') : [],
    maxPricePerSeat: args['max-price'] ? Number(args['max-price']) : null,
    maxRow: args['max-row'] ? Number(args['max-row']) : null,
    allowSplit: !!args['allow-split'],
  },
  headless: !args.headed,
  allowHosts: args['allow-host'] ? String(args['allow-host']).split(',') : [],
  stateFile: args['state-file'] || 'state/last-run.json',
  humanHandoff: async ({ message }) => { console.log(`\n>>> 사람 개입 필요: ${message}\n>>> 브라우저에서 입력을 마치면 자동으로 계속됩니다.\n`); },
  confirmPurchase: async (s) => {
    console.log(`\n===== 결제 확인 =====\n${s.text}\n선점 유지: ${s.expiresIn}\n`);
    const ans = await ask('결제를 진행하려면 정확히 "yes" 를 입력하세요 (그 외 입력 시 좌석 반환): ');
    return ans === 'yes';
  },
});

const result = await bot.run();
console.log('\n===== 결과 =====');
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 'DONE' || result.status === 'CANCELLED' ? 0 : 2);
