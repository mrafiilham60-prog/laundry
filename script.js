// ========================================================
// LAPISAN DATA LOKAL (dataset pesanan & users) + penyimpanan
// ========================================================
function loadLocalList(key) {
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.warn('[Storage] Gagal membaca ' + key + ':', err.message);
        return [];
    }
}
let users = loadLocalList('DMS_LAUNDRY_USERS');
let dataset = loadLocalList('DMS_LAUNDRY_TRANSAKSI');

function saveData() {
    try { localStorage.setItem('DMS_LAUNDRY_TRANSAKSI', JSON.stringify(dataset)); }
    catch (err) { console.warn('[Storage] Gagal menyimpan pesanan:', err.message); }
}
function saveUsers() {
    try { localStorage.setItem('DMS_LAUNDRY_USERS', JSON.stringify(users)); }
    catch (err) { console.warn('[Storage] Gagal menyimpan users:', err.message); }
}

// ========================================================
// JAM KERJA (08.00 - 20.00 WIB) & ANTREAN PESANAN
// Semua perhitungan memakai WIB (UTC+7), bukan jam perangkat pelanggan.
// Pesanan yang masuk di luar jam kerja otomatis ditandai "Ditangani mulai ..." pada kolom jam
// (ikut tersimpan di Supabase) dan otomatis dianggap siap ditangani saat toko buka.
// ========================================================
const WORK_OPEN_MIN = 8 * 60;     // 08:00
const WORK_CLOSE_MIN = 20 * 60;   // 20:00 (tutup)
const WIB_OFFSET_MS = 7 * 3600000;
const WIB_DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const WIB_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const QUEUE_ACTIVE_STATUSES = ['Baru', 'Menunggu Konfirmasi'];
const QUEUE_TAG_RE = /\s*(?:•\s*)?Ditangani mulai (\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}) WIB/;
const COURIER_TAG_RE = /\s*(?:•\s*)?Kurir tiba (\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}) WIB/;
const COURIER_PICKUP_DELAY_MIN = 15; // kurir menjemput 15 menit setelah pesanan terverifikasi
const EXPRESS_HOURS_MIN = 4 * 60;    // Express selesai 4 jam KERJA sejak pakaian diterima di toko
const EXPRESS_PENDING_TEXT = '4 jam kerja setelah pakaian diterima di toko';
const EXPRESS_TAG_RE = /\s*(?:•\s*)?Target selesai (\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}) WIB/;
const EXPRESS_DONE_STATUSES = ['Selesai', 'Siap diantar', 'Siap diambil'];

function padWib(n) { return String(n).padStart(2, '0'); }
function wib(d) { return new Date(d.getTime() + WIB_OFFSET_MS); }                       // baca dengan getUTC*
function wibToDate(y, m, d, hh, mm) { return new Date(Date.UTC(y, m, d, hh, mm) - WIB_OFFSET_MS); }

function isWithinWorkingHours(d = new Date()) {
    const w = wib(d);
    const mins = w.getUTCHours() * 60 + w.getUTCMinutes();
    return mins >= WORK_OPEN_MIN && mins < WORK_CLOSE_MIN;
}

// Jika toko sedang buka -> waktu itu sendiri; jika tutup -> jam buka berikutnya
function getNextOpening(d = new Date()) {
    const w = wib(d);
    const mins = w.getUTCHours() * 60 + w.getUTCMinutes();
    if (mins < WORK_OPEN_MIN) return wibToDate(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), 8, 0);
    if (mins >= WORK_CLOSE_MIN) return wibToDate(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + 1, 8, 0);
    return d;
}

// Menambah menit KERJA saja (di luar 08.00 - 20.00 tidak dihitung)
function addWorkingMinutes(d, minutes) {
    let cur = getNextOpening(d);
    let remaining = minutes;
    for (let i = 0; i < 14; i++) {
        const w = wib(cur);
        const close = wibToDate(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), 20, 0);
        const avail = Math.floor((close.getTime() - cur.getTime()) / 60000);
        if (remaining < avail) return new Date(cur.getTime() + remaining * 60000);
        remaining -= avail;
        cur = wibToDate(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + 1, 8, 0);
    }
    return cur;
}

function formatWibClock(d) {
    const w = wib(d);
    return `${padWib(w.getUTCHours())}:${padWib(w.getUTCMinutes())}`;
}
function wibDayNumber(d) {
    const w = wib(d);
    return Math.floor(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) / 86400000);
}
function formatWibDayLabel(d, ref = new Date()) {
    const diff = wibDayNumber(d) - wibDayNumber(ref);
    if (diff === 0) return 'Hari ini';
    if (diff === 1) return 'Besok';
    const w = wib(d);
    return `${WIB_DAYS[w.getUTCDay()]}, ${w.getUTCDate()} ${WIB_MONTHS[w.getUTCMonth()]}`;
}
function formatWibWhen(d, ref = new Date()) {
    return `${formatWibDayLabel(d, ref)}, ${formatWibClock(d)} WIB`;
}
// Untuk kalimat: "pukul 10:15 WIB" / "besok pukul 08:10 WIB"
function formatWibPukul(d, ref = new Date()) {
    const day = formatWibDayLabel(d, ref);
    const lead = day === 'Hari ini' ? '' : (day === 'Besok' ? 'besok ' : `${day} `);
    return `${lead}pukul ${formatWibClock(d)} WIB`;
}

// Penanda antrean pada teks jadwal: "... • Ditangani mulai 08/11/2026 08:00 WIB"
function appendQueueTag(jam, handleAt) {
    const w = wib(handleAt);
    const tag = `Ditangani mulai ${padWib(w.getUTCDate())}/${padWib(w.getUTCMonth() + 1)}/${w.getUTCFullYear()} ${formatWibClock(handleAt)} WIB`;
    return jam ? `${jam} • ${tag}` : tag;
}
function getQueuedHandleTime(item) {
    const m = item && typeof item.jam === 'string' ? item.jam.match(QUEUE_TAG_RE) : null;
    return m ? wibToDate(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) : null;
}
function displayJam(jam) {
    if (typeof jam !== 'string') return jam;
    return jam
        .replace(new RegExp(QUEUE_TAG_RE.source, 'g'), '')
        .replace(new RegExp(COURIER_TAG_RE.source, 'g'), '')
        .replace(new RegExp(EXPRESS_TAG_RE.source, 'g'), '');
}

// ---- Penjemputan kurir: tiba = waktu verifikasi + 15 menit (dihitung dalam jam kerja) ----
function isCourierOrder(item) { return !!item && item.tipe === 'Dijemput kurir'; }

// Penanda pada teks jadwal: "... • Kurir tiba 08/11/2026 10:15 WIB" (menggantikan penanda antrean/penanda lama)
function setCourierEtaTag(jam, eta) {
    const w = wib(eta);
    const tag = `Kurir tiba ${padWib(w.getUTCDate())}/${padWib(w.getUTCMonth() + 1)}/${w.getUTCFullYear()} ${formatWibClock(eta)} WIB`;
    const base = String(displayJam(jam || '') || '').trim();
    return base ? `${base} • ${tag}` : tag;
}
function getCourierEtaTime(item) {
    const m = item && typeof item.jam === 'string' ? item.jam.match(COURIER_TAG_RE) : null;
    return m ? wibToDate(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) : null;
}
function getCourierEta(verifiedAt = new Date()) {
    return addWorkingMinutes(verifiedAt, COURIER_PICKUP_DELAY_MIN);
}
// waiting = kurir belum waktunya tiba; due = sudah waktunya jemput
function getCourierState(item, now = new Date()) {
    if (!isCourierOrder(item) || item.status !== 'Dijemput') return null;
    const at = getCourierEtaTime(item);
    if (!at) return null;
    return { state: at.getTime() > now.getTime() ? 'waiting' : 'due', at };
}
function getCourierBadgeHtml(item) {
    const c = getCourierState(item);
    if (!c) return '';
    if (c.state === 'waiting') {
        return `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200 inline-flex items-center gap-1"><i class="fa-solid fa-motorcycle"></i> Kurir tiba ± ${formatWibPukul(c.at)}</span>`;
    }
    return `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-300 inline-flex items-center gap-1 animate-pulse"><i class="fa-solid fa-motorcycle"></i> Waktunya kurir jemput</span>`;
}
function getCourierMessage(item) {
    if (!isCourierOrder(item)) return '';
    if (['Menunggu Konfirmasi', 'Baru'].includes(item.status)) {
        return `Kurir menjemput ${COURIER_PICKUP_DELAY_MIN} menit setelah pesanan diverifikasi admin.`;
    }
    const c = getCourierState(item);
    if (!c) return '';
    return c.state === 'waiting'
        ? `Pesanan terverifikasi. Kurir menjemput sekitar ${formatWibPukul(c.at)} (${COURIER_PICKUP_DELAY_MIN} menit setelah verifikasi).`
        : 'Kurir sedang menuju alamat Anda untuk menjemput cucian.';
}
function getCourierNoticeHtml(item) {
    const msg = getCourierMessage(item);
    if (!msg) return '';
    return `
                <div class="p-2.5 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-900 flex items-start gap-2">
                    <i class="fa-solid fa-motorcycle mt-0.5 text-blue-600"></i>
                    <span class="text-[11px] text-blue-800">${msg}</span>
                </div>
            `;
}
function getCourierTrackLineHtml(item) {
    const msg = getCourierMessage(item);
    return msg ? `<p class="text-[10px] text-blue-700 mt-1">🛵 ${msg}</p>` : '';
}

// ---- Express: 4 jam kerja dihitung sejak pakaian DITERIMA di toko (status berubah ke Diproses) ----
function isExpressOrder(item) { return !!item && /express/i.test(String(item.layanan || '')); }

function getExpressTargetTime(item) {
    const m = item && typeof item.jam === 'string' ? item.jam.match(EXPRESS_TAG_RE) : null;
    return m ? wibToDate(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) : null;
}
// Pesanan Express yang hitungan 4 jamnya belum dimulai (menunggu pakaian diterima di toko)
function isExpressClockPending(item) {
    return isExpressOrder(item) && typeof item.jam === 'string'
        && item.jam.includes(EXPRESS_PENDING_TEXT) && !getExpressTargetTime(item);
}
function setExpressTargetTag(jam, target) {
    const w = wib(target);
    const tag = `Target selesai ${padWib(w.getUTCDate())}/${padWib(w.getUTCMonth() + 1)}/${w.getUTCFullYear()} ${formatWibClock(target)} WIB`;
    const base = String(jam || '').replace(new RegExp(EXPRESS_TAG_RE.source, 'g'), '').trim();
    return base ? `${base} • ${tag}` : tag;
}
// Dipanggil saat status berubah: mulai hitung 4 jam kerja ketika pesanan Express masuk status Diproses
function maybeStartExpressClock(item, newStatus, prevStatus, startAt = new Date()) {
    if (newStatus !== 'Diproses' || prevStatus === 'Diproses' || !isExpressClockPending(item)) return null;
    const target = addWorkingMinutes(startAt, EXPRESS_HOURS_MIN);
    item.jam = setExpressTargetTag(item.jam, target);
    return target;
}
function getExpressBadgeHtml(item) {
    if (!isExpressOrder(item)) return '';
    const target = getExpressTargetTime(item);
    if (!target) {
        if (!isExpressClockPending(item) || item.status === 'Diproses' || EXPRESS_DONE_STATUSES.includes(item.status)) return '';
        return `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-50 text-slate-600 border border-slate-200 inline-flex items-center gap-1"><i class="fa-solid fa-hourglass-start"></i> Express · hitungan 4 jam belum mulai</span>`;
    }
    if (item.status !== 'Diproses') return '';
    if (target.getTime() > new Date().getTime()) {
        return `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-violet-50 text-violet-700 border border-violet-200 inline-flex items-center gap-1"><i class="fa-solid fa-stopwatch"></i> Express selesai ± ${formatWibPukul(target)}</span>`;
    }
    return `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-300 inline-flex items-center gap-1 animate-pulse"><i class="fa-solid fa-stopwatch"></i> Lewat target Express</span>`;
}
function getExpressMessage(item) {
    if (!isExpressOrder(item)) return '';
    const target = getExpressTargetTime(item);
    if (!target) {
        if (!isExpressClockPending(item) || EXPRESS_DONE_STATUSES.includes(item.status)) return '';
        return 'Estimasi selesai Express (4 jam kerja) mulai dihitung setelah pakaian diterima di toko dan dikonfirmasi admin.';
    }
    if (item.status !== 'Diproses') return '';
    return target.getTime() > new Date().getTime()
        ? `Estimasi selesai: ${formatWibPukul(target)} (4 jam kerja sejak pakaian diterima di toko).`
        : 'Cucian Express Anda sudah memasuki waktu target selesai dan segera diselesaikan.';
}
function getExpressNoticeHtml(item) {
    const msg = getExpressMessage(item);
    if (!msg) return '';
    return `
                <div class="p-2.5 bg-violet-50 border border-violet-200 rounded-xl text-xs text-violet-900 flex items-start gap-2">
                    <i class="fa-solid fa-stopwatch mt-0.5 text-violet-600"></i>
                    <span class="text-[11px] text-violet-800">${msg}</span>
                </div>
            `;
}
function getExpressTrackLineHtml(item) {
    const msg = getExpressMessage(item);
    return msg ? `<p class="text-[10px] text-violet-700 mt-1">⏱ ${msg}</p>` : '';
}
// waiting = belum waktunya ditangani; ready = sudah jam kerja tapi belum disentuh admin
function getQueueState(item, now = new Date()) {
    const at = getQueuedHandleTime(item);
    if (!at || !item || !QUEUE_ACTIVE_STATUSES.includes(item.status)) return null;
    return { state: at.getTime() > now.getTime() ? 'waiting' : 'ready', at };
}
function getQueueBadgeHtml(item) {
    const q = getQueueState(item);
    if (!q) return '';
    if (q.state === 'waiting') {
        return `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 inline-flex items-center gap-1"><i class="fa-solid fa-moon"></i> Antrean jam kerja · mulai ${formatWibWhen(q.at)}</span>`;
    }
    return `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-300 inline-flex items-center gap-1"><i class="fa-solid fa-sun"></i> Masuk di luar jam kerja · siap ditangani</span>`;
}
function getQueueNoticeHtml(item) {
    const q = getQueueState(item);
    if (!q || q.state !== 'waiting') return '';
    return `
                <div class="p-2.5 bg-indigo-50 border border-indigo-200 rounded-xl text-xs text-indigo-900 space-y-0.5">
                    <div class="font-bold flex items-center gap-1.5 text-indigo-800"><i class="fa-solid fa-moon"></i> Diterima di luar jam kerja</div>
                    <p class="text-[11px] text-indigo-700">Jam kerja kami 08.00 - 20.00 WIB. Pesanan Anda otomatis masuk antrean dan ditangani mulai ${formatWibWhen(q.at)}.</p>
                </div>
            `;
}
function getQueueTrackLineHtml(item) {
    const q = getQueueState(item);
    if (!q || q.state !== 'waiting') return '';
    return `<p class="text-[10px] text-indigo-700 mt-1">🌙 Pesanan masuk di luar jam kerja dan otomatis ditangani mulai ${formatWibWhen(q.at)}.</p>`;
}

// Banner di form pesanan pelanggan (hanya tampil saat toko tutup)
function updateJamKerjaBanner() {
    const box = document.getElementById('pelanggan-jamkerja-banner');
    const text = document.getElementById('pelanggan-jamkerja-text');
    if (!box) return;
    const now = new Date();
    if (isWithinWorkingHours(now)) {
        box.classList.add('hidden');
        return;
    }
    if (text) text.innerText = `Pesanan tetap bisa dibuat dan akan otomatis ditangani mulai ${formatWibWhen(getNextOpening(now), now)}.`;
    box.classList.remove('hidden');
}

// Render ulang tampilan sesuai peran (dipakai setelah sinkron dan saat jam kerja tiba)
function refreshRoleViews() {
    if (!currentUser) return;
    if (currentUser.role === 'admin') {
        refreshNextAutoResi();
        renderOnlineOrdersTable();
    } else if (currentUser.role === 'pelanggan') {
        renderPelangganOrders();
    } else if (currentUser.role === 'owner') {
        renderOwnerStats();
        renderOwnerDetailedReport();
    }
}

// Berjalan otomatis tiap 30 detik: perbarui banner, dan segarkan tampilan saat waktu penanganan tiba
let lastQueueTick = Date.now();
function workingHoursTick() {
    const now = Date.now();
    updateJamKerjaBanner();
    const crossed = Array.isArray(dataset) && dataset.some(x =>
        [getQueuedHandleTime(x), getCourierEtaTime(x), getExpressTargetTime(x)].some(t => t && t.getTime() > lastQueueTick && t.getTime() <= now)
    );
    lastQueueTick = now;
    if (crossed) refreshRoleViews();
}

// ========================================================
// PESANAN "BELUM TERKIRIM" KE SUPABASE
// Pesanan baru dicatat di sini sampai berhasil masuk Supabase. Saat sinkron, hanya pesanan
// inilah yang dipertahankan walau belum ada di server; selebihnya mengikuti isi Supabase
// (jadi data yang dihapus di Supabase ikut hilang dari web).
// ========================================================
const PENDING_KEY = 'DMS_LAUNDRY_PENDING';
const cloudInFlight = new Set();

function loadPendingResi() {
    return loadLocalList(PENDING_KEY).map(String);
}
function savePendingResi(list) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); }
    catch (err) { console.warn('[Storage] Gagal menyimpan daftar pending:', err.message); }
}
function markPendingResi(resi) {
    const list = loadPendingResi();
    if (!list.includes(String(resi))) { list.push(String(resi)); savePendingResi(list); }
}
function clearPendingResi(resi) {
    savePendingResi(loadPendingResi().filter(r => r !== String(resi)));
}

// Kirim pesanan ke Supabase; hanya dianggap beres jika server menyatakan sukses
async function pushOrderToCloud(order) {
    if (!order || !order.resi) return false;
    markPendingResi(order.resi);
    if (typeof insertTransactionToDB !== 'function') return false;
    if (cloudInFlight.has(order.resi)) return false; // jangan kirim dobel
    cloudInFlight.add(order.resi);
    try {
        const result = await insertTransactionToDB(order);
        if (result && result.success) {
            clearPendingResi(order.resi);
            return true;
        }
    } catch (err) {
        console.error('[Supabase] Simpan pesanan gagal:', err);
    } finally {
        cloudInFlight.delete(order.resi);
    }
    return false;
}

