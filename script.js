let users = JSON.parse(localStorage.getItem('DMS_LAUNDRY_USERS')) || [
    { nama: 'Rina Melati', hp: '081234567890', password: 'User123' },
    { nama: 'Budi Santoso', hp: '085712345678', password: 'User123' }
];

let currentUser = JSON.parse(sessionStorage.getItem('DMS_LAUNDRY_USER')) || null;
let loginTimer = null;
let logoutTimer = null;

function saveData() { localStorage.setItem('DMS_LAUNDRY_TRANSAKSI', JSON.stringify(dataset)); }
function saveUsers() { localStorage.setItem('DMS_LAUNDRY_USERS', JSON.stringify(users)); }

// ========================================================
// NAVIGASI SCREEN UTAMA (Landing, Auth, Dashboard)
// ========================================================
function showPublicLanding() {
    document.getElementById('screen-public').classList.remove('hidden');
    document.getElementById('screen-login').classList.add('hidden');
    document.getElementById('screen-dashboard').classList.add('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showAuthScreen(tab = 'login') {
    document.getElementById('screen-public').classList.add('hidden');
    document.getElementById('screen-login').classList.remove('hidden');
    document.getElementById('screen-dashboard').classList.add('hidden');
    switchAuthTab(tab);
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    if (typeof supabase !== 'undefined' && supabase) {
        try {
            const { data, error } = await supabase
                .from('users')
                .select('*')
                .or(`username.eq."${u}",hp.eq."${u}"`)
                .eq('password', p)
                .maybeSingle();

            if (!error && data) {
                authUser = { role: data.role, nama: data.nama, hp: data.hp, id: data.id };
            }
        } catch (err) {
            console.warn('[Supabase] Gagal login via Supabase, beralih ke cache lokal:', err);
        }
    }

    // 2. Fallback Autentikasi Cache / Offline Lokal
    if (!authUser) {
        // Role: Admin Kasir
        if (u.toLowerCase() === 'admin' && (p === 'Admin123' || p === 'admin123')) {
            authUser = { role: 'admin', nama: 'Administrator Kasir' };
        }
        // Role: Owner
        else if (u.toLowerCase() === 'owner' && (p === 'Owner123' || p === 'owner123')) {
            authUser = { role: 'owner', nama: 'Pemilik Usaha (Owner)' };
        }
        // Role: Pelanggan
        else {
            const found = users.find(x => (x.hp === u || (x.username && x.username === u) || x.nama.toLowerCase() === u.toLowerCase()) && x.password === p);
            if (found) {
                authUser = { role: found.role || 'pelanggan', nama: found.nama, hp: found.hp };
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

// Pop-up Logout (1 Detik)
function handleLogout() {
    sessionStorage.removeItem('DMS_LAUNDRY_USER');
    currentUser = null;

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

    screenPublic.classList.add('hidden');
    screenLogin.classList.add('hidden');
    screenDashboard.classList.remove('hidden');

    ['admin', 'pelanggan', 'owner'].forEach(r => {
        const el = document.getElementById(`view-${r}`);
        if (el) el.classList.add('hidden');
    });

    if (currentUser.role === 'admin') {
        document.getElementById('view-admin').classList.remove('hidden');
        document.getElementById('admin-sidebar-name').innerText = currentUser.nama;
        document.getElementById('kasir-name-display').innerText = currentUser.nama;
        switchAdminTab('input-order');
        refreshNextAutoResi();
        calculateKasirTotals();
        renderOnlineOrdersTable();
    } else if (currentUser.role === 'pelanggan') {
        document.getElementById('view-pelanggan').classList.remove('hidden');
        document.getElementById('pelanggan-name-nav').innerText = currentUser.nama;
        switchPelangganTab('buat');
        renderPelangganOrders();
    } else if (currentUser.role === 'owner') {
        document.getElementById('view-owner').classList.remove('hidden');
        switchOwnerTab('pemasukan');
    }

    // Pastikan posisi scroll langsung berada di paling atas
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.body.scrollTop = 0;
    document.documentElement.scrollTop = 0;
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

    // Tentukan index tahapan: Dijemput (1), Dicuci (2), Disetrika (3), Diantar / Selesai (4)
    let stepIndex = 1;
    if (item.status === 'Baru' || item.status === 'Dijemput') stepIndex = 1;
    else if (item.status === 'Diproses' || item.status === 'Dicuci') stepIndex = 2;
    else if (item.status === 'Disetrika') stepIndex = 3;
    else if (item.status === 'Siap diantar' || item.status === 'Selesai') stepIndex = 4;

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
        tabInput.classList.remove('hidden');
        tabOnline.classList.add('hidden');
        navInput.className = 'flex-1 md:w-full text-left px-4 py-2.5 rounded-xl bg-teal-800 text-white transition flex items-center gap-2.5';
        navOnline.className = 'flex-1 md:w-full text-left px-4 py-2.5 rounded-xl text-slate-300 hover:bg-navy-800 hover:text-white transition flex items-center justify-between';
    } else {
        tabInput.classList.add('hidden');
        tabOnline.classList.remove('hidden');
        navOnline.className = 'flex-1 md:w-full text-left px-4 py-2.5 rounded-xl bg-teal-800 text-white transition flex items-center justify-between';
        navInput.className = 'flex-1 md:w-full text-left px-4 py-2.5 rounded-xl text-slate-300 hover:bg-navy-800 hover:text-white transition flex items-center gap-2.5';
        renderOnlineOrdersTable();
    }
}

function refreshNextAutoResi() {
    const nextNum = String(dataset.length + 1).padStart(4, '0');
    const autoResi = `LD-${nextNum}`;
    const el = document.getElementById('auto-resi-display');
    if (el) el.innerText = autoResi;
}

function selectKasirRadio(group, value, element) {
    const pill = element.closest('.radio-pill');
    if (!pill) return;
    const container = pill.parentElement;
    container.querySelectorAll('.radio-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');

    if (group === 'metode') document.getElementById('kasir-metode-val').value = value;
    if (group === 'status-bayar') document.getElementById('kasir-status-bayar-val').value = value;
}

function calculateKasirTotals() {
    const qtyKiloan = parseFloat(document.getElementById('qty-kiloan').value) || 0;
    const qtyExpress = parseFloat(document.getElementById('qty-express').value) || 0;
    const diskon = parseFloat(document.getElementById('kasir-diskon').value) || 0;

    const subKiloan = qtyKiloan * 7000;
    const subExpress = qtyExpress * 10000;
    const subtotal = subKiloan + subExpress;
    const total = Math.max(0, subtotal - diskon);

    document.getElementById('subtotal-kiloan-text').innerText = `Rp ${subKiloan.toLocaleString('id-ID')}`;
    document.getElementById('subtotal-express-text').innerText = `Rp ${subExpress.toLocaleString('id-ID')}`;
    document.getElementById('kasir-subtotal-display').innerText = `Rp ${subtotal.toLocaleString('id-ID')}`;
    document.getElementById('kasir-total-display').innerText = `Rp ${total.toLocaleString('id-ID')}`;

    return { subtotal, diskon, total, qtyKiloan, qtyExpress };
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
    document.getElementById('kasir-cust-search').value = '';
    document.getElementById('kasir-cust-name').value = '';
    document.getElementById('kasir-cust-hp').value = '';
    document.getElementById('kasir-cust-selected').classList.add('hidden');
}

async function quickNewCustomer() {
    const nama = prompt('Masukkan Nama Lengkap Pelanggan Baru:');
    if (!nama) return;
    const hp = prompt('Masukkan Nomor HP Pelanggan (08... / 62..., 10-13 digit):');
    if (!hp) return;

    const check = validateIndonesianPhone(hp);
    if (!check.valid) {
        alert(check.message);
        return;
    }

    const newUser = { nama, hp: check.cleanNumber, password: 'User123', role: 'pelanggan' };
    users.push(newUser);
    saveUsers();

    if (typeof insertUserToDB === 'function') {
        await insertUserToDB(newUser);
    }

    document.getElementById('kasir-cust-name').value = nama;
    document.getElementById('kasir-cust-hp').value = check.cleanNumber;
    document.getElementById('kasir-cust-search').value = `${nama} (${check.cleanNumber})`;
    document.getElementById('cust-selected-name').innerText = nama;
    document.getElementById('cust-selected-hp').innerText = check.cleanNumber;
    document.getElementById('kasir-cust-selected').classList.remove('hidden');
}

async function handleKasirOrder(e) {
    e.preventDefault();
    const { subtotal, diskon, total, qtyKiloan, qtyExpress } = calculateKasirTotals();

    if (qtyKiloan === 0 && qtyExpress === 0) {
        triggerLoginError('Silakan masukkan jumlah berat/qty cucian (minimal 1 item).', 'Order Gagal');
        return;
    }

    let nama = document.getElementById('kasir-cust-name').value.trim();
    let hp = document.getElementById('kasir-cust-hp').value.trim();

    if (!nama) {
        nama = document.getElementById('kasir-cust-search').value.trim() || 'Pelanggan Toko';
        hp = '081234567890';
    }

    const nextNum = String(dataset.length + 1).padStart(4, '0');
    const resi = `LD-${nextNum}`;

    let layananStr = [];
    if (qtyKiloan > 0) layananStr.push(`Cuci Kiloan (${qtyKiloan} kg)`);
    if (qtyExpress > 0) layananStr.push(`Express (${qtyExpress} kg)`);

    const item = {
        resi,
        nama,
        hp,
        layanan: layananStr.join(', '),
        berat: qtyKiloan + qtyExpress,
        tipe: 'Order di Toko',
        alamat: '',
        jam: document.getElementById('kasir-estimasi').value,
        catatan: '',
        subtotal,
        diskon,
        ongkir: 0,
        total,
        metode: document.getElementById('kasir-metode-val').value,
        statusBayar: document.getElementById('kasir-status-bayar-val').value,
        status: 'Diproses',
        tanggal: new Date().toISOString().split('T')[0]
    };

    dataset.unshift(item);
    saveData();

    // Simpan ke Supabase jika terhubung
    if (typeof insertTransactionToDB === 'function') {
        await insertTransactionToDB(item);
    }

    // Reset Form
    clearSelectedCustomer();
    document.getElementById('qty-kiloan').value = 0;
    document.getElementById('qty-express').value = 0;
    document.getElementById('kasir-diskon').value = 0;
    calculateKasirTotals();
    refreshNextAutoResi();

    // Cetak & Tampilkan Struk
    showReceipt(item);
}

// Pesanan Online (Table List Page 14)
let currentOnlineFilter = 'Semua';
function filterOnlineOrders(filter, btn) {
    currentOnlineFilter = filter;
    document.querySelectorAll('.filter-pill').forEach(b => {
        b.className = 'filter-pill px-3.5 py-1.5 rounded-full text-xs font-semibold bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 transition';
    });
    btn.className = 'filter-pill active px-3.5 py-1.5 rounded-full text-xs font-semibold bg-teal-50 text-teal-700 border border-teal-600 transition';
    renderOnlineOrdersTable();
}

function renderOnlineOrdersTable() {
    const tbody = document.getElementById('tabel-online-body');
    if (!tbody) return;

    let items = dataset.filter(x => x.tipe.toLowerCase().includes('kurir') || x.tipe.toLowerCase().includes('online') || x.status === 'Baru');
    document.getElementById('badge-online-count').innerText = dataset.filter(x => x.status === 'Baru').length;

    if (currentOnlineFilter !== 'Semua') {
        items = items.filter(x => x.status === currentOnlineFilter);
    }

    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-slate-400">Tidak ada pesanan online pada kategori ini.</td></tr>`;
        return;
    }

    tbody.innerHTML = items.map(item => {
        // Status Badges
        let statusBadge = '';
        if (item.status === 'Baru') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200">Baru</span>`;
        else if (item.status === 'Dijemput') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200">Dijemput</span>`;
        else if (item.status === 'Diproses' || item.status === 'Dicuci') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-teal-50 text-teal-700 border border-teal-200">Diproses</span>`;
        else statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">${item.status}</span>`;

        // Payment Badges
        let bayarBadge = item.statusBayar === 'Lunas' ?
            `<span class="text-emerald-700 font-semibold">Lunas</span>` :
            `<span class="text-rose-600 font-semibold">Belum dibayar</span>`;

        // Action Button
        let actionBtn = '';
        if (item.status === 'Baru') {
            actionBtn = `<button onclick="advanceOrderStatus('${item.resi}', 'Dijemput')" class="px-3.5 py-1.5 rounded-lg bg-teal-700 text-white font-semibold hover:bg-teal-800 transition">Terima pesanan</button>`;
        } else if (item.status === 'Dijemput') {
            actionBtn = `<button onclick="advanceOrderStatus('${item.resi}', 'Diproses')" class="px-3.5 py-1.5 rounded-lg bg-teal-700 text-white font-semibold hover:bg-teal-800 transition">Update status</button>`;
        } else if (item.status === 'Diproses') {
            actionBtn = `<button onclick="advanceOrderStatus('${item.resi}', 'Selesai')" class="px-3.5 py-1.5 rounded-lg bg-teal-700 text-white font-semibold hover:bg-teal-800 transition">Update status</button>`;
        } else {
            actionBtn = `<button onclick="showReceiptByResi('${item.resi}')" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 font-semibold transition">Struk</button>`;
        }

        return `
            <tr class="hover:bg-slate-50 transition">
                <td class="p-4 font-bold text-teal-800 font-mono">${item.resi}</td>
                <td class="p-4 font-semibold text-slate-900">${item.nama}</td>
                <td class="p-4 text-slate-600">${item.layanan}</td>
                <td class="p-4 text-slate-600">${item.metode} · ${bayarBadge}</td>
                <td class="p-4 text-slate-600">${item.tipe}</td>
                <td class="p-4 text-slate-600 font-mono text-[11px]">${item.jam || '-'}</td>
                <td class="p-4">${statusBadge}</td>
                <td class="p-4 text-center">${actionBtn}</td>
            </tr>
        `;
    }).join('');
}

async function advanceOrderStatus(resi, newStatus) {
    const item = dataset.find(x => x.resi === resi);
    if (!item) return;
    item.status = newStatus;
    if (newStatus === 'Selesai') item.statusBayar = 'Lunas';
    saveData();
    renderOnlineOrdersTable();

    // Sinkronkan update status ke Supabase
    if (typeof updateTransactionStatusInDB === 'function') {
        await updateTransactionStatusInDB(resi, newStatus, item.statusBayar);
    }
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

function selectPelangganRadio(group, val, element) {
    const pill = element.closest('.radio-pill');
    if (!pill) return;
    const container = pill.parentElement;
    container.querySelectorAll('.radio-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');

    if (group === 'layanan') {
        document.getElementById('pelanggan-layanan-val').value = val;
    }
    if (group === 'pengambilan') {
        document.getElementById('pelanggan-pengambilan-val').value = val;
        const secAlamat = document.getElementById('section-pelanggan-alamat');
        if (val === 'Dijemput kurir') {
            secAlamat.classList.remove('hidden');
            document.getElementById('pelanggan-ongkir-text').innerText = 'Rp 3.000';
            document.getElementById('pelanggan-total-text').innerText = 'Rp 24.000';
        } else {
            secAlamat.classList.add('hidden');
            document.getElementById('pelanggan-ongkir-text').innerText = 'Rp 0';
            document.getElementById('pelanggan-total-text').innerText = 'Rp 21.000';
        }
    }
    if (group === 'metode') {
        document.getElementById('pelanggan-metode-val').value = val;
    }
}

function handleKirimPesananPelanggan(e) {
    e.preventDefault();
    if (!currentUser) return;

    const layanan = document.getElementById('pelanggan-layanan-val').value;
    const pengambilan = document.getElementById('pelanggan-pengambilan-val').value;
    const alamat = document.getElementById('pelanggan-alamat').value.trim();
    const jam = document.getElementById('pelanggan-jam').value.trim();
    const catatan = document.getElementById('pelanggan-catatan').value.trim();
    const metode = document.getElementById('pelanggan-metode-val').value;

    const ongkir = pengambilan === 'Dijemput kurir' ? 3000 : 0;
    const subtotal = layanan === 'Express' ? 30000 : 21000;
    const total = subtotal + ongkir;

    const nextNum = String(dataset.length + 1).padStart(4, '0');
    const resi = `LD-${nextNum}`;

    const newOrder = {
        resi,
        nama: currentUser.nama,
        hp: currentUser.hp || '081234567890',
        layanan,
        berat: 3,
        tipe: pengambilan,
        alamat,
        jam,
        catatan,
        subtotal,
        diskon: 0,
        ongkir,
        total,
        metode,
        statusBayar: (metode === 'Tunai saat jemput/antar') ? 'Belum dibayar' : 'Lunas',
        status: 'Baru',
        tanggal: new Date().toISOString().split('T')[0]
    };

    dataset.unshift(newOrder);
    saveData();

    // Simpan ke database Supabase
    if (typeof insertTransactionToDB === 'function') {
        insertTransactionToDB(newOrder);
    }

    alert(`Pesanan berhasil dibuat!\nNomor Pesanan Anda: ${resi}\nKurir akan memproses pesanan Anda.`);
    switchPelangganTab('pesanan');
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
        if (item.status === 'Siap diantar') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-blue-50 text-blue-700">Siap diantar</span>`;
        else if (item.status === 'Dicuci' || item.status === 'Diproses') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-amber-50 text-amber-700">Dicuci</span>`;
        else if (item.status === 'Selesai') statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-50 text-emerald-700">Selesai</span>`;
        else statusBadge = `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-slate-100 text-slate-700">${item.status}</span>`;

        // Payment Badges
        let bayarBadge = item.statusBayar === 'Lunas' ?
            `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-50 text-emerald-700">Lunas</span>` :
            `<span class="px-2.5 py-1 rounded-md text-[11px] font-bold bg-rose-50 text-rose-700">Belum dibayar</span>`;

        return `
            <div class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3 hover:border-teal-600 transition">
                <div class="flex justify-between items-center">
                    <span class="text-base font-extrabold text-slate-900 font-mono">${item.resi}</span>
                    ${statusBadge}
                </div>
                <div class="text-xs text-slate-500">
                    ${item.layanan} · Estimasi selesai: ${item.tanggal}
                </div>
                <div class="flex justify-between items-center pt-2 border-t border-slate-100 text-xs">
                    <span class="text-slate-600">${item.metode} · ${bayarBadge}</span>
                    <span class="font-extrabold text-slate-900 font-mono">Rp ${item.total.toLocaleString('id-ID')}</span>
                </div>
            </div>
        `;
    }).join('');
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
    document.getElementById('rec-diskon').innerText = `Rp ${(item.diskon || 0).toLocaleString('id-ID')}`;
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
async function initDataSync() {
    if (typeof fetchUsersFromDB === 'function') {
        const remoteUsers = await fetchUsersFromDB();
        if (remoteUsers && remoteUsers.length > 0) {
            users = remoteUsers;
        }
    }
    if (typeof fetchTransactionsFromDB === 'function') {
        const remoteTrx = await fetchTransactionsFromDB();
        if (remoteTrx && remoteTrx.length > 0) {
            dataset = remoteTrx;
            if (currentUser) {
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
        }
    }
}
initDataSync();
