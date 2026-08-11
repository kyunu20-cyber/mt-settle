-- MT 정산 — 영수증 이미지 저장용 Storage 설정
-- 사용법: Supabase 대시보드 → SQL Editor → 붙여넣고 Run

-- 영수증 버킷 (공개 읽기, 이미지 5MB 제한)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

-- 업로드 허용 (anon)
drop policy if exists "receipts_anon_insert" on storage.objects;
create policy "receipts_anon_insert" on storage.objects
  for insert to anon with check (bucket_id = 'receipts');

-- 읽기 허용 (공개)
drop policy if exists "receipts_public_select" on storage.objects;
create policy "receipts_public_select" on storage.objects
  for select to anon using (bucket_id = 'receipts');