let currentUser = JSON.parse(sessionStorage.getItem('DMS_LAUNDRY_USER')) || null;
let loginTimer = null;
let logoutTimer = null;
// ========================================================
// NAVIGASI SCREEN UTAMA (Landing, Auth, Dashboard)
// ========================================================
function showPublicLanding() {
    const scPub = document.getElementById('screen-public');
    const scLog = document.getElementById('screen-login');
    const scDash = document.getElementById('screen-dashboard');
    if (scPub) scPub.classList.remove('hidden');
    if (scLog) scLog.classList.add('hidden');
    if (scDash) scDash.classList.add('hidden');
    if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showAuthScreen(tab = 'login') {
    const scPub = document.getElementById('screen-public');
    const scLog = document.getElementById('screen-login');
    const scDash = document.getElementById('screen-dashboard');
    if (scPub) scPub.classList.add('hidden');
    if (scLog) scLog.classList.remove('hidden');
    if (scDash) scDash.classList.add('hidden');
    switchAuthTab(tab);
    if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' });
}

function switchAuthTab(tab) {
    const formLogin = document.getElementById('form-login');
    const formRegister = document.getElementById('form-register');
    const authTitle = document.getElementById('auth-title');
    const authSubtitle = document.getElementById('auth-subtitle');
    const sideTitle = document.getElementById('auth-side-title');

    if (tab === 'login') {
        formLogin.classList.remove('hidden');
        formRegister.classList.add('hidden');
        authTitle.innerText = 'Masuk';
        authSubtitle.innerText = 'Selamat datang kembali.';
        if (sideTitle) sideTitle.innerHTML = 'Cucian beres,<br>tanpa ribet.';
    } else {
        formLogin.classList.add('hidden');
        formRegister.classList.remove('hidden');
        authTitle.innerText = 'Daftar akun';
        authSubtitle.innerText = 'Akun untuk pelanggan baru.';
        if (sideTitle) sideTitle.innerHTML = 'Daftar sekali,<br>pesan kapan saja.';
        const pwd = document.getElementById('reg-password');
        if (pwd) checkPasswordRequirements(pwd.value || '');
    }
}

// ========================================================
// VALIDASI FORM (No HP 08/62 10-13 digit & Password Variasi)
// ========================================================
function validateIndonesianPhone(phone) {
    if (!phone) return { valid: false, message: 'Nomor telepon wajib diisi.' };
    const clean = phone.replace(/[\s\-]/g, '');
    const digits = clean.startsWith('+') ? clean.slice(1) : clean;

    if (!/^[0-9]+$/.test(digits)) {
        return { valid: false, message: 'Nomor telepon hanya boleh berisi angka.' };
    }
    if (!digits.startsWith('08') && !digits.startsWith('62')) {
        return { valid: false, message: 'Nomor telepon wajib diawali dengan 08 atau 62 (contoh: 08123456789 atau 628123456789).' };
    }
    if (digits.length < 10) {
        return { valid: false, message: `Nomor telepon kurang dari 10 digit (${digits.length} digit). Minimal 10 digit.` };
    }
    if (digits.length > 13) {
        return { valid: false, message: `Nomor telepon melebihi batas (${digits.length} digit). Maksimal 13 digit.` };
    }

    return { valid: true, cleanNumber: digits };
}

function checkPasswordRequirements(pwd) {
    const hasUpper = /[A-Z]/.test(pwd);
    const hasLower = /[a-z]/.test(pwd);
    const hasNumber = /[0-9]/.test(pwd);

    updateReqBadge('req-upper', hasUpper, 'Huruf Kapital (A-Z)');
    updateReqBadge('req-lower', hasLower, 'Nonkapital (a-z)');
    updateReqBadge('req-number', hasNumber, 'Angka (0-9)');
}

function updateReqBadge(id, valid, text) {
    const el = document.getElementById(id);
    if (!el) return;
    if (valid) {
        el.className = 'px-2 py-0.5 rounded bg-teal-50 border border-teal-200 text-teal-700 font-semibold flex items-center gap-1 transition';
        el.innerHTML = `<i class="fa-solid fa-circle-check text-[9px] text-teal-600"></i> ${text}`;
    } else {
        el.className = 'px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-500 flex items-center gap-1 transition';
        el.innerHTML = `<i class="fa-solid fa-circle-xmark text-[9px]"></i> ${text}`;
    }
}

// ========================================================
// AUTHENTICATION LOGIC (Login, Register, Logout)
// ========================================================
async function handleLogin(e) {
    e.preventDefault();
    const u = document.getElementById('login-username').value.trim();
    const p = document.getElementById('login-password').value.trim();

    let authUser = null;

    // 1. Coba Autentikasi Cloud Supabase jika aktif
    if (typeof loginUserFromDB === 'function') {
        try {
            const remoteUser = await loginUserFromDB(u, p);
            if (remoteUser) {
                authUser = { role: remoteUser.role, nama: remoteUser.nama, hp: remoteUser.hp, id: remoteUser.id, username: remoteUser.username };
            }
        } catch (err) {
            console.warn('[Supabase] Gagal login via Supabase Cloud, mencoba fallback lokal:', err);
        }
    } else if (typeof supabaseClient !== 'undefined' && supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('users')
                .select('*')
                .or(`username.eq."${u}",hp.eq."${u}"`)
                .eq('password', p)
                .maybeSingle();

            if (!error && data) {
                authUser = { role: data.role, nama: data.nama, hp: data.hp, id: data.id, username: data.username };
            }
        } catch (err) {
            console.warn('[Supabase] Gagal login via Supabase Client:', err);
        }
    }

    // 2. Fallback Autentikasi Cache / Offline Lokal
    if (!authUser) {
        // Role: Admin Kasir
        if (u.toLowerCase() === 'admin' && !hasStoredAccount('admin') && (p === 'Admin123' || p === 'admin123')) {
            authUser = { role: 'admin', nama: 'Administrator Kasir' };
        }
        // Role: Owner
        else if (u.toLowerCase() === 'owner' && !hasStoredAccount('owner') && (p === 'Owner123' || p === 'owner123')) {
            authUser = { role: 'owner', nama: 'Pemilik Usaha (Owner)' };
        }
        // Role: Pelanggan
        else {
            const found = users.find(x => (x.hp === u || (x.username && x.username === u) || x.nama.toLowerCase() === u.toLowerCase()) && x.password === p);
            if (found) {
                authUser = { role: found.role || 'pelanggan', nama: found.nama, hp: found.hp, username: found.username };
            }
        }
    }

    if (authUser) {
        currentUser = authUser;
        sessionStorage.setItem('DMS_LAUNDRY_USER', JSON.stringify(currentUser));
        triggerLoginSuccess(currentUser);
    } else {
        triggerLoginError('Username / Nomor HP atau Kata Sandi yang Anda masukkan salah. Silakan periksa kembali.', 'Login Gagal');
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const nama = document.getElementById('reg-nama').value.trim();
    const hp = document.getElementById('reg-hp').value.trim();
    const password = document.getElementById('reg-password').value.trim();
    const confirmPassword = document.getElementById('reg-password-confirm').value.trim();

    // 1. Validasi Nomor Telepon
    const phoneCheck = validateIndonesianPhone(hp);
    if (!phoneCheck.valid) {
        triggerLoginError(phoneCheck.message, 'Pendaftaran Gagal');
        return;
    }
    const cleanHp = phoneCheck.cleanNumber;

    // 2. Validasi Kata Sandi
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);

    if (!hasUpper || !hasLower || !hasNumber) {
        triggerLoginError('Kata sandi wajib memiliki kombinasi huruf kapital (A-Z), huruf nonkapital (a-z), dan angka (0-9).', 'Pendaftaran Gagal');
        return;
    }
    if (password.length < 6) {
        triggerLoginError('Kata sandi minimal terdiri dari 6 karakter.', 'Pendaftaran Gagal');
        return;
    }
    if (password !== confirmPassword) {
        triggerLoginError('Konfirmasi kata sandi tidak cocok. Mohon ketik ulang kata sandi dengan benar.', 'Pendaftaran Gagal');
        return;
    }
    if (users.find(x => x.hp === cleanHp || (x.username && x.username === cleanHp))) {
        triggerLoginError('Nomor WhatsApp / HP sudah terdaftar! Silakan langsung masuk ke akun Anda.', 'Pendaftaran Gagal');
        return;
    }

    const newUser = { username: cleanHp, nama, hp: cleanHp, password, role: 'pelanggan' };
    users.push(newUser);
    saveUsers();

    // Simpan ke database Supabase
    if (typeof insertUserToDB === 'function') {
        await insertUserToDB(newUser);
    }

    currentUser = { role: 'pelanggan', nama, hp: cleanHp };
    sessionStorage.setItem('DMS_LAUNDRY_USER', JSON.stringify(currentUser));
    triggerLoginSuccess(currentUser, 'Akun pelanggan berhasil didaftarkan! Selamat datang di DMS Laundry.');
}

// ========================================================
// GANTI KATA SANDI (setelah login) & LUPA KATA SANDI (di layar login)
// Catatan: aplikasi ini menyimpan kata sandi apa adanya (tanpa enkripsi) pada tabel users.
// ========================================================
const FORGOT_KEY = 'DMS_LAUNDRY_FORGOT';
const FORGOT_MAX_FAILS = 5;
const FORGOT_LOCK_MS = 10 * 60 * 1000;
let forgotVerifiedUser = null;

// Kata sandi bawaan (admin/owner) hanya berlaku bila akun itu BELUM ada di tabel users,
// supaya kata sandi yang sudah diganti tidak bisa dikalahkan oleh kata sandi bawaan di kode.
function hasStoredAccount(name) {
    const key = String(name).toLowerCase();
    return Array.isArray(users) && users.some(x => String(x.username || '').toLowerCase() === key);
}
function findLocalUser(identifier) {
    const key = String(identifier || '').trim().toLowerCase();
    if (!key) return null;
    return users.find(x => String(x.hp || '').toLowerCase() === key || String(x.username || '').toLowerCase() === key) || null;
}
// 0812xxxx dan 62812xxxx dianggap nomor yang sama
function phoneVariants(clean) {
    const v = new Set([clean]);
    if (clean.startsWith('62')) v.add('0' + clean.slice(2));
    if (clean.startsWith('08')) v.add('62' + clean.slice(1));
    return [...v];
}
function validateNewPassword(password, confirm, oldPassword) {
    if (password.length < 6) return 'Kata sandi baru minimal terdiri dari 6 karakter.';
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
        return 'Kata sandi baru wajib memiliki kombinasi huruf kapital (A-Z), huruf nonkapital (a-z), dan angka (0-9).';
    }
    if (password !== confirm) return 'Konfirmasi kata sandi baru tidak cocok. Mohon ketik ulang dengan benar.';
    if (oldPassword !== undefined && password === oldPassword) return 'Kata sandi baru harus berbeda dari kata sandi lama.';
    return '';
}
function showInlineMessage(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    if (message) { el.innerText = message; el.classList.remove('hidden'); }
    else { el.innerText = ''; el.classList.add('hidden'); }
}
function togglePasswordFields(ids, show) {
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.type = show ? 'text' : 'password'; });
}
function clearFields(ids) {
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}
function setBusy(buttonId, busy, busyText) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    if (busy) { btn._label = btn.innerText; btn.innerText = busyText; btn.disabled = true; }
    else { if (btn._label) btn.innerText = btn._label; btn.disabled = false; }
}
function updateLocalPassword(identifier, newPassword) {
    const local = findLocalUser(identifier);
    if (local) { local.password = newPassword; saveUsers(); }
}

// ---------------- Ganti kata sandi ----------------
function openChangePasswordModal() {
    if (!currentUser) return;
    clearFields(['cp-old', 'cp-new', 'cp-confirm']);
    togglePasswordFields(['cp-old', 'cp-new', 'cp-confirm'], false);
    const chk = document.getElementById('cp-show');
    if (chk) chk.checked = false;
    showInlineMessage('cp-error', '');
    const modal = document.getElementById('modal-change-password');
    if (modal) modal.classList.remove('hidden');
}
function closeChangePasswordModal() {
    const modal = document.getElementById('modal-change-password');
    if (modal) modal.classList.add('hidden');
    clearFields(['cp-old', 'cp-new', 'cp-confirm']);
}

async function handleChangePassword(e) {
    e.preventDefault();
    showInlineMessage('cp-error', '');
    if (!currentUser) {
        showInlineMessage('cp-error', 'Sesi Anda berakhir. Silakan login ulang.');
        return;
    }
    const oldPw = document.getElementById('cp-old').value.trim();
    const newPw = document.getElementById('cp-new').value.trim();
    const confirmPw = document.getElementById('cp-confirm').value.trim();

    const identifier = currentUser.hp || currentUser.username;
    if (!identifier) {
        showInlineMessage('cp-error', 'Akun ini memakai kredensial bawaan aplikasi dan belum tersimpan di Supabase, sehingga kata sandinya tidak dapat diubah dari sini. Tambahkan akunnya pada tabel users terlebih dahulu.');
        return;
    }
    if (!oldPw) { showInlineMessage('cp-error', 'Kata sandi lama wajib diisi.'); return; }
    const problem = validateNewPassword(newPw, confirmPw, oldPw);
    if (problem) { showInlineMessage('cp-error', problem); return; }

    setBusy('cp-submit', true, 'Menyimpan...');
    try {
        // 1. Verifikasi kata sandi lama (Supabase dulu, lalu salinan lokal)
        let account = null;
        if (typeof loginUserFromDB === 'function') {
            try { account = await loginUserFromDB(identifier, oldPw); } catch (err) { /* lanjut ke lokal */ }
        }
        if (!account) {
            const local = findLocalUser(identifier);
            if (local && local.password === oldPw) account = local;
        }
        if (!account) { showInlineMessage('cp-error', 'Kata sandi lama salah.'); return; }

        // 2. Simpan ke Supabase (dianggap berhasil hanya jika baris benar-benar terupdate)
        const result = (typeof updateUserPasswordInDB === 'function')
            ? await updateUserPasswordInDB(account, newPw)
            : { success: false, error: 'Supabase tidak tersedia' };
        if (!result.success) {
            showInlineMessage('cp-error', `Kata sandi belum dapat disimpan ke server (${result.error || 'tidak diketahui'}). Periksa koneksi internet lalu coba lagi.`);
            return;
        }
        updateLocalPassword(identifier, newPw);
    } finally {
        setBusy('cp-submit', false);
    }

    closeChangePasswordModal();
    showReadableModal({
        icon: 'fa-solid fa-circle-check text-emerald-600',
        iconWrapClass: 'w-14 h-14 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-2xl mx-auto flex items-center justify-center text-2xl shadow-sm',
        title: 'Kata Sandi Berhasil Diubah',
        subtitle: 'Gunakan kata sandi baru Anda saat masuk berikutnya.',
        rows: [],
        primaryBtn: { text: 'Tutup', class: 'flex-1 bg-teal-700 hover:bg-teal-800 text-white font-bold py-2.5 rounded-xl text-xs transition shadow-sm' }
    });
}

// ---------------- Lupa kata sandi ----------------
function getForgotState() {
    try {
        const st = JSON.parse(localStorage.getItem(FORGOT_KEY) || '{}');
        return { fails: st.fails || 0, until: st.until || 0 };
    } catch (err) { return { fails: 0, until: 0 }; }
}
function saveForgotState(st) {
    try { localStorage.setItem(FORGOT_KEY, JSON.stringify(st)); } catch (err) { /* abaikan */ }
}
function setForgotStep(step) {
    const verify = document.getElementById('form-forgot-verify');
    const reset = document.getElementById('form-forgot-reset');
    if (verify) verify.classList.toggle('hidden', step !== 1);
    if (reset) reset.classList.toggle('hidden', step !== 2);
    showInlineMessage('fp-error', '');
    showInlineMessage('fp-error2', '');
}
function openForgotPasswordModal() {
    forgotVerifiedUser = null;
    clearFields(['fp-hp', 'fp-nama', 'fp-new', 'fp-confirm']);
    togglePasswordFields(['fp-new', 'fp-confirm'], false);
    const chk = document.getElementById('fp-show');
    if (chk) chk.checked = false;
    // isi otomatis dari kolom login jika terlihat seperti nomor HP
    const typed = ((document.getElementById('login-username') || {}).value || '').trim();
    const hpEl = document.getElementById('fp-hp');
    if (hpEl && /^[0-9+\s-]{8,}$/.test(typed)) hpEl.value = typed;
    setForgotStep(1);
    const modal = document.getElementById('modal-forgot-password');
    if (modal) modal.classList.remove('hidden');
}
function closeForgotPasswordModal() {
    forgotVerifiedUser = null;
    const modal = document.getElementById('modal-forgot-password');
    if (modal) modal.classList.add('hidden');
    clearFields(['fp-hp', 'fp-nama', 'fp-new', 'fp-confirm']);
}

async function handleForgotVerify(e) {
    e.preventDefault();
    showInlineMessage('fp-error', '');
    const state = getForgotState();
    const now = Date.now();
    if (state.until > now) {
        showInlineMessage('fp-error', `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil((state.until - now) / 60000)} menit.`);
        return;
    }

    const hpRaw = document.getElementById('fp-hp').value.trim();
    const namaIn = document.getElementById('fp-nama').value.trim();
    const phoneCheck = validateIndonesianPhone(hpRaw);
    if (!phoneCheck.valid) { showInlineMessage('fp-error', phoneCheck.message); return; }
    if (!namaIn) { showInlineMessage('fp-error', 'Nama lengkap wajib diisi.'); return; }

    setBusy('fp-verify-btn', true, 'Memeriksa...');
    let account = null;
    try {
        for (const variant of phoneVariants(phoneCheck.cleanNumber)) {
            if (typeof findUserByHpFromDB === 'function') {
                try { account = await findUserByHpFromDB(variant); } catch (err) { /* lanjut ke lokal */ }
            }
            if (!account) account = findLocalUser(variant);
            if (account) break;
        }
    } finally {
        setBusy('fp-verify-btn', false);
    }

    // Hanya akun pelanggan yang boleh direset mandiri (admin/owner tidak)
    const matches = !!account
        && String(account.role || 'pelanggan') === 'pelanggan'
        && String(account.nama || '').trim().toLowerCase() === namaIn.toLowerCase();

    if (!matches) {
        const fails = state.fails + 1;
        const locked = fails >= FORGOT_MAX_FAILS;
        saveForgotState({ fails: locked ? 0 : fails, until: locked ? now + FORGOT_LOCK_MS : 0 });
        showInlineMessage('fp-error', locked
            ? `Terlalu banyak percobaan. Coba lagi dalam ${FORGOT_LOCK_MS / 60000} menit.`
            : `Nomor HP dan nama lengkap tidak cocok dengan data akun pelanggan. Sisa percobaan: ${FORGOT_MAX_FAILS - fails}. Akun admin/owner tidak dapat direset lewat halaman ini.`);
        return;
    }

    saveForgotState({ fails: 0, until: 0 });
    forgotVerifiedUser = account;
    const info = document.getElementById('fp-account-info');
    if (info) info.innerText = `${account.nama} · ${account.hp || account.username}`;
    setForgotStep(2);
}

async function handleForgotReset(e) {
    e.preventDefault();
    showInlineMessage('fp-error2', '');
    if (!forgotVerifiedUser) {
        setForgotStep(1);
        showInlineMessage('fp-error', 'Verifikasi data akun diperlukan terlebih dahulu.');
        return;
    }
    const newPw = document.getElementById('fp-new').value.trim();
    const confirmPw = document.getElementById('fp-confirm').value.trim();
    const problem = validateNewPassword(newPw, confirmPw, forgotVerifiedUser.password);
    if (problem) { showInlineMessage('fp-error2', problem); return; }

    const account = forgotVerifiedUser;
    const identifier = account.hp || account.username;
    setBusy('fp-reset-btn', true, 'Menyimpan...');
    try {
        const result = (typeof updateUserPasswordInDB === 'function')
            ? await updateUserPasswordInDB(account, newPw)
            : { success: false, error: 'Supabase tidak tersedia' };
        if (!result.success) {
            showInlineMessage('fp-error2', `Kata sandi belum dapat disimpan ke server (${result.error || 'tidak diketahui'}). Periksa koneksi internet lalu coba lagi.`);
            return;
        }
        updateLocalPassword(identifier, newPw);
    } finally {
        setBusy('fp-reset-btn', false);
    }

    forgotVerifiedUser = null;
    closeForgotPasswordModal();
    showReadableModal({
        icon: 'fa-solid fa-circle-check text-emerald-600',
        iconWrapClass: 'w-14 h-14 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-2xl mx-auto flex items-center justify-center text-2xl shadow-sm',
        title: 'Kata Sandi Berhasil Diubah',
        subtitle: 'Silakan masuk memakai kata sandi baru Anda.',
        rows: [],
        primaryBtn: {
            text: 'Masuk Sekarang',
            class: 'flex-1 bg-teal-700 hover:bg-teal-800 text-white font-bold py-2.5 rounded-xl text-xs transition shadow-sm',
            onClick: () => {
                if (typeof switchAuthTab === 'function') switchAuthTab('login');
                const u = document.getElementById('login-username');
                const p = document.getElementById('login-password');
                if (u) u.value = identifier;
                if (p) { p.value = ''; if (p.focus) p.focus(); }
            }
        }
    });
}

// Pop-up Login Berhasil (1 Detik)
function triggerLoginSuccess(user, customDesc) {
    const modal = document.getElementById('modal-login-success');
    const userName = document.getElementById('popup-user-name');
    const successDesc = document.getElementById('popup-success-desc');

    if (userName) userName.innerText = user.nama;
    if (successDesc && customDesc) successDesc.innerText = customDesc;

    if (modal) modal.classList.remove('hidden');

    initDashboardView();

    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = setTimeout(() => {
        dismissLoginSuccessModal();
    }, 1000);
}

function dismissLoginSuccessModal() {
    if (loginTimer) { clearTimeout(loginTimer); loginTimer = null; }
    const modal = document.getElementById('modal-login-success');
    if (modal) modal.classList.add('hidden');
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.body.scrollTop = 0;
    document.documentElement.scrollTop = 0;
}

// Pop-up Error
function triggerLoginError(msg, title = 'Login Gagal') {
    const modal = document.getElementById('modal-login-error');
    const titleEl = document.getElementById('popup-error-title');
    const desc = document.getElementById('popup-error-desc');
    if (titleEl) titleEl.innerText = title;
    if (desc) desc.innerText = msg;
    if (modal) modal.classList.remove('hidden');
}

