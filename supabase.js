// ========================================================
// KONFIGURASI & KONEKSI SUPABASE: DMS LAUNDRY
// ========================================================

const SUPABASE_CONFIG = {
    url: 'https://fcsplxevjjxrqweuivuk.supabase.co',
    anonKey: 'sb_publishable_Ua2erxAJovQoXaarKIdQgg_9leNdozJ'
};

// Cek apakah konfigurasi Supabase valid
function isSupabaseConfigured() {
    return Boolean(
        SUPABASE_CONFIG.url && 
        SUPABASE_CONFIG.anonKey && 
        !SUPABASE_CONFIG.url.includes('YOUR_PROJECT_ID')
    );
}

// Inisialisasi Supabase Client (menggunakan supabaseClient agar tidak konflik dengan window.supabase)
let supabaseClient = null;
try {
    if (typeof window !== 'undefined' && typeof window.supabase !== 'undefined' && typeof window.supabase.createClient === 'function' && isSupabaseConfigured()) {
        supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
        window.supabaseClient = supabaseClient;
        console.log('%c[Supabase] Klien SDK Supabase berhasil diinisialisasi!', 'color: #0d766e; font-weight: bold;');
    }
} catch (err) {
    console.warn('[Supabase] Warning saat inisialisasi SDK Supabase:', err.message);
}

// Helper Direct REST API (Bekerja 100% tanpa bergantung pada CDN SDK / file protocol)
async function supabaseRest(endpoint, options = {}) {
    if (!isSupabaseConfigured()) return null;

    const fullUrl = `${SUPABASE_CONFIG.url}/rest/v1/${endpoint}`;
    const headers = {
        'apikey': SUPABASE_CONFIG.anonKey,
        'Authorization': `Bearer ${SUPABASE_CONFIG.anonKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...(options.headers || {})
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(fullUrl, {
            ...options,
            headers,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const data = await response.json();
        return data;
    } catch (err) {
        clearTimeout(timeoutId);
        console.error(`[Supabase REST Error] ${endpoint}:`, err.message);
        throw err;
    }
}

// Notifikasi visual kecil saat sync database cloud
function showCloudToast(message, isSuccess = true) {
    try {
        let toast = document.getElementById('supabase-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'supabase-toast';
            toast.className = 'fixed bottom-5 right-5 z-[9999] px-4 py-2.5 rounded-xl text-xs font-semibold shadow-lg transition-all duration-300 transform translate-y-10 opacity-0 flex items-center space-x-2 pointer-events-none';
            document.body.appendChild(toast);
        }

        if (isSuccess) {
            toast.style.backgroundColor = '#0d766e';
            toast.style.color = '#ffffff';
            toast.innerHTML = `<svg class="w-4 h-4 text-emerald-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg><span>${message}</span>`;
        } else {
            toast.style.backgroundColor = '#ef4444';
            toast.style.color = '#ffffff';
            toast.innerHTML = `<svg class="w-4 h-4 text-white flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg><span>${message}</span>`;
        }

        toast.classList.remove('translate-y-10', 'opacity-0');
        toast.classList.add('translate-y-0', 'opacity-100');

        setTimeout(() => {
            toast.classList.remove('translate-y-0', 'opacity-100');
            toast.classList.add('translate-y-10', 'opacity-0');
        }, 3500);
    } catch (_) {}
}

// ========================================================
// OPERASI DATABASE PENGGUNA (USERS / ADMIN / OWNER / PELANGGAN)
// ========================================================

/**
 * Mengambil seluruh data pengguna dari Supabase (atau fallback LocalStorage)
 */
async function fetchUsersFromDB() {
    // 1. Coba lewat Supabase SDK Client
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient.from('users').select('*');
            if (!error && Array.isArray(data) && data.length > 0) {
                localStorage.setItem('DMS_LAUNDRY_USERS', JSON.stringify(data));
                return data;
            }
        } catch (err) {
            console.warn('[Supabase] SDK fetch users gagal, mencoba REST API fallback...', err.message);
        }
    }

    // 2. Fallback Direct REST API Supabase
    try {
        const data = await supabaseRest('users?select=*');
        if (Array.isArray(data) && data.length > 0) {
            localStorage.setItem('DMS_LAUNDRY_USERS', JSON.stringify(data));
            return data;
        }
    } catch (err) {
        console.warn('[Supabase] REST fetch users gagal, beralih ke cache lokal:', err.message);
    }

    // 3. Fallback LocalStorage Offline
    return JSON.parse(localStorage.getItem('DMS_LAUNDRY_USERS')) || [];
}

