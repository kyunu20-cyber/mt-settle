import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Playwright 는 서버 런타임에서 그대로 require 해야 한다(번들링 금지)
  serverExternalPackages: ['playwright', 'playwright-core'],
  devIndicators: false,
  // 상위 디렉터리에 다른 lockfile 이 있어도 이 폴더를 루트로 사용
  turbopack: { root: __dirname },
};

export default nextConfig;
