// 간단한 타임스탬프 로거 (메모리에 기록도 보관)
export function createLogger({ quiet = false, sink = console } = {}) {
  const lines = [];
  const t0 = Date.now();
  const write = (level, msg) => {
    const line = `[+${((Date.now() - t0) / 1000).toFixed(3)}s] ${level.padEnd(5)} ${msg}`;
    lines.push(line);
    if (!quiet) (level === 'ERROR' ? sink.error : sink.log).call(sink, line);
  };
  return {
    lines,
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    state: (from, to, info) => write('STATE', `${from} → ${to}${info ? ' ' + JSON.stringify(info) : ''}`),
  };
}
