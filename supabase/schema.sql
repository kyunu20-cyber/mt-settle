-- MT 정산 — Supabase 스키마
-- 사용법: Supabase 대시보드 → SQL Editor → 아래 전체 붙여넣고 Run

create extension if not exists pgcrypto;

-- 정산판 1개 = 1행. data(jsonb)에 참가자·지출 전체를 담음.
create table if not exists public.boards (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'MT 정산',
  data        jsonb not null default '{}'::jsonb,
  edit_token  text not null,                       -- 편집 권한 비밀키
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.boards enable row level security;

-- 읽기: 누구나(참가자 조회). id(랜덤 UUID)를 알아야 의미가 있음.
drop policy if exists boards_select_public on public.boards;
create policy boards_select_public on public.boards for select using (true);

-- 컬럼 권한: anon 키로는 edit_token을 절대 못 읽음 (조회에 안 내려감).
--            insert/update/delete 직접 권한 없음 → 아래 RPC로만 쓰기 가능.
revoke all on public.boards from anon;
grant select (id, title, data, created_at, updated_at) on public.boards to anon;

-- 새 정산판 생성 → 조회용 id + 편집용 token 발급
create or replace function public.create_board(p_title text, p_data jsonb)
returns table (id uuid, edit_token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_token text := encode(gen_random_bytes(16), 'hex');
begin
  insert into public.boards (title, data, edit_token)
  values (coalesce(p_title, 'MT 정산'), coalesce(p_data, '{}'::jsonb), v_token)
  returning boards.id into v_id;
  return query select v_id, v_token;
end;
$$;

-- 저장(수정) → 토큰이 일치할 때만 허용
create or replace function public.save_board(p_id uuid, p_token text, p_title text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.boards
     set title = coalesce(p_title, title),
         data = coalesce(p_data, data),
         updated_at = now()
   where id = p_id and edit_token = p_token;
  if not found then
    raise exception 'invalid token or board not found';
  end if;
end;
$$;

revoke all on function public.create_board(text, jsonb) from public;
revoke all on function public.save_board(uuid, text, text, jsonb) from public;
grant execute on function public.create_board(text, jsonb) to anon;
grant execute on function public.save_board(uuid, text, text, jsonb) to anon;
