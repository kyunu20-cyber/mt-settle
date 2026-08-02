# MT 정산

MT·모임 정산 웹. 관리자가 지출·회비를 입력하면 **1인당 금액**과 **회비 납부 현황**을 자동으로 정리하고, 참가자는 **링크로 결과만 조회**한다.

## 기능

- 지출 항목 입력(이름·금액·결제자·링크) → 총합·1인당 자동 계산
- 참가자별 회비 납부/미납 체크 → 걷힌 금액·미납자 정리
- 관리자 편집 링크 / 참가자 조회 링크 분리 (조회는 읽기전용)

## 스택

- React + Vite + TypeScript
- Supabase (Postgres) — 정산판 저장·공유
- 배포: Vercel

## 로컬 실행

```bash
npm install
cp .env.example .env.local   # Supabase URL·anon key 입력
npm run dev
```

## Supabase 준비

`supabase/schema.sql`을 Supabase 대시보드 → SQL Editor에 붙여넣고 Run.
테이블 `boards` + 함수 `create_board`/`save_board` + RLS가 생성된다.

## 환경변수

| 이름 | 설명 |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase Project URL |
| `VITE_SUPABASE_ANON_KEY` | anon public key (공개 가능, 쓰기는 RLS·토큰으로 보호) |

## 라우팅 (해시 기반)

- `#/` — 관리자 새 정산판(로컬 임시 저장) → "클라우드에 올려 공유"
- `#/b/<id>/edit/<token>` — 관리자 편집(클라우드 저장)
- `#/b/<id>` — 참가자 조회(읽기전용)