function dismissLoginErrorModal() {
    const modal = document.getElementById('modal-login-error');
    if (modal) modal.classList.add('hidden');
}

// ========================================================
// MODAL DETAIL & KONFIRMASI RINGKAS (MUDAH DIBACA)
// ========================================================
let readableModalPrimaryAction = null;
let readableModalSecondaryAction = null;

function showReadableModal(options) {
    const modal = document.getElementById('modal-readable-detail');
    if (!modal) return;

    const iconWrap = document.getElementById('popup-detail-icon-wrap');
    const icon = document.getElementById('popup-detail-icon');
    const title = document.getElementById('popup-detail-title');
    const subtitle = document.getElementById('popup-detail-subtitle');
    const card = document.getElementById('popup-detail-card');
    const btnPri = document.getElementById('popup-detail-btn-pri');
    const btnSec = document.getElementById('popup-detail-btn-sec');

    if (icon) icon.className = options.icon || 'fa-solid fa-circle-check';
    if (iconWrap) {
        iconWrap.className = options.iconWrapClass || 'w-14 h-14 bg-teal-50 border border-teal-200 text-teal-700 rounded-2xl mx-auto flex items-center justify-center text-2xl shadow-sm';
    }
    if (title) title.innerText = options.title || 'Informasi';
    if (subtitle) {
        subtitle.innerText = options.subtitle || '';
        subtitle.style.display = options.subtitle ? 'block' : 'none';
    }

    if (card && Array.isArray(options.rows)) {
        card.innerHTML = options.rows.map(row => {
            let valHtml = '';
            if (row.isBadge) {
                valHtml = `<span class="${row.badgeClass || 'px-2 py-0.5 rounded font-bold bg-teal-50 text-teal-800 border border-teal-200 text-[11px]'}">${row.value}</span>`;
            } else if (row.highlight) {
                valHtml = `<span class="font-extrabold text-teal-800 text-sm font-mono">${row.value}</span>`;
            } else {
                valHtml = `<span class="font-semibold text-slate-800 text-right max-w-[65%]">${row.value}</span>`;
            }

            return `
                <div class="flex justify-between items-start gap-2 py-1.5 border-b border-slate-200/60 last:border-b-0">
                    <span class="text-slate-500 font-medium">${row.label}</span>
                    ${valHtml}
                </div>
            `;
        }).join('');
    }

    // Tombol Utama (Primary)
    if (btnPri) {
        if (options.primaryBtn) {
            btnPri.innerText = options.primaryBtn.text || 'Lanjut';
            btnPri.className = options.primaryBtn.class || 'flex-1 bg-teal-700 hover:bg-teal-800 text-white font-bold py-2.5 rounded-xl text-xs transition shadow-sm';
            btnPri.style.display = 'block';
            readableModalPrimaryAction = options.primaryBtn.onClick || null;
            btnPri.onclick = () => {
                closeReadableDetailModal();
                if (typeof readableModalPrimaryAction === 'function') readableModalPrimaryAction();
            };
        } else {
            btnPri.style.display = 'none';
        }
    }

    // Tombol Sekunder (Secondary)
    if (btnSec) {
        if (options.secondaryBtn) {
            btnSec.innerText = options.secondaryBtn.text || 'Tutup';
            btnSec.className = options.secondaryBtn.class || 'flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 rounded-xl text-xs transition';
            btnSec.style.display = 'block';
            readableModalSecondaryAction = options.secondaryBtn.onClick || null;
            btnSec.onclick = () => {
                closeReadableDetailModal();
                if (typeof readableModalSecondaryAction === 'function') readableModalSecondaryAction();
            };
        } else {
            btnSec.style.display = 'none';
        }
    }

    modal.classList.remove('hidden');
}

function closeReadableDetailModal() {
    const modal = document.getElementById('modal-readable-detail');
    if (modal) modal.classList.add('hidden');
}

// Pop-up Logout (1 Detik) & Hapus Data Login
function handleLogout() {
    sessionStorage.clear();
    currentUser = null;

    // Bersihkan seluruh data input login & register
    const loginUser = document.getElementById('login-username');
    const loginPass = document.getElementById('login-password');
    if (loginUser) loginUser.value = '';
    if (loginPass) loginPass.value = '';

    const regNama = document.getElementById('reg-nama');
    const regHp = document.getElementById('reg-hp');
    const regPass = document.getElementById('reg-password');
    const regConfirm = document.getElementById('reg-password-confirm');
    if (regNama) regNama.value = '';
    if (regHp) regHp.value = '';
    if (regPass) regPass.value = '';
    if (regConfirm) regConfirm.value = '';

    // Bersihkan pencarian kasir jika ada
    clearSelectedCustomer();

    const modal = document.getElementById('modal-logout-success');
    if (modal) modal.classList.remove('hidden');

    if (logoutTimer) clearTimeout(logoutTimer);
    logoutTimer = setTimeout(() => {
        dismissLogoutModal();
    }, 1000);
}

function dismissLogoutModal() {
    if (logoutTimer) { clearTimeout(logoutTimer); logoutTimer = null; }
    const modal = document.getElementById('modal-logout-success');
    if (modal) modal.classList.add('hidden');
    showPublicLanding();
}

// ========================================================
// CONTROLLER DASHBOARD VIEW SESUAI ROLE
// ========================================================
function initDashboardView() {
    const screenPublic = document.getElementById('screen-public');
    const screenLogin = document.getElementById('screen-login');
    const screenDashboard = document.getElementById('screen-dashboard');

    if (!currentUser) {
        showPublicLanding();
        return;
    }

    if (screenPublic) screenPublic.classList.add('hidden');
    if (screenLogin) screenLogin.classList.add('hidden');
    if (screenDashboard) screenDashboard.classList.remove('hidden');

    ['admin', 'pelanggan', 'owner'].forEach(r => {
        const el = document.getElementById(`view-${r}`);
        if (el) el.classList.add('hidden');
    });

    if (currentUser.role === 'admin') {
        const vAdm = document.getElementById('view-admin');
        if (vAdm) vAdm.classList.remove('hidden');
        const sName = document.getElementById('admin-sidebar-name');
        if (sName) sName.innerText = currentUser.nama;
        const kName = document.getElementById('kasir-name-display');
        if (kName) kName.innerText = currentUser.nama;
        switchAdminTab('input-order');
        refreshNextAutoResi();
        calculateKasirTotals();
        renderOnlineOrdersTable();
    } else if (currentUser.role === 'pelanggan') {
        const vPel = document.getElementById('view-pelanggan');
        if (vPel) vPel.classList.remove('hidden');
        const pName = document.getElementById('pelanggan-name-nav');
        if (pName) pName.innerText = currentUser.nama;
        switchPelangganTab('buat');
        initPelangganJadwal();
        updateJamKerjaBanner();
        updateCashMethodOption();
        renderPelangganOrders();
    } else if (currentUser.role === 'owner') {
        const vOwn = document.getElementById('view-owner');
        if (vOwn) vOwn.classList.remove('hidden');
        switchOwnerTab('pemasukan');
    }

    if (typeof window.scrollTo === 'function') {
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }
}

// ========================================================
// 1. PUBLIC LANDING TRACKING RESI (Page 1 & 3)
// ========================================================
function trackPublicResi() {
    const q = document.getElementById('public-tracking-input').value.trim().toUpperCase();
    if (!q) {
        triggerLoginError('Silakan masukkan nomor pesanan / resi yang ingin dilacak.', 'Lacak Pesanan');
        return;
    }

    const item = dataset.find(x => x.resi.toUpperCase() === q);
    const detailBox = document.getElementById('public-tracking-detail');

    const pills = [
        document.getElementById('pill-step-1'),
        document.getElementById('pill-step-2'),
        document.getElementById('pill-step-3'),
        document.getElementById('pill-step-4')
    ];

    // Reset pills
    pills.forEach(p => {
        if (p) p.className = 'py-1.5 px-2 rounded-lg bg-slate-50 border border-slate-200 text-slate-500 font-medium';
    });

    if (!item) {
        detailBox.classList.remove('hidden');
        detailBox.className = 'mt-3 p-3 bg-rose-50 border border-rose-100 rounded-xl text-xs text-rose-700';
        detailBox.innerHTML = `Nomor pesanan <strong>${q}</strong> tidak ditemukan. Pastikan nomor pesanan sudah benar.`;
        return;
    }

    // Tangani status Menunggu Konfirmasi
    if (item.status === 'Menunggu Konfirmasi') {
        detailBox.classList.remove('hidden');
        detailBox.className = 'mt-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 space-y-1';
        detailBox.innerHTML = `
            <div class="flex justify-between font-bold">
                <span>${item.resi} · ${item.nama}</span>
                <span class="text-amber-700">⏳ Menunggu Konfirmasi</span>
            </div>
            <div class="text-[11px] text-amber-800">
                Layanan: ${item.layanan} (${item.berat} kg) · Pembayaran: ${item.metode} (${item.statusBayar})
            </div>
            <p class="text-[10px] text-amber-700 mt-1">Pembayaran pesanan Anda sedang diverifikasi oleh admin kami sebelum proses pencucian dimulai.</p>
            ${getQueueTrackLineHtml(item)}${getCourierTrackLineHtml(item)}${getExpressTrackLineHtml(item)}
        `;
        return;
    }

    // Sesuaikan teks tahapan pill sesuai tipe pesanan (Kurir vs Ambil Toko)
    const isJemput = (item.tipe === 'Dijemput kurir');
    if (pills[0]) pills[0].innerText = isJemput ? 'Dijemput' : 'Diterima';
    if (pills[3]) pills[3].innerText = isJemput ? 'Diantar' : 'Siap Diambil';

    // Tentukan index tahapan: Dijemput/Diterima (1), Dicuci (2), Disetrika (3), Diantar / Siap Diambil / Selesai (4)
    let stepIndex = 1;
    if (item.status === 'Baru' || item.status === 'Dijemput') stepIndex = 1;
    else if (item.status === 'Diproses' || item.status === 'Dicuci') stepIndex = 2;
    else if (item.status === 'Disetrika') stepIndex = 3;
    else if (item.status === 'Siap diantar' || item.status === 'Siap diambil' || item.status === 'Selesai') stepIndex = 4;

    for (let i = 0; i < stepIndex; i++) {
        if (pills[i]) {
            pills[i].className = 'py-1.5 px-2 rounded-lg bg-teal-50 border border-teal-600 text-teal-800 font-bold';
        }
    }

    detailBox.classList.remove('hidden');
    detailBox.className = 'mt-3 p-3 bg-teal-50 border border-teal-100 rounded-xl text-xs text-teal-900 space-y-1';
    detailBox.innerHTML = `
        <div class="flex justify-between font-bold">
            <span>${item.resi} · ${item.nama}</span>
            <span class="text-teal-700">${item.status}</span>
        </div>
        <div class="text-[11px] text-teal-800">
            Layanan: ${item.layanan} (${item.berat} kg) · Pembayaran: ${item.metode} (${item.statusBayar})
        </div>
        ${getQueueTrackLineHtml(item)}${getCourierTrackLineHtml(item)}${getExpressTrackLineHtml(item)}
    `;
}

// ========================================================
// 2. KASIR / ADMIN LOGIC (Page 2, 11, 12, 14)
// ========================================================
function switchAdminTab(tab) {
    const tabInput = document.getElementById('admin-tab-input');
    const tabOnline = document.getElementById('admin-tab-online');
    const navInput = document.getElementById('admin-nav-input');
    const navOnline = document.getElementById('admin-nav-online');

    if (tab === 'input-order') {
        if (tabInput) tabInput.classList.remove('hidden');
        if (tabOnline) tabOnline.classList.add('hidden');
        if (navInput) navInput.className = 'flex-1 md:w-full text-left px-4 py-2.5 rounded-xl bg-teal-800 text-white transition flex items-center gap-2.5';
        if (navOnline) navOnline.className = 'flex-1 md:w-full text-left px-4 py-2.5 rounded-xl text-slate-300 hover:bg-navy-800 hover:text-white transition flex items-center justify-between';
    } else {
        if (tabInput) tabInput.classList.add('hidden');
        if (tabOnline) tabOnline.classList.remove('hidden');
        if (navOnline) navOnline.className = 'flex-1 md:w-full text-left px-4 py-2.5 rounded-xl bg-teal-800 text-white transition flex items-center justify-between';
        if (navInput) navInput.className = 'flex-1 md:w-full text-left px-4 py-2.5 rounded-xl text-slate-300 hover:bg-navy-800 hover:text-white transition flex items-center gap-2.5';
        renderOnlineOrdersTable();
    }
}

// ========================================================
// NOMOR RESI ACAK (format LD-XXXXXX, tanpa huruf/angka yang mirip: 0/O, 1/I)
// ========================================================
const RESI_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 karakter
let pendingKasirResi = null; // resi yang sedang ditampilkan di layar kasir

function randomResiCode(length = 6) {
    const bytes = new Uint8Array(length);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = '';
    for (const b of bytes) out += RESI_ALPHABET[b & 31];
    return out;
}

function isResiUsed(resi) {
    const key = String(resi).toUpperCase();
    return Array.isArray(dataset) && dataset.some(x => x && String(x.resi).toUpperCase() === key);
}

// Membuat resi acak yang belum dipakai pesanan lain
function getNextResiNumber() {
    let resi;
    let tries = 0;
    do {
        resi = `LD-${randomResiCode()}`;
        tries++;
    } while (isResiUsed(resi) && tries < 50);
    return resi;
}

// Resi di layar kasir dibuat sekali, dan dipakai persis sama saat order disimpan
function refreshNextAutoResi(forceNew = false) {
    if (forceNew || !pendingKasirResi || isResiUsed(pendingKasirResi)) {
        pendingKasirResi = getNextResiNumber();
    }
    const el = document.getElementById('auto-resi-display');
    if (el) el.innerText = pendingKasirResi;
}

function selectKasirRadio(group, value, element) {
    const pill = element.closest('.radio-pill');
    if (!pill) return;
    const container = pill.parentElement;
    container.querySelectorAll('.radio-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');

    if (group === 'metode') {
        document.getElementById('kasir-metode-val').value = value;
    }
    if (group === 'status-bayar') document.getElementById('kasir-status-bayar-val').value = value;
}

// Helper Waktu Express Otomatis: H+4 Jam setelah order
function getExpressEstimatedTime() {
    const now = new Date();
    now.setHours(now.getHours() + 4);
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const timeStr = `${hh}:${mm}`;

    const today = new Date();
    if (now.getDate() === today.getDate()) {
        return `Hari ini, ${timeStr} WIB (4 Jam Selesai)`;
    } else {
        return `Besok, ${timeStr} WIB (4 Jam Selesai)`;
    }
}

// Logika Pilihan Hari & Jam Kasir dengan Tombol
let kasirSelectedHari = 'Besok';
let kasirSelectedJam = '17:00';

function updateKasirEstimasiInput() {
    const el = document.getElementById('kasir-estimasi');
    if (el) el.value = `${kasirSelectedHari}, ${kasirSelectedJam} WIB`;
}

function selectKasirHari(hari, el) {
    kasirSelectedHari = hari;
    document.querySelectorAll('#group-kasir-hari .btn-kasir-hari').forEach(b => {
        b.className = 'btn-kasir-hari px-2.5 py-1.5 rounded-lg border border-slate-200 hover:border-teal-600 text-slate-700 text-center font-medium transition text-[11px]';
    });
    if (el) {
        el.className = 'btn-kasir-hari active px-2.5 py-1.5 rounded-lg border border-teal-600 bg-teal-50 text-teal-800 text-center font-bold transition text-[11px]';
    }
    updateKasirEstimasiInput();
}

function selectKasirJam(jam, el) {
    kasirSelectedJam = jam;
    document.querySelectorAll('#group-kasir-jam .btn-kasir-jam').forEach(b => {
        b.className = 'btn-kasir-jam px-1.5 py-1.5 rounded-lg border border-slate-200 hover:border-teal-600 text-slate-700 text-center font-medium transition text-[11px]';
    });
    if (el) {
        el.className = 'btn-kasir-jam active px-1.5 py-1.5 rounded-lg border border-teal-600 bg-teal-50 text-teal-800 text-center font-bold transition text-[11px]';
    }
    updateKasirEstimasiInput();
}

function setKasirExpress4Jam() {
    const el = document.getElementById('kasir-estimasi');
    if (el) el.value = getExpressEstimatedTime();
    showCloudToast('Estimasi Express otomatis diset: H+4 Jam!');
}

function selectKasirTipe(tipe, el) {
    const hidden = document.getElementById('kasir-tipe-val');
    if (hidden) hidden.value = tipe;

    document.querySelectorAll('#kasir-tipe-group .btn-kasir-tipe').forEach(b => {
        b.className = 'btn-kasir-tipe p-2.5 rounded-xl border border-slate-200 hover:border-teal-600 text-slate-700 text-xs font-medium text-left transition flex items-center gap-2';
    });
    if (el) {
        el.className = 'btn-kasir-tipe active p-2.5 rounded-xl border border-teal-600 bg-teal-50 text-teal-800 text-xs font-bold text-left transition flex items-center gap-2';
    }

    const secAlamat = document.getElementById('section-kasir-alamat');
    if (secAlamat) {
        if (tipe === 'Dijemput kurir') {
            secAlamat.classList.remove('hidden');
        } else {
            secAlamat.classList.add('hidden');
        }
    }

    calculateKasirTotals();
}

function calculateKasirTotals() {
    const qtyKiloan = parseFloat(document.getElementById('qty-kiloan').value) || 0;
    const qtyExpress = parseFloat(document.getElementById('qty-express').value) || 0;
    const tipe = document.getElementById('kasir-tipe-val')?.value || 'Order di Toko';

    const subKiloan = qtyKiloan * 7000;
    const subExpress = qtyExpress * 10000;
    const subtotal = subKiloan + subExpress;
    const ongkir = (tipe === 'Dijemput kurir') ? 3000 : 0;
    const total = subtotal + ongkir;

    const subKiloText = document.getElementById('subtotal-kiloan-text');
    const subExpText = document.getElementById('subtotal-express-text');
    const subDisp = document.getElementById('kasir-subtotal-display');
    const ongDisp = document.getElementById('kasir-ongkir-display');
    const totDisp = document.getElementById('kasir-total-display');

    if (subKiloText) subKiloText.innerText = `Rp ${subKiloan.toLocaleString('id-ID')}`;
    if (subExpText) subExpText.innerText = `Rp ${subExpress.toLocaleString('id-ID')}`;
    if (subDisp) subDisp.innerText = `Rp ${subtotal.toLocaleString('id-ID')}`;
    if (ongDisp) ongDisp.innerText = `Rp ${ongkir.toLocaleString('id-ID')}`;
    if (totDisp) totDisp.innerText = `Rp ${total.toLocaleString('id-ID')}`;

    // Jika pesanan didominasi Express, otomatis set estimasi ke H+4 Jam
    if (qtyExpress > 0 && qtyKiloan === 0) {
        const estEl = document.getElementById('kasir-estimasi');
        if (estEl && !estEl.value.includes('4 Jam')) {
            estEl.value = getExpressEstimatedTime();
        }
    }

    return { subtotal, ongkir, total, qtyKiloan, qtyExpress, tipe };
}

function autocompleteCustomer(val) {
    const q = val.trim().toLowerCase();
    if (!q) return;

    // Search in existing users or dataset
    const foundUser = users.find(u => u.nama.toLowerCase().includes(q) || u.hp.includes(q)) ||
                      dataset.find(d => d.nama.toLowerCase().includes(q) || d.hp.includes(q));

    if (foundUser && q.length >= 3) {
        document.getElementById('kasir-cust-name').value = foundUser.nama;
        document.getElementById('kasir-cust-hp').value = foundUser.hp;
        document.getElementById('cust-selected-name').innerText = foundUser.nama;
        document.getElementById('cust-selected-hp').innerText = foundUser.hp;
        document.getElementById('kasir-cust-selected').classList.remove('hidden');
    }
}

function clearSelectedCustomer() {
    const search = document.getElementById('kasir-cust-search');
    const name = document.getElementById('kasir-cust-name');
    const hp = document.getElementById('kasir-cust-hp');
    const sel = document.getElementById('kasir-cust-selected');
    if (search) search.value = '';
    if (name) name.value = '';
    if (hp) hp.value = '';
    if (sel) sel.classList.add('hidden');
}

