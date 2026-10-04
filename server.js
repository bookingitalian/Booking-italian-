const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to Render Environment Variables.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3
});

const norm = v => String(v ?? '').trim().replace(/\s+/g, ' ');
const passportOk = v => /^A\d{8}$/i.test(norm(v));
const nationalIdOk = v => /^\d{14}$/.test(norm(v));
const phoneOk = v => /^01\d{9}$/.test(norm(v));
const ticketOk = v => /^IT-\d{6}$/i.test(norm(v));
const italianServices = new Set(['national', 'schengen', 'consular', 'attestation']);

async function initDb() {
  // Existing medical table — preserved exactly as the current backend uses it.
  await pool.query(`CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    ticket TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    passport TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL UNIQUE,
    booking_date TEXT NOT NULL,
    exam_date TEXT NOT NULL,
    payment INTEGER NOT NULL DEFAULT 2500,
    exam_place TEXT NOT NULL DEFAULT 'حميات العباسية',
    governorate TEXT NOT NULL DEFAULT 'القاهرة',
    destination TEXT NOT NULL DEFAULT 'الأردن',
    status TEXT NOT NULL DEFAULT 'محجوز',
    created_at TEXT NOT NULL
  )`);

  // Italian portal uses a separate table in the SAME PostgreSQL/Supabase database.
  // This prevents Italian bookings from colliding with the existing medical bookings.
  await pool.query(`CREATE TABLE IF NOT EXISTS italian_appointments (
    id TEXT PRIMARY KEY,
    ticket TEXT NOT NULL UNIQUE,
    service TEXT NOT NULL,
    name TEXT NOT NULL,
    identity TEXT NOT NULL,
    phone TEXT NOT NULL,
    appointment_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'قيد المراجعة',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_at TIMESTAMPTZ
  )`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_italian_appointments_identity ON italian_appointments(identity)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_italian_appointments_phone ON italian_appointments(phone)`);
}

async function medicalTicket() {
  while (true) {
    const t = 'mc' + crypto.randomInt(10000000000, 100000000000);
    const result = await pool.query('SELECT 1 FROM appointments WHERE ticket = $1 LIMIT 1', [t]);
    if (result.rowCount === 0) return t;
  }
}

async function italianTicket() {
  while (true) {
    const t = 'IT-' + crypto.randomInt(100000, 1000000);
    const result = await pool.query('SELECT 1 FROM italian_appointments WHERE ticket = $1 LIMIT 1', [t]);
    if (result.rowCount === 0) return t;
  }
}

async function row(q) {
  const result = await pool.query(
    'SELECT * FROM appointments WHERE passport = $1 OR phone = $1 OR ticket = $2 LIMIT 1',
    [q.toUpperCase(), q.toLowerCase()]
  );
  return result.rows[0] || null;
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// =========================
// Existing medical portal API — preserved
// =========================
app.post('/api/appointments', async (req, res) => {
  try {
    const x = req.body || {};
    const name = norm(x.name);
    const passport = norm(x.passport).toUpperCase();
    const phone = norm(x.phone);

    if (name.length < 3) return res.status(400).json({ error: 'يرجى كتابة الاسم بشكل صحيح.' });
    if (!passportOk(passport)) return res.status(400).json({ error: 'رقم الجواز غير صحيح. يجب أن يبدأ بحرف A ويتبعه 8 أرقام.' });
    if (!phoneOk(phone)) return res.status(400).json({ error: 'رقم الهاتف غير صحيح. يجب أن يتكون من 11 رقمًا ويبدأ بـ 01.' });
    if (x.booking_date && x.exam_date && x.exam_date < x.booking_date) return res.status(400).json({ error: 'تاريخ الكشف لا يمكن أن يكون قبل تاريخ الحجز.' });

    const dup = await pool.query('SELECT 1 FROM appointments WHERE passport = $1 OR phone = $2 LIMIT 1', [passport, phone]);
    if (dup.rowCount) return res.status(409).json({ error: 'لا يمكن التسجيل مرة أخرى بنفس رقم الجواز أو رقم الهاتف.' });

    const data = {
      id: crypto.randomUUID(),
      ticket: await medicalTicket(),
      name,
      passport,
      phone,
      booking_date: norm(x.booking_date),
      exam_date: norm(x.exam_date),
      payment: 2500,
      exam_place: 'حميات العباسية',
      governorate: 'القاهرة',
      destination: 'الأردن',
      status: 'محجوز',
      created_at: new Date().toISOString()
    };

    await pool.query(
      `INSERT INTO appointments
       (id,ticket,name,passport,phone,booking_date,exam_date,payment,exam_place,governorate,destination,status,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [data.id, data.ticket, data.name, data.passport, data.phone, data.booking_date, data.exam_date,
       data.payment, data.exam_place, data.governorate, data.destination, data.status, data.created_at]
    );

    res.status(201).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ في الخادم.' });
  }
});