/**
 * Autentikasi Pengguna langsung ke Supabase Cloud
 */
async function loginUserFromDB(usernameOrHp, password) {
    const clean = usernameOrHp.trim();

    // 1. Coba lewat SDK
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('users')
                .select('*')
                .or(`username.eq."${clean}",hp.eq."${clean}"`)
                .eq('password', password)
                .maybeSingle();

            if (!error && data) {
                return data;
            }
        } catch (err) {
            console.warn('[Supabase SDK Login error]:', err.message);
        }
    }

    // 2. Coba lewat Direct REST API
    try {
        const query = `users?select=*&or=(username.eq.${clean},hp.eq.${clean})&password=eq.${encodeURIComponent(password)}`;
        const list = await supabaseRest(query);
        if (Array.isArray(list) && list.length > 0) {
            return list[0];
        }
    } catch (err) {
        console.warn('[Supabase REST Login error]:', err.message);
    }

    return null;
}

/**
 * Menyimpan pengguna baru ke Supabase & LocalStorage
 */
async function insertUserToDB(userObj) {
    const payload = {
        username: userObj.hp || userObj.username,
        nama: userObj.nama,
        hp: userObj.hp || userObj.username,
        password: userObj.password,
        role: userObj.role || 'pelanggan'
    };

    // 1. Coba lewat Supabase SDK Client
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient.from('users').insert([payload]).select();
            if (error) throw error;
            console.log('[Supabase SDK] Pengguna baru tersimpan di cloud:', data);
            showCloudToast('Akun berhasil disinkronkan ke Supabase Cloud!');
            return { success: true, data };
        } catch (err) {
            console.warn('[Supabase SDK] Gagal simpan user via SDK, mencoba REST...', err.message);
        }
    }

    // 2. Fallback Direct REST API
    try {
        const data = await supabaseRest('users', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        console.log('[Supabase REST] Pengguna baru tersimpan di cloud:', data);
        showCloudToast('Akun berhasil disinkronkan ke Supabase Cloud!');
        return { success: true, data };
    } catch (err) {
        console.error('[Supabase Error] Gagal simpan user ke cloud:', err.message);
        showCloudToast('Catatan: Akun tersimpan di lokal (Cloud offline / error)', false);
        return { success: false, error: err.message };
    }
}

/**
 * Mencari satu akun berdasarkan nomor HP / username (untuk fitur Lupa Kata Sandi)
 * Mengembalikan null jika tidak ditemukan atau server tidak dapat dihubungi.
 */
async function findUserByHpFromDB(hpOrUsername) {
    const clean = String(hpOrUsername || '').trim();
    if (!clean) return null;

    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('users')
                .select('*')
                .or(`username.eq."${clean}",hp.eq."${clean}"`)
                .limit(1);
            if (!error && Array.isArray(data) && data.length > 0) return data[0];
        } catch (err) {
            console.warn('[Supabase SDK] Cari akun gagal:', err.message);
        }
    }

    try {
        const list = await supabaseRest(`users?select=*&or=(username.eq.${encodeURIComponent(clean)},hp.eq.${encodeURIComponent(clean)})&limit=1`);
        if (Array.isArray(list) && list.length > 0) return list[0];
    } catch (err) {
        console.warn('[Supabase REST] Cari akun gagal:', err.message);
    }
    return null;
}

/**
 * Mengubah kata sandi akun di Supabase.
 * Dianggap berhasil HANYA jika ada baris yang benar-benar terupdate
 * (jika izin UPDATE tabel users diblokir, hasilnya 0 baris dan dilaporkan gagal).
 */