// Pop-up Tambah Pelanggan Baru di Kasir
function openNewCustomerModal() {
    const modal = document.getElementById('modal-pelanggan-baru');
    if (!modal) return;
    document.getElementById('modal-cust-nama').value = '';
    document.getElementById('modal-cust-hp').value = '';
    document.getElementById('modal-cust-alamat').value = '';
    modal.classList.remove('hidden');
    setTimeout(() => {
        document.getElementById('modal-cust-nama').focus();
    }, 100);
}

function closeNewCustomerModal() {
    const modal = document.getElementById('modal-pelanggan-baru');
    if (modal) modal.classList.add('hidden');
}

async function submitNewCustomerModal(e) {
    if (e) e.preventDefault();
    const nama = document.getElementById('modal-cust-nama').value.trim();
    const hp = document.getElementById('modal-cust-hp').value.trim();
    const alamat = document.getElementById('modal-cust-alamat').value.trim();

    if (!nama) {
        triggerLoginError('Mohon masukkan nama lengkap pelanggan!', 'Data Belum Lengkap');
        return;
    }

    const check = validateIndonesianPhone(hp);
    if (!check.valid) {
        triggerLoginError(check.message, 'Format Nomor HP Salah');
        return;
    }

    // Cek apakah sudah terdaftar
    const existing = users.find(u => u.hp === check.cleanNumber || (u.username && u.username === check.cleanNumber));
    let isExisting = false;
    if (existing) {
        isExisting = true;
    } else {
        const newUser = { nama, hp: check.cleanNumber, alamat, password: 'User123', role: 'pelanggan' };
        users.push(newUser);
        saveUsers();

        if (typeof insertUserToDB === 'function') {
            await insertUserToDB(newUser);
        }
    }

    // Set langsung ke form kasir
    document.getElementById('kasir-cust-name').value = nama;
    document.getElementById('kasir-cust-hp').value = check.cleanNumber;
    document.getElementById('kasir-cust-search').value = `${nama} (${check.cleanNumber})`;
    document.getElementById('cust-selected-name').innerText = nama;
    document.getElementById('cust-selected-hp').innerText = check.cleanNumber;
    document.getElementById('kasir-cust-selected').classList.remove('hidden');

    closeNewCustomerModal();

    showReadableModal({
        icon: 'fa-solid fa-user-check text-teal-600',
        iconWrapClass: 'w-14 h-14 bg-teal-50 border border-teal-200 text-teal-700 rounded-2xl mx-auto flex items-center justify-center text-2xl shadow-sm',
        title: isExisting ? 'Pelanggan Terpilih!' : 'Pelanggan Baru Disimpan!',
        subtitle: isExisting ? 'Nomor telepon pelanggan ini sudah terdaftar sebelumnya. Data langsung disiapkan di form kasir.' : 'Pelanggan baru berhasil didaftarkan dan langsung terpilih di kasir.',
        rows: [
            { label: 'Nama Pelanggan', value: nama },
            { label: 'Nomor WhatsApp / HP', value: check.cleanNumber, isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-800' },
            { label: 'Alamat', value: alamat || '-' }
        ],
        primaryBtn: {
            text: 'Lanjut Input Order',
            onClick: () => {}
        }
    });
}

function quickNewCustomer() {
    openNewCustomerModal();
}

async function handleKasirOrder(e) {
    e.preventDefault();
    const { subtotal, ongkir, total, qtyKiloan, qtyExpress, tipe } = calculateKasirTotals();

    // Validasi Minimal Order 1 kg
    const totalBerat = qtyKiloan + qtyExpress;
    if (totalBerat < 1) {
        triggerLoginError('Minimal order cucian adalah 1 kg! Silakan masukkan berat cucian minimal 1 kg.', 'Order Gagal');
        return;
    }

    // Validasi batas berat: Express maks 5 kg, Cuci Kiloan maks 15 kg
    if (qtyExpress > MAX_KG_EXPRESS) {
        triggerLoginError(`Maksimal order Express adalah ${MAX_KG_EXPRESS} kg. Kurangi berat Express atau pindahkan ke Cuci Kiloan.`, 'Berat Melebihi Batas');
        return;
    }
    if (qtyKiloan > MAX_KG_NORMAL) {
        triggerLoginError(`Maksimal order Cuci Kiloan adalah ${MAX_KG_NORMAL} kg per pesanan.`, 'Berat Melebihi Batas');
        return;
    }

    let nama = document.getElementById('kasir-cust-name').value.trim();
    let hp = document.getElementById('kasir-cust-hp').value.trim();

    if (!nama) {
        nama = document.getElementById('kasir-cust-search').value.trim() || 'Pelanggan Toko';
        hp = '081234567890';
    }

    const alamatEl = document.getElementById('kasir-alamat');
    const alamat = (alamatEl && alamatEl.value ? alamatEl.value : '').trim();

    if (tipe === 'Dijemput kurir' && !alamat) {
        triggerLoginError('Mohon isi alamat lengkap pengantaran / penjemputan kurir!', 'Alamat Kurir Wajib Diisi');
        if (alamatEl) alamatEl.focus();
        return;
    }

    const finalAlamat = (tipe === 'Dijemput kurir') ? alamat : (alamat || 'Gerai Toko DMS Laundry');
    const initialStatus = (tipe === 'Dijemput kurir') ? 'Baru' : 'Diproses';
    // Pakai resi yang tampil di layar kasir; setelah dipakai, kosongkan agar order berikutnya dapat resi baru
    const resi = (pendingKasirResi && !isResiUsed(pendingKasirResi)) ? pendingKasirResi : getNextResiNumber();
    pendingKasirResi = null;

    let layananStr = [];
    if (qtyKiloan > 0) layananStr.push(`Cuci Kiloan (${qtyKiloan} kg)`);
    if (qtyExpress > 0) layananStr.push(`Express (${qtyExpress} kg)`);

    const item = {
        resi,
        nama,
        hp,
        layanan: layananStr.join(', '),
        berat: qtyKiloan + qtyExpress,
        tipe,
        alamat: finalAlamat,
        // Express yang dijemput kurir: pakaian belum di toko, jadi 4 jam kerja dihitung nanti saat diterima
        jam: (qtyExpress > 0 && tipe === 'Dijemput kurir')
            ? `Estimasi selesai: ${EXPRESS_PENDING_TEXT}`
            : document.getElementById('kasir-estimasi').value,
        catatan: '',
        subtotal,
        diskon: 0,
        ongkir,
        total,
        metode: document.getElementById('kasir-metode-val').value,
        statusBayar: document.getElementById('kasir-status-bayar-val').value,
        status: initialStatus,
        tanggal: new Date().toISOString().split('T')[0]
    };

    dataset.unshift(item);
    saveData();

    // Simpan ke Supabase jika terhubung (dicatat sebagai 'belum terkirim' sampai berhasil)
    await pushOrderToCloud(item);

    // Reset Form
    clearSelectedCustomer();
    document.getElementById('qty-kiloan').value = 0;
    document.getElementById('qty-express').value = 0;
    if (alamatEl) alamatEl.value = '';
    const defTipeBtn = document.querySelector('#kasir-tipe-group .btn-kasir-tipe');
    if (defTipeBtn) selectKasirTipe('Order di Toko', defTipeBtn);
    calculateKasirTotals();
    refreshNextAutoResi();

    // Pop-up Ringkasan Order Kasir yang Mudah Dibaca
    showReadableModal({
        icon: 'fa-solid fa-file-invoice text-teal-600',
        iconWrapClass: 'w-14 h-14 bg-teal-50 border border-teal-200 text-teal-700 rounded-2xl mx-auto flex items-center justify-center text-2xl shadow-sm',
        title: 'Order Kasir Berhasil Disimpan!',
        subtitle: 'Pesanan telah dicatat ke sistem & database. Anda dapat langsung mencetak struk kasir.',
        rows: [
            { label: 'Nomor Resi', value: item.resi, isBadge: true, badgeClass: 'px-2.5 py-1 rounded-md font-extrabold text-teal-800 bg-teal-50 border border-teal-300 font-mono text-xs' },
            { label: 'Nama Pelanggan', value: `${item.nama} (${item.hp})` },
            { label: 'Tipe Order', value: `${item.tipe} (${ongkir > 0 ? 'Ongkir Rp ' + ongkir.toLocaleString('id-ID') : 'Rp 0'})` },
            { label: 'Layanan Cucian', value: item.layanan },
            { label: 'Total Pembayaran', value: `Rp ${item.total.toLocaleString('id-ID')}`, highlight: true },
            { label: 'Status Pembayaran', value: `${item.metode} (${item.statusBayar})`, isBadge: true, badgeClass: item.statusBayar === 'Lunas' ? 'px-2 py-0.5 rounded font-bold bg-emerald-50 text-emerald-700 border border-emerald-200' : 'px-2 py-0.5 rounded font-bold bg-rose-50 text-rose-700 border border-rose-200' },
            { label: 'Estimasi Selesai', value: displayJam(item.jam) }
        ],
        primaryBtn: {
            text: '🖨️ Cetak Struk Resi',
            class: 'flex-1 bg-teal-700 hover:bg-teal-800 text-white font-bold py-2.5 rounded-xl text-xs transition shadow-sm',
            onClick: () => {
                showReceipt(item);
            }
        },
        secondaryBtn: {
            text: 'Input Order Baru',
            onClick: () => {}
        }
    });
}

// Kelola Semua Pesanan Admin (Order di Toko & Pesanan Online)
let currentOnlineFilter = 'Semua';
function filterOnlineOrders(filter, btn) {
    currentOnlineFilter = filter;
    document.querySelectorAll('.filter-pill').forEach(b => {
        b.className = 'filter-pill px-3 py-1.5 rounded-full text-xs font-semibold bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 transition';
    });
    if (btn) {
        btn.className = 'filter-pill active px-3 py-1.5 rounded-full text-xs font-semibold bg-teal-50 text-teal-700 border border-teal-600 transition';
    }
    renderOnlineOrdersTable();
}

function renderOnlineOrdersTable() {
    const tbody = document.getElementById('tabel-online-body');
    const cardsContainer = document.getElementById('tabel-online-cards');
    if (!tbody && !cardsContainer) return;

    // Counter total semua pesanan
    const totalCount = dataset.length;
    const countAllEl = document.getElementById('count-all-orders');
    if (countAllEl) countAllEl.innerText = totalCount;

    const baruCount = dataset.filter(x => x.status === 'Baru').length;
    const badgeCount = document.getElementById('badge-online-count');
    if (badgeCount) badgeCount.innerText = baruCount;

    let items = [...dataset];

    if (currentOnlineFilter === 'Order di Toko') {
        items = items.filter(x => x.tipe === 'Order di Toko');
    } else if (currentOnlineFilter === 'Dijemput kurir') {
        items = items.filter(x => x.tipe === 'Dijemput kurir');
    } else if (currentOnlineFilter === 'Antar sendiri ke toko') {
        items = items.filter(x => x.tipe === 'Antar sendiri ke toko');
    } else if (currentOnlineFilter === 'Online') {
        items = items.filter(x => x.tipe === 'Dijemput kurir' || x.tipe === 'Antar sendiri ke toko');
    } else if (currentOnlineFilter === 'Menunggu Konfirmasi') {
        items = items.filter(x => x.status === 'Menunggu Konfirmasi' || x.statusBayar === 'Menunggu Konfirmasi');
    } else if (currentOnlineFilter === 'Siap diantar') {
        items = items.filter(x => x.status === 'Siap diantar' || x.status === 'Siap diambil');
    } else if (currentOnlineFilter !== 'Semua') {
        items = items.filter(x => x.status === currentOnlineFilter);
    }

    if (items.length === 0) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-slate-400">Tidak ada pesanan pada kategori filter "${currentOnlineFilter}".</td></tr>`;
        if (cardsContainer) cardsContainer.innerHTML = `<div class="p-8 text-center text-slate-400 text-xs">Tidak ada pesanan pada kategori filter "${currentOnlineFilter}".</div>`;
        return;
    }

    // Helper untuk generate elemen baris dan kartu
    const renderedItems = items.map(item => {
        // Status Badges
        let statusBadge = '';
        if (item.status === 'Menunggu Konfirmasi') {
            statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-300 animate-pulse inline-flex items-center gap-1"><i class="fa-solid fa-clock"></i>Menunggu Konfirmasi</span>`;
        } else if (item.status === 'Baru') {
            statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200 inline-flex items-center gap-1"><i class="fa-solid fa-sparkles"></i>Baru</span>`;
        } else if (item.status === 'Dijemput') {
            statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200 inline-flex items-center gap-1"><i class="fa-solid fa-motorcycle"></i>Dijemput</span>`;
        } else if (item.status === 'Diproses' || item.status === 'Dicuci') {
            statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-teal-50 text-teal-700 border border-teal-200 inline-flex items-center gap-1"><i class="fa-solid fa-jug-detergent"></i>Diproses</span>`;
        } else if (item.status === 'Siap diantar') {
            statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 inline-flex items-center gap-1"><i class="fa-solid fa-truck-fast"></i>Siap diantar</span>`;
        } else if (item.status === 'Siap diambil') {
            statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 inline-flex items-center gap-1"><i class="fa-solid fa-store"></i>Siap diambil</span>`;
        } else {
            statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 inline-flex items-center gap-1"><i class="fa-solid fa-check"></i>${item.status}</span>`;
        }

        // Penanda antrean di luar jam kerja
        const queueBadge = getQueueBadgeHtml(item);
        if (queueBadge) statusBadge += `<div class="mt-1">${queueBadge}</div>`;
        const courierBadge = getCourierBadgeHtml(item);
        if (courierBadge) statusBadge += `<div class="mt-1">${courierBadge}</div>`;
        const expressBadge = getExpressBadgeHtml(item);
        if (expressBadge) statusBadge += `<div class="mt-1">${expressBadge}</div>`;

        // Payment Badges
        let bayarBadge = item.statusBayar === 'Lunas' ?
            `<span class="text-emerald-700 font-bold">Lunas</span>` :
            item.statusBayar === 'Menunggu Konfirmasi' ?
            `<span class="text-amber-700 font-bold">Menunggu Konfirmasi</span>` :
            `<span class="text-rose-600 font-bold">Belum dibayar</span>`;

        // Tipe Badge (Toko vs Antar Toko vs Jemput Kurir)
        let tipeBadge = '';
        if (item.tipe === 'Order di Toko') {
            tipeBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200 inline-flex items-center gap-1"><i class="fa-solid fa-shop text-[9px]"></i>Order Toko</span>`;
        } else if (item.tipe === 'Antar sendiri ke toko') {
            tipeBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 inline-flex items-center gap-1"><i class="fa-solid fa-store text-[9px]"></i>Antar Toko</span>`;
        } else {
            tipeBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-teal-50 text-teal-700 border border-teal-200 inline-flex items-center gap-1"><i class="fa-solid fa-motorcycle text-[9px]"></i>${item.tipe || 'Dijemput kurir'}</span>`;
        }

        // Action Buttons: Sesuai Tipe Order (Kurir vs Ambil Toko)
        const isJemput = (item.tipe === 'Dijemput kurir');
        let actionBtn = `
            <div class="flex items-center justify-center gap-1.5 flex-wrap">
                <button onclick="openAdminUpdateModal('${item.resi}')" title="Update Pesanan" class="px-2.5 py-1.5 rounded-lg bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 font-bold text-xs transition flex items-center gap-1 shadow-sm">
                    <i class="fa-solid fa-pen-to-square"></i> Update
                </button>
        `;

        if (item.status === 'Menunggu Konfirmasi') {
            actionBtn += `<button onclick="confirmAdminPayment('${item.resi}')" class="px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white font-bold hover:bg-emerald-700 transition text-xs flex items-center gap-1 shadow-sm"><i class="fa-solid fa-check"></i> Konfirmasi</button>`;
        } else if (item.status === 'Baru') {
            if (isJemput) {
                actionBtn += `<button onclick="advanceOrderStatus('${item.resi}', 'Dijemput')" class="px-2.5 py-1.5 rounded-lg bg-teal-700 text-white font-semibold hover:bg-teal-800 transition text-xs flex items-center gap-1"><i class="fa-solid fa-motorcycle text-[10px]"></i> Jemput</button>`;
            } else {
                actionBtn += `<button onclick="advanceOrderStatus('${item.resi}', 'Diproses')" class="px-2.5 py-1.5 rounded-lg bg-teal-700 text-white font-semibold hover:bg-teal-800 transition text-xs flex items-center gap-1"><i class="fa-solid fa-shop text-[10px]"></i> Terima</button>`;
            }
        } else if (item.status === 'Dijemput') {
            actionBtn += `<button onclick="advanceOrderStatus('${item.resi}', 'Diproses')" class="px-2.5 py-1.5 rounded-lg bg-teal-700 text-white font-semibold hover:bg-teal-800 transition text-xs flex items-center gap-1"><i class="fa-solid fa-jug-detergent text-[10px]"></i> Proses Cuci</button>`;
        } else if (item.status === 'Diproses') {
            const nextReady = isJemput ? 'Siap diantar' : 'Siap diambil';
            actionBtn += `<button onclick="advanceOrderStatus('${item.resi}', '${nextReady}')" class="px-2.5 py-1.5 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 transition text-xs flex items-center gap-1">${isJemput ? '<i class="fa-solid fa-truck-fast text-[10px]"></i> Siap Antar' : '<i class="fa-solid fa-store text-[10px]"></i> Siap Ambil'}</button>`;
        } else if (item.status === 'Siap diantar' || item.status === 'Siap diambil') {
            actionBtn += `<button onclick="advanceOrderStatus('${item.resi}', 'Selesai')" class="px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700 transition text-xs flex items-center gap-1"><i class="fa-solid fa-circle-check text-[10px]"></i> Selesai</button>`;
        }
        actionBtn += `<button onclick="showReceiptByResi('${item.resi}')" title="Cetak Struk" class="px-2 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition text-xs"><i class="fa-solid fa-print"></i></button>`;
        actionBtn += `</div>`;

        return { item, statusBadge, bayarBadge, tipeBadge, actionBtn };
    });

    // Render Table Rows (Desktop)
    if (tbody) {
        tbody.innerHTML = renderedItems.map(({ item, statusBadge, bayarBadge, tipeBadge, actionBtn }) => `
            <tr class="hover:bg-slate-50 transition border-b border-slate-100">
                <td class="p-4 font-bold text-teal-800 font-mono">${item.resi}</td>
                <td class="p-4">
                    <div class="font-semibold text-slate-900">${item.nama}</div>
                    <div class="text-[11px] text-slate-400 font-mono">${item.hp || '-'}</div>
                </td>
                <td class="p-4 whitespace-nowrap">${tipeBadge}</td>
                <td class="p-4 text-slate-700">
                    <div class="font-medium">${item.layanan}</div>
                    <div class="text-[11px] text-slate-400 font-mono">${item.berat} kg</div>
                </td>
                <td class="p-4 text-slate-700">
                    <div class="font-bold text-slate-900">Rp ${(item.total || 0).toLocaleString('id-ID')}</div>
                    <div class="text-[11px] text-slate-500">${item.metode} · ${bayarBadge}</div>
                </td>
                <td class="p-4 text-slate-600 font-mono text-[11px]">${displayJam(item.jam) || '-'}</td>
                <td class="p-4 whitespace-nowrap">${statusBadge}</td>
                <td class="p-4 text-center">${actionBtn}</td>
            </tr>
        `).join('');
    }

    // Render Cards View (Mobile)
    if (cardsContainer) {
        cardsContainer.innerHTML = renderedItems.map(({ item, statusBadge, bayarBadge, tipeBadge, actionBtn }) => `
            <div class="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-3">
                <div class="flex justify-between items-center">
                    <span class="font-extrabold text-teal-800 font-mono text-sm">${item.resi}</span>
                    ${statusBadge}
                </div>
                <div class="flex justify-between items-start text-xs border-b border-slate-100 pb-2.5">
                    <div>
                        <div class="font-bold text-slate-900 text-sm">${item.nama}</div>
                        <div class="text-[11px] text-slate-400 font-mono mt-0.5"><i class="fa-solid fa-phone text-[9px] mr-1"></i>${item.hp || '-'}</div>
                    </div>
                    <div class="text-right">
                        ${tipeBadge}
                    </div>
                </div>
                <div class="text-xs text-slate-600 space-y-1.5">
                    <div class="flex justify-between">
                        <span class="text-slate-400">Layanan Cucian:</span>
                        <span class="font-semibold text-slate-800">${item.layanan} (${item.berat} kg)</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-slate-400">Jadwal / Estimasi:</span>
                        <span class="font-semibold text-slate-800 font-mono text-[11px]">${displayJam(item.jam) || '-'}</span>
                    </div>
                    <div class="flex justify-between items-center pt-1 border-t border-slate-50">
                        <span class="text-slate-400">Total Biaya:</span>
                        <span class="font-extrabold text-teal-800 text-sm">Rp ${(item.total || 0).toLocaleString('id-ID')} · ${bayarBadge}</span>
                    </div>
                </div>
                <div class="pt-2 border-t border-slate-100">
                    ${actionBtn}
                </div>
            </div>
        `).join('');
    }
}

