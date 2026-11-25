'use client';
import { useState } from 'react';
import { mockApi } from '../api';

export default function MockLogin() {
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 모의 로그인: 비밀번호는 서버로 보내지도, 저장하지도 않는다.
    await mockApi('login', { user: id });
    setPw('');
    location.href = new URLSearchParams(location.search).get('next') || '/mock';
  };
  return (
    <main className="mx-auto max-w-sm p-6" data-mock-stage="login">
      <h1 className="text-xl font-bold">로그인 (모의)</h1>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-2">
        <input id="mock-login-id" value={id} onChange={e => setId(e.target.value)} placeholder="아이디" className="rounded border p-2" />
        <input id="mock-login-pw" type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="비밀번호 (아무 값)" className="rounded border p-2" />
        <button id="mock-login-submit" className="rounded bg-rose-600 py-2 font-bold text-white">로그인</button>
      </form>
    </main>
  );
}
