import { supabase } from './supabase'

// 업로드 전 클라이언트 압축 (최대 1600px, JPEG 0.7) — 실패 시 원본 사용
async function compress(file: File): Promise<{ body: Blob; type: string }> {
  try {
    const img = await createImageBitmap(file)
    const maxDim = 1600
    let { width, height } = img
    if (Math.max(width, height) > maxDim) {
      const scale = maxDim / Math.max(width, height)
      width = Math.round(width * scale)
      height = Math.round(height * scale)
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no ctx')
    ctx.drawImage(img, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.7),
    )
    if (!blob) throw new Error('no blob')
    return { body: blob, type: 'image/jpeg' }
  } catch {
    return { body: file, type: file.type || 'image/jpeg' }
  }
}

/** 영수증 이미지 업로드 → 공개 URL 반환 */
export async function uploadReceipt(file: File): Promise<string> {
  if (!supabase) throw new Error('cloud disabled')
  const { body, type } = await compress(file)
  const path = `${crypto.randomUUID()}.jpg`
  const { error } = await supabase.storage
    .from('receipts')
    .upload(path, body, { contentType: type, upsert: false })
  if (error) throw error
  return supabase.storage.from('receipts').getPublicUrl(path).data.publicUrl
}
