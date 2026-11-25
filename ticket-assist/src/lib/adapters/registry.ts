import type { SiteAdapter } from './types';
import { mockAdapter } from './mock';
import { nolAdapter, yes24Adapter, melonAdapter, ticketlinkAdapter, coupangPlayAdapter, mockAssistAdapter } from './real';

export const ADAPTERS: SiteAdapter[] = [mockAssistAdapter, mockAdapter, nolAdapter, yes24Adapter, melonAdapter, ticketlinkAdapter, coupangPlayAdapter];

export function resolveAdapter(url: string, id?: string): SiteAdapter {
  if (id) {
    const a = ADAPTERS.find(x => x.id === id);
    if (!a) throw new Error(`알 수 없는 Adapter: ${id}`);
    if (!a.matches(new URL(url))) throw new Error(`URL 이 ${a.name} 도메인이 아닙니다: ${url}`);
    return a;
  }
  const u = new URL(url);
  const a = ADAPTERS.find(x => x.matches(u));
  if (!a) throw new Error(`지원하지 않는 사이트입니다: ${u.hostname}. 사이트별 Adapter 가 필요합니다.`);
  return a;
}

export function adapterInfo() {
  return ADAPTERS.map(a => ({ id: a.id, name: a.name, hosts: a.hosts, support: a.support }));
}
