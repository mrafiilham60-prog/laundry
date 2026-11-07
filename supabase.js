// ========================================================
// KONFIGURASI & KONEKSI SUPABASE: DMS LAUNDRY
// ========================================================

/**
 * PANDUAN MENGHUBUNGKAN KE SUPABASE:
 * 1. Buka dashboard proyek Supabase Anda: https://supabase.com/dashboard
 * 2. Masuk ke Project Settings -> Configuration -> API
 * 3. Salin "Project URL" dan tempel ke SUPABASE_URL di bawah ini.
 * 4. Salin "anon public" API Key dan tempel ke SUPABASE_ANON_KEY di bawah ini.
 * 5. Jalankan query SQL dari file "supabase_schema.sql" di SQL Editor Supabase.
 */

const SUPABASE_CONFIG = {
    // URL Proyek Supabase Anda:
    url: 'https://fcsplxevjjxrqweuivuk.supabase.co',
    
    // Anon Public Key Anda:
    anonKey: 'sb_publishable_Ua2erxAJovQoXaarKIdQgg_9leNdozJ'
};

// Cek apakah konfigurasi Supabase sudah diisi dengan benar
function isSupabaseConfigured() {
    return SUPABASE_CONFIG.url && 
           SUPABASE_CONFIG.anonKey && 
           !SUPABASE_CONFIG.url.includes('YOUR_PROJECT_ID') && 
           !SUPABASE_CONFIG.anonKey.includes('YOUR_SUPABASE_ANON_KEY');
}

// Inisialisasi Supabase Client jika SDK tersedia
let supabase = null;
try {
    if (typeof window.supabase !== 'undefined' && isSupabaseConfigured()) {
        supabase = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
        console.log('%c[Supabase] Berhasil terhubung ke Supabase Cloud!', 'color: #0d766e; font-weight: bold;');
    } else {
        console.log('%c[Supabase] Berjalan dalam mode LocalStorage (Offline / Demo). Masukkan URL & Key Supabase di supabase.js untuk mengaktifkan cloud.', 'color: #f59e0b;');
    }
} catch (err) {
    console.warn('[Supabase] Gagal menginisialisasi klien Supabase:', err);
}

// ========================================================
// OPERASI DATABASE PENGGUNA (USERS / ADMIN / OWNER / PELANGGAN)
// ========================================================

/**
 * Mengambil seluruh data pengguna dari Supabase (atau fallback LocalStorage)
 */
async function fetchUsersFromDB() {
    if (supabase) {
        try {
            const { data, error } = await supabase.from('users').select('*');
            if (error) throw error;
            if (data && data.length > 0) {
                // Simpan cache ke local storage untuk cadangan offline
                localStorage.setItem('DMS_LAUNDRY_USERS', JSON.stringify(data));
                return data;
            }
        } catch (err) {
            console.error('[Supabase] Gagal mengambil data users:', err.message);
        }
    }
    // Fallback ke LocalStorage
    return JSON.parse(localStorage.getItem('DMS_LAUNDRY_USERS')) || [];
}

/**
 * Menyimpan pengguna baru ke Supabase & LocalStorage
 */
async function insertUserToDB(userObj) {
    // Pastikan field lengkap
    const payload = {
        username: userObj.hp || userObj.username,
        nama: userObj.nama,
        hp: userObj.hp || userObj.username,
        password: userObj.password,
        role: userObj.role || 'pelanggan'
    };

    if (supabase) {
        try {
            const { data, error } = await supabase.from('users').insert([payload]).select();
            if (error) throw error;
            console.log('[Supabase] Pengguna baru tersimpan di cloud:', data);
            return { success: true, data };
        } catch (err) {
            console.error('[Supabase] Error insert user:', err.message);
            return { success: false, error: err.message };
        }
    }

    return { success: true, offline: true };
}

// ========================================================
// OPERASI DATABASE TRANSAKSI (ORDERS)
// ========================================================

/**
 * Mengambil seluruh transaksi dari Supabase (atau fallback LocalStorage)
 */
async function fetchTransactionsFromDB() {
    if (supabase) {
        try {
            const { data, error } = await supabase
                .from('transaksi')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            if (data && data.length > 0) {
                // Mapping kolom database (snake_case) ke format aplikasi (camelCase)
                const mappedData = data.map(item => ({
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

                localStorage.setItem('DMS_LAUNDRY_TRANSAKSI', JSON.stringify(mappedData));
                return mappedData;
            }
        } catch (err) {
            console.error('[Supabase] Gagal mengambil data transaksi:', err.message);
        }
    }
    // Fallback ke LocalStorage
    return JSON.parse(localStorage.getItem('DMS_LAUNDRY_TRANSAKSI')) || [];
}

/**
 * Menyimpan transaksi baru ke Supabase
 */
async function insertTransactionToDB(trxObj) {
    const payload = {
        resi: trxObj.resi,
        nama: trxObj.nama,
        hp: trxObj.hp,
        layanan: trxObj.layanan,
        berat: trxObj.berat,
        tipe: trxObj.tipe,
        alamat: trxObj.alamat || '',
        jam: trxObj.jam || '',
        catatan: trxObj.catatan || '',
        subtotal: trxObj.subtotal,
        diskon: trxObj.diskon || 0,
        ongkir: trxObj.ongkir || 0,
        total: trxObj.total,
        metode: trxObj.metode,
        status_bayar: trxObj.statusBayar,
        status: trxObj.status,
        tanggal: trxObj.tanggal || new Date().toISOString().split('T')[0]
    };

    if (supabase) {
        try {
            const { data, error } = await supabase.from('transaksi').insert([payload]).select();
            if (error) throw error;
            console.log('[Supabase] Transaksi berhasil tersimpan di cloud:', data);
            return { success: true, data };
        } catch (err) {
            console.error('[Supabase] Error insert transaksi:', err.message);
            return { success: false, error: err.message };
        }
    }

    return { success: true, offline: true };
}

/**
 * Memperbarui status pesanan dan status pembayaran di Supabase
 */
async function updateTransactionStatusInDB(resi, newStatus, newStatusBayar) {
    const updates = { status: newStatus };
    if (newStatusBayar) updates.status_bayar = newStatusBayar;

    if (supabase) {
        try {
            const { data, error } = await supabase
                .from('transaksi')
                .update(updates)
                .eq('resi', resi)
                .select();

            if (error) throw error;
            console.log('[Supabase] Status transaksi di cloud diperbarui:', data);
            return { success: true, data };
        } catch (err) {
            console.error('[Supabase] Error update status transaksi:', err.message);
            return { success: false, error: err.message };
        }
    }

    return { success: true, offline: true };
}
