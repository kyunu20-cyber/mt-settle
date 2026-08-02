export const won = (n: number) => `${(n || 0).toLocaleString('ko-KR')}원`

export const newId = () => crypto.randomUUID()
