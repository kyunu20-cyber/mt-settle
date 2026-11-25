// 모의 예매 사이트 클라이언트 (vanilla JS)
(() => {
  const $ = (s) => document.querySelector(s);
  const won = (n) => n.toLocaleString('ko-KR');
  const api = async (path, opts = {}) => {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let data = null;
    try { data = await res.json(); } catch { /* svg 등 */ }
    return { status: res.status, ok: res.ok, data };
  };
  const goStep = (next) => {
    const map = { event: '/', queue: '/queue.html', captcha: '/captcha.html', seats: '/seats.html', checkout: '/checkout.html' };
    location.href = map[next] || '/';
  };

  async function serverOffset() {
    const t0 = Date.now();
    const { data } = await api('/api/time');
    const t1 = Date.now();
    return data.now - (t0 + t1) / 2;
  }

  const pages = {
    async index() {
      const [{ data: ev }, offset] = await Promise.all([api('/api/event'), serverOffset()]);
      $('#event-title').textContent = ev.title;
      $('#event-venue').textContent = ev.venue;
      $('#open-at').textContent = new Date(ev.openAt).toLocaleString('ko-KR');
      $('#open-at').dataset.openAt = ev.openAt;
      $('#grades').innerHTML = ev.grades.map(g => `<tr><td>${g.section}구역</td><td>${g.grade}석</td><td>${won(g.price)}원</td></tr>`).join('');
      const btn = $('#book-btn');
      const enable = () => { btn.disabled = false; btn.textContent = '예매하기'; btn.dataset.state = 'open'; };
      if (ev.open) enable(); else btn.dataset.state = 'before-open';
      const tick = () => {
        const remain = ev.openAt - (Date.now() + offset);
        if (remain > 0) {
          const s = Math.ceil(remain / 1000);
          $('#countdown').textContent = `오픈까지 ${Math.floor(s / 3600)}시간 ${Math.floor(s / 60) % 60}분 ${s % 60}초`;
        } else {
          $('#countdown').textContent = '예매 진행 중';
          if (btn.disabled) { if (ev.requireReload) $('#reload-hint').hidden = false; else enable(); }
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
      btn.addEventListener('click', () => {
        if (ev.popups.bookingInNewWindow) window.open('/booking.html', 'booking', 'width=1100,height=900');
        else location.href = '/booking.html';
      });
      if (ev.popups.notice && localStorage.getItem('hideNotice') !== new Date().toDateString()) {
        setTimeout(() => { $('#notice-modal').hidden = false; }, ev.popups.noticeDelayMs);
      }
      $('#notice-close').addEventListener('click', () => {
        if ($('#notice-modal input').checked) localStorage.setItem('hideNotice', new Date().toDateString());
        $('#notice-modal').hidden = true;
      });
    },

    async booking() {
      const r = await api('/api/booking/enter', { method: 'POST' });
      if (r.status === 403) { $('#booking-msg').textContent = r.data.error; $('#booking-msg').className = 'error'; return; }
      if (!r.ok) { $('#booking-msg').textContent = r.data?.error || '오류'; return; }
      goStep(r.data.next);
    },

    async queue() {
      const poll = async () => {
        const r = await api('/api/queue/status');
        if (r.ok) {
          if (r.data.position === null) return goStep('event');
          $('#queue-position').textContent = r.data.position;
          $('#queue-bar').style.width = Math.max(5, 100 - r.data.position) + '%';
          if (r.data.passed) return goStep(r.data.next);
        }
        setTimeout(poll, 700);
      };
      poll();
    },

    async captcha() {
      const load = () => { $('#captcha-img').src = '/api/captcha.svg?t=' + Date.now(); $('#captcha-input').value = ''; };
      load();
      $('#captcha-refresh').addEventListener('click', load);
      $('#captcha-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await api('/api/captcha', { method: 'POST', body: { answer: $('#captcha-input').value } });
        if (r.ok) return goStep(r.data.next);
        $('#captcha-error').textContent = r.data?.error || '오류';
        load();
      });
    },

    async seats() {
      const { data: ev } = await api('/api/event');
      const selected = new Set();
      let seatById = new Map(), maxPerOrder = 4;

      const render = (data) => {
        maxPerOrder = data.maxPerOrder;
        seatById = new Map(data.seats.map(s => [s.id, s]));
        for (const id of [...selected]) if (seatById.get(id)?.status !== 'available') selected.delete(id);
        const map = $('#seat-map');
        map.innerHTML = data.sections.map(sec => {
          const rows = [];
          for (let r = 1; r <= sec.rows; r++) {
            const cells = [];
            for (let n = 1; n <= sec.seatsPerRow; n++) {
              const s = seatById.get(`${sec.id}-${r}-${n}`);
              const st = selected.has(s.id) ? 'selected' : s.status;
              cells.push(`<button class="seat ${st}" data-seat-id="${s.id}" data-section="${s.section}" data-row="${s.row}" data-number="${s.number}" data-grade="${s.grade}" data-price="${s.price}" data-status="${s.status}" data-aisle-after="${s.aisleAfter}" aria-pressed="${selected.has(s.id)}" title="${s.section}구역 ${s.row}열 ${s.number}번" ${s.status === 'available' ? '' : 'disabled'}></button>`);
              if (s.aisleAfter) cells.push('<span class="aisle"></span>');
            }
            rows.push(`<div class="seat-row" data-row="${r}"><span class="rowlabel">${r}열</span>${cells.join('')}</div>`);
          }
          return `<div class="section" data-section="${sec.id}"><h3>${sec.id}구역 · ${sec.grade}석 ${won(sec.price)}원</h3>${rows.join('')}</div>`;
        }).join('');
        updateBar();
      };
      const updateBar = () => {
        const list = [...selected].map(id => seatById.get(id));
        $('#selected-count').textContent = list.length;
        $('#selected-list').textContent = list.map(s => `${s.section}-${s.row}열-${s.number}`).join(', ');
        $('#selected-total').textContent = won(list.reduce((a, s) => a + s.price, 0));
        $('#hold-btn').disabled = list.length === 0;
      };
      const refresh = async () => {
        const r = await api('/api/seats');
        if (r.status === 403) return goStep(r.data.next);
        if (r.ok) render(r.data);
      };

      $('#seat-map').addEventListener('click', (e) => {
        const b = e.target.closest('.seat');
        if (!b || b.disabled) return;
        const id = b.dataset.seatId;
        if (selected.has(id)) selected.delete(id);
        else {
          if (selected.size >= maxPerOrder) { alert(`1회 최대 ${maxPerOrder}매까지 선택 가능합니다.`); return; }
          selected.add(id);
        }
        b.classList.toggle('selected', selected.has(id));
        b.setAttribute('aria-pressed', String(selected.has(id)));
        updateBar();
      });

      $('#hold-btn').addEventListener('click', async () => {
        if (ev.popups.confirmOnHold && !confirm(`선택한 ${selected.size}매로 예매를 진행하시겠습니까?`)) return;
        $('#hold-btn').disabled = true;
        const r = await api('/api/hold', { method: 'POST', body: { seatIds: [...selected] } });
        if (r.ok) return goStep('checkout');
        if (r.status === 403) return goStep(r.data.next);
        alert(r.data?.error || '좌석 선점 실패');
        selected.clear();
        await refresh();
      });

      await refresh();
      setInterval(refresh, 1500);
      if (ev.popups.ad) setTimeout(() => { $('#ad-layer').hidden = false; }, ev.popups.adDelayMs ?? 300);
      $('#ad-close').addEventListener('click', () => { $('#ad-layer').hidden = true; });
    },

    async checkout() {
      const r = await api('/api/hold');
      if (!r.ok) { $('#hold-summary').innerHTML = `<p class="error">${r.data?.error}</p><a href="/seats.html">좌석 다시 선택</a>`; $('#pay-btn').disabled = true; return; }
      const h = r.data;
      const offset = h.now - Date.now();
      const sum = $('#hold-summary');
      sum.dataset.holdId = h.id;
      sum.dataset.seatIds = h.seatIds.join(',');
      sum.dataset.total = h.total;
      sum.innerHTML = `<ul>${h.seats.map(s => `<li>${s.section}구역 ${s.row}열 ${s.number}번 (${s.grade}석 ${won(s.price)}원)</li>`).join('')}</ul><p>합계 <strong>${won(h.total)}원</strong></p>`;
      const tick = () => {
        const remain = Math.max(0, h.expiresAt - (Date.now() + offset));
        $('#hold-timer').textContent = `${Math.floor(remain / 60000)}:${String(Math.floor(remain / 1000) % 60).padStart(2, '0')}`;
        if (remain > 0) setTimeout(tick, 500);
      };
      tick();
      $('#pay-btn').addEventListener('click', async () => {
        if (!$('#agree').checked) { $('#pay-error').textContent = '약관에 동의해 주세요.'; return; }
        const p = await api('/api/pay', { method: 'POST', body: { agree: true } });
        if (p.ok) location.href = '/done.html?order=' + p.data.orderId;
        else $('#pay-error').textContent = p.data?.error || '결제 실패';
      });
      $('#cancel-btn').addEventListener('click', async () => {
        if (!confirm('예매를 취소하고 좌석을 반환하시겠습니까?')) return;
        await api('/api/release', { method: 'POST' });
        location.href = '/seats.html';
      });
    },

    async done() {
      const id = new URLSearchParams(location.search).get('order');
      const r = await api('/api/order/' + encodeURIComponent(id));
      if (!r.ok) { $('#order-id').textContent = '조회 실패'; return; }
      $('#order-id').textContent = r.data.orderId;
      $('#order-detail').textContent = `${r.data.seatIds.join(', ')} · ${won(r.data.total)}원`;
    },
  };

  const run = pages[document.body.dataset.page];
  if (run) run().catch(err => console.error(err));
})();
