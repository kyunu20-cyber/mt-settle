// 모의 CAPTCHA: 왜곡된 SVG 문자 이미지. 자동화 봇은 이것을 풀지 않고 사람에게 넘긴다.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export function newCaptcha(rnd = Math.random) {
  let answer = '';
  for (let i = 0; i < 6; i++) answer += CHARS[Math.floor(rnd() * CHARS.length)];
  return answer;
}
export function captchaSvg(answer, rnd = Math.random) {
  const letters = [...answer].map((ch, i) => {
    const x = 18 + i * 30, y = 42 + (rnd() * 12 - 6), rot = rnd() * 40 - 20;
    return `<text x="${x}" y="${y}" transform="rotate(${rot.toFixed(1)} ${x} ${y})" font-size="30" font-family="serif" fill="#334">${ch}</text>`;
  }).join('');
  const lines = Array.from({ length: 7 }, () =>
    `<line x1="${rnd() * 200}" y1="${rnd() * 60}" x2="${rnd() * 200}" y2="${rnd() * 60}" stroke="#889" stroke-width="1.5"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60"><rect width="200" height="60" fill="#eef"/>${lines}${letters}</svg>`;
}
