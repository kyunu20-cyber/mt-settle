export type Route =
  | { mode: 'local' }
  | { mode: 'edit'; id: string; token: string }
  | { mode: 'view'; id: string }

export function parseRoute(): Route {
  const h = location.hash.replace(/^#/, '')
  const edit = h.match(/^\/b\/([^/]+)\/edit\/([^/]+)$/)
  if (edit) return { mode: 'edit', id: edit[1], token: edit[2] }
  const view = h.match(/^\/b\/([^/]+)$/)
  if (view) return { mode: 'view', id: view[1] }
  return { mode: 'local' }
}

export const editHash = (id: string, token: string) => `#/b/${id}/edit/${token}`
export const viewHash = (id: string) => `#/b/${id}`

export const viewUrl = (id: string) =>
  `${location.origin}${location.pathname}${viewHash(id)}`
