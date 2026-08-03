import { supabase } from './supabase'
import type { Board } from '../types'

/** 새 보드 생성 → 조회용 id + 편집용 token 반환 */
export async function createBoard(
  board: Board,
): Promise<{ id: string; token: string }> {
  if (!supabase) throw new Error('cloud disabled')
  const { data, error } = await supabase.rpc('create_board', {
    p_title: board.title,
    p_data: board,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return { id: row.id, token: row.edit_token }
}

/** 토큰이 맞을 때만 저장(수정) */
export async function saveBoard(
  id: string,
  token: string,
  board: Board,
): Promise<void> {
  if (!supabase) throw new Error('cloud disabled')
  const { error } = await supabase.rpc('save_board', {
    p_id: id,
    p_token: token,
    p_title: board.title,
    p_data: board,
  })
  if (error) throw error
}

/** 조회 (읽기전용) — edit_token은 컬럼 권한으로 애초에 안 내려옴 */
export async function fetchBoard(id: string): Promise<Board | null> {
  if (!supabase) throw new Error('cloud disabled')
  const { data, error } = await supabase
    .from('boards')
    .select('data')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return data.data as Board
}