app.get('/api/appointments/search', async (req, res) => {
  try {
    const q = norm(req.query.q);
    if (!q) return res.status(400).json({ error: 'أدخل رقم الجواز أو الهاتف أو رقم التذكرة.' });
    if (/^[a-zA-Z]/.test(q) && !passportOk(q) && !/^mc\d{11}$/i.test(q)) return res.status(400).json({ error: 'البيانات المدخلة غير صحيحة.' });
    if (/^A/i.test(q) && !passportOk(q)) return res.status(400).json({ error: 'رقم الجواز غير صحيح. يجب أن يبدأ بحرف A ويتبعه 8 أرقام.' });
    if (/^MC/i.test(q) && !/^mc\d{11}$/i.test(q)) return res.status(400).json({ error: 'رقم التذكرة غير صحيح. يجب أن يبدأ بـ mc ويتبعه 11 رقمًا.' });
    if (/^\d+$/.test(q) && !phoneOk(q)) return res.status(400).json({ error: 'رقم الهاتف غير صحيح. يجب أن يتكون من 11 رقمًا ويبدأ بـ 01.' });

    const x = await row(q);
    if (!x) return res.status(404).json({ error: 'البيانات غير صحيحة أو لا يوجد حجز مطابق.' });
    res.json(x);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ في الخادم.' });
  }
});

// =========================
// Italian portal API — new, same database
// =========================
app.post('/api/italian/bookings', async (req, res) => {
  try {
    const x = req.body || {};
    const service = norm(x.service);
    const name = norm(x.name);
    const identity = norm(x.identity).toUpperCase();
    const phone = norm(x.phone);
    const date = norm(x.date);

    if (!italianServices.has(service)) return res.status(400).json({ error: 'الخدمة المختارة غير صحيحة.' });
    if (name.length < 3) return res.status(400).json({ error: 'يرجى كتابة الاسم بالكامل بشكل صحيح.' });
    if (!passportOk(identity) && !nationalIdOk(identity)) return res.status(400).json({ error: 'رقم الجواز أو الرقم القومي غير صحيح.' });
    if (!phoneOk(phone)) return res.status(400).json({ error: 'رقم الهاتف غير صحيح. يجب أن يتكون من 11 رقمًا ويبدأ بـ 01.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'تاريخ الموعد غير صحيح.' });

    const data = {
      id: crypto.randomUUID(),
      ticket: await italianTicket(),
      service,
      name,
      identity,
      phone,
      date,
      status: 'قيد المراجعة'
    };

    await pool.query(
      `INSERT INTO italian_appointments
       (id,ticket,service,name,identity,phone,appointment_date,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [data.id, data.ticket, data.service, data.name, data.identity, data.phone, data.date, data.status]
    );

    res.status(201).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء حفظ الحجز.' });
  }
});

app.get('/api/italian/bookings/search', async (req, res) => {
  try {
    const ticket = norm(req.query.ticket).toUpperCase();
    const identity = norm(req.query.identity).toUpperCase();

    if (!ticketOk(ticket)) return res.status(400).json({ error: 'رقم الحجز غير صحيح. يجب أن يكون مثل IT-123456.' });
    if (!passportOk(identity) && !nationalIdOk(identity)) return res.status(400).json({ error: 'رقم الجواز أو الرقم القومي غير صحيح.' });

    const result = await pool.query(
      `SELECT ticket,service,name,identity,phone,appointment_date AS date,status,created_at
       FROM italian_appointments
       WHERE ticket = $1 AND identity = $2
       LIMIT 1`,
      [ticket, identity]
    );

    if (!result.rowCount) return res.status(404).json({ error: 'لم يتم العثور على حجز مطابق.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء الاستعلام.' });
  }
});

app.post('/api/italian/bookings/cancel', async (req, res) => {
  try {
    const ticket = norm(req.body && req.body.ticket).toUpperCase();
    const identity = norm(req.body && req.body.identity).toUpperCase();

    if (!ticketOk(ticket)) return res.status(400).json({ error: 'رقم الحجز غير صحيح.' });
    if (!passportOk(identity) && !nationalIdOk(identity)) return res.status(400).json({ error: 'رقم الجواز أو الرقم القومي غير صحيح.' });

    const result = await pool.query(
      `UPDATE italian_appointments
       SET status = 'ملغى', cancelled_at = NOW()
       WHERE ticket = $1 AND identity = $2 AND status <> 'ملغى'
       RETURNING ticket,status`,
      [ticket, identity]
    );

    if (!result.rowCount) {
      const exists = await pool.query(
        `SELECT status FROM italian_appointments WHERE ticket = $1 AND identity = $2 LIMIT 1`,
        [ticket, identity]
      );
      if (!exists.rowCount) return res.status(404).json({ error: 'لم يتم العثور على حجز مطابق.' });
      if (exists.rows[0].status === 'ملغى') return res.status(409).json({ error: 'هذا الموعد ملغى بالفعل.' });
      return res.status(409).json({ error: 'تعذر إلغاء الحجز.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إلغاء الحجز.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'italian-appointment-portal' }));

app.get('*splat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`Italian appointment portal running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
