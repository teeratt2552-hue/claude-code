(() => {
  'use strict';

  /* ---------- Service worker (PWA offline) ---------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  /* ---------- Login gate ---------- */
  const DEFAULT_PASSWORD = '456899';
  const PASSWORD_KEY = 'app_password_v1';
  const SESSION_KEY = 'app_session_v1';
  const loginScreen = document.getElementById('loginScreen');
  const loginPass = document.getElementById('loginPass');
  const loginBtn = document.getElementById('loginBtn');
  const loginErr = document.getElementById('loginErr');

  function getPassword(){
    return localStorage.getItem(PASSWORD_KEY) || DEFAULT_PASSWORD;
  }
  function savePasswordLocal(pw){
    localStorage.setItem(PASSWORD_KEY, pw);
  }

  // Resolved on first cloud password snapshot (or never if cloud not configured)
  let passwordSynced = false;
  let waitForPwSync = null;
  function newPwSyncWaiter(){
    waitForPwSync = new Promise(resolve => { waitForPwSync._resolve = resolve; });
  }
  newPwSyncWaiter();

  function unlock(){
    sessionStorage.setItem(SESSION_KEY, 'ok');
    loginScreen.classList.add('hidden');
    setTimeout(() => { try { document.getElementById('inpName').focus(); } catch {} }, 200);
  }

  async function tryLogin(){
    const entered = loginPass.value;
    if (entered === getPassword()) { unlock(); return; }

    // If cloud is configured but password hasn't synced yet, wait briefly and retry once.
    const cfg = window.FIREBASE_CONFIG;
    const cloudConfigured = cfg && cfg.apiKey && !String(cfg.apiKey).includes('YOUR_');
    if (cloudConfigured && !passwordSynced) {
      loginErr.style.color = 'var(--muted)';
      loginErr.textContent = 'กำลังเชื่อมต่อ...';
      await Promise.race([waitForPwSync, new Promise(r => setTimeout(r, 4000))]);
      if (entered === getPassword()) { loginErr.textContent = ''; unlock(); return; }
    }

    loginErr.style.color = '';
    loginErr.textContent = 'รหัสผ่านไม่ถูกต้อง';
    loginPass.value = '';
    loginPass.focus();
    clearTimeout(tryLogin._t);
    tryLogin._t = setTimeout(() => { loginErr.textContent = ''; }, 2500);
  }
  loginBtn.addEventListener('click', tryLogin);
  loginPass.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

  if (sessionStorage.getItem(SESSION_KEY) === 'ok') {
    loginScreen.classList.add('hidden');
  } else {
    setTimeout(() => loginPass.focus(), 100);
  }

  const STORAGE_KEY = 'buying_records_v1';
  const SALES_KEY = 'sales_records_v1';
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

  /* ---------- Local cache: sales ---------- */
  function loadSalesLocal(){
    try {
      const raw = localStorage.getItem(SALES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  function saveSalesLocal(list){
    try { localStorage.setItem(SALES_KEY, JSON.stringify(list)); } catch {}
  }

  /* ---------- Cloud state ---------- */
  let cloudReady = false;
  let db = null;
  let recordsCol = null;
  let salesCol = null;
  let cloudCache = null; // latest snapshot from Firestore (records)
  let cloudSalesCache = null; // latest snapshot from Firestore (sales)
  let unsub = null;
  let unsubSales = null;
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

  /* ---------- Sales CRUD ---------- */
  function loadAllSales(){
    if (cloudReady && cloudSalesCache) return cloudSalesCache.slice();
    return loadSalesLocal();
  }
  async function addSale(rec){
    const list = loadSalesLocal();
    list.push(rec);
    saveSalesLocal(list);
    if (cloudSalesCache) cloudSalesCache = [...cloudSalesCache.filter(r => r.id !== rec.id), rec];
    refreshAll();
    if (cloudReady && salesCol && FB) {
      try {
        setSyncStatus('syncing');
        await FB.setDoc(FB.doc(salesCol, rec.id), rec);
      } catch (e) { setSyncStatus('offline'); }
    } else {
      try { bc && bc.postMessage('sync'); } catch {}
    }
  }
  async function deleteSale(id){
    saveSalesLocal(loadSalesLocal().filter(r => r.id !== id));
    if (cloudSalesCache) cloudSalesCache = cloudSalesCache.filter(r => r.id !== id);
    refreshAll();
    if (cloudReady && salesCol && FB) {
      try {
        setSyncStatus('syncing');
        await FB.deleteDoc(FB.doc(salesCol, id));
      } catch (e) { setSyncStatus('offline'); }
    } else {
      try { bc && bc.postMessage('sync'); } catch {}
    }
  }

  let bc = null;
  try { bc = new BroadcastChannel('buying_records_sync'); bc.onmessage = () => refreshAll(); } catch {}
  window.addEventListener('storage', e => { if (e.key === STORAGE_KEY || e.key === SALES_KEY) refreshAll(); });

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

  async function changePassword(newPw){
    savePasswordLocal(newPw);
    if (cloudReady && db && FB) {
      try {
        await FB.setDoc(FB.doc(db, 'meta', 'auth'), { password: newPw, updatedAt: new Date().toISOString() });
      } catch (e) {
        console.warn('Password cloud sync failed:', e);
      }
    }
  }

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
      salesCol = fsMod.collection(db, 'sales');
      const auth = authMod.getAuth(app);
      await authMod.signInAnonymously(auth);
      await new Promise((resolve) => {
        const off = authMod.onAuthStateChanged(auth, user => { if (user) { off(); resolve(); } });
      });

      // subscribe to shared password (doc: meta/auth)
      const metaRef = fsMod.doc(db, 'meta', 'auth');
      fsMod.onSnapshot(metaRef, snap => {
        if (snap.exists()) {
          const data = snap.data();
          if (data && typeof data.password === 'string' && data.password.length > 0) {
            savePasswordLocal(data.password);
          }
        }
        passwordSynced = true;
        if (waitForPwSync && waitForPwSync._resolve) waitForPwSync._resolve();
      }, () => {
        passwordSynced = true;
        if (waitForPwSync && waitForPwSync._resolve) waitForPwSync._resolve();
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

      unsubSales = fsMod.onSnapshot(salesCol, { includeMetadataChanges:true }, snap => {
        const list = [];
        snap.forEach(d => list.push(d.data()));
        cloudSalesCache = list;
        saveSalesLocal(list);
        refreshAll();
      }, err => {
        console.warn('Sales sync error:', err);
        setSyncStatus('offline');
      });
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

  // Week helpers (Monday-start week)
  function weekStart(date){
    const d = new Date(date);
    d.setHours(0,0,0,0);
    const day = d.getDay(); // 0=Sun, 1=Mon...
    const offset = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + offset);
    return d;
  }
  function weekEnd(date){
    const s = weekStart(date);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    e.setHours(23,59,59,999);
    return e;
  }
  function thisWeekDateKey(){ return toDateKey(new Date()); }
  function lastWeekDateKey(){ const d = new Date(); d.setDate(d.getDate()-7); return toDateKey(d); }
  function formatWeekRangeThai(date){
    const s = weekStart(date), e = weekEnd(date);
    const sameMonth = s.getMonth() === e.getMonth();
    if (sameMonth) {
      return `${s.getDate()}–${e.getDate()} ${THAI_MONTHS[s.getMonth()]} ${s.getFullYear()+543}`;
    }
    return `${s.getDate()} ${THAI_MONTHS[s.getMonth()]} – ${e.getDate()} ${THAI_MONTHS[e.getMonth()]} ${e.getFullYear()+543}`;
  }

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
  // ตัดทศนิยมตัวที่ 3 ทิ้ง → เก็บ 2 ตำแหน่ง (truncate, ไม่ปัด)
  function trunc2(n){
    const x = Number(n) || 0;
    const neg = x < 0;
    const abs = Math.abs(x);
    const str = abs.toFixed(10);
    const [intStr, decStr = ''] = str.split('.');
    const first2 = (decStr + '00').slice(0, 2);
    const result = parseFloat(intStr + '.' + first2);
    return neg ? -result : result;
  }
  // ปัดเป็นจำนวนเต็ม: ตัวที่ 1 ≥5 ปัดขึ้น, <5 ปัดลง (ตัวที่ 2+ ตัดทิ้ง)
  function roundInt(n){
    const x = Number(n) || 0;
    const neg = x < 0;
    const abs = Math.abs(x);
    const str = abs.toFixed(10);
    const [intStr, decStr = ''] = str.split('.');
    const d1 = parseInt(decStr[0] || '0', 10);
    let intNum = parseInt(intStr, 10);
    if (d1 >= 5) intNum++;
    return neg ? -intNum : intNum;
  }
  const nf2 = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('th-TH');
  const fmt = n => nf2.format(trunc2(n));
  const fmtInt = n => nf0.format(Number(n) || 0);

  /* ---------- Elements ---------- */
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  const navButtons = $$('.nav-tab');
  const views = { input: $('#view-input'), history: $('#view-history'), graph: $('#view-graph'), sell: $('#view-sell') };

  const inpName = $('#inpName'), inpWeight = $('#inpWeight'), inpPrice = $('#inpPrice');
  const calcTotal = $('#calcTotal'), calcFormula = $('#calcFormula');
  const btnSave = $('#btnSave'), saveHint = $('#saveHint');
  const sumCount = $('#sumCount'), sumWeight = $('#sumWeight'), sumMoney = $('#sumMoney');
  const recentList = $('#recentList'), recentCount = $('#recentCount');
  const todayLabel = $('#todayLabel');

  const histDate = $('#histDate'), histSearch = $('#histSearch');
  const hCount = $('#hCount'), hWeight = $('#hWeight'), hMoney = $('#hMoney');
  const histBody = $('#histBody');
  const histSellBody = $('#histSellBody');
  const histBuyStats = $('#histBuyStats'), histSellStats = $('#histSellStats');
  const histBuyCard = $('#histBuyCard'), histSellCard = $('#histSellCard');
  const histSearchField = $('#histSearchField');
  const hSellCount = $('#hSellCount'), hSellGwt = $('#hSellGwt'), hSellAmount = $('#hSellAmount');
  let histMode = 'buy'; // 'buy' | 'sell'

  const graphMonth = $('#graphMonth');
  const graphWeekDate = $('#graphWeekDate');
  const fieldGraphMonth = $('#fieldGraphMonth'), fieldGraphWeek = $('#fieldGraphWeek');
  const monthChips = $('#monthChips'), weekChips = $('#weekChips');
  const gMoney = $('#gMoney'), gWeight = $('#gWeight'), gCount = $('#gCount');
  const gSales = $('#gSales'), gCost = $('#gCost'), gProfit = $('#gProfit'), gProfitCard = $('#gProfitCard');
  const chartMoney = $('#chartMoney'), chartWeight = $('#chartWeight'), chartProfit = $('#chartProfit');
  const chartMoneyTitle = $('#chartMoneyTitle'), chartWeightTitle = $('#chartWeightTitle');
  let graphPeriod = 'month'; // 'week' | 'month'

  // Sell tab elements
  const sellDate = $('#sellDate'), sellGwt = $('#sellGwt'), sellDrc = $('#sellDrc');
  const sellContr = $('#sellContr');
  const sellNwt = $('#sellNwt'), sellNetPri = $('#sellNetPri');
  const sellAmount = $('#sellAmount'), sellFormula = $('#sellFormula');
  const btnSellSave = $('#btnSellSave'), sellHint = $('#sellHint');
  const sellRecentList = $('#sellRecentList'), sellRecentCount = $('#sellRecentCount');

  /* ---------- Tabs ---------- */
  function switchTab(name){
    navButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    Object.entries(views).forEach(([k,v]) => v.classList.toggle('active', k === name));
    if (name === 'history') renderHistory();
    if (name === 'graph') renderGraph();
    if (name === 'input') renderInput();
    if (name === 'sell') renderSales();
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
  function applyHistMode(){
    const isBuy = histMode === 'buy';
    histBuyStats.hidden = !isBuy;
    histSellStats.hidden = isBuy;
    histBuyCard.hidden = !isBuy;
    histSellCard.hidden = isBuy;
    if (histSearchField) histSearchField.hidden = !isBuy;
    $$('[data-hist-mode]').forEach(b => b.classList.toggle('active', b.dataset.histMode === histMode));
  }

  function renderHistory(){
    applyHistMode();
    const key = histDate.value || todayKey();
    if (!histDate.value) histDate.value = key;

    if (histMode === 'buy') renderHistoryBuy(key);
    else renderHistorySell(key);
  }

  function renderHistoryBuy(key){
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

  function renderHistorySell(key){
    let list = loadAllSales().filter(r => r.dateKey === key);
    list.sort((a,b) => (a.ts||'').localeCompare(b.ts||''));

    const totGwt = list.reduce((s,r)=>s+(r.gwt||0),0);
    const totAmt = list.reduce((s,r)=>s+(r.amount||0),0);
    hSellCount.textContent = fmtInt(list.length);
    hSellGwt.textContent = fmt(totGwt);
    hSellAmount.textContent = fmt(totAmt);

    if (list.length === 0) {
      histSellBody.innerHTML = `<tr><td colspan="7" class="empty-row">ไม่มีรายการขายในวันนี้</td></tr>`;
      return;
    }
    histSellBody.innerHTML = list.map(r => `
      <tr>
        <td>${formatDateThai(r.date)}</td>
        <td class="num">${fmt(r.gwt)}</td>
        <td class="num">${fmt(r.drc)}</td>
        <td class="num">${nf2.format(r.nwt)}</td>
        <td class="num">${nf2.format(r.netPri)}</td>
        <td class="num total">${nf2.format(r.amount)}</td>
        <td class="actions"><button class="del-btn" data-del="${r.id}" title="ลบรายการนี้" aria-label="ลบ">×</button></td>
      </tr>`).join('');

    histSellBody.querySelectorAll('[data-del]').forEach(b => {
      b.addEventListener('click', () => {
        const rec = loadAllSales().find(x => x.id === b.dataset.del);
        if (rec) confirmDeleteSale(rec);
      });
    });
  }

  $$('[data-hist-mode]').forEach(b => {
    b.addEventListener('click', () => {
      histMode = b.dataset.histMode;
      renderHistory();
      b.blur();
    });
  });

  // Sync the selected date across history + graph views so changing the date
  // updates everything immediately.
  function syncActiveDate(dateKey){
    if (!dateKey) return;
    if (histDate.value !== dateKey) histDate.value = dateKey;
    const monthKey = dateKey.slice(0,7);
    if (graphMonth.value !== monthKey) graphMonth.value = monthKey;
    if (graphWeekDate.value !== dateKey) graphWeekDate.value = dateKey;
    renderHistory();
    if (views.graph && views.graph.classList.contains('active')) renderGraph();
  }

  histDate.addEventListener('change', () => syncActiveDate(histDate.value || todayKey()));
  histSearch.addEventListener('input', renderHistory);

  // Quick date chips
  $$('[data-quick]').forEach(b => {
    b.addEventListener('click', () => {
      syncActiveDate(b.dataset.quick === 'yesterday' ? yesterdayKey() : todayKey());
    });
  });
  $$('[data-quick-month]').forEach(b => {
    b.addEventListener('click', () => {
      graphMonth.value = b.dataset.quickMonth === 'last' ? lastMonthKey() : thisMonthKey();
      // Also move histDate to the 1st of that month so history reflects the pick
      const firstOfMonth = `${graphMonth.value}-01`;
      histDate.value = firstOfMonth;
      graphWeekDate.value = firstOfMonth;
      renderGraph();
      if (views.history && views.history.classList.contains('active')) renderHistory();
    });
  });

  /* ---------- Confirm modal ---------- */
  const modal = $('#confirmModal');
  const confirmText = $('#confirmText');
  const confirmOk = $('#confirmOk');
  const confirmCancel = $('#confirmCancel');
  let pendingDelete = null;

  function confirmDelete(rec){
    pendingDelete = { kind:'record', rec };
    confirmText.innerHTML = `ลบรายการของ <strong>${escapeHtml(rec.name)}</strong><br/>${fmt(rec.weight)} กก. • ${fmt(rec.total)} บาท`;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden','false');
  }
  function confirmDeleteSale(rec){
    pendingDelete = { kind:'sale', rec };
    confirmText.innerHTML = `ลบรายการขาย<br/>${formatDateThai(rec.date)} • ${nf2.format(rec.amount)} บาท`;
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
    if (!pendingDelete) return;
    if (pendingDelete.kind === 'sale') deleteSale(pendingDelete.rec.id);
    else deleteRecord(pendingDelete.rec.id);
    toast('ลบรายการแล้ว', 'ok');
    closeModal();
    refreshAll();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('show')) closeModal();
  });

  /* ---------- Export ---------- */
  $('#btnExportDay').addEventListener('click', () => {
    const key = histDate.value || todayKey();
    const buys = loadAll().filter(r => r.dateKey === key).sort((a,b)=>a.ts.localeCompare(b.ts));
    const sells = loadAllSales().filter(r => r.dateKey === key).sort((a,b)=>(a.ts||'').localeCompare(b.ts||''));
    if (buys.length === 0 && sells.length === 0) return toast('ไม่มีข้อมูลให้ export', 'error');
    exportCSV(buys, sells, `สรุป_${key}.csv`, `วันที่ ${formatDateThai(key)}`);
  });
  $('#btnExportWeek').addEventListener('click', () => {
    const key = histDate.value || todayKey();
    const [y,m,d] = key.split('-').map(Number);
    const base = new Date(y, m-1, d);
    const s = weekStart(base), e = weekEnd(base);
    const sKey = toDateKey(s), eKey = toDateKey(e);
    const inRange = r => { const rd = new Date(r.ts); return rd >= s && rd <= e; };
    const buys = loadAll().filter(inRange).sort((a,b)=>a.ts.localeCompare(b.ts));
    const sells = loadAllSales().filter(r => r.dateKey >= sKey && r.dateKey <= eKey).sort((a,b)=>(a.ts||'').localeCompare(b.ts||''));
    if (buys.length === 0 && sells.length === 0) return toast('ไม่มีข้อมูลในสัปดาห์นี้', 'error');
    exportCSV(buys, sells, `สรุป_สัปดาห์_${sKey}.csv`, `สัปดาห์ ${formatDateThai(sKey)} ถึง ${formatDateThai(eKey)}`);
  });
  $('#btnExportMonth').addEventListener('click', () => {
    const key = histDate.value || todayKey();
    const month = key.slice(0,7);
    const buys = loadAll().filter(r => r.monthKey === month).sort((a,b)=>a.ts.localeCompare(b.ts));
    const sells = loadAllSales().filter(r => r.monthKey === month).sort((a,b)=>(a.ts||'').localeCompare(b.ts||''));
    if (buys.length === 0 && sells.length === 0) return toast('ไม่มีข้อมูลในเดือนนี้', 'error');
    exportCSV(buys, sells, `สรุป_เดือน_${month}.csv`, `เดือน ${month}`);
  });

  function exportCSV(buys, sells, filename, periodLabel){
    const rows = [];
    rows.push([`สรุปรายการ ${periodLabel || ''}`]);
    rows.push([]);

    rows.push(['[ รายการซื้อ ]']);
    rows.push(['วันที่','เวลา','ลูกค้า','น้ำหนัก(กก.)','ราคา/กก.(บาท)','ราคารับซื้อ(บาท)']);
    buys.forEach(r => {
      const d = new Date(r.ts);
      rows.push([toDateKey(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`, r.name, r.weight, r.price, r.total]);
    });
    const totW = buys.reduce((s,r)=>s+r.weight,0);
    const totCost = buys.reduce((s,r)=>s+r.total,0);
    rows.push(['','','รวม', trunc2(totW).toFixed(2), '', trunc2(totCost).toFixed(2)]);
    rows.push([]);

    rows.push(['[ รายการขาย ]']);
    rows.push(['วันที่','GWT(กก.)','DRC(%)','NWT(กก.)','Contr.Pri','Net Pri','Amount(บาท)']);
    sells.forEach(r => {
      rows.push([r.date, r.gwt, r.drc, r.nwt, r.contrPri, r.netPri, r.amount]);
    });
    const totGwt = sells.reduce((s,r)=>s+(r.gwt||0),0);
    const totSales = sells.reduce((s,r)=>s+(r.amount||0),0);
    rows.push(['รวม', trunc2(totGwt).toFixed(2), '', '', '', '', trunc2(totSales).toFixed(2)]);
    rows.push([]);

    const profit = totSales - totCost;
    rows.push(['[ สรุปกำไร/ขาดทุน ]']);
    rows.push(['ยอดขายรวม', trunc2(totSales).toFixed(2), 'บาท']);
    rows.push(['ต้นทุน (ยอดซื้อรวม)', trunc2(totCost).toFixed(2), 'บาท']);
    rows.push([profit >= 0 ? 'กำไรสุทธิ' : 'ขาดทุนสุทธิ', trunc2(profit).toFixed(2), 'บาท']);

    const csv = rows.map(row =>
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
  function applyGraphPeriod(){
    const isWeek = graphPeriod === 'week';
    fieldGraphWeek.hidden = !isWeek;
    fieldGraphMonth.hidden = isWeek;
    weekChips.hidden = !isWeek;
    monthChips.hidden = isWeek;
    $$('[data-period]').forEach(b => b.classList.toggle('active', b.dataset.period === graphPeriod));
  }

  function renderGraph(){
    applyGraphPeriod();
    const all = loadAll();
    const sales = loadAllSales();

    if (graphPeriod === 'week') {
      const dateStr = graphWeekDate.value || thisWeekDateKey();
      if (!graphWeekDate.value) graphWeekDate.value = dateStr;
      const [y,m,d] = dateStr.split('-').map(Number);
      const base = new Date(y, m-1, d);
      const start = weekStart(base);
      const moneyByDay = Array(7).fill(0);
      const weightByDay = Array(7).fill(0);
      const salesByDay = Array(7).fill(0);
      const labels = ['จ','อ','พ','พฤ','ศ','ส','อา'];
      const dateLabels = [];
      for (let i=0;i<7;i++){
        const di = new Date(start); di.setDate(start.getDate()+i);
        dateLabels.push(toDateKey(di));
      }
      let recCount = 0;
      all.forEach(r => {
        const idx = dateLabels.indexOf(r.dateKey);
        if (idx === -1) return;
        recCount++;
        moneyByDay[idx] += r.total;
        weightByDay[idx] += r.weight;
      });
      sales.forEach(s => {
        const idx = dateLabels.indexOf(s.dateKey);
        if (idx === -1) return;
        salesByDay[idx] += s.amount;
      });
      const profitByDay = salesByDay.map((s,i) => s - moneyByDay[i]);
      const totalCost = moneyByDay.reduce((a,b)=>a+b,0);
      const totalSales = salesByDay.reduce((a,b)=>a+b,0);
      const totalProfit = totalSales - totalCost;
      gMoney.textContent = fmt(totalCost);
      gWeight.textContent = fmt(weightByDay.reduce((a,b)=>a+b,0));
      gCount.textContent = fmtInt(recCount);
      updateProfitStats(totalSales, totalCost, totalProfit);
      drawBarChart(chartMoney, moneyByDay, { gradId:'gradMoney', c1:'#14b8a6', c2:'#0d9488', unit:'บ.', labels, everyLabel:true });
      drawBarChart(chartWeight, weightByDay, { gradId:'gradWeight', c1:'#38bdf8', c2:'#0284c7', unit:'กก.', labels, everyLabel:true });
      drawProfitChart(chartProfit, profitByDay, { unit:'บ.', labels, everyLabel:true });
    } else {
      const key = graphMonth.value || thisMonthKey();
      if (!graphMonth.value) graphMonth.value = key;
      const [y,m] = key.split('-').map(Number);
      const n = daysInMonth(y,m);
      const moneyByDay = Array(n).fill(0);
      const weightByDay = Array(n).fill(0);
      const salesByDay = Array(n).fill(0);
      let recCount = 0;
      all.forEach(r => {
        if (r.monthKey !== key) return;
        recCount++;
        const idx = new Date(r.ts).getDate() - 1;
        moneyByDay[idx] += r.total;
        weightByDay[idx] += r.weight;
      });
      sales.forEach(s => {
        if (s.monthKey !== key) return;
        const idx = parseInt(s.dateKey.slice(8), 10) - 1;
        if (idx < 0 || idx >= n) return;
        salesByDay[idx] += s.amount;
      });
      const profitByDay = salesByDay.map((s,i) => s - moneyByDay[i]);
      const totalCost = moneyByDay.reduce((a,b)=>a+b,0);
      const totalSales = salesByDay.reduce((a,b)=>a+b,0);
      const totalProfit = totalSales - totalCost;
      gMoney.textContent = fmt(totalCost);
      gWeight.textContent = fmt(weightByDay.reduce((a,b)=>a+b,0));
      gCount.textContent = fmtInt(recCount);
      updateProfitStats(totalSales, totalCost, totalProfit);
      drawBarChart(chartMoney, moneyByDay, { gradId:'gradMoney', c1:'#14b8a6', c2:'#0d9488', unit:'บ.' });
      drawBarChart(chartWeight, weightByDay, { gradId:'gradWeight', c1:'#38bdf8', c2:'#0284c7', unit:'กก.' });
      drawProfitChart(chartProfit, profitByDay, { unit:'บ.' });
    }
  }

  function updateProfitStats(totalSales, totalCost, totalProfit){
    if (gSales) gSales.textContent = fmt(totalSales);
    if (gCost) gCost.textContent = fmt(totalCost);
    if (gProfit) gProfit.textContent = fmt(totalProfit);
    if (gProfitCard) {
      gProfitCard.classList.remove('profit-up','profit-down');
      if (totalProfit > 0) gProfitCard.classList.add('profit-up');
      else if (totalProfit < 0) gProfitCard.classList.add('profit-down');
    }
  }
  graphMonth.addEventListener('change', () => {
    // When picking a month, also shift histDate/week into that month so all views stay in sync
    const m = graphMonth.value || thisMonthKey();
    const firstOfMonth = `${m}-01`;
    histDate.value = firstOfMonth;
    graphWeekDate.value = firstOfMonth;
    renderGraph();
    if (views.history && views.history.classList.contains('active')) renderHistory();
  });
  graphWeekDate.addEventListener('change', () => syncActiveDate(graphWeekDate.value || thisWeekDateKey()));
  $$('[data-period]').forEach(b => {
    b.addEventListener('click', () => {
      graphPeriod = b.dataset.period;
      renderGraph();
      b.blur();
    });
  });
  $$('[data-quick-week]').forEach(b => {
    b.addEventListener('click', () => {
      syncActiveDate(b.dataset.quickWeek === 'last' ? lastWeekDateKey() : thisWeekDateKey());
    });
  });

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
    const hitW = barW + gap;

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
      const label = opts.labels ? opts.labels[i] : String(i+1);
      if (v > 0) {
        g += `<rect class="bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="url(#${opts.gradId})"></rect>`;
      }
      const step = n > 20 ? 3 : (n > 10 ? 2 : 1);
      const show = opts.everyLabel || (i+1) % step === 0 || i === 0 || i === n-1;
      if (show) {
        g += `<text class="label" x="${x + barW/2}" y="${padT+innerH+16}" text-anchor="middle">${label}</text>`;
      }
    }

    // Full-column hit areas (rendered last so they sit on top for tapping)
    for (let i=0;i<n;i++){
      const v = values[i];
      const x = padL + i*(barW+gap) - gap/2;
      g += `<rect class="hit" data-idx="${i}" data-val="${v}" data-label="${opts.labels ? opts.labels[i] : String(i+1)}" data-unit="${opts.unit}" data-kind="plain" x="${x}" y="${padT}" width="${hitW}" height="${innerH}"></rect>`;
    }

    svg.innerHTML = g;
    attachChartTooltip(svg);
  }

  function drawProfitChart(svg, values, opts){
    const W = 900, H = 260;
    const padL = 56, padR = 16, padT = 14, padB = 30;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const n = values.length;
    const maxPos = Math.max(0, ...values);
    const maxNeg = Math.max(0, ...values.map(v => -v));
    const niceTop = niceNumber(maxPos || 1);
    const niceBot = niceNumber(maxNeg || 0);
    const total = niceTop + niceBot;
    const range = total > 0 ? total : 1;
    const zeroY = padT + (niceTop / range) * innerH;
    const gap = 3;
    const barW = (innerW - gap*(n-1)) / n;

    const ticks = 5;
    const tickVals = [];
    for (let i=0;i<=ticks;i++) tickVals.push(-niceBot + (range * i / ticks));

    let g = `
      <defs>
        <linearGradient id="gradProfitUp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#10b981"/>
          <stop offset="100%" stop-color="#059669"/>
        </linearGradient>
        <linearGradient id="gradProfitDn" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#ef4444"/>
          <stop offset="100%" stop-color="#b91c1c"/>
        </linearGradient>
      </defs>`;

    for (const tv of tickVals) {
      const y = padT + innerH - ((tv + niceBot) / range) * innerH;
      g += `<line class="grid" x1="${padL}" y1="${y}" x2="${padL+innerW}" y2="${y}"/>`;
      g += `<text class="tick" x="${padL-10}" y="${y+3}" text-anchor="end">${shortNum(tv)}</text>`;
    }
    g += `<line class="axis" x1="${padL}" y1="${zeroY}" x2="${padL+innerW}" y2="${zeroY}"/>`;

    const hitW = barW + gap;
    for (let i=0;i<n;i++){
      const v = values[i];
      const x = padL + i*(barW+gap);
      const label = opts.labels ? opts.labels[i] : String(i+1);
      if (v > 0) {
        const h = (v / range) * innerH;
        const y = zeroY - h;
        g += `<rect class="bar" x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="url(#gradProfitUp)"></rect>`;
      } else if (v < 0) {
        const h = (-v / range) * innerH;
        g += `<rect class="bar" x="${x}" y="${zeroY}" width="${barW}" height="${h}" rx="4" fill="url(#gradProfitDn)"></rect>`;
      }
      const step = n > 20 ? 3 : (n > 10 ? 2 : 1);
      const show = opts.everyLabel || (i+1) % step === 0 || i === 0 || i === n-1;
      if (show) {
        g += `<text class="label" x="${x + barW/2}" y="${padT+innerH+16}" text-anchor="middle">${label}</text>`;
      }
    }

    // Full-column hit areas on top for tapping
    for (let i=0;i<n;i++){
      const v = values[i];
      const x = padL + i*(barW+gap) - gap/2;
      g += `<rect class="hit" data-idx="${i}" data-val="${v}" data-label="${opts.labels ? opts.labels[i] : String(i+1)}" data-unit="${opts.unit}" data-kind="profit" x="${x}" y="${padT}" width="${hitW}" height="${innerH}"></rect>`;
    }

    svg.innerHTML = g;
    attachChartTooltip(svg);
  }

  /* ---------- Chart tooltip (mobile-tap friendly) ---------- */
  function attachChartTooltip(svg){
    const wrap = svg.parentElement;
    if (!wrap) return;
    let tip = wrap.querySelector('.chart-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      wrap.appendChild(tip);
    }
    const hide = () => { tip.classList.remove('show','up','down'); };
    const showAt = (hit) => {
      const val = parseFloat(hit.getAttribute('data-val')) || 0;
      const label = hit.getAttribute('data-label') || '';
      const unit = hit.getAttribute('data-unit') || '';
      const kind = hit.getAttribute('data-kind') || 'plain';
      tip.classList.remove('up','down');
      let prefix = '';
      if (kind === 'profit') {
        if (val > 0) { tip.classList.add('up'); prefix = '+'; }
        else if (val < 0) tip.classList.add('down');
      }
      tip.innerHTML = `<span class="tip-label">${label}</span>${prefix}${fmt(val)} ${unit}`;
      // Position in viewBox coordinates mapped to CSS pixels of wrap
      const wrapRect = wrap.getBoundingClientRect();
      const svgRect = svg.getBoundingClientRect();
      const vb = svg.viewBox && svg.viewBox.baseVal;
      const vbW = vb ? vb.width : 900;
      const vbH = vb ? vb.height : 260;
      const hx = parseFloat(hit.getAttribute('x')) + parseFloat(hit.getAttribute('width'))/2;
      const hy = parseFloat(hit.getAttribute('y')) || 0;
      const sx = svgRect.width / vbW;
      const sy = svgRect.height / vbH;
      const cssX = svgRect.left - wrapRect.left + hx * sx;
      const cssY = svgRect.top - wrapRect.top + (hy + 10) * sy;
      tip.style.left = cssX + 'px';
      tip.style.top = cssY + 'px';
      tip.classList.add('show');
    };
    // Remove previous listener to avoid duplicates on re-render
    if (svg._tipHandler) svg.removeEventListener('click', svg._tipHandler);
    const handler = (e) => {
      const hit = e.target.closest('.hit');
      if (!hit) { hide(); return; }
      showAt(hit);
    };
    svg._tipHandler = handler;
    svg.addEventListener('click', handler);
    // Hide when tapping outside the chart wrap
    if (!wrap._outsideHandler) {
      const outside = (e) => {
        if (!wrap.contains(e.target)) wrap.querySelectorAll('.chart-tip').forEach(t => t.classList.remove('show','up','down'));
      };
      document.addEventListener('click', outside);
      wrap._outsideHandler = outside;
    }
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
    const sign = v < 0 ? '-' : '';
    const a = Math.abs(v);
    if (a >= 1e6) return sign + (a/1e6).toFixed(1).replace(/\.0$/,'')+'M';
    if (a >= 1e3) return sign + (a/1e3).toFixed(1).replace(/\.0$/,'')+'k';
    if (Number.isInteger(a)) return sign + String(a);
    return sign + a.toFixed(1);
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
    if (views.sell && views.sell.classList.contains('active')) renderSales();
  }

  /* ---------- Sell tab ---------- */
  function updateSellCalc(){
    if (!sellAmount) return;
    const gwt = parseFloat(sellGwt.value) || 0;
    const drc = parseFloat(sellDrc.value) || 0;
    const contr = parseFloat(sellContr.value) || 0;
    const nwt = roundInt(gwt * (drc / 100));
    const netPri = trunc2(contr * (drc / 100));
    const amount = roundInt(gwt * netPri);
    sellNwt.textContent = nf2.format(nwt);
    sellNetPri.textContent = nf2.format(netPri);
    sellAmount.innerHTML = `${nf2.format(amount)} <span class="unit">บาท</span>`;
    sellFormula.textContent = `${fmt(gwt)} กก. × ${nf2.format(netPri)} บ.`;
  }
  if (sellGwt) sellGwt.addEventListener('input', updateSellCalc);
  if (sellDrc) sellDrc.addEventListener('input', updateSellCalc);
  if (sellContr) sellContr.addEventListener('input', updateSellCalc);

  if (btnSellSave) btnSellSave.addEventListener('click', async () => {
    const dateVal = sellDate.value;
    const gwt = parseFloat(sellGwt.value);
    const drc = parseFloat(sellDrc.value);
    const contr = parseFloat(sellContr.value);
    if (!dateVal) return flash(sellHint, 'กรุณาเลือกวันที่ขาย', true);
    if (!(gwt > 0)) return flash(sellHint, 'GWT ต้องมากกว่า 0', true);
    if (!(drc > 0)) return flash(sellHint, 'DRC ต้องมากกว่า 0', true);
    if (!(contr > 0)) return flash(sellHint, 'Contr.Pri ต้องมากกว่า 0', true);

    const nwt = roundInt(gwt * (drc / 100));
    const netPri = trunc2(contr * (drc / 100));
    const amount = roundInt(gwt * netPri);
    const now = new Date();
    const [y, m, d] = dateVal.split('-').map(Number);
    const saleDate = new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
    const rec = {
      id: `${now.getTime()}_${Math.random().toString(36).slice(2,8)}`,
      date: dateVal,
      gwt, drc, nwt,
      contrPri: contr,
      netPri, amount,
      ts: saleDate.toISOString(),
      dateKey: dateVal,
      monthKey: dateVal.slice(0,7),
    };
    sellGwt.value = ''; sellDrc.value = ''; sellContr.value = '';
    updateSellCalc();
    toast(`บันทึกการขาย • ${nf2.format(amount)} บาท`, 'ok');
    addSale(rec);
  });

  [sellGwt, sellDrc, sellContr].forEach((el, i, arr) => {
    if (!el) return;
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (i < arr.length - 1) arr[i+1].focus();
        else btnSellSave && btnSellSave.click();
      }
    });
  });

  function renderSales(){
    if (!sellRecentList) return;
    const list = loadAllSales();
    const sorted = [...list].sort((a,b) => (b.ts||'').localeCompare(a.ts||''));
    const recent = sorted.slice(0, 12);
    sellRecentCount.textContent = list.length > recent.length ? `แสดง ${recent.length}/${list.length}` : (list.length ? `ทั้งหมด ${list.length}` : '');
    if (recent.length === 0) {
      sellRecentList.innerHTML = '<li class="empty">ยังไม่มีรายการขาย</li>';
      return;
    }
    sellRecentList.innerHTML = recent.map(r => `
      <li class="sell-item">
        <div>
          <div class="who">${nf2.format(r.amount)} บาท</div>
          <div class="meta">${formatDateThai(r.date)} • GWT ${fmt(r.gwt)} • DRC ${fmt(r.drc)}% • NWT ${nf2.format(r.nwt)} • Net ${nf2.format(r.netPri)}</div>
        </div>
        <button class="del-btn" data-del="${r.id}" title="ลบรายการนี้" aria-label="ลบ">×</button>
      </li>
    `).join('');
    sellRecentList.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-del');
        const rec = loadAllSales().find(x => x.id === id);
        if (rec) confirmDeleteSale(rec);
      });
    });
  }

  /* ---------- Password change modal ---------- */
  const pwModal = document.getElementById('pwModal');
  const pwOld = document.getElementById('pwOld');
  const pwNew = document.getElementById('pwNew');
  const pwConfirm = document.getElementById('pwConfirm');
  const pwErr = document.getElementById('pwErr');
  const pwSubmit = document.getElementById('pwSubmit');
  const pwCancel = document.getElementById('pwCancel');
  const btnSettings = document.getElementById('btnSettings');

  function openPwModal(){
    pwOld.value = ''; pwNew.value = ''; pwConfirm.value = '';
    pwErr.textContent = '';
    pwModal.classList.add('show');
    pwModal.setAttribute('aria-hidden','false');
    setTimeout(() => pwOld.focus(), 80);
  }
  function closePwModal(){
    pwModal.classList.remove('show');
    pwModal.setAttribute('aria-hidden','true');
  }
  function showPwErr(msg){
    pwErr.textContent = msg;
  }
  async function submitPwChange(){
    const oldVal = pwOld.value;
    const newVal = pwNew.value;
    const confVal = pwConfirm.value;
    if (oldVal !== getPassword()) return showPwErr('รหัสเดิมไม่ถูกต้อง');
    if (!newVal || newVal.length < 4) return showPwErr('รหัสใหม่ต้องมีอย่างน้อย 4 ตัว');
    if (newVal === oldVal) return showPwErr('รหัสใหม่ต้องไม่เหมือนรหัสเดิม');
    if (newVal !== confVal) return showPwErr('รหัสใหม่ 2 ช่องไม่ตรงกัน');
    await changePassword(newVal);
    closePwModal();
    toast('เปลี่ยนรหัสผ่านแล้ว • กรุณาเข้าสู่ระบบใหม่', 'ok');
    sessionStorage.removeItem(SESSION_KEY);
    setTimeout(() => { location.reload(); }, 900);
  }
  if (btnSettings) btnSettings.addEventListener('click', openPwModal);
  if (pwCancel) pwCancel.addEventListener('click', closePwModal);
  if (pwSubmit) pwSubmit.addEventListener('click', submitPwChange);
  if (pwModal) pwModal.addEventListener('click', e => { if (e.target === pwModal) closePwModal(); });
  [pwOld, pwNew, pwConfirm].forEach((el, i, arr) => {
    if (!el) return;
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (i < arr.length - 1) arr[i+1].focus(); else submitPwChange();
      }
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && pwModal && pwModal.classList.contains('show')) closePwModal();
  });

  /* ---------- Init ---------- */
  function init(){
    histDate.value = todayKey();
    graphMonth.value = thisMonthKey();
    graphWeekDate.value = thisWeekDateKey();
    if (sellDate) sellDate.value = todayKey();
    applyGraphPeriod();
    updateCalc();
    updateSellCalc();
    setSyncStatus('local');
    renderInput();
    renderSales();
    setTimeout(() => inpName.focus(), 200);
  }
  init();
  // Start cloud sync immediately so password can arrive before login is attempted
  initCloud();
})();