async function updateUserPasswordInDB(user, newPassword) {
    if (!user) return { success: false, error: 'Akun tidak ditemukan' };
    const useId = user.id !== undefined && user.id !== null;
    const col = useId ? 'id' : (user.hp ? 'hp' : 'username');
    const val = useId ? user.id : (user.hp || user.username);
    if (val === undefined || val === null || val === '') return { success: false, error: 'Identitas akun tidak lengkap' };

    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('users')
                .update({ password: newPassword })
                .eq(col, val)
                .select();
            if (!error && Array.isArray(data) && data.length > 0) {
                showCloudToast('Kata sandi berhasil diperbarui di Supabase Cloud!');
                return { success: true };
            }
        } catch (err) {
            console.warn('[Supabase SDK] Ubah kata sandi gagal, mencoba REST...', err.message);
        }
    }

    try {
        const data = await supabaseRest(`users?${col}=eq.${encodeURIComponent(val)}`, {
            method: 'PATCH',
            body: JSON.stringify({ password: newPassword })
        });
        if (Array.isArray(data) && data.length > 0) {
            showCloudToast('Kata sandi berhasil diperbarui di Supabase Cloud!');
            return { success: true };
        }
        return { success: false, error: 'tidak ada akun yang terupdate, periksa izin UPDATE pada tabel users' };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ========================================================
// OPERASI DATABASE TRANSAKSI (ORDERS)
// ========================================================

/**
 * Mengambil seluruh transaksi dari Supabase (atau fallback LocalStorage)
 */
async function fetchTransactionsFromServer() {
    let rawData = null;

    // 1. Coba lewat SDK
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('transaksi')
                .select('*')
                .order('created_at', { ascending: false });

            if (!error && Array.isArray(data)) {
                rawData = data;
            }
        } catch (err) {
            console.warn('[Supabase SDK] Fetch transaksi gagal, mencoba REST...', err.message);
        }
    }

    // 2. Coba lewat REST Fallback jika SDK belum dapat data
    if (!rawData) {
        try {
            const data = await supabaseRest('transaksi?select=*&order=created_at.desc');
            if (Array.isArray(data)) {
                rawData = data;
            }
        } catch (err) {
            console.warn('[Supabase REST] Fetch transaksi gagal, beralih ke cache lokal:', err.message);
        }
    }

    // 3. Mapping data dari snake_case (DB) ke camelCase (App)
    // Server berhasil dihubungi (meskipun tabel kosong) -> hasilnya adalah data resmi dari Supabase
    if (Array.isArray(rawData)) {
        const mappedData = rawData.map(item => ({
            resi: item.resi,
            nama: item.nama,
            hp: item.hp,
            layanan: item.layanan,
            berat: parseFloat(item.berat) || 0,
            tipe: item.tipe,
            alamat: item.alamat || '',
            jam: item.jam || '',
            catatan: item.catatan || '',
            subtotal: parseFloat(item.subtotal) || 0,
            diskon: parseFloat(item.diskon) || 0,
            ongkir: parseFloat(item.ongkir) || 0,
            total: parseFloat(item.total) || 0,
            metode: item.metode,
            statusBayar: item.status_bayar,
            status: item.status,
            tanggal: item.tanggal
        }));

        return mappedData;
    }

    // Server tidak bisa dihubungi / belum dikonfigurasi: kembalikan null (BUKAN data lokal),
    // supaya aplikasi tahu bahwa data lokal tidak boleh dianggap sudah dihapus dari server.
    return null;
}

/**
 * Versi lama (tetap tersedia): memakai cache lokal jika server tidak bisa dihubungi
 */
async function fetchTransactionsFromDB() {
    const fromServer = await fetchTransactionsFromServer();
    if (fromServer && fromServer.length > 0) {
        localStorage.setItem('DMS_LAUNDRY_TRANSAKSI', JSON.stringify(fromServer));
        return fromServer;
    }
    return JSON.parse(localStorage.getItem('DMS_LAUNDRY_TRANSAKSI')) || [];
}

/**
 * Menyimpan transaksi baru ke Supabase Cloud
 */
