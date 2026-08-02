export type Route =
  | { mode: 'local' }
  | { mode: 'edit'; code: string; token: string }
  | { mode: 'view'; code: string }

export function parseRoute(): Route {
  const parts = location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
  if (parts.length >= 2) return { mode: 'edit', code: parts[0], token: parts[1] }
  if (parts.length === 1) return { mode: 'view', code: parts[0] }
  return { mode: 'local' }
}

export const editHash = (code: string, token: string) => `#/${code}/${token}`
export const viewHash = (code: string) => `#/${code}`

export const viewUrl = (code: string) =>
  `${location.origin}${location.pathname}${viewHash(code)}`

export const editUrl = (code: string, token: string) =>
  `${location.origin}${location.pathname}${editHash(code, token)}`