// Modal Admin Update Pesanan (Order di Toko & Online)
function openAdminUpdateModal(resi) {
    const item = dataset.find(x => x.resi === resi);
    if (!item) return;

    document.getElementById('update-modal-resi').innerText = item.resi;
    document.getElementById('update-modal-resi-val').value = item.resi;
    document.getElementById('update-modal-nama').innerText = `${item.nama} (${item.hp || '-'})`;
    const tipeSelect = document.getElementById('update-modal-tipe');
    if (tipeSelect) tipeSelect.value = item.tipe || 'Order di Toko';
    document.getElementById('update-modal-status').value = item.status || 'Diproses';
    document.getElementById('update-modal-status-bayar').value = item.statusBayar || 'Belum dibayar';
    document.getElementById('update-modal-metode').value = item.metode || 'Tunai';
    document.getElementById('update-modal-berat').value = item.berat || 1;
    document.getElementById('update-modal-total').value = item.total || 0;
    document.getElementById('update-modal-jam').value = item.jam || '';
    document.getElementById('update-modal-catatan').value = item.catatan || '';

    const modal = document.getElementById('modal-admin-update-pesanan');
    if (modal) modal.classList.remove('hidden');
}

function closeAdminUpdateModal() {
    const modal = document.getElementById('modal-admin-update-pesanan');
    if (modal) modal.classList.add('hidden');
}

