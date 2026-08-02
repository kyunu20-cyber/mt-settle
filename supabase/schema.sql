-- MT 정산 — Supabase 스키마
-- 사용법: Supabase 대시보드 → SQL Editor → 아래 전체 붙여넣고 Run

-- 정산판 1개 = 1행. data(jsonb)에 참가자·지출 전체를 담음.
create table if not exists public.boards (
  id          uuid primary key default gen_random_uuid(),
  code        text unique,                          -- 짧은 공유 코드(6자)
  title       text not null default 'MT 정산',
  data        jsonb not null default '{}'::jsonb,
  edit_token  text not null,                        -- 편집 권한 비밀키
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.boards add column if not exists code text unique;

alter table public.boards enable row level security;

-- 읽기: 누구나(참가자 조회). code(랜덤)를 알아야 의미가 있음.
drop policy if exists boards_select_public on public.boards;
create policy boards_select_public on public.boards for select using (true);

-- 컬럼 권한: anon 키로는 edit_token을 절대 못 읽음.
--            insert/update/delete 직접 권한 없음 → 아래 RPC로만 쓰기 가능.
revoke all on public.boards from anon;
grant select (id, code, title, data, created_at, updated_at) on public.boards to anon;

-- 새 정산판 생성 → 짧은 code + 편집용 token 발급
drop function if exists public.create_board(text, jsonb);
create function public.create_board(p_title text, p_data jsonb)
returns table (code text, edit_token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code  text;
  v_token text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  v_alpha text := 'abcdefghijkmnpqrstuvwxyz23456789'; -- 헷갈리는 0,o,1,l 제외
  i int;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    end loop;
    exit when not exists (select 1 from public.boards where code = v_code);
  end loop;
  insert into public.boards (title, data, edit_token, code)
  values (coalesce(p_title, 'MT 정산'), coalesce(p_data, '{}'::jsonb), v_token, v_code);
  return query select v_code, v_token;
end;
$$;

-- 저장(수정) → code + 토큰이 일치할 때만 허용
drop function if exists public.save_board(uuid, text, text, jsonb);
drop function if exists public.save_board(text, text, text, jsonb);
create function public.save_board(p_code text, p_token text, p_title text, p_data jsonb)
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
   where code = p_code and edit_token = p_token;
  if not found then
    raise exception 'invalid token or board not found';
  end if;
end;
$$;

grant execute on function public.create_board(text, jsonb) to anon;
grant execute on function public.save_board(text, text, text, jsonb) to anon;
