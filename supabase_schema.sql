-- ========================================================
-- SKEMA DATABASE SUPABASE: DMS LAUNDRY
-- Dijalankan di: Supabase Dashboard -> SQL Editor -> New Query
-- ========================================================

-- 1. Hapus tabel lama jika ingin reset (Opsional / Idempotent)
-- DROP TABLE IF EXISTS transaksi CASCADE;
-- DROP TABLE IF EXISTS users CASCADE;

-- 2. TABEL USERS (Pengguna, Admin, Owner)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL, -- Nomor HP untuk pelanggan, 'admin' untuk kasir, 'owner' untuk pemilik
    nama TEXT NOT NULL,
    hp TEXT NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'owner', 'pelanggan')),
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Index untuk pencarian cepat berdasarkan username & nomor HP
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_hp ON users(hp);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 3. TABEL TRANSAKSI (Pesanan Offline Kasir & Online Pelanggan)
CREATE TABLE IF NOT EXISTS transaksi (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resi TEXT UNIQUE NOT NULL,
    nama TEXT NOT NULL,
    hp TEXT NOT NULL,
    layanan TEXT NOT NULL,
    berat NUMERIC(10, 2) NOT NULL DEFAULT 0,
    tipe TEXT NOT NULL DEFAULT 'Order di Toko', -- 'Order di Toko', 'Dijemput kurir', 'Antar sendiri ke toko'
    alamat TEXT DEFAULT '',
    jam TEXT DEFAULT '',
    catatan TEXT DEFAULT '',
    subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
    diskon NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ongkir NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total NUMERIC(12, 2) NOT NULL DEFAULT 0,
    metode TEXT NOT NULL DEFAULT 'Tunai', -- 'Tunai', 'Transfer', 'QRIS', 'E-wallet', 'Tunai saat jemput/antar'
    status_bayar TEXT NOT NULL DEFAULT 'Belum dibayar', -- 'Lunas', 'Belum dibayar', 'DP', 'Bayar nanti'
    status TEXT NOT NULL DEFAULT 'Baru', -- 'Baru', 'Dijemput', 'Diproses', 'Siap diantar', 'Selesai'
    tanggal DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Index untuk pencarian transaksi & filter laporan bulanan
CREATE INDEX IF NOT EXISTS idx_transaksi_resi ON transaksi(resi);
CREATE INDEX IF NOT EXISTS idx_transaksi_hp ON transaksi(hp);
CREATE INDEX IF NOT EXISTS idx_transaksi_status ON transaksi(status);
CREATE INDEX IF NOT EXISTS idx_transaksi_status_bayar ON transaksi(status_bayar);
CREATE INDEX IF NOT EXISTS idx_transaksi_tanggal ON transaksi(tanggal);

-- 4. KEBIJAKAN KEAMANAN (ROW LEVEL SECURITY / RLS)
-- Mengaktifkan RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaksi ENABLE ROW LEVEL SECURITY;

-- Buat policy publik untuk akses Client Anonim (aplikasi web langsung)
-- Kebijakan Users
DROP POLICY IF EXISTS "Public read access for users" ON users;
CREATE POLICY "Public read access for users" ON users
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public insert access for users" ON users;
CREATE POLICY "Public insert access for users" ON users
    FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Public update access for users" ON users;
CREATE POLICY "Public update access for users" ON users
    FOR UPDATE USING (true);

-- Kebijakan Transaksi
DROP POLICY IF EXISTS "Public read access for transaksi" ON transaksi;
CREATE POLICY "Public read access for transaksi" ON transaksi
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public insert access for transaksi" ON transaksi;
CREATE POLICY "Public insert access for transaksi" ON transaksi
    FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Public update access for transaksi" ON transaksi;
CREATE POLICY "Public update access for transaksi" ON transaksi
    FOR UPDATE USING (true);

-- 5. DATA AWAL (SEED DATA DEFAULT)
-- Insert akun Admin Kasir, Owner, dan Pelanggan Contoh
INSERT INTO users (username, nama, hp, password, role)
VALUES 
    ('admin', 'Administrator Kasir', '081200000001', 'Admin123', 'admin'),
    ('owner', 'Pemilik Usaha (Owner)', '081200000002', 'Owner123', 'owner'),
    ('081234567890', 'Rina Melati', '081234567890', 'User123', 'pelanggan'),
    ('085712345678', 'Budi Santoso', '085712345678', 'User123', 'pelanggan')
ON CONFLICT (username) DO NOTHING;

-- Insert transaksi awal
INSERT INTO transaksi (resi, nama, hp, layanan, berat, tipe, alamat, jam, catatan, subtotal, diskon, ongkir, total, metode, status_bayar, status, tanggal)
VALUES 
    ('LD-0005', 'Rina Melati', '081234567890', 'Cuci Kiloan', 3, 'Dijemput kurir', 'Jl. Melati No. 12', '09.00-11.00', 'Pisahkan pakaian putih', 21000, 0, 3000, 24000, 'Transfer', 'Belum dibayar', 'Baru', CURRENT_DATE),
    ('LD-0003', 'Budi Santoso', '085712345678', 'Express', 2, 'Antar sendiri ke toko', '', '13.00-15.00', '', 20000, 0, 0, 20000, 'QRIS', 'Lunas', 'Dijemput', CURRENT_DATE - INTERVAL '1 day'),
    ('LD-0002', 'Dewi Lestari', '081987654321', 'Cuci Kiloan', 4, 'Dijemput kurir', 'Jl. Pahlawan No. 4', '10.00-12.00', 'Gunakan pewangi lavender', 28000, 3000, 3000, 28000, 'Tunai', 'Belum dibayar', 'Diproses', CURRENT_DATE - INTERVAL '2 days'),
    ('LD-0001', 'Ahmad Fauzi', '081345678901', 'Cuci Kiloan', 5, 'Dijemput kurir', 'Jl. Merdeka No. 88', '08.00-10.00', '', 35000, 5000, 3000, 33000, 'QRIS', 'Lunas', 'Siap diantar', CURRENT_DATE - INTERVAL '3 days'),
    ('LD-0000', 'Siti Rahma', '082134567890', 'Cuci Kiloan', 3, 'Antar sendiri ke toko', '', '', '', 21000, 0, 0, 21000, 'Tunai', 'Lunas', 'Selesai', CURRENT_DATE - INTERVAL '4 days')
ON CONFLICT (resi) DO NOTHING;
