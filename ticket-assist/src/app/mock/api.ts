export async function mockApi<T = Record<string, unknown>>(path: string, body?: unknown): Promise<{ status: number; ok: boolean; data: T }> {
  const res = await fetch('/api/mock/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, ok: res.ok, data };
}
export const won = (n: number) => n.toLocaleString('ko-KR');
