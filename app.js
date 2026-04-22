(() => {
  'use strict';

  /* ---------- Service worker (PWA offline) ---------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  /* ---------- Login gate ---------- */
  const PASSWORD = '456899';
  const SESSION_KEY = 'app_session_v1';
  const loginScreen = document.getElementById('loginScreen');
  const loginPass = document.getElementById('loginPass');
  const loginBtn = document.getElementById('loginBtn');
  const loginErr = document.getElementById('loginErr');

  function unlock(){
    sessionStorage.setItem(SESSION_KEY, 'ok');
    loginScreen.classList.add('hidden');
    setTimeout(() => { try { document.getElementById('inpName').focus(); } catch {} }, 200);
  }
  function tryLogin(){
    if (loginPass.value === PASSWORD) {
      unlock();
    } else {
      loginErr.textContent = 'รหัสผ่านไม่ถูกต้อง';
      loginPass.value = '';
      loginPass.focus();
      clearTimeout(tryLogin._t);
      tryLogin._t = setTimeout(() => { loginErr.textContent = ''; }, 2500);
    }
  }
  loginBtn.addEventListener('click', tryLogin);
  loginPass.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

  if (sessionStorage.getItem(SESSION_KEY) === 'ok') {
    loginScreen.classList.add('hidden');
  } else {
    setTimeout(() => loginPass.focus(), 100);
  }

  const STORAGE_KEY = 'buying_records_v1';
  const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const THAI_DAYS = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];

  /* ---------- Local cache (fallback + instant render) ---------- */
  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  function saveLocal(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {}
  }

  /* ---------- Cloud state ---------- */
  let cloudReady = false;
  let db = null;
  let recordsCol = null;
  let cloudCache = null; // latest snapshot from Firestore
  let unsub = null;
  let FB = null; // firebase modules (lazy loaded)

  function loadAll() {
    if (cloudReady && cloudCache) return cloudCache.slice();
    return loadLocal();
  }

  async function addRecord(rec) {
    const localList = loadLocal();
    localList.push(rec);
    saveLocal(localList);
    if (cloudCache) cloudCache = [...cloudCache.filter(r => r.id !== rec.id), rec];
    refreshAll();
    if (cloudReady && recordsCol && FB) {
      try {
        setSyncStatus('syncing');
        await FB.setDoc(FB.doc(recordsCol, rec.id), rec);
      } catch (e) {
        setSyncStatus('offline');
      }
    } else {
      try { bc && bc.postMessage('sync'); } catch {}
    }
  }

  async function deleteRecord(id) {
    const localList = loadLocal().filter(r => r.id !== id);
    saveLocal(localList);
    if (cloudCache) cloudCache = cloudCache.filter(r => r.id !== id);
    refreshAll();
    if (cloudReady && recordsCol && FB) {
      try {
        setSyncStatus('syncing');
        await FB.deleteDoc(FB.doc(recordsCol, id));
      } catch (e) {
        setSyncStatus('offline');
      }
    } else {
      try { bc && bc.postMessage('sync'); } catch {}
    }
  }

  let bc = null;
  try { bc = new BroadcastChannel('buying_records_sync'); bc.onmessage = () => refreshAll(); } catch {}
  window.addEventListener('storage', e => { if (e.key === STORAGE_KEY) refreshAll(); });

  /* ---------- Sync status chip ---------- */
  const syncChip = document.getElementById('syncChip');
  const syncText = document.getElementById('syncText');
  function setSyncStatus(state){
    if (!syncChip) return;
    syncChip.classList.remove('ok','syncing','offline','local');
    syncChip.classList.add(state);
    const labels = { ok:'ซิงก์แล้ว', syncing:'กำลังซิงก์…', offline:'ออฟไลน์', local:'ใช้เครื่องเดียว' };
    syncText.textContent = labels[state] || state;
  }

  /* ---------- Online/offline watch ---------- */
  window.addEventListener('online', () => { if (cloudReady) setSyncStatus('syncing'); });
  window.addEventListener('offline', () => { if (cloudReady) setSyncStatus('offline'); });

  /* ---------- Init Firebase (dynamic import so login still works offline) ---------- */
  async function initCloud(){
    const cfg = window.FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey || String(cfg.apiKey).includes('YOUR_')) {
      setSyncStatus('local');
      return;
    }
    try {
      setSyncStatus('syncing');
      const [appMod, fsMod, authMod] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js'),
        import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js'),
      ]);
      FB = { ...fsMod, ...authMod };
      const app = appMod.initializeApp(cfg);
      db = fsMod.initializeFirestore(app, {
        localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() })
      });
      recordsCol = fsMod.collection(db, 'records');
      const auth = authMod.getAuth(app);
      await authMod.signInAnonymously(auth);
      await new Promise((resolve) => {
        const off = authMod.onAuthStateChanged(auth, user => { if (user) { off(); resolve(); } });
      });
      unsub = fsMod.onSnapshot(recordsCol, { includeMetadataChanges:true }, snap => {
        const list = [];
        snap.forEach(d => list.push(d.data()));
        cloudCache = list;
        saveLocal(list);
        cloudReady = true;
        if (snap.metadata.fromCache || !navigator.onLine) {
          setSyncStatus('offline');
        } else if (snap.metadata.hasPendingWrites) {
          setSyncStatus('syncing');
        } else {
          setSyncStatus('ok');
        }
        refreshAll();
      }, () => setSyncStatus('offline'));
    } catch (e) {
      console.warn('Firebase init failed:', e);
      setSyncStatus('local');
    }
  }

  /* ---------- Date helpers ---------- */
  const pad = n => String(n).padStart(2,'0');
  const toDateKey = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const toMonthKey = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
  const todayKey = () => toDateKey(new Date());
  const thisMonthKey = () => toMonthKey(new Date());
  function yesterdayKey(){ const d = new Date(); d.setDate(d.getDate()-1); return toDateKey(d); }
  function lastMonthKey(){ const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()-1); return toMonthKey(d); }

  function formatDateThai(ds){
    const [y,m,d] = ds.split('-').map(Number);
    const dt = new Date(y, m-1, d);
    return `${THAI_DAYS[dt.getDay()]} ${d} ${THAI_MONTHS[m-1]} ${y+543}`;
  }
  function formatMonthThai(ms){
    const [y,m] = ms.split('-').map(Number);
    return `${THAI_MONTHS[m-1]} ${y+543}`;
  }
  function formatTime(iso){
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const daysInMonth = (y,m) => new Date(y, m, 0).getDate();

  /* ---------- Number helpers ---------- */
  const nf2 = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('th-TH');
  const fmt = n => nf2.format(Number(n) || 0);
  const fmtInt = n => nf0.format(Number(n) || 0);

  /* ---------- Elements ---------- */
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  const navButtons = $$('.nav-tab');
  const views = { input: $('#view-input'), history: $('#view-history'), graph: $('#view-graph') };

  const inpName = $('#inpName'), inpWeight = $('#inpWeight'), inpPrice = $('#inpPrice');
  const calcTotal = $('#calcTotal'), calcFormula = $('#calcFormula');
  const btnSave = $('#btnSave'), saveHint = $('#saveHint');
  const sumCount = $('#sumCount'), sumWeight = $('#sumWeight'), sumMoney = $('#sumMoney');
  const recentList = $('#recentList'), recentCount = $('#recentCount');
  const todayLabel = $('#todayLabel');

  const histDate = $('#histDate'), histSearch = $('#histSearch');
  const hCount = $('#hCount'), hWeight = $('#hWeight'), hMoney = $('#hMoney');
  const histBody = $('#histBody');

  const graphMonth = $('#graphMonth');
  const gMoney = $('#gMoney'), gWeight = $('#gWeight'), gCount = $('#gCount');
  const chartMoney = $('#chartMoney'), chartWeight = $('#chartWeight');

  /* ---------- Tabs ---------- */
  function switchTab(name){
    navButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    Object.entries(views).forEach(([k,v]) => v.classList.toggle('active', k === name));
    if (name === 'history') renderHistory();
    if (name === 'graph') renderGraph();
    if (name === 'input') renderInput();
    // scroll to top when changing tab on mobile
    window.scrollTo({ top:0, behavior:'smooth' });
  }
  navButtons.forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  /* ---------- Input tab ---------- */
  function updateCalc(){
    const w = parseFloat(inpWeight.value) || 0;
    const p = parseFloat(inpPrice.value) || 0;
    const total = w * p;
    calcTotal.innerHTML = `${fmt(total)} <span class="unit">บาท</span>`;
    calcFormula.textContent = `${fmt(w)} กก. × ${fmt(p)} บ.`;
  }
  inpWeight.addEventListener('input', updateCalc);
  inpPrice.addEventListener('input', updateCalc);

  btnSave.addEventListener('click', async () => {
    const name = inpName.value.trim();
    const weight = parseFloat(inpWeight.value);
    const price = parseFloat(inpPrice.value);
    if (!name) return flash(saveHint, 'กรุณากรอกชื่อลูกค้า', true);
    if (!(weight > 0)) return flash(saveHint, 'น้ำหนักต้องมากกว่า 0', true);
    if (!(price > 0)) return flash(saveHint, 'ราคาต้องมากกว่า 0', true);

    const now = new Date();
    const rec = {
      id: `${now.getTime()}_${Math.random().toString(36).slice(2,8)}`,
      name, weight, price,
      total: Math.round(weight * price * 100) / 100,
      ts: now.toISOString(),
      dateKey: toDateKey(now),
      monthKey: toMonthKey(now),
    };
    inpName.value = ''; inpWeight.value = ''; inpPrice.value = '';
    updateCalc();
    inpName.focus();
    toast(`บันทึกแล้ว • ${name} • ${fmt(rec.total)} บาท`, 'ok');
    addRecord(rec);
  });

  // Enter key = move forward / submit
  [inpName, inpWeight, inpPrice].forEach((el, i, arr) => {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (i < arr.length - 1) arr[i+1].focus();
        else btnSave.click();
      }
    });
  });

  function flash(el, text, isErr){
    el.textContent = text;
    el.style.color = isErr ? 'var(--rose)' : 'var(--muted)';
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { el.textContent = ''; }, 2500);
  }

  function renderInput(){
    const key = todayKey();
    const list = loadAll().filter(r => r.dateKey === key);
    const totW = list.reduce((s,r)=>s+r.weight,0);
    const totM = list.reduce((s,r)=>s+r.total,0);
    sumCount.textContent = fmtInt(list.length);
    sumWeight.textContent = fmt(totW);
    sumMoney.textContent = fmt(totM);

    const recent = [...list].sort((a,b)=>b.ts.localeCompare(a.ts)).slice(0,8);
    recentCount.textContent = list.length > recent.length ? `แสดง ${recent.length}/${list.length}` : '';

    if (recent.length === 0) {
      recentList.innerHTML = '<li class="empty">ยังไม่มีรายการวันนี้</li>';
    } else {
      recentList.innerHTML = recent.map(r => `
        <li>
          <div>
            <div class="who">${escapeHtml(r.name)}</div>
            <div class="meta">${formatTime(r.ts)} • ${fmt(r.weight)} กก. × ${fmt(r.price)} บ.</div>
          </div>
          <div class="amount">${fmt(r.total)} บ.</div>
        </li>`).join('');
    }

    todayLabel.textContent = formatDateThai(key);
  }

  /* ---------- History tab ---------- */
  function renderHistory(){
    const key = histDate.value || todayKey();
    if (!histDate.value) histDate.value = key;
    const q = (histSearch.value || '').trim().toLowerCase();

    let list = loadAll().filter(r => r.dateKey === key);
    if (q) list = list.filter(r => r.name.toLowerCase().includes(q));
    list.sort((a,b) => a.ts.localeCompare(b.ts));

    const totW = list.reduce((s,r)=>s+r.weight,0);
    const totM = list.reduce((s,r)=>s+r.total,0);
    hCount.textContent = fmtInt(list.length);
    hWeight.textContent = fmt(totW);
    hMoney.textContent = fmt(totM);

    if (list.length === 0) {
      histBody.innerHTML = `<tr><td colspan="6" class="empty-row">${q ? 'ไม่พบรายการที่ค้นหา' : 'ไม่มีรายการในวันนี้'}</td></tr>`;
      return;
    }
    histBody.innerHTML = list.map(r => `
      <tr>
        <td>${formatTime(r.ts)}</td>
        <td class="name">${escapeHtml(r.name)}</td>
        <td class="num">${fmt(r.weight)}</td>
        <td class="num">${fmt(r.price)}</td>
        <td class="num total">${fmt(r.total)}</td>
        <td class="actions"><button class="del-btn" data-del="${r.id}" title="ลบรายการนี้" aria-label="ลบ">×</button></td>
      </tr>`).join('');

    histBody.querySelectorAll('[data-del]').forEach(b => {
      b.addEventListener('click', () => {
        const rec = loadAll().find(x => x.id === b.dataset.del);
        if (rec) confirmDelete(rec);
      });
    });
  }
  histDate.addEventListener('change', renderHistory);
  histSearch.addEventListener('input', renderHistory);

  // Quick date chips
  $$('[data-quick]').forEach(b => {
    b.addEventListener('click', () => {
      histDate.value = b.dataset.quick === 'yesterday' ? yesterdayKey() : todayKey();
      renderHistory();
    });
  });
  $$('[data-quick-month]').forEach(b => {
    b.addEventListener('click', () => {
      graphMonth.value = b.dataset.quickMonth === 'last' ? lastMonthKey() : thisMonthKey();
      renderGraph();
    });
  });

  /* ---------- Confirm modal ---------- */
  const modal = $('#confirmModal');
  const confirmText = $('#confirmText');
  const confirmOk = $('#confirmOk');
  const confirmCancel = $('#confirmCancel');
  let pendingDelete = null;

  function confirmDelete(rec){
    pendingDelete = rec;
    confirmText.innerHTML = `ลบรายการของ <strong>${escapeHtml(rec.name)}</strong><br/>${fmt(rec.weight)} กก. • ${fmt(rec.total)} บาท`;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden','false');
  }
  function closeModal(){
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden','true');
    pendingDelete = null;
  }
  confirmCancel.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  confirmOk.addEventListener('click', () => {
    if (pendingDelete) {
      deleteRecord(pendingDelete.id);
      toast('ลบรายการแล้ว', 'ok');
      closeModal();
      refreshAll();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('show')) closeModal();
  });

  /* ---------- Export ---------- */
  $('#btnExportDay').addEventListener('click', () => {
    const key = histDate.value || todayKey();
    const list = loadAll().filter(r => r.dateKey === key).sort((a,b)=>a.ts.localeCompare(b.ts));
    if (list.length === 0) return toast('ไม่มีข้อมูลให้ export', 'error');
    exportCSV(list, `รับซื้อ_${key}.csv`);
  });
  $('#btnExportMonth').addEventListener('click', () => {
    const key = histDate.value || todayKey();
    const month = key.slice(0,7);
    const list = loadAll().filter(r => r.monthKey === month).sort((a,b)=>a.ts.localeCompare(b.ts));
    if (list.length === 0) return toast('ไม่มีข้อมูลในเดือนนี้', 'error');
    exportCSV(list, `รับซื้อ_เดือน_${month}.csv`);
  });

  function exportCSV(list, filename){
    const header = ['วันที่','เวลา','ลูกค้า','น้ำหนัก(กก.)','ราคา/กก.(บาท)','ราคารับซื้อ(บาท)'];
    const rows = list.map(r => {
      const d = new Date(r.ts);
      return [toDateKey(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`, r.name, r.weight, r.price, r.total];
    });
    const totW = list.reduce((s,r)=>s+r.weight,0);
    const totM = list.reduce((s,r)=>s+r.total,0);
    rows.push([]);
    rows.push(['','','รวม', totW.toFixed(2), '', totM.toFixed(2)]);

    const csv = [header, ...rows].map(row =>
      row.map(v => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(',')
    ).join('\r\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    toast(`Export แล้ว: ${filename}`, 'ok');
  }

  /* ---------- Graph tab ---------- */
  function renderGraph(){
    const key = graphMonth.value || thisMonthKey();
    if (!graphMonth.value) graphMonth.value = key;
    const [y,m] = key.split('-').map(Number);
    const n = daysInMonth(y,m);
    const moneyByDay = Array(n).fill(0);
    const weightByDay = Array(n).fill(0);
    let recCount = 0;

    loadAll().forEach(r => {
      if (r.monthKey !== key) return;
      recCount++;
      const idx = new Date(r.ts).getDate() - 1;
      moneyByDay[idx] += r.total;
      weightByDay[idx] += r.weight;
    });

    gMoney.textContent = fmt(moneyByDay.reduce((a,b)=>a+b,0));
    gWeight.textContent = fmt(weightByDay.reduce((a,b)=>a+b,0));
    gCount.textContent = fmtInt(recCount);

    drawBarChart(chartMoney, moneyByDay, { gradId:'gradMoney', c1:'#14b8a6', c2:'#0d9488', unit:'บ.' });
    drawBarChart(chartWeight, weightByDay, { gradId:'gradWeight', c1:'#38bdf8', c2:'#0284c7', unit:'กก.' });
  }
  graphMonth.addEventListener('change', renderGraph);

  function drawBarChart(svg, values, opts){
    const W = 900, H = 260;
    const padL = 48, padR = 16, padT = 14, padB = 30;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const n = values.length;
    const max = Math.max(1, ...values);
    const niceMax = niceNumber(max);
    const gap = 3;
    const barW = (innerW - gap*(n-1)) / n;

    const ticks = 5;
    const tickVals = [];
    for (let i=0;i<=ticks;i++) tickVals.push(niceMax * i / ticks);

    let g = `
      <defs>
        <linearGradient id="${opts.gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${opts.c1}"/>
          <stop offset="100%" stop-color="${opts.c2}"/>
        </linearGradient>
      </defs>`;

    for (const tv of tickVals) {
      const y = padT + innerH - (tv/niceMax)*innerH;
      g += `<line class="grid" x1="${padL}" y1="${y}" x2="${padL+innerW}" y2="${y}"/>`;
      g += `<text class="tick" x="${padL-10}" y="${y+3}" text-anchor="end">${shortNum(tv)}</text>`;
    }
    g += `<line class="axis" x1="${padL}" y1="${padT+innerH}" x2="${padL+innerW}" y2="${padT+innerH}"/>`;

    for (let i=0;i<n;i++){
      const v = values[i];
      const h = (v/niceMax)*innerH;
      const x = padL + i*(barW+gap);
      const y = padT + innerH - h;
      if (v > 0) {
        g += `<rect class="bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="url(#${opts.gradId})"><title>วันที่ ${i+1}: ${fmt(v)} ${opts.unit}</title></rect>`;
      }
      const step = n > 20 ? 3 : (n > 10 ? 2 : 1);
      if ((i+1) % step === 0 || i === 0 || i === n-1) {
        g += `<text class="label" x="${x + barW/2}" y="${padT+innerH+16}" text-anchor="middle">${i+1}</text>`;
      }
    }

    svg.innerHTML = g;
  }

  function niceNumber(v){
    if (v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const pow = Math.pow(10, exp);
    const frac = v / pow;
    let nf;
    if (frac <= 1) nf = 1;
    else if (frac <= 2) nf = 2;
    else if (frac <= 5) nf = 5;
    else nf = 10;
    return nf * pow;
  }
  function shortNum(v){
    if (v >= 1e6) return (v/1e6).toFixed(1).replace(/\.0$/,'')+'M';
    if (v >= 1e3) return (v/1e3).toFixed(1).replace(/\.0$/,'')+'k';
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(1);
  }

  /* ---------- Toast ---------- */
  const toastEl = $('#toast');
  let toastTimer = null;
  function toast(msg, kind){
    toastEl.className = 'toast show' + (kind ? ' '+kind : '');
    toastEl.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.className = 'toast' + (kind ? ' '+kind : '');
    }, 2400);
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function refreshAll(){
    renderInput();
    if (views.history.classList.contains('active')) renderHistory();
    if (views.graph.classList.contains('active')) renderGraph();
  }

  /* ---------- Init ---------- */
  function init(){
    histDate.value = todayKey();
    graphMonth.value = thisMonthKey();
    updateCalc();
    setSyncStatus('local');
    renderInput();
    setTimeout(() => inpName.focus(), 200);
    initCloud();
  }
  init();
})();