async function insertTransactionToDB(trxObj) {
    const payload = {
        resi: trxObj.resi,
        nama: trxObj.nama,
        hp: trxObj.hp,
        layanan: trxObj.layanan,
        berat: trxObj.berat || 0,
        tipe: trxObj.tipe || 'Order di Toko',
        alamat: trxObj.alamat || '',
        jam: trxObj.jam || '',
        catatan: trxObj.catatan || '',
        subtotal: trxObj.subtotal || 0,
        diskon: trxObj.diskon || 0,
        ongkir: trxObj.ongkir || 0,
        total: trxObj.total || 0,
        metode: trxObj.metode || 'Tunai',
        status_bayar: trxObj.statusBayar || 'Belum dibayar',
        status: trxObj.status || 'Baru',
        tanggal: trxObj.tanggal || new Date().toISOString().split('T')[0]
    };

    // 1. Coba lewat SDK
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient.from('transaksi').insert([payload]).select();
            if (error) throw error;
            console.log('[Supabase SDK] Transaksi tersimpan di cloud:', data);
            showCloudToast(`Pesanan ${trxObj.resi} tersimpan di Supabase Cloud!`);
            return { success: true, data };
        } catch (err) {
            console.warn('[Supabase SDK] Gagal simpan transaksi via SDK, mencoba REST...', err.message);
        }
    }

    // 2. Fallback lewat REST API
    try {
        const data = await supabaseRest('transaksi', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        if (data === null) throw new Error('Supabase belum dikonfigurasi');
        console.log('[Supabase REST] Transaksi tersimpan di cloud:', data);
        showCloudToast(`Pesanan ${trxObj.resi} tersimpan di Supabase Cloud!`);
        return { success: true, data };
    } catch (err) {
        console.error('[Supabase Error] Gagal simpan transaksi ke cloud:', err.message);
        showCloudToast(`Catatan: Pesanan tersimpan lokal (Cloud offline / error)`, false);
        return { success: false, error: err.message };
    }
}

/**
 * Memperbarui status pesanan dan status pembayaran di Supabase Cloud
 */
async function updateTransactionStatusInDB(resi, newStatus, newStatusBayar) {
    const updates = { status: newStatus };
    if (newStatusBayar) updates.status_bayar = newStatusBayar;
    return await updateFullTransactionInDB(resi, updates);
}

/**
 * Memperbarui data transaksi lengkap di Supabase Cloud
 */
async function updateFullTransactionInDB(resi, updates) {
    const payload = {};
    if (updates.status !== undefined) payload.status = updates.status;
    if (updates.status_bayar !== undefined) payload.status_bayar = updates.status_bayar;
    if (updates.statusBayar !== undefined) payload.status_bayar = updates.statusBayar;
    if (updates.berat !== undefined) payload.berat = updates.berat;
    if (updates.subtotal !== undefined) payload.subtotal = updates.subtotal;
    if (updates.diskon !== undefined) payload.diskon = updates.diskon;
    if (updates.ongkir !== undefined) payload.ongkir = updates.ongkir;
    if (updates.total !== undefined) payload.total = updates.total;
    if (updates.layanan !== undefined) payload.layanan = updates.layanan;
    if (updates.tipe !== undefined) payload.tipe = updates.tipe;
    if (updates.metode !== undefined) payload.metode = updates.metode;
    if (updates.jam !== undefined) payload.jam = updates.jam;
    if (updates.alamat !== undefined) payload.alamat = updates.alamat;
    if (updates.catatan !== undefined) payload.catatan = updates.catatan;

    // 1. Coba lewat SDK
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('transaksi')
                .update(payload)
                .eq('resi', resi)
                .select();

            if (error) throw error;
            console.log('[Supabase SDK] Data transaksi diperbarui di cloud:', data);
            showCloudToast(`Pesanan ${resi} berhasil diperbarui di cloud!`);
            return { success: true, data };
        } catch (err) {
            console.warn('[Supabase SDK] Gagal update transaksi via SDK, mencoba REST...', err.message);
        }
    }

    // 2. Fallback lewat REST API
    try {
        const data = await supabaseRest(`transaksi?resi=eq.${encodeURIComponent(resi)}`, {
            method: 'PATCH',
            body: JSON.stringify(payload)
        });
        console.log('[Supabase REST] Data transaksi diperbarui di cloud:', data);
        showCloudToast(`Pesanan ${resi} berhasil diperbarui di cloud!`);
        return { success: true, data };
    } catch (err) {
        console.error('[Supabase Error] Gagal update transaksi ke cloud:', err.message);
        showCloudToast(`Catatan: Update pesanan tersimpan lokal`, false);
        return { success: false, error: err.message };
    }
}