async function submitAdminUpdateModal(e) {
    if (e) e.preventDefault();
    const resi = document.getElementById('update-modal-resi-val').value;
    const item = dataset.find(x => x.resi === resi);
    if (!item) return;

    const newTipe = document.getElementById('update-modal-tipe') ? document.getElementById('update-modal-tipe').value : item.tipe;
    const newStatus = document.getElementById('update-modal-status').value;
    const newStatusBayar = document.getElementById('update-modal-status-bayar').value;
    const newMetode = document.getElementById('update-modal-metode').value;
    const newBerat = parseFloat(document.getElementById('update-modal-berat').value) || item.berat;
    const newTotal = parseFloat(document.getElementById('update-modal-total').value) || item.total;
    const newJam = document.getElementById('update-modal-jam').value.trim();
    const newCatatan = document.getElementById('update-modal-catatan').value.trim();

    // Admin mengubah status ke Dijemput (pesanan kurir): kurir tiba 15 menit setelah verifikasi ini
    const prevStatus = item.status;
    let finalJam = newJam;
    if (newStatus === 'Dijemput' && prevStatus !== 'Dijemput' && newTipe === 'Dijemput kurir' && !COURIER_TAG_RE.test(newJam)) {
        finalJam = setCourierEtaTag(newJam, getCourierEta());
    }
    // Express: status diubah ke Diproses (pakaian diterima di toko) -> mulai hitung 4 jam kerja
    const expressProbe = { layanan: item.layanan, jam: finalJam };
    if (maybeStartExpressClock(expressProbe, newStatus, prevStatus)) finalJam = expressProbe.jam;

    // Update objek di dataset lokal
    item.tipe = newTipe;
    item.status = newStatus;
    item.statusBayar = newStatusBayar;
    item.metode = newMetode;
    item.berat = newBerat;
    item.total = newTotal;
    item.jam = finalJam;
    item.catatan = newCatatan;

    saveData();
    renderOnlineOrdersTable();

    // Jika owner sedang buka laporan bulanan, update juga rekapnya
    if (typeof renderOwnerStats === 'function') renderOwnerStats();
    if (typeof renderOwnerDetailedReport === 'function') renderOwnerDetailedReport();

    // Sinkronkan update ke Supabase Cloud
    if (typeof updateFullTransactionInDB === 'function') {
        await updateFullTransactionInDB(resi, {
            status: newStatus,
            status_bayar: newStatusBayar,
            tipe: newTipe,
            metode: newMetode,
            berat: newBerat,
            total: newTotal,
            jam: finalJam,
            catatan: newCatatan
        });
    }

    closeAdminUpdateModal();
    showCloudToast(`Pesanan ${resi} berhasil diperbarui!`);

    showReadableModal({
        icon: 'fa-solid fa-pen-to-square text-teal-600',
        iconWrapClass: 'w-14 h-14 bg-teal-50 border border-teal-200 text-teal-700 rounded-2xl mx-auto flex items-center justify-center text-2xl shadow-sm',
        title: 'Perubahan Pesanan Disimpan!',
        subtitle: `Data pesanan ${resi} telah diperbarui di sistem kasir & Supabase Cloud.`,
        rows: [
            { label: 'Nomor Resi', value: resi, isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-mono font-bold bg-teal-50 text-teal-800 border border-teal-300' },
            { label: 'Tipe Order', value: newTipe },
            { label: 'Status Pengerjaan', value: newStatus, isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-bold bg-teal-50 text-teal-700 border border-teal-200' },
            { label: 'Status Pembayaran', value: `${newMetode} (${newStatusBayar})`, isBadge: true, badgeClass: newStatusBayar === 'Lunas' ? 'px-2 py-0.5 rounded font-bold bg-emerald-50 text-emerald-700 border border-emerald-200' : 'px-2 py-0.5 rounded font-bold bg-amber-50 text-amber-700 border border-amber-200' },
            { label: 'Berat Cucian', value: `${newBerat} kg` },
            { label: 'Total Biaya', value: `Rp ${newTotal.toLocaleString('id-ID')}`, highlight: true },
            { label: 'Jadwal / Estimasi', value: newJam || '-' }
        ],
        primaryBtn: {
            text: 'Tutup & Lihat Pesanan',
            onClick: () => {}
        }
    });
}

async function advanceOrderStatus(resi, newStatus) {
    const item = dataset.find(x => x.resi === resi);
    if (!item) return;
    const prevStatus = item.status;
    item.status = newStatus;
    if (newStatus === 'Selesai') item.statusBayar = 'Lunas';

    // Pesanan dijemput kurir: kurir tiba 15 menit setelah verifikasi (saat admin menekan tombol ini)
    const courierEta = (newStatus === 'Dijemput' && isCourierOrder(item)) ? getCourierEta() : null;
    if (courierEta) item.jam = setCourierEtaTag(item.jam, courierEta);

    // Express: pakaian diterima di toko -> mulai hitung 4 jam kerja
    const expressTarget = maybeStartExpressClock(item, newStatus, prevStatus);

    saveData();
    renderOnlineOrdersTable();

    // Sinkronkan update status ke Supabase
    if ((courierEta || expressTarget) && typeof updateFullTransactionInDB === 'function') {
        if (courierEta) showCloudToast(`Pesanan ${resi} terverifikasi. Kurir menjemput sekitar ${formatWibClock(courierEta)} WIB.`);
        if (expressTarget) showCloudToast(`Pesanan Express ${resi} diterima. Estimasi selesai ${formatWibPukul(expressTarget)}.`);
        await updateFullTransactionInDB(resi, { status: newStatus, status_bayar: item.statusBayar, jam: item.jam });
    } else if (typeof updateTransactionStatusInDB === 'function') {
        await updateTransactionStatusInDB(resi, newStatus, item.statusBayar);
    }
}

// Konfirmasi Pembayaran oleh Admin (Verifikasi Status Pesanan)
async function confirmAdminPayment(resi) {
    const item = dataset.find(x => x.resi === resi);
    if (!item) return;

    // Pesanan dijemput kurir: setelah terverifikasi, kurir tiba 15 menit kemudian (status Dijemput)
    const prevStatus = item.status;
    const isCourier = isCourierOrder(item);
    const courierEta = isCourier ? getCourierEta() : null;
    item.status = isCourier ? 'Dijemput' : 'Diproses';
    item.statusBayar = 'Lunas';
    if (courierEta) item.jam = setCourierEtaTag(item.jam, courierEta);
    // Express non-kurir: dikonfirmasi -> Diproses, mulai hitung 4 jam kerja
    const expressTarget = maybeStartExpressClock(item, item.status, prevStatus);
    saveData();
    renderOnlineOrdersTable();

    if (typeof renderOwnerStats === 'function') renderOwnerStats();
    if (typeof renderOwnerDetailedReport === 'function') renderOwnerDetailedReport();

    if ((courierEta || expressTarget) && typeof updateFullTransactionInDB === 'function') {
        await updateFullTransactionInDB(resi, { status: item.status, status_bayar: 'Lunas', jam: item.jam });
    } else if (typeof updateTransactionStatusInDB === 'function') {
        await updateTransactionStatusInDB(resi, item.status, 'Lunas');
    }

    showCloudToast(courierEta
        ? `Pembayaran pesanan ${resi} terverifikasi Lunas! Kurir menjemput sekitar ${formatWibClock(courierEta)} WIB.`
        : `Pembayaran pesanan ${resi} telah dikonfirmasi Lunas! Pesanan kini Diproses.${expressTarget ? ` Estimasi selesai ${formatWibPukul(expressTarget)}.` : ''}`);

    showReadableModal({
        icon: 'fa-solid fa-circle-check text-emerald-600',
        iconWrapClass: 'w-14 h-14 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-2xl mx-auto flex items-center justify-center text-2xl shadow-sm',
        title: 'Pembayaran Telah Dikonfirmasi!',
        subtitle: courierEta
            ? `Pembayaran pesanan ${resi} telah diverifikasi Lunas. Kurir akan menjemput cucian sekitar ${formatWibPukul(courierEta)} (${COURIER_PICKUP_DELAY_MIN} menit setelah verifikasi).`
            : `Status pembayaran pesanan ${resi} telah diverifikasi Lunas dan pesanan kini masuk antrean Diproses.`,
        rows: [
            { label: 'Nomor Resi', value: item.resi, isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-mono font-bold bg-teal-50 text-teal-800 border border-teal-300' },
            { label: 'Pelanggan', value: item.nama },
            { label: 'Layanan Cucian', value: item.layanan },
            ...(expressTarget ? [{ label: 'Estimasi Selesai', value: formatWibWhen(expressTarget), isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-bold bg-violet-50 text-violet-700 border border-violet-200' }] : []),
            ...(courierEta ? [{ label: 'Kurir Menjemput', value: formatWibWhen(courierEta), isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-bold bg-blue-50 text-blue-700 border border-blue-200' }] : []),
            { label: 'Status Pengerjaan', value: item.status, isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-bold bg-teal-50 text-teal-700 border border-teal-200' },
            { label: 'Status Pembayaran', value: 'Lunas', isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-bold bg-emerald-50 text-emerald-700 border border-emerald-200' },
            { label: 'Total Masuk Omset', value: `Rp ${item.total.toLocaleString('id-ID')}`, highlight: true }
        ],
        primaryBtn: {
            text: 'Tutup & Lihat Pesanan',
            onClick: () => {}
        }
    });
}

// ========================================================
// 3. PELANGGAN LOGIC (Page 6, 8, 10, 16)
// ========================================================
function switchPelangganTab(tab) {
    const viewBuat = document.getElementById('pelanggan-view-buat');
    const viewPesanan = document.getElementById('pelanggan-view-pesanan');
    const btnBuat = document.getElementById('pelanggan-tab-btn-buat');
    const btnPesanan = document.getElementById('pelanggan-tab-btn-pesanan');

    if (tab === 'buat') {
        viewBuat.classList.remove('hidden');
        viewPesanan.classList.add('hidden');
        btnBuat.className = 'h-full border-b-2 border-teal-700 text-teal-700 font-bold transition';
        btnPesanan.className = 'h-full border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition';
    } else {
        viewBuat.classList.add('hidden');
        viewPesanan.classList.remove('hidden');
        btnPesanan.className = 'h-full border-b-2 border-teal-700 text-teal-700 font-bold transition';
        btnBuat.className = 'h-full border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition';
        renderPelangganOrders();
    }
}

// Helper Waktu Penjemputan & Pengantaran Express (4 Jam Selesai)
function getExpressPickupDeliveryTimes(tipe = 'Dijemput kurir') {
    const now = new Date();
    const isJemput = (tipe === 'Dijemput kurir');
    const openNow = isWithinWorkingHours(now);

    // Kurir menjemput 15 menit setelah pesanan diverifikasi admin (jam pastinya dicatat saat verifikasi)
    const jamJemput = isJemput
        ? `${COURIER_PICKUP_DELAY_MIN} menit setelah pesanan terverifikasi admin`
        : (openNow
            ? `Hari ini, bawa langsung ke toko (Buka s/d 20:00)`
            : `${formatWibDayLabel(getNextOpening(now), now)}, bawa langsung ke toko (Buka 08:00 - 20:00)`);

    // Estimasi selesai TIDAK diberi jam saat order: 4 jam kerja baru dihitung sejak pakaian diterima di toko
    // (jamnya muncul setelah admin mengonfirmasi pakaian diterima / status Diproses)
    const jamAntar = EXPRESS_PENDING_TEXT;

    const combined = isJemput
        ? `Estimasi selesai: ${jamAntar} (Jemput: ${jamJemput})`
        : `Estimasi selesai: ${jamAntar}`;

    return { jamJemput, jamAntar, combined };
}

// Perbarui Teks Jadwal berdasarkan Metode Pengambilan (Antar sendiri -> 'Ambil pada', Kurir -> 'Tentukan hari pengantaran')
function updateJadwalLabels(pengambilanVal) {
    updateJadwalLabelsBase(pengambilanVal);
    updateQuickDayButtons();
    updateJadwalTexts();
}
function updateJadwalLabelsBase(pengambilanVal) {
    const isAntarSendiri = (pengambilanVal === 'Antar sendiri ke toko');

    const titleEl = document.getElementById('label-jadwal-title');
    const subtitleEl = document.getElementById('label-jadwal-subtitle');
    const tglLabelEl = document.getElementById('label-jadwal-tgl');
    const jamLabelEl = document.getElementById('label-jadwal-jam');
    const infoEl = document.getElementById('label-jadwal-info');
    const quickDaysEl = document.getElementById('pelanggan-quick-days');

    // Express elements
    const expLabelJemput = document.getElementById('express-label-jemput');
    const expDescJemput = document.getElementById('express-desc-jemput');
    const expLabelAntar = document.getElementById('express-label-antar');
    const expDescAntar = document.getElementById('express-desc-antar');

    if (isAntarSendiri) {
        // Mode Antar Sendiri -> Teks "Ambil pada"
        if (titleEl) titleEl.innerText = 'Ambil pada';
        if (subtitleEl) subtitleEl.innerText = 'Pilih jadwal Anda mengambil pakaian bersih di gerai toko DMS Laundry (Minimal H+1)';
        if (tglLabelEl) tglLabelEl.innerText = 'Ambil pada Hari / Tanggal (Min. H+1)';
        if (jamLabelEl) jamLabelEl.innerText = 'Ambil pada Jam';
        if (infoEl) infoEl.innerHTML = '<i class="fa-solid fa-store text-teal-600"></i> Silakan datang ke gerai DMS Laundry untuk mengambil pakaian bersih pada waktu ini';

        if (quickDaysEl) {
            const btns = quickDaysEl.querySelectorAll('.btn-quick-day');
            if (btns[0]) btns[0].innerText = 'Ambil Besok (H+1)';
            if (btns[1]) btns[1].innerText = 'Ambil Lusa (H+2)';
            if (btns[2]) btns[2].innerText = 'Ambil H+3';
        }

        if (expLabelJemput) expLabelJemput.innerHTML = '<i class="fa-solid fa-store text-amber-600"></i> Serah Terima di Toko:';
        if (expDescJemput) expDescJemput.innerText = 'Bawa cucian Anda langsung ke gerai toko DMS Laundry';
        if (expLabelAntar) expLabelAntar.innerHTML = '<i class="fa-solid fa-clock text-emerald-600"></i> Estimasi Selesai (4 Jam Kerja):';
        if (expDescAntar) expDescAntar.innerText = 'Dihitung 4 jam kerja sejak pakaian diterima di toko; jamnya muncul setelah dikonfirmasi admin';
    } else {
        // Mode Dijemput kurir -> Tentukan hari pengantaran
        if (titleEl) titleEl.innerText = 'Tentukan Hari Pengantaran';
        if (subtitleEl) subtitleEl.innerText = 'Tentukan hari dan jam pengantaran oleh kurir ke alamat Anda (Minimal H+1)';
        if (tglLabelEl) tglLabelEl.innerText = 'Tentukan Hari / Tanggal Pengantaran (Min. H+1)';
        if (jamLabelEl) jamLabelEl.innerText = 'Tentukan Jam Pengantaran Kurir';
        if (infoEl) infoEl.innerHTML = '<i class="fa-solid fa-truck-fast text-teal-600"></i> Kurir akan mengantarkan cucian ke rumah Anda sesuai jam ini';

        if (quickDaysEl) {
            const btns = quickDaysEl.querySelectorAll('.btn-quick-day');
            if (btns[0]) btns[0].innerText = 'Diantar Besok (H+1)';
            if (btns[1]) btns[1].innerText = 'Diantar Lusa (H+2)';
            if (btns[2]) btns[2].innerText = 'Diantar H+3';
        }

        if (expLabelJemput) expLabelJemput.innerHTML = '<i class="fa-solid fa-truck-pickup text-amber-600"></i> Jam Penjemputan Kurir:';
        if (expDescJemput) expDescJemput.innerText = `Kurir datang ±${COURIER_PICKUP_DELAY_MIN} menit setelah admin memverifikasi pesanan Anda`;
        if (expLabelAntar) expLabelAntar.innerHTML = '<i class="fa-solid fa-house text-emerald-600"></i> Estimasi Selesai (4 Jam Kerja):';
        if (expDescAntar) expDescAntar.innerText = 'Dihitung sejak pakaian diterima di toko; jamnya muncul setelah dikonfirmasi admin, lalu diantar kembali oleh kurir';
    }

    updatePelangganJadwalFromInputs();
}

function selectPelangganRadio(group, val, element) {
    const pill = element.closest('.radio-pill');
    if (!pill) return;
    const container = pill.parentElement;
    container.querySelectorAll('.radio-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');

    if (group === 'layanan') {
        document.getElementById('pelanggan-layanan-val').value = val;
        const jamHidden = document.getElementById('pelanggan-jam');
        const boxExpress = document.getElementById('box-express-jadwal');
        const secJadwal = document.getElementById('section-pelanggan-jadwal');
        const tipePengambilan = document.getElementById('pelanggan-pengambilan-val')?.value || 'Dijemput kurir';

        if (val === 'Express') {
            const expTimes = getExpressPickupDeliveryTimes(tipePengambilan);
            if (jamHidden) jamHidden.value = expTimes.combined;

            const elJemput = document.getElementById('express-jam-jemput');
            const elAntar = document.getElementById('express-jam-antar');
            if (elJemput) elJemput.innerText = expTimes.jamJemput;
            if (elAntar) elAntar.innerText = expTimes.jamAntar;

            if (boxExpress) boxExpress.classList.remove('hidden');
            if (secJadwal) secJadwal.classList.add('hidden');

            showCloudToast('Express aktif: Menampilkan jam penjemputan & jam pengantaran (4 jam selesai)!');
        } else {
            // Cuci Kiloan: Tampilkan form jadwal minimal H+1
            if (boxExpress) boxExpress.classList.add('hidden');
            if (secJadwal) secJadwal.classList.remove('hidden');
            updatePelangganJadwalFromInputs();
        }
        calculatePelangganTotals();
    }
    if (group === 'pengambilan') {
        document.getElementById('pelanggan-pengambilan-val').value = val;
        updateCashMethodOption(); // Tunai ke kurir <-> Tunai
        const secAlamat = document.getElementById('section-pelanggan-alamat');
        const infoJemput = document.getElementById('info-kurir-jemput');
        const infoAntar = document.getElementById('info-antar-sendiri');

        if (val === 'Dijemput kurir') {
            if (secAlamat) secAlamat.classList.remove('hidden');
            if (infoJemput) infoJemput.classList.remove('hidden');
            if (infoAntar) infoAntar.classList.add('hidden');
        } else {
            // Antar sendiri ke toko
            if (secAlamat) secAlamat.classList.add('hidden');
            if (infoJemput) infoJemput.classList.add('hidden');
            if (infoAntar) infoAntar.classList.remove('hidden');
        }

        // Perbarui teks jadwal sesuai opsi: Antar sendiri -> 'Ambil pada', Kurir -> 'Tentukan hari pengantaran'
        updateJadwalLabels(val);

        // Perbarui jam Express jika Express sedang aktif
        const layananVal = document.getElementById('pelanggan-layanan-val')?.value;
        if (layananVal === 'Express') {
            const expTimes = getExpressPickupDeliveryTimes(val);
            const jamHidden = document.getElementById('pelanggan-jam');
            if (jamHidden) jamHidden.value = expTimes.combined;
            const elJemput = document.getElementById('express-jam-jemput');
            const elAntar = document.getElementById('express-jam-antar');
            if (elJemput) elJemput.innerText = expTimes.jamJemput;
            if (elAntar) elAntar.innerText = expTimes.jamAntar;
        }

        calculatePelangganTotals();
    }
    if (group === 'metode') {
        document.getElementById('pelanggan-metode-val').value = val;
        // Pop-up pembayaran HANYA muncul saat pelanggan melakukan pembayaran (saat submit order / tombol bayar)
    }
}

// Helpers Form Jadwal Pengambilan (Minimal H+1 dari hari ini)
function getMinScheduleDate() {
    return getDateOffset(getScheduleRule().minDays); // H+1, atau H+2 untuk order di atas 5 kg
}

function getDateOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function initPelangganJadwal() {
    const tglInput = document.getElementById('pelanggan-tgl-ambil');
    if (!tglInput) return;
    const minDate = getMinScheduleDate();
    const maxDate = getMaxScheduleDate();
    tglInput.min = minDate;
    tglInput.max = maxDate;
    if (!tglInput.value || tglInput.value < minDate) {
        tglInput.value = minDate;
    } else if (maxDate && tglInput.value > maxDate) {
        tglInput.value = maxDate;
    }

    const boxExpress = document.getElementById('box-express-jadwal');
    const secJadwal = document.getElementById('section-pelanggan-jadwal');
    const layananEl = document.getElementById('pelanggan-layanan-val');
    const tipePengambilan = document.getElementById('pelanggan-pengambilan-val')?.value || 'Dijemput kurir';

    updateJadwalLabels(tipePengambilan);

    if (layananEl && layananEl.value === 'Express') {
        const expTimes = getExpressPickupDeliveryTimes(tipePengambilan);
        const jamHidden = document.getElementById('pelanggan-jam');
        if (jamHidden) jamHidden.value = expTimes.combined;
        const elJemput = document.getElementById('express-jam-jemput');
        const elAntar = document.getElementById('express-jam-antar');
        if (elJemput) elJemput.innerText = expTimes.jamJemput;
        if (elAntar) elAntar.innerText = expTimes.jamAntar;
        if (boxExpress) boxExpress.classList.remove('hidden');
        if (secJadwal) secJadwal.classList.add('hidden');
    } else {
        if (boxExpress) boxExpress.classList.add('hidden');
        if (secJadwal) secJadwal.classList.remove('hidden');
        updatePelangganJadwalFromInputs();
    }
}

function setPelangganQuickDay(offset, btn) {
    const tglInput = document.getElementById('pelanggan-tgl-ambil');
    if (!tglInput) return;
    tglInput.value = getDateOffset(offset);
    document.querySelectorAll('#pelanggan-quick-days .btn-quick-day').forEach(b => {
        b.className = 'btn-quick-day flex-1 py-1 rounded-lg border border-slate-200 hover:border-teal-600 text-slate-600 text-[10px] font-medium text-center transition';
    });
    if (btn) {
        btn.className = 'btn-quick-day active flex-1 py-1 rounded-lg border border-teal-600 bg-teal-50 text-teal-800 text-[10px] font-bold text-center transition';
    }
    updatePelangganJadwalFromInputs();
}

function updatePelangganJadwalFromInputs() {
    const tglInput = document.getElementById('pelanggan-tgl-ambil');
    const jamSelect = document.getElementById('pelanggan-jam-ambil');
    const jamHidden = document.getElementById('pelanggan-jam');
    if (!tglInput || !jamSelect || !jamHidden) return;

    const tipePengambilan = document.getElementById('pelanggan-pengambilan-val')?.value || 'Dijemput kurir';
    const isAntarSendiri = (tipePengambilan === 'Antar sendiri ke toko');

    const rule = getScheduleRule();
    const minDate = getMinScheduleDate();
    const maxDate = getMaxScheduleDate();
    if (tglInput.value && tglInput.value < minDate) {
        const errorTitle = isAntarSendiri ? 'Jadwal Ambil di Toko' : 'Jadwal Pengantaran Kurir';
        const reason = rule.heavy ? ` (order di atas ${rule.thresholdKg} kg butuh pengerjaan minimal ${rule.minDays} hari)` : '';
        const errorMsg = isAntarSendiri
            ? `Jadwal pengambilan pakaian bersih di toko minimal H+${rule.minDays} hari dari tanggal pemesanan${reason}!`
            : `Jadwal pengantaran pakaian oleh kurir minimal H+${rule.minDays} hari dari tanggal pemesanan${reason}!`;
        triggerLoginError(errorMsg, errorTitle);
        tglInput.value = minDate;
    } else if (tglInput.value && maxDate && tglInput.value > maxDate) {
        triggerLoginError(`Order di atas ${HEAVY_KG_THRESHOLD} kg maksimal selesai ${HEAVY_MAX_DAYS} hari (paling lambat H+${HEAVY_MAX_DAYS}).`, 'Jadwal Terlalu Lama');
        tglInput.value = maxDate;
    }

    if (!tglInput.value) tglInput.value = minDate;

    const d = new Date(tglInput.value + 'T00:00:00');
    const dayName = d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
    const jamVal = jamSelect.value;

    const prefix = isAntarSendiri ? 'Ambil pada' : 'Diantar pada';
    jamHidden.value = `${prefix}: ${dayName} (${jamVal})`;
}

function selectPelangganJadwal(jadwalStr, el) {
    const jamInput = document.getElementById('pelanggan-jam');
    if (jamInput) jamInput.value = jadwalStr;
}

function calculatePelangganTotals() {
    const beratInput = document.getElementById('pelanggan-berat');
    let berat = parseFloat(beratInput ? beratInput.value : 3) || 1;
    if (berat < 1) berat = 1;

    const layananEl = document.getElementById('pelanggan-layanan-val');
    const pengambilanEl = document.getElementById('pelanggan-pengambilan-val');

    const layanan = (layananEl && layananEl.value) ? layananEl.value : 'Cuci Kiloan';
    const pengambilan = (pengambilanEl && pengambilanEl.value) ? pengambilanEl.value : 'Dijemput kurir';

    const tarifPerKg = (layanan === 'Express') ? 10000 : 7000;
    const subtotal = Math.round(berat * tarifPerKg);
    const ongkir = (pengambilan === 'Dijemput kurir') ? 3000 : 0;
    const total = subtotal + ongkir;

    const subText = document.getElementById('pelanggan-subtotal-text');
    const ongText = document.getElementById('pelanggan-ongkir-text');
    const totText = document.getElementById('pelanggan-total-text');

    if (subText) subText.innerText = `Rp ${subtotal.toLocaleString('id-ID')} (${berat} kg)`;
    if (ongText) ongText.innerText = `Rp ${ongkir.toLocaleString('id-ID')}`;
    if (totText) totText.innerText = `Rp ${total.toLocaleString('id-ID')}`;

    applyWeightRules(); // batas berat & jadwal mengikuti berat/layanan

    return { berat, subtotal, ongkir, total, layanan, pengambilan };
}

async function handleKirimPesananPelanggan(e) {
    e.preventDefault();
    if (!currentUser) {
        triggerLoginError('Sesi Anda berakhir. Silakan login ulang untuk membuat pesanan.', 'Belum Login');
        return;
    }

    const { berat, subtotal, ongkir, total, layanan, pengambilan } = calculatePelangganTotals();

    // Validasi Minimal Order 1 kg
    if (berat < 1) {
        triggerLoginError('Minimal order cucian adalah 1 kg! Silakan masukkan estimasi berat minimal 1 kg.', 'Pesanan Gagal');
        return;
    }

    // Validasi batas berat: Express maks 5 kg, Cuci Kiloan maks 15 kg
    const weightRule = getWeightRules(layanan, berat);
    if (berat > weightRule.maxKg) {
        triggerLoginError(weightRule.express
            ? `Maksimal order Express adalah ${MAX_KG_EXPRESS} kg. Kurangi berat atau pilih Cuci Kiloan (maksimal ${MAX_KG_NORMAL} kg).`
            : `Maksimal order adalah ${MAX_KG_NORMAL} kg per pesanan. Silakan kurangi berat cucian.`, 'Berat Melebihi Batas');
        return;
    }

    const alamatEl = document.getElementById('pelanggan-alamat');
    const jamEl = document.getElementById('pelanggan-jam');
    const catatanEl = document.getElementById('pelanggan-catatan');
    const metodeEl = document.getElementById('pelanggan-metode-val');

    const alamat = (alamatEl && alamatEl.value ? alamatEl.value : '').trim();
    let jam = (jamEl && jamEl.value ? jamEl.value : '').trim();
    const catatan = (catatanEl && catatanEl.value ? catatanEl.value : '').trim();
    let metode = (metodeEl && metodeEl.value ? metodeEl.value : getCashMethodLabel(pengambilan));
    if (isCashMethod(metode)) metode = getCashMethodLabel(pengambilan); // pastikan sesuai jenis pengambilan

    // Jadwal Express dihitung ulang saat dikirim (jam kerja bisa berubah sejak form dibuka)
    const isExpressOrderNow = /express/i.test(String(layanan));
    if (isExpressOrderNow) jam = getExpressPickupDeliveryTimes(pengambilan).combined;

    // Order di luar jam kerja (08.00 - 20.00 WIB) otomatis masuk antrean dan ditangani saat toko buka
    const orderTime = new Date();
    const handleAt = isWithinWorkingHours(orderTime) ? null : getNextOpening(orderTime);
    const offHours = !!handleAt;

    const isJemput = (pengambilan === 'Dijemput kurir');
    if (isJemput && !alamat) {
        triggerLoginError('Mohon isi alamat lengkap penjemputan pakaian agar kurir kami dapat langsung mendatangi rumah Anda.', 'Alamat Penjemputan');
        if (alamatEl) alamatEl.focus();
        return;
    }

    const finalAlamat = isJemput ? alamat : (alamat || 'Antar & Ambil Sendiri di Gerai DMS Laundry');
    const resi = getNextResiNumber();
    const isNonCash = !isCashMethod(metode);

    // Status otomatis: jika transfer/QRIS/E-wallet -> Menunggu Konfirmasi (agar tidak rugi sebelum diverifikasi admin)
    const orderStatus = isNonCash ? 'Menunggu Konfirmasi' : 'Baru';
    const orderStatusBayar = isNonCash ? 'Menunggu Konfirmasi' : 'Belum dibayar';

    const newOrder = {
        resi,
        nama: currentUser.nama,
        hp: currentUser.hp || '081234567890',
        layanan: `${layanan} (${berat} kg)`,
        berat,
        tipe: pengambilan,
        alamat: finalAlamat,
        jam: offHours ? appendQueueTag(jam, handleAt) : jam,
        catatan,
        subtotal,
        diskon: 0,
        ongkir,
        total,
        metode,
        statusBayar: orderStatusBayar,
        status: orderStatus,
        tanggal: new Date().toISOString().split('T')[0]
    };

    dataset.unshift(newOrder);
    saveData();

    // Simpan ke database Supabase di latar belakang (tidak menahan popup)
    pushOrderToCloud(newOrder);

    // Tampilkan Pop-Up Rincian Pesanan yang Mudah Dibaca
    const modalSubtitle = isJemput
        ? `Kurir DMS Laundry akan mendatangi alamat Anda untuk mengambil pakaian cucian ${COURIER_PICKUP_DELAY_MIN} menit setelah pesanan Anda diverifikasi admin.`
        : 'Silakan serahkan pakaian cucian Anda langsung ke gerai toko DMS Laundry sesuai jadwal.';

    // Informasi antrean jika order masuk di luar jam kerja
    const queueLabel = offHours ? formatWibWhen(handleAt, orderTime) : '';
    const queueIntro = offHours ? `Pesanan diterima di luar jam kerja (08.00 - 20.00 WIB) dan otomatis ditangani mulai ${queueLabel}.` : '';
    const queueRows = offHours
        ? [{ label: 'Mulai Ditangani', value: queueLabel, isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-bold bg-indigo-50 text-indigo-700 border border-indigo-200' }]
        : [];
    const heavyRows = (!isExpressOrderNow && weightRule.heavy)
        ? [{ label: 'Lama Pengerjaan', value: `Order di atas ${weightRule.thresholdKg} kg: minimal ${weightRule.minDays} hari, maksimal selesai ${weightRule.maxDays} hari` }]
        : [];
    const pickupRows = isJemput
        ? [{ label: 'Penjemputan Kurir', value: `${COURIER_PICKUP_DELAY_MIN} menit setelah pesanan terverifikasi admin` }]
        : [];

    if (isNonCash) {
        showReadableModal({
            icon: 'fa-solid fa-clock text-amber-600',
            iconWrapClass: 'w-14 h-14 bg-amber-50 border border-amber-200 text-amber-700 rounded-2xl mx-auto flex items-center justify-center text-2xl shadow-sm',
            title: 'Pesanan Berhasil Dibuat!',
            subtitle: offHours ? `${queueIntro} ${modalSubtitle}` : modalSubtitle,
            rows: [
                { label: 'Nomor Resi', value: resi, isBadge: true, badgeClass: 'px-2.5 py-1 rounded-md font-extrabold text-teal-800 bg-teal-50 border border-teal-300 font-mono text-xs' },
                { label: 'Layanan Cucian', value: `${layanan} (${berat} kg)` },
                { label: 'Metode Pengantaran', value: `${pengambilan} (${ongkir > 0 ? 'Ongkir Rp ' + ongkir.toLocaleString('id-ID') : 'Gratis / Rp 0'})` },
                (isExpressOrderNow
                    ? { label: 'Estimasi Selesai', value: 'Dihitung 4 jam kerja sejak pakaian diterima di toko; jamnya muncul setelah dikonfirmasi admin' }
                    : { label: isJemput ? 'Hari & Jam Pengantaran' : 'Ambil pada', value: jam || 'Segera' }),
                { label: isJemput ? 'Alamat Penjemputan' : 'Lokasi Serah Terima', value: finalAlamat },
                { label: 'Total Pembayaran', value: `Rp ${total.toLocaleString('id-ID')}`, highlight: true },
                { label: 'Metode Pembayaran', value: metode },
                ...heavyRows,
                ...pickupRows,
                ...queueRows,
                { label: 'Status Pesanan', value: 'Menunggu Konfirmasi Admin', isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-bold bg-amber-50 text-amber-700 border border-amber-300' }
            ],
            primaryBtn: {
                text: `💳 Lanjut Bayar via ${getPaymentView(normalizePaymentMethod(metode)).label}`,
                class: 'flex-1 bg-teal-700 hover:bg-teal-800 text-white font-bold py-2.5 rounded-xl text-xs transition shadow-sm',
                onClick: () => {
                    switchPelangganTab('pesanan');
                    openQrisModal(total, resi, metode);
                }
            },
            secondaryBtn: {
                text: 'Pantau di Pesanan Saya',
                onClick: () => {
                    switchPelangganTab('pesanan');
                }
            }
        });
    } else {
        showReadableModal({
            icon: 'fa-solid fa-circle-check text-emerald-600',
            iconWrapClass: 'w-14 h-14 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-2xl mx-auto flex items-center justify-center text-2xl shadow-sm',
            title: 'Pesanan Berhasil Dibuat!',
            subtitle: `${offHours ? queueIntro + ' ' : ''}${modalSubtitle} ${isJemput ? 'Siapkan uang tunai untuk dibayarkan langsung ke kurir.' : 'Pembayaran tunai dilakukan di toko saat Anda menyerahkan cucian.'}`,
            rows: [
                { label: 'Nomor Resi', value: resi, isBadge: true, badgeClass: 'px-2.5 py-1 rounded-md font-extrabold text-teal-800 bg-teal-50 border border-teal-300 font-mono text-xs' },
                { label: 'Layanan Cucian', value: `${layanan} (${berat} kg)` },
                { label: 'Metode Pengantaran', value: `${pengambilan} (${ongkir > 0 ? 'Ongkir Rp ' + ongkir.toLocaleString('id-ID') : 'Gratis / Rp 0'})` },
                (isExpressOrderNow
                    ? { label: 'Estimasi Selesai', value: 'Dihitung 4 jam kerja sejak pakaian diterima di toko; jamnya muncul setelah dikonfirmasi admin' }
                    : { label: isJemput ? 'Hari & Jam Pengantaran' : 'Ambil pada', value: jam || 'Segera' }),
                { label: isJemput ? 'Alamat Penjemputan' : 'Lokasi Serah Terima', value: finalAlamat },
                { label: 'Total Estimasi', value: `Rp ${total.toLocaleString('id-ID')}`, highlight: true },
                { label: 'Metode Pembayaran', value: metode },
                ...heavyRows,
                ...pickupRows,
                ...queueRows,
                { label: 'Status Pesanan', value: 'Baru', isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-bold bg-slate-100 text-slate-700 border border-slate-200' }
            ],
            primaryBtn: {
                text: '📋 Buka Pesanan Saya',
                class: 'flex-1 bg-teal-700 hover:bg-teal-800 text-white font-bold py-2.5 rounded-xl text-xs transition shadow-sm',
                onClick: () => {
                    switchPelangganTab('pesanan');
                }
            }
        });
    }
}

function renderPelangganOrders() {
    const container = document.getElementById('pelanggan-orders-container');
    if (!container || !currentUser) return;

    const myOrders = dataset.filter(x => x.nama.toLowerCase() === currentUser.nama.toLowerCase() || (currentUser.hp && x.hp === currentUser.hp));

    if (myOrders.length === 0) {
        container.innerHTML = `
            <div class="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-400">
                <i class="fa-solid fa-box-open text-3xl mb-2 text-slate-300"></i>
                <p class="text-xs">Belum ada pesanan cucian. Buat pesanan pertama Anda sekarang!</p>
            </div>
        `;
        return;
    }

    container.innerHTML = myOrders.map(item => {
        // Status Badges
        let statusBadge = '';
        if (item.status === 'Menunggu Konfirmasi') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-300 animate-pulse inline-flex items-center gap-1"><i class="fa-solid fa-clock"></i>Menunggu Konfirmasi</span>`;
        else if (item.status === 'Siap diantar') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-indigo-50 text-indigo-700 inline-flex items-center gap-1"><i class="fa-solid fa-truck-fast"></i>Siap diantar</span>`;
        else if (item.status === 'Siap diambil') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-indigo-50 text-indigo-700 inline-flex items-center gap-1"><i class="fa-solid fa-store"></i>Siap diambil</span>`;
        else if (item.status === 'Dicuci' || item.status === 'Diproses') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-teal-50 text-teal-700 inline-flex items-center gap-1"><i class="fa-solid fa-jug-detergent"></i>Diproses</span>`;
        else if (item.status === 'Selesai') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-50 text-emerald-700 inline-flex items-center gap-1"><i class="fa-solid fa-circle-check"></i>Selesai</span>`;
        else statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-slate-100 text-slate-700">${item.status}</span>`;

        // Payment Badges
        let bayarBadge = item.statusBayar === 'Lunas' ?
            `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-50 text-emerald-700">Lunas</span>` :
            item.statusBayar === 'Menunggu Konfirmasi' ?
            `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-amber-50 text-amber-700">Menunggu Konfirmasi</span>` :
            `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-rose-50 text-rose-700">Belum dibayar</span>`;

        // Notice status pengerjaan untuk pelanggan
        let statusNotice = '';
        if (item.status === 'Menunggu Konfirmasi') {
            statusNotice = `
                <div class="p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 space-y-0.5">
                    <div class="font-bold flex items-center gap-1.5 text-amber-800"><i class="fa-solid fa-clock"></i> Menunggu Konfirmasi Admin</div>
                    <p class="text-[11px] text-amber-700">Pembayaran Anda sedang kami verifikasi. Admin akan mengonfirmasi status pesanan ini segera.</p>
                </div>
            `;
        } else if (item.status === 'Siap diambil') {
            statusNotice = `
                <div class="p-2.5 bg-indigo-50 border border-indigo-200 rounded-xl text-xs text-indigo-900 space-y-0.5">
                    <div class="font-bold flex items-center gap-1.5 text-indigo-800"><i class="fa-solid fa-store"></i> Siap Diambil di Gerai</div>
                    <p class="text-[11px] text-indigo-700">Pakaian bersih Anda telah selesai disetrika dan siap Anda ambil di gerai DMS Laundry.</p>
                </div>
            `;
        } else if (item.status === 'Siap diantar') {
            statusNotice = `
                <div class="p-2.5 bg-indigo-50 border border-indigo-200 rounded-xl text-xs text-indigo-900 space-y-0.5">
                    <div class="font-bold flex items-center gap-1.5 text-indigo-800"><i class="fa-solid fa-truck-fast"></i> Sedang Diantar Kurir</div>
                    <p class="text-[11px] text-indigo-700">Kurir DMS Laundry sedang dalam perjalanan mengantarkan pakaian bersih ke alamat Anda.</p>
                </div>
            `;
        }

        // Info antrean jika pesanan masuk di luar jam kerja
        statusNotice = getQueueNoticeHtml(item) + getCourierNoticeHtml(item) + getExpressNoticeHtml(item) + statusNotice;

        // Tombol Bayar QRIS jika belum lunas / masih menunggu konfirmasi
        let payBtn = '';
        if (item.statusBayar !== 'Lunas' && !isCashMethod(item.metode)) {
            const payView = getPaymentView(normalizePaymentMethod(item.metode));
            const btnText = item.status === 'Menunggu Konfirmasi' ? `Lihat Pembayaran ${payView.label}` : `Bayar Sekarang via ${payView.label}`;
            payBtn = `
                <div class="pt-2 border-t border-slate-100">
                    <button onclick="openQrisModal(${item.total}, '${item.resi}', '${item.metode}')" class="w-full py-2 px-3 rounded-xl bg-teal-50 hover:bg-teal-100 border border-teal-200 text-teal-800 text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm">
                        <i class="${payView.icon}"></i> ${btnText}
                    </button>
                </div>
            `;
        }

        return `
            <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3 hover:border-teal-600 transition">
                <div class="flex justify-between items-center">
                    <span class="text-base font-extrabold text-slate-900 font-mono">${item.resi}</span>
                    ${statusBadge}
                </div>
                ${statusNotice}
                <div class="text-xs text-slate-500">
                    ${item.layanan} · Estimasi / Jadwal: <span class="font-semibold text-slate-700 font-mono">${displayJam(item.jam) || item.tanggal}</span>
                </div>
                <div class="flex justify-between items-center pt-2 border-t border-slate-100 text-xs">
                    <span class="text-slate-600">${item.metode} · ${bayarBadge}</span>
                    <span class="font-extrabold text-slate-900 font-mono text-sm">Rp ${(item.total || 0).toLocaleString('id-ID')}</span>
                </div>
                ${payBtn}
            </div>
        `;
    }).join('');
}

// Modal Pop-up QRIS & Data Rekening (GoPay & Bank Jago dari QRIS.zip)
let currentPayingResi = null;

// ========================================================
// ATURAN BERAT CUCIAN & LAMA PENGERJAAN
// - Express: maksimal 5 kg
// - Cuci Kiloan: maksimal 15 kg
// - Kiloan di atas 5 kg: pengerjaan minimal 2 hari dan maksimal selesai 4 hari (jadwal H+2 s/d H+4)
// - Kiloan di atas 10 kg: paling cepat H+3 (jadwal H+3 s/d H+4)
// ========================================================
const MAX_KG_EXPRESS = 5;
const MAX_KG_NORMAL = 15;
const HEAVY_KG_THRESHOLD = 5;
const HEAVY_MIN_DAYS = 2;
const HEAVY_MAX_DAYS = 4;
const XHEAVY_KG_THRESHOLD = 10;   // di atas 10 kg: paling cepat H+3
const XHEAVY_MIN_DAYS = 3;
const QUICK_DAY_INACTIVE = 'btn-quick-day flex-1 py-1 rounded-lg border border-slate-200 hover:border-teal-600 text-slate-600 text-[10px] font-medium text-center transition';
const QUICK_DAY_ACTIVE = 'btn-quick-day active flex-1 py-1 rounded-lg border border-teal-600 bg-teal-50 text-teal-800 text-[10px] font-bold text-center transition';

function getWeightRules(layanan, berat) {
    if (/express/i.test(String(layanan))) {
        return { express: true, maxKg: MAX_KG_EXPRESS, heavy: false, thresholdKg: null, minDays: 1, maxDays: null };
    }
    if (berat > XHEAVY_KG_THRESHOLD) {
        return { express: false, maxKg: MAX_KG_NORMAL, heavy: true, thresholdKg: XHEAVY_KG_THRESHOLD, minDays: XHEAVY_MIN_DAYS, maxDays: HEAVY_MAX_DAYS };
    }
    if (berat > HEAVY_KG_THRESHOLD) {
        return { express: false, maxKg: MAX_KG_NORMAL, heavy: true, thresholdKg: HEAVY_KG_THRESHOLD, minDays: HEAVY_MIN_DAYS, maxDays: HEAVY_MAX_DAYS };
    }
    return { express: false, maxKg: MAX_KG_NORMAL, heavy: false, thresholdKg: null, minDays: 1, maxDays: null };
}
// Aturan yang berlaku untuk isi form saat ini
function getScheduleRule() {
    const layanan = (document.getElementById('pelanggan-layanan-val') || {}).value || 'Cuci Kiloan';
    const berat = parseFloat((document.getElementById('pelanggan-berat') || {}).value) || 1;
    return getWeightRules(layanan, berat);
}
function getMaxScheduleDate() {
    const r = getScheduleRule();
    return r.maxDays ? getDateOffset(r.maxDays) : '';
}

// Tombol cepat pilihan hari mengikuti aturan (H+1..H+3 biasa, H+2..H+4 untuk di atas 5 kg)
function updateQuickDayButtons() {
    const box = document.getElementById('pelanggan-quick-days');
    if (!box) return;
    const isAntarSendiri = ((document.getElementById('pelanggan-pengambilan-val') || {}).value === 'Antar sendiri ke toko');
    const rule = getScheduleRule();
    const minDays = rule.minDays;
    const selected = (document.getElementById('pelanggan-tgl-ambil') || {}).value;
    const verb = isAntarSendiri ? 'Ambil' : 'Diantar';
    const names = { 1: 'Besok', 2: 'Lusa' };
    box.querySelectorAll('.btn-quick-day').forEach((b, i) => {
        const off = minDays + i;
        b.setAttribute('onclick', `setPelangganQuickDay(${off}, this)`);
        b.innerText = names[off] ? `${verb} ${names[off]} (H+${off})` : `${verb} H+${off}`;
        b.className = (selected && selected === getDateOffset(off)) ? QUICK_DAY_ACTIVE : QUICK_DAY_INACTIVE;
        if (rule.maxDays && off > rule.maxDays) b.classList.add('hidden'); // di luar batas maksimal selesai
    });
}

// Teks batas hari pada judul jadwal
function updateJadwalTexts() {
    const rule = getScheduleRule();
    const isAntarSendiri = ((document.getElementById('pelanggan-pengambilan-val') || {}).value === 'Antar sendiri ke toko');
    const range = rule.maxDays ? `H+${rule.minDays} sampai H+${rule.maxDays}` : `Minimal H+${rule.minDays}`;
    const rangeShort = rule.maxDays ? `H+${rule.minDays} s/d H+${rule.maxDays}` : `Min. H+${rule.minDays}`;
    const subtitleEl = document.getElementById('label-jadwal-subtitle');
    const tglLabelEl = document.getElementById('label-jadwal-tgl');
    const badge = document.getElementById('pelanggan-jadwal-badge');
    if (subtitleEl) subtitleEl.innerText = isAntarSendiri
        ? `Pilih jadwal Anda mengambil pakaian bersih di gerai toko DMS Laundry (${range})`
        : `Tentukan hari dan jam pengantaran oleh kurir ke alamat Anda (${range})`;
    if (tglLabelEl) tglLabelEl.innerText = isAntarSendiri
        ? `Ambil pada Hari / Tanggal (${rangeShort})`
        : `Tentukan Hari / Tanggal Pengantaran (${rangeShort})`;
    if (badge) badge.innerText = rule.maxDays ? `H+${rule.minDays} - H+${rule.maxDays}` : `Minimal H+${rule.minDays}`;
}

// Batas tanggal mengikuti berat; tanggal yang di luar batas dirapikan tanpa pesan (berat baru saja diubah)
function syncScheduleLimits() {
    const tglInput = document.getElementById('pelanggan-tgl-ambil');
    if (tglInput) {
        const minDate = getMinScheduleDate();
        const maxDate = getMaxScheduleDate();
        tglInput.min = minDate;
        tglInput.max = maxDate;
        if (!tglInput.value || tglInput.value < minDate) tglInput.value = minDate;
        else if (maxDate && tglInput.value > maxDate) tglInput.value = maxDate;
    }
    updateQuickDayButtons();
    updateJadwalTexts();
    const layanan = (document.getElementById('pelanggan-layanan-val') || {}).value;
    if (!/express/i.test(String(layanan))) updatePelangganJadwalFromInputs();
}

// Periksa berat terhadap batas, tampilkan petunjuk/peringatan, dan sesuaikan jadwal
function applyWeightRules() {
    const input = document.getElementById('pelanggan-berat');
    if (!input) return { ok: true, message: '' };
    const layanan = (document.getElementById('pelanggan-layanan-val') || {}).value || 'Cuci Kiloan';
    const berat = parseFloat(input.value) || 0;
    const rule = getWeightRules(layanan, berat);
    input.max = String(rule.maxKg);

    const hint = document.getElementById('pelanggan-berat-hint');
    if (hint) hint.innerText = `Order 1 - ${rule.maxKg} kg`;

    let message = '';
    let tone = 'info';
    if (berat > rule.maxKg) {
        message = rule.express
            ? `Maksimal order Express ${MAX_KG_EXPRESS} kg. Kurangi berat atau pilih Cuci Kiloan (maksimal ${MAX_KG_NORMAL} kg).`
            : `Maksimal order ${MAX_KG_NORMAL} kg per pesanan.`;
        tone = 'error';
    } else if (rule.express) {
        message = `Express maksimal ${MAX_KG_EXPRESS} kg per pesanan.`;
    } else if (rule.heavy) {
        message = `Order di atas ${rule.thresholdKg} kg: pengerjaan minimal ${rule.minDays} hari dan maksimal selesai ${rule.maxDays} hari. Jadwal dipilih H+${rule.minDays} sampai H+${rule.maxDays}.`;
        tone = 'warn';
    } else {
        message = `Maksimal ${MAX_KG_NORMAL} kg. Di atas ${HEAVY_KG_THRESHOLD} kg pengerjaan minimal ${HEAVY_MIN_DAYS} hari, di atas ${XHEAVY_KG_THRESHOLD} kg minimal ${XHEAVY_MIN_DAYS} hari (maksimal selesai ${HEAVY_MAX_DAYS} hari).`;
    }
    const info = document.getElementById('pelanggan-berat-info');
    if (info) {
        info.innerText = message;
        const tones = {
            info: 'text-slate-500',
            warn: 'text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg px-2.5 py-1.5',
            error: 'text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 font-semibold'
        };
        info.className = `mt-2 text-[11px] ${tones[tone]}`;
    }
    syncScheduleLimits();
    return { ok: berat >= 1 && berat <= rule.maxKg, rule, message, tone };
}

// ---- Metode TUNAI menyesuaikan jenis pengambilan ----
// Dijemput kurir -> "Tunai ke kurir"; Antar sendiri ke toko -> "Tunai"
function isCashMethod(metode) {
    return /tunai/i.test(String(metode || ''));
}
function getCashMethodLabel(tipe) {
    const t = tipe || (document.getElementById('pelanggan-pengambilan-val') || {}).value || 'Dijemput kurir';
    return t === 'Dijemput kurir' ? 'Tunai ke kurir' : 'Tunai';
}
// Ubah tulisan pilihan Tunai di form, dan nilai terpilihnya jika Tunai sedang dipilih
function updateCashMethodOption() {
    const label = getCashMethodLabel();
    const labelEl = document.getElementById('pelanggan-pill-tunai-label');
    if (labelEl) labelEl.innerText = label;
    const hidden = document.getElementById('pelanggan-metode-val');
    if (hidden && isCashMethod(hidden.value)) hidden.value = label;
}

// Tentukan jenis metode dari teks metode yang tersimpan pada pesanan
function normalizePaymentMethod(metode) {
    const m = String(metode || '').toLowerCase();
    if (m.includes('qris')) return 'qris';
    if (m.includes('transfer') || m.includes('jago') || m.includes('bank')) return 'transfer';
    if (m.includes('wallet') || m.includes('gopay') || m.includes('go-pay')) return 'ewallet';
    return 'all';
}

// Tampilan popup pembayaran untuk tiap metode
function getPaymentView(key) {
    const views = {
        qris: {
            label: 'QRIS',
            icon: 'fa-solid fa-qrcode',
            title: 'Bayar via QRIS',
            subtitle: 'Scan kode QRIS di bawah ini dengan aplikasi e-wallet atau mobile banking.',
            hint: 'Pastikan nominal yang dibayar sama dengan total tagihan, lalu tekan "Saya Sudah Bayar".',
            show: ['pay-card-qris']
        },
        transfer: {
            label: 'Transfer Bank Jago',
            icon: 'fa-solid fa-building-columns',
            title: 'Bayar via Transfer Bank Jago',
            subtitle: 'Transfer ke rekening resmi DMS Laundry di bawah ini.',
            hint: 'Transfer sesuai total tagihan ke rekening Bank Jago, lalu tekan "Saya Sudah Bayar".',
            show: ['pay-card-jago']
        },
        ewallet: {
            label: 'GoPay',
            icon: 'fa-solid fa-wallet',
            title: 'Bayar via E-wallet (GoPay)',
            subtitle: 'Kirim saldo GoPay ke nomor resmi DMS Laundry di bawah ini.',
            hint: 'Kirim sesuai total tagihan ke nomor GoPay, lalu tekan "Saya Sudah Bayar".',
            show: ['pay-card-gopay']
        },
        all: {
            label: 'QRIS / Bank',
            icon: 'fa-solid fa-qrcode',
            title: 'Rincian Pembayaran',
            subtitle: 'Scan QRIS atau transfer ke rekening resmi DMS Laundry.',
            hint: '',
            show: ['pay-card-qris', 'pay-card-gopay', 'pay-card-jago']
        }
    };
    return views[key] || views.all;
}

function applyPaymentModalView(key) {
    const view = getPaymentView(key);
    ['pay-card-qris', 'pay-card-gopay', 'pay-card-jago'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !view.show.includes(id));
    });
    const icon = document.getElementById('pay-modal-icon');
    const title = document.getElementById('pay-modal-title');
    const sub = document.getElementById('pay-modal-subtitle');
    const hint = document.getElementById('pay-modal-hint');
    if (icon) icon.className = view.icon;
    if (title) title.innerText = view.title;
    if (sub) sub.innerText = view.subtitle;
    if (hint) {
        hint.innerText = view.hint;
        hint.classList.toggle('hidden', !view.hint);
    }
}

function openQrisModal(customNominal, resiOrLabel, metode) {
    currentPayingResi = resiOrLabel || null;
    const modal = document.getElementById('modal-pembayaran-qris');
    if (!modal) return;

    // Tentukan metode: dari parameter, atau dari data pesanan, atau tampilkan semua
    let methodKey = metode ? normalizePaymentMethod(metode) : null;
    if (!methodKey && resiOrLabel && Array.isArray(dataset)) {
        const found = dataset.find(x => x.resi === resiOrLabel);
        if (found) methodKey = normalizePaymentMethod(found.metode);
    }
    applyPaymentModalView(methodKey || 'all');

    let nominalText = 'Rp 24.000';
    if (customNominal) {
        nominalText = `Rp ${parseInt(customNominal, 10).toLocaleString('id-ID')}`;
    } else {
        const kasirTot = document.getElementById('kasir-total-display');
        const pelTot = document.getElementById('pelanggan-total-text');
        if (kasirTot && kasirTot.innerText !== 'Rp 0') nominalText = kasirTot.innerText;
        else if (pelTot) nominalText = pelTot.innerText;
    }

    const nomEl = document.getElementById('modal-qris-nominal');
    if (nomEl) nomEl.innerText = nominalText;

    const resiEl = document.getElementById('modal-qris-resi-info');
    if (resiEl) {
        resiEl.innerText = resiOrLabel ? `Pesanan: ${resiOrLabel}` : 'DMS Laundry Official Payment';
    }

    modal.classList.remove('hidden');
}

function closeQrisModal() {
    const modal = document.getElementById('modal-pembayaran-qris');
    if (modal) modal.classList.add('hidden');
}

async function konfirmasiSudahBayar() {
    closeQrisModal();
    if (currentPayingResi) {
        const item = dataset.find(x => x.resi === currentPayingResi);
        if (item) {
            item.status = 'Menunggu Konfirmasi';
            item.statusBayar = 'Menunggu Konfirmasi';
            saveData();
            renderPelangganOrders();
            renderOnlineOrdersTable();

            if (typeof updateTransactionStatusInDB === 'function') {
                await updateTransactionStatusInDB(item.resi, 'Menunggu Konfirmasi', 'Menunggu Konfirmasi');
            }
        }
    }
    showCloudToast('Konfirmasi pembayaran dicatat! Menunggu verifikasi admin agar pesanan segera dikerjakan.');

    showReadableModal({
        icon: 'fa-solid fa-clock text-amber-600',
        iconWrapClass: 'w-14 h-14 bg-amber-50 border border-amber-200 text-amber-700 rounded-2xl mx-auto flex items-center justify-center text-2xl shadow-sm',
        title: 'Konfirmasi Pembayaran Diterima!',
        subtitle: 'Terima kasih telah melakukan pembayaran. Bukti pembayaran Anda sedang kami verifikasi sebelum pakaian mulai dicuci.',
        rows: [
            { label: 'Nomor Pesanan', value: currentPayingResi || 'LD-Official', isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-mono font-bold bg-teal-50 text-teal-800 border border-teal-300' },
            { label: 'Status Pembayaran', value: 'Menunggu Konfirmasi Admin', isBadge: true, badgeClass: 'px-2 py-0.5 rounded font-bold bg-amber-50 text-amber-700 border border-amber-300' },
            { label: 'Proses Berikutnya', value: 'Admin memverifikasi mutasi bank & kurir menjemput pakaian' }
        ],
        primaryBtn: {
            text: '📋 Pantau di Pesanan Saya',
            onClick: () => {
                if (currentUser && currentUser.role === 'pelanggan') {
                    switchPelangganTab('pesanan');
                }
            }
        }
    });

    if (currentUser && currentUser.role === 'pelanggan') {
        switchPelangganTab('pesanan');
    }
}

function copyPaymentData(text, btnElement) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            if (btnElement) {
                const original = btnElement.innerHTML;
                btnElement.innerHTML = `<i class="fa-solid fa-check text-emerald-600"></i> Tersalin!`;
                btnElement.classList.add('bg-emerald-50', 'text-emerald-700');
                setTimeout(() => {
                    btnElement.innerHTML = original;
                    btnElement.classList.remove('bg-emerald-50', 'text-emerald-700');
                }, 2000);
            }
            showCloudToast(`Nomor ${text} berhasil disalin ke clipboard!`);
        });
    } else {
        prompt('Salin nomor berikut:', text);
    }
}

// ========================================================
// 4. OWNER LOGIC (Page 9 & 13)
// ========================================================
function switchOwnerTab(tab) {
    const tabPemasukan = document.getElementById('owner-tab-pemasukan');
    const tabLaporan = document.getElementById('owner-tab-laporan');
    const navPemasukan = document.getElementById('owner-nav-pemasukan');
    const navLaporan = document.getElementById('owner-nav-laporan');

    const activeNavClass = 'flex-1 md:w-full text-left px-4 py-2.5 rounded-xl bg-teal-800 text-white transition flex items-center gap-2.5';
    const inactiveNavClass = 'flex-1 md:w-full text-left px-4 py-2.5 rounded-xl text-slate-300 hover:bg-navy-800 hover:text-white transition flex items-center gap-2.5';

    if (tab === 'pemasukan') {
        if (tabPemasukan) tabPemasukan.classList.remove('hidden');
        if (tabLaporan) tabLaporan.classList.add('hidden');
        if (navPemasukan) navPemasukan.className = activeNavClass;
        if (navLaporan) navLaporan.className = inactiveNavClass;
        renderOwnerStats();
    } else {
        if (tabPemasukan) tabPemasukan.classList.add('hidden');
        if (tabLaporan) tabLaporan.classList.remove('hidden');
        if (navLaporan) navLaporan.className = activeNavClass;
        if (navPemasukan) navPemasukan.className = inactiveNavClass;
        renderOwnerDetailedReport();
    }

    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.body.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    const mainOwner = document.querySelector('#view-owner main');
    if (mainOwner) mainOwner.scrollTop = 0;
}

function renderOwnerStats() {
    const today = new Date().toISOString().split('T')[0];
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const thisMonthPrefix = today.slice(0, 7);

    // Hanya pesanan yang SUDAH LUNAS yang dihitung dalam pembukuan / pemasukan
    const paidDataset = dataset.filter(x => x.statusBayar === 'Lunas');

    let omsetHari = 0;
    let omsetMinggu = 0;
    let omsetBulan = 0;

    paidDataset.forEach(item => {
        const amt = item.total || 0;
        if (item.tanggal === today) omsetHari += amt;
        if (item.tanggal >= sevenDaysAgo) omsetMinggu += amt;
        if (item.tanggal.startsWith(thisMonthPrefix)) omsetBulan += amt;
    });

    const elHari = document.getElementById('owner-stat-hari');
    const elMinggu = document.getElementById('owner-stat-minggu');
    const elBulan = document.getElementById('owner-stat-bulan');

    if (elHari) elHari.innerText = `Rp ${omsetHari.toLocaleString('id-ID')}`;
    if (elMinggu) elMinggu.innerText = `Rp ${omsetMinggu.toLocaleString('id-ID')}`;
    if (elBulan) elBulan.innerText = `Rp ${omsetBulan.toLocaleString('id-ID')}`;

    // Render 7-day Teal Bar Chart
    renderOwnerChart();

    // Render Monthly Summary Table
    renderOwnerMonthlyTable();
}

function renderOwnerChart() {
    const container = document.getElementById('owner-chart-bars');
    if (!container) return;

    // Hanya transaksi yang sudah lunas
    const paidDataset = dataset.filter(x => x.statusBayar === 'Lunas');

    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        days.push(d.toISOString().split('T')[0]);
    }

    const dayTotals = days.map(dStr => {
        return paidDataset.filter(x => x.tanggal === dStr).reduce((acc, curr) => acc + curr.total, 0);
    });

    const maxVal = Math.max(...dayTotals, 50000);

    container.innerHTML = days.map((dStr, idx) => {
        const total = dayTotals[idx];
        const heightPct = Math.max(15, Math.round((total / maxVal) * 100));
        const dayLabel = new Date(dStr).toLocaleDateString('id-ID', { weekday: 'short' });

        return `
            <div class="flex-1 flex flex-col items-center gap-1.5 h-full justify-end group">
                <span class="text-[9px] text-slate-400 group-hover:text-teal-700 font-mono font-semibold transition">
                    ${total > 0 ? (total / 1000) + 'k' : '0'}
                </span>
                <div class="w-full max-w-[2.25rem] bg-teal-700 hover:bg-teal-600 rounded-t-lg transition-all" style="height: ${heightPct}%;"></div>
                <span class="text-[10px] text-slate-500 font-medium">${dayLabel}</span>
            </div>
        `;
    }).join('');
}

function renderOwnerMonthlyTable() {
    const tbody = document.getElementById('owner-monthly-table');
    if (!tbody) return;

    // Hanya transaksi yang sudah LUNAS yang dimasukkan ke rekapitulasi bulanan
    const paidDataset = dataset.filter(x => x.statusBayar === 'Lunas');

    const monthlyMap = {};
    paidDataset.forEach(item => {
        const monthKey = item.tanggal.slice(0, 7);
        if (!monthlyMap[monthKey]) monthlyMap[monthKey] = { count: 0, total: 0 };
        monthlyMap[monthKey].count += 1;
        monthlyMap[monthKey].total += item.total;
    });

    const rows = Object.keys(monthlyMap).sort().reverse();
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-slate-400">Belum ada transaksi lunas tercatat.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(mKey => {
        const [year, month] = mKey.split('-');
        const monthName = new Date(year, month - 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
        const data = monthlyMap[mKey];

        return `
            <tr class="hover:bg-slate-50">
                <td class="p-3 font-semibold text-slate-900">${monthName}</td>
                <td class="p-3 text-slate-600">${data.count} pesanan lunas</td>
                <td class="p-3 text-right font-extrabold text-slate-900 font-mono">Rp ${data.total.toLocaleString('id-ID')}</td>
            </tr>
        `;
    }).join('');
}

function renderOwnerDetailedReport(targetMonth) {
    const tbody = document.getElementById('owner-detailed-report-body');
    const monthSelect = document.getElementById('owner-report-month-filter');
    if (!tbody || !monthSelect) return;

    // HANYA transaksi yang SUDAH LUNAS yang dimasukkan ke laporan bulanan
    const paidDataset = dataset.filter(x => x.statusBayar === 'Lunas');

    // Kumpulkan seluruh bulan unik dari transaksi lunas
    const availableMonths = [...new Set(paidDataset.map(item => item.tanggal.slice(0, 7)))].sort().reverse();

    // Nilai aktif saat ini
    const currentVal = targetMonth !== undefined ? targetMonth : (monthSelect.value || (availableMonths[0] || 'all'));

    let selectHtml = `<option value="all">Semua Periode (${paidDataset.length} Transaksi Lunas)</option>`;
    availableMonths.forEach(mKey => {
        const [year, month] = mKey.split('-');
        const monthName = new Date(year, month - 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
        const count = paidDataset.filter(x => x.tanggal.startsWith(mKey)).length;
        selectHtml += `<option value="${mKey}">${monthName} (${count} Transaksi Lunas)</option>`;
    });
    monthSelect.innerHTML = selectHtml;
    monthSelect.value = currentVal;

    // Filter data berdasarkan bulan terpilih dari transaksi lunas
    let filteredItems = paidDataset;
    if (currentVal !== 'all') {
        filteredItems = paidDataset.filter(x => x.tanggal.startsWith(currentVal));
    }

    // Kalkulasi KPI
    const totalRevenue = filteredItems.reduce((acc, curr) => acc + (curr.total || 0), 0);
    const totalCount = filteredItems.length;
    const doneCount = filteredItems.filter(x => x.status === 'Selesai').length;
    const avgOrder = totalCount > 0 ? Math.round(totalRevenue / totalCount) : 0;

    // Update KPI Cards
    const repTotal = document.getElementById('rep-month-total');
    const repCount = document.getElementById('rep-month-count');
    const repDone = document.getElementById('rep-month-done');
    const repAvg = document.getElementById('rep-month-avg');
    const repInfo = document.getElementById('rep-table-info');

    if (repTotal) repTotal.innerText = `Rp ${totalRevenue.toLocaleString('id-ID')}`;
    if (repCount) repCount.innerText = `${totalCount} pesanan lunas`;
    if (repDone) repDone.innerText = `${doneCount} pesanan selesai`;
    if (repAvg) repAvg.innerText = `Rp ${avgOrder.toLocaleString('id-ID')}`;
    if (repInfo) repInfo.innerText = `${totalCount} transaksi lunas tercatat`;

    // Render Tabel Rincian
    if (filteredItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-slate-400">Tidak ada transaksi lunas pada periode ini.</td></tr>`;
        return;
    }

    tbody.innerHTML = filteredItems.map(item => {
        let statusBadge = '';
        if (item.status === 'Selesai') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Selesai</span>`;
        else if (item.status === 'Diproses') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-teal-50 text-teal-700 border border-teal-200">Diproses</span>`;
        else if (item.status === 'Dijemput') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200">Dijemput</span>`;
        else statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-200">${item.status}</span>`;

        const bayarBadge = `<span class="text-emerald-700 font-semibold flex items-center gap-1"><i class="fa-solid fa-circle-check text-[10px]"></i> Lunas</span>`;

        return `
            <tr class="hover:bg-slate-50 transition">
                <td class="p-3 font-bold text-teal-800 font-mono">${item.resi}</td>
                <td class="p-3 text-slate-600 font-mono text-[11px]">${item.tanggal}</td>
                <td class="p-3">
                    <span class="font-semibold text-slate-900 block">${item.nama}</span>
                    <span class="text-[10px] text-slate-400 font-mono">${item.hp || '-'}</span>
                </td>
                <td class="p-3 text-slate-700">${item.layanan} (${item.berat} kg)</td>
                <td class="p-3 text-slate-600">${item.tipe}</td>
                <td class="p-3 text-slate-600">${item.metode} · ${bayarBadge}</td>
                <td class="p-3">${statusBadge}</td>
                <td class="p-3 text-right font-extrabold text-slate-900 font-mono">Rp ${item.total.toLocaleString('id-ID')}</td>
            </tr>
        `;
    }).join('');
}

function printOwnerReport() {
    const printable = document.getElementById('printable-owner-report');
    if (!printable) {
        window.print();
        return;
    }

    const monthSelect = document.getElementById('owner-report-month-filter');
    const selectedMonth = monthSelect ? monthSelect.value : 'all';

    // HANYA transaksi yang SUDAH LUNAS yang dicetak dalam laporan keuangan bulanan
    const paidDataset = dataset.filter(x => x.statusBayar === 'Lunas');

    let filteredItems = paidDataset;
    let periodText = 'Semua Periode';

    if (selectedMonth !== 'all') {
        filteredItems = paidDataset.filter(x => x.tanggal.startsWith(selectedMonth));
        const [year, month] = selectedMonth.split('-');
        periodText = new Date(year, month - 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    }

    const totalRevenue = filteredItems.reduce((acc, curr) => acc + (curr.total || 0), 0);
    const totalOrders = filteredItems.length;
    const avgOrder = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
    const todayFormatted = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

    let tableRows = filteredItems.map((item, idx) => `
        <tr style="border-bottom: 1px solid #e2e8f0; font-size: 11px;">
            <td style="padding: 6px 8px; text-align: center;">${idx + 1}</td>
            <td style="padding: 6px 8px; font-family: monospace; font-weight: bold;">${item.resi}</td>
            <td style="padding: 6px 8px;">${item.tanggal}</td>
            <td style="padding: 6px 8px; font-weight: 600;">${item.nama}</td>
            <td style="padding: 6px 8px;">${item.layanan} (${item.berat} kg)</td>
            <td style="padding: 6px 8px;">${item.metode} (Lunas)</td>
            <td style="padding: 6px 8px;">${item.status}</td>
            <td style="padding: 6px 8px; text-align: right; font-family: monospace; font-weight: bold;">Rp ${item.total.toLocaleString('id-ID')}</td>
        </tr>
    `).join('');

    printable.innerHTML = `
        <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; color: #0f172a; line-height: 1.4;">
            <!-- Header Kop Surat Laundry -->
            <div style="border-bottom: 2px solid #0d766e; padding-bottom: 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-end;">
                <div>
                    <h1 style="margin: 0; font-size: 22px; font-weight: 800; color: #0d766e; letter-spacing: -0.5px;">DMS LAUNDRY</h1>
                    <p style="margin: 2px 0 0 0; font-size: 11px; color: #475569;">Layanan Manajemen & Cuci Pakaian Profesional Modern</p>
                    <p style="margin: 1px 0 0 0; font-size: 10px; color: #64748b;">Jl. Kampus Unim, Mojokerto · Telp/WA: 0812-3456-7890</p>
                </div>
                <div style="text-align: right;">
                    <div style="display: inline-block; background-color: #f0fdfa; border: 1px solid #99f6e4; color: #0d766e; font-weight: 700; font-size: 11px; padding: 4px 10px; border-radius: 6px; margin-bottom: 4px;">
                        DOKUMEN KEUANGAN OWNER
                    </div>
                    <div style="font-size: 10px; color: #64748b;">Dicetak: ${todayFormatted}</div>
                </div>
            </div>

            <!-- Judul Laporan & Periode -->
            <div style="text-align: center; margin-bottom: 16px;">
                <h2 style="margin: 0; font-size: 16px; font-weight: 800; text-transform: uppercase; color: #0f172a;">LAPORAN PEMASUKAN & TRANSAKSI LUNAS BULANAN</h2>
                <div style="font-size: 12px; font-weight: 600; color: #0d766e; margin-top: 2px;">Periode: ${periodText}</div>
                <div style="font-size: 10px; color: #64748b; margin-top: 1px;">(Hanya merekap transaksi yang telah berstatus lunas)</div>
            </div>

            <!-- Ringkasan Keuangan Box -->
            <div style="display: flex; gap: 12px; margin-bottom: 18px;">
                <div style="flex: 1; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; background-color: #f8fafc;">
                    <div style="font-size: 10px; color: #64748b; font-weight: 600; text-transform: uppercase;">Total Pemasukan</div>
                    <div style="font-size: 16px; font-weight: 800; color: #0d766e; font-family: monospace; margin-top: 2px;">Rp ${totalRevenue.toLocaleString('id-ID')}</div>
                </div>
                <div style="flex: 1; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; background-color: #f8fafc;">
                    <div style="font-size: 10px; color: #64748b; font-weight: 600; text-transform: uppercase;">Pesanan Lunas</div>
                    <div style="font-size: 16px; font-weight: 800; color: #0f172a; font-family: monospace; margin-top: 2px;">${totalOrders} Pesanan</div>
                </div>
                <div style="flex: 1; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; background-color: #f8fafc;">
                    <div style="font-size: 10px; color: #64748b; font-weight: 600; text-transform: uppercase;">Status Pembayaran</div>
                    <div style="font-size: 16px; font-weight: 800; color: #059669; font-family: monospace; margin-top: 2px;">100% LUNAS</div>
                </div>
                <div style="flex: 1; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; background-color: #f8fafc;">
                    <div style="font-size: 10px; color: #64748b; font-weight: 600; text-transform: uppercase;">Rata-rata Order</div>
                    <div style="font-size: 16px; font-weight: 800; color: #0f172a; font-family: monospace; margin-top: 2px;">Rp ${avgOrder.toLocaleString('id-ID')}</div>
                </div>
            </div>

            <!-- Tabel Transaksi -->
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
                <thead>
                    <tr style="background-color: #0f2b38; color: #ffffff; font-size: 11px;">
                        <th style="padding: 8px; text-align: center; width: 30px;">No</th>
                        <th style="padding: 8px; text-align: left;">Resi</th>
                        <th style="padding: 8px; text-align: left;">Tanggal</th>
                        <th style="padding: 8px; text-align: left;">Pelanggan</th>
                        <th style="padding: 8px; text-align: left;">Layanan</th>
                        <th style="padding: 8px; text-align: left;">Pembayaran</th>
                        <th style="padding: 8px; text-align: left;">Status</th>
                        <th style="padding: 8px; text-align: right;">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
                <tfoot>
                    <tr style="background-color: #f1f5f9; font-weight: bold; font-size: 12px; border-top: 2px solid #0d766e;">
                        <td colspan="7" style="padding: 10px 8px; text-align: right;">TOTAL KESELURUHAN:</td>
                        <td style="padding: 10px 8px; text-align: right; font-family: monospace; color: #0d766e; font-size: 13px;">Rp ${totalRevenue.toLocaleString('id-ID')}</td>
                    </tr>
                </tfoot>
            </table>

            <!-- Tanda Tangan Formal -->
            <div style="display: flex; justify-content: space-between; margin-top: 36px; padding: 0 24px;">
                <div style="text-align: center; font-size: 11px;">
                    <div style="color: #64748b; margin-bottom: 50px;">Dibuat dan Diperiksa Oleh,</div>
                    <div style="font-weight: 700; text-decoration: underline;">Kasir / Admin DMS Laundry</div>
                    <div style="color: #64748b; font-size: 10px;">Bagian Administrasi Keuangan</div>
                </div>
                <div style="text-align: center; font-size: 11px;">
                    <div style="color: #64748b; margin-bottom: 50px;">Disetujui Oleh,</div>
                    <div style="font-weight: 700; text-decoration: underline;">Pemilik Usaha (Owner)</div>
                    <div style="color: #64748b; font-size: 10px;">DMS Laundry</div>
                </div>
            </div>
        </div>
    `;

    printable.classList.remove('hidden');
    window.print();
    setTimeout(() => {
        printable.classList.add('hidden');
    }, 1500);
}

// ========================================================
// 5. RECEIPT STRUK CETAK
// ========================================================
function showReceipt(item) {
    document.getElementById('rec-resi').innerText = item.resi;
    document.getElementById('rec-tgl').innerText = item.tanggal;
    document.getElementById('rec-nama').innerText = item.nama;
    document.getElementById('rec-tipe').innerText = item.tipe;
    document.getElementById('rec-layanan').innerText = `${item.layanan} (${item.berat} kg)`;
    document.getElementById('rec-subtotal').innerText = `Rp ${item.subtotal.toLocaleString('id-ID')}`;
    
    const ongRow = document.getElementById('rec-row-ongkir');
    const ongEl = document.getElementById('rec-ongkir');
    if (ongRow && ongEl) {
        if (item.ongkir > 0) {
            ongRow.classList.remove('hidden');
            ongEl.innerText = `Rp ${item.ongkir.toLocaleString('id-ID')}`;
        } else {
            ongRow.classList.add('hidden');
        }
    }

    document.getElementById('rec-total').innerText = `Rp ${item.total.toLocaleString('id-ID')}`;

    document.getElementById('modal-receipt').classList.remove('hidden');
}

function showReceiptByResi(resi) {
    const item = dataset.find(x => x.resi === resi);
    if (item) showReceipt(item);
}

function closeReceipt() {
    document.getElementById('modal-receipt').classList.add('hidden');
}

// Inisialisasi Tampilan Awal saat Web Dibuka
if (currentUser) {
    initDashboardView();
} else {
    showPublicLanding();
}

// Sinkronisasi data awal dengan database Supabase Cloud jika aktif
let dataSyncRunning = false;
let lastDataSyncAt = 0;

async function initDataSync() {
    if (dataSyncRunning) return;
    dataSyncRunning = true;
    try {
        if (typeof fetchUsersFromDB === 'function') {
            const remoteUsers = await fetchUsersFromDB();
            if (remoteUsers && remoteUsers.length > 0) {
                users = remoteUsers;
            }
        }
        if (typeof fetchTransactionsFromServer === 'function') {
            // null = server tidak bisa dihubungi -> data lokal dibiarkan apa adanya
            const remoteTrx = await fetchTransactionsFromServer();
            if (Array.isArray(remoteTrx)) {
                // Supabase adalah sumber utama: pesanan yang sudah tidak ada di Supabase ikut dihapus dari web.
                // Pengecualian: pesanan baru yang belum berhasil terkirim tetap dipertahankan dan dikirim ulang.
                const remoteResi = new Set(remoteTrx.map(r => String(r.resi)));
                const pending = loadPendingResi().filter(r => !remoteResi.has(r));
                const unsynced = dataset.filter(x => x && pending.includes(String(x.resi)));
                savePendingResi(unsynced.map(x => String(x.resi)));

                dataset = [...unsynced, ...remoteTrx];
                saveData();
                unsynced.forEach(o => pushOrderToCloud(o));

                refreshRoleViews();
            }
        }
    } catch (err) {
        console.warn('[Sinkron] Gagal sinkronisasi data:', err.message);
    } finally {
        dataSyncRunning = false;
        lastDataSyncAt = Date.now();
    }
}

// Sinkron ulang saat tab web dibuka kembali (maksimal sekali per 15 detik)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastDataSyncAt > 15000) {
        initDataSync();
    }
});

initPelangganJadwal();
updateJamKerjaBanner();
updateCashMethodOption();
setInterval(workingHoursTick, 30000);
initDataSync();