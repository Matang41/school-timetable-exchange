const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Always load .env from the same folder as server.js, regardless of where
// the command is launched from.
dotenv.config({ path: path.join(__dirname, '.env') });
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const helmet = require('helmet');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { spawn } = require('child_process');

// ============================================================
// 🏫 MASTER DEPARTMENT RESOLVER V2
// ============================================================
const DEPARTMENT_RULES_PATH = path.join(__dirname, 'config', 'department_rules.json');
let DEPARTMENT_RULES = { groups: [], subject_prefix_map: {}, code_rules: [], special_code_prefix_rules: [], overrides: {}, evidence: {} };
try { DEPARTMENT_RULES = JSON.parse(fs.readFileSync(DEPARTMENT_RULES_PATH, 'utf8')); }
catch (error) { console.warn('⚠️ โหลด department_rules.json ไม่สำเร็จ:', error.message); }
function groupByCode(code){ return (DEPARTMENT_RULES.groups||[]).find(g=>g.code===code)||null; }
function subjectGroupFromCode(subject){ const raw=String(subject||'').trim().toUpperCase(), map=DEPARTMENT_RULES.subject_prefix_map||{}; for(const k of Object.keys(map).sort((a,b)=>b.length-a.length)) if(raw.startsWith(k)) return map[k]; return null; }
function codeGroupCode(code){ const raw=String(code||'').trim(), numeric=parseInt(raw.replace(/\D/g,''),10); if(!Number.isFinite(numeric))return null; for(const r of (DEPARTMENT_RULES.special_code_prefix_rules||[])) if(raw.startsWith(r.prefix||r[0])) return r.group||r[1]; for(const r of (DEPARTMENT_RULES.code_rules||[])){const min=r.min??r[0],max=r.max??r[1],group=r.group??r[2];if(numeric>=min&&numeric<=max)return group;} return null; }
function resolveDepartment(code,schedule=[]){
    const rawCode=String(code||'').trim();
    const override=DEPARTMENT_RULES.overrides?.teacher_code?.[rawCode];
    if(override)return groupByCode(override);
    if((DEPARTMENT_RULES.overrides?.office_teacher_codes||[]).map(String).includes(rawCode))return groupByCode('OFFICE');
    const numeric=parseInt(rawCode.replace(/\D/g,''),10);
    if(Number.isFinite(numeric) && numeric>=9000 && numeric<=9999) return groupByCode('EXP');
    if(Number.isFinite(numeric)) {
        const fixedRanges=[[700,750,'SCI'],[751,799,'CAR'],[800,899,'FL'],[900,949,'ACT'],[950,999,'CAR']];
        for(const [min,max,group] of fixedRanges){ if(numeric>=min&&numeric<=max) return groupByCode(group); }
    }
    const codeGroup=codeGroupCode(rawCode);
    if(codeGroup) return groupByCode(codeGroup);
    const counts={}, items=Array.isArray(schedule)?schedule:[]; let recognized=0;
    for(const item of items){const g=subjectGroupFromCode(item?.subject||item?.subject_code||'');if(!g||g==='ACT')continue;counts[g]=(counts[g]||0)+1;recognized++;}
    if(recognized){const d=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0],threshold=Number(DEPARTMENT_RULES.evidence?.dominance_threshold||.55),min=Number(DEPARTMENT_RULES.evidence?.minimum_recognized_courses||3);if(d&&d[1]>=min&&d[1]/recognized>=threshold)return groupByCode(d[0]);}
    return groupByCode(codeGroup||'ACT');
}

const app = express();

// Normalize admin PIN without changing intentional characters.
// Removes BOM / zero-width characters that can accidentally appear from copy-paste.
function normalizeAdminPin(pin) {
    return String(pin ?? '')
        .replace(/\uFEFF/g, '')
        .replace(/[\u200B-\u200D\u2060]/g, '')
        .trim();
}

function fingerprintSecret(value) {
    return crypto.createHash('sha256')
        .update(String(value ?? ''), 'utf8')
        .digest('hex')
        .slice(0, 12);
}

function secretsEqual(a, b) {
    const aa = Buffer.from(String(a ?? ''), 'utf8');
    const bb = Buffer.from(String(b ?? ''), 'utf8');
    if (aa.length !== bb.length) return false;
    return crypto.timingSafeEqual(aa, bb);
}



// ============================================================
// CONFIG
// ============================================================
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const COOKIE_NAME = 'school_auth';
const ADMIN_CODE = String(process.env.ADMIN_CODE || '613').trim();
const ADMIN_PIN = normalizeAdminPin(process.env.ADMIN_PIN || '');
const ADMIN_NAME = process.env.ADMIN_NAME || 'นายนนทพัทธ์ วงค์มูล';

console.log(`[AUTH] ADMIN_CODE=${ADMIN_CODE}`);
console.log(`[AUTH] ADMIN_PIN=${ADMIN_PIN ? 'configured' : 'NOT CONFIGURED'}`);
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const SGS_ENGINE_PATH = path.join(__dirname, 'scripts', 'sgs_engine.py');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'school.sqlite3');
const MAX_FILE_SIZE = 25 * 1024 * 1024;

if (NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

if (JWT_SECRET === 'CHANGE_ME_IN_PRODUCTION' && NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be changed in production.');
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// DATABASE
// ============================================================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dept INTEGER NOT NULL DEFAULT 900,
    role TEXT NOT NULL DEFAULT 'teacher',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_code TEXT NOT NULL,
    day TEXT NOT NULL,
    period INTEGER NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT '',
    room TEXT NOT NULL DEFAULT '',
    teacher_name TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_priority INTEGER NOT NULL DEFAULT 90,
    dataset_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (teacher_code, day, period)
);

CREATE INDEX IF NOT EXISTS idx_schedules_teacher ON schedules(teacher_code);
CREATE INDEX IF NOT EXISTS idx_schedules_day_period ON schedules(day, period);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_code TEXT NOT NULL,
    actor_name TEXT NOT NULL DEFAULT '',
    actor_role TEXT NOT NULL DEFAULT 'teacher',
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_code);

CREATE TABLE IF NOT EXISTS import_sessions (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    upload_type TEXT NOT NULL,
    imported_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    record_count INTEGER NOT NULL DEFAULT 0,
    warning_count INTEGER NOT NULL DEFAULT 0,
    conflict_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS swap_requests (
    id TEXT PRIMARY KEY,
    requester_code TEXT NOT NULL,
    target_code TEXT NOT NULL,
    absence_date TEXT NOT NULL,
    original_day TEXT NOT NULL,
    original_period INTEGER NOT NULL,
    original_subject TEXT NOT NULL DEFAULT '',
    original_level TEXT NOT NULL DEFAULT '',
    original_room TEXT NOT NULL DEFAULT '',
    action_type TEXT NOT NULL DEFAULT 'swap',
    return_day TEXT NOT NULL DEFAULT '',
    return_period INTEGER,
    return_subject TEXT NOT NULL DEFAULT '',
    return_level TEXT NOT NULL DEFAULT '',
    return_room TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'saved',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    responded_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_swap_target_status ON swap_requests(target_code, status);
CREATE INDEX IF NOT EXISTS idx_swap_requester_status ON swap_requests(requester_code, status);

CREATE TABLE IF NOT EXISTS substitution_assignments (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    requester_code TEXT NOT NULL,
    target_code TEXT NOT NULL,
    date TEXT NOT NULL,
    day TEXT NOT NULL,
    period INTEGER NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT '',
    room TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    FOREIGN KEY(request_id) REFERENCES swap_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sub_target_date ON substitution_assignments(target_code, date);
`);


// ============================================================
// V10.7 - SAFE SQLITE SCHEMA MIGRATION
// Existing installations may already have swap_requests created
// by older versions. CREATE TABLE IF NOT EXISTS does not add
// newly introduced columns, so ensure them explicitly.
// ============================================================
function ensureColumn(tableName, columnName, definition) {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const exists = columns.some(col => col.name === columnName);
    if (!exists) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
        console.log(`🛠️ Added missing column ${tableName}.${columnName}`);
    }
}

try {
    ensureColumn('swap_requests', 'responded_at', 'TEXT');
    ensureColumn('swap_requests', 'updated_at', 'TEXT');
    ensureColumn('swap_requests', 'return_day', "TEXT NOT NULL DEFAULT ''");
    ensureColumn('swap_requests', 'return_period', 'INTEGER');
    ensureColumn('swap_requests', 'return_subject', "TEXT NOT NULL DEFAULT ''");
    ensureColumn('swap_requests', 'return_level', "TEXT NOT NULL DEFAULT ''");
    ensureColumn('swap_requests', 'return_room', "TEXT NOT NULL DEFAULT ''");
    ensureColumn('swap_requests', 'action_type', "TEXT NOT NULL DEFAULT 'swap'");
    ensureColumn('swap_requests', 'status', "TEXT NOT NULL DEFAULT 'saved'");
    ensureColumn('swap_requests', 'note', "TEXT NOT NULL DEFAULT ''");
    ensureColumn('swap_requests', 'created_at', "TEXT NOT NULL DEFAULT ''");
} catch (migrationError) {
    console.error('❌ V10.7 SQLite schema migration failed:', migrationError.message);
}

// V10.6: legacy pending requests are now treated as saved draft/document records.
try { db.prepare(`UPDATE swap_requests SET status='saved' WHERE status='pending'`).run(); } catch (_) {}

const nowISO = () => new Date().toISOString();

function auditLog({ actorCode = 'system', actorName = 'system', actorRole = 'system', action, targetType = '', targetId = '', details = {}, ip = '' }) {
    try {
        db.prepare(`
            INSERT INTO audit_logs (actor_code, actor_name, actor_role, action, target_type, target_id, details, ip, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            normalizeCode(actorCode) || 'system',
            sanitizeName(actorName) || 'system',
            String(actorRole || 'system'),
            String(action || 'unknown'),
            String(targetType || ''),
            String(targetId || ''),
            JSON.stringify(details || {}),
            String(ip || ''),
            nowISO()
        );
    } catch (err) {
        console.warn('⚠️ Audit log failed:', err.message);
    }
}

const deptFromCode = (code, schedule = []) => resolveDepartment(code, schedule)?.id || 900;

// Bootstrap exactly one admin identity.
const adminExisting = db.prepare('SELECT code FROM teachers WHERE code = ?').get(ADMIN_CODE);
if (!adminExisting) {
    const ts = nowISO();
    db.prepare(`INSERT INTO teachers (code, name, dept, role, active, created_at, updated_at)
                VALUES (?, ?, ?, 'admin', 1, ?, ?)`)
      .run(ADMIN_CODE, ADMIN_NAME, deptFromCode(ADMIN_CODE), ts, ts);
} else {
    db.prepare(`UPDATE teachers SET role = 'admin', active = 1, updated_at = ? WHERE code = ?`)
      .run(nowISO(), ADMIN_CODE);
}

// ============================================================
// SECURITY / MIDDLEWARE
// ============================================================
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '4mb' }));

// Never expose server code, environment files, database, uploads, or Python scripts.
app.use((req, res, next) => {
    const blockedPrefixes = [
        '/data',
        '/uploads',
        '/scripts',
        '/server.js',
        '/package.json',
        '/.env'
    ];
    if (blockedPrefixes.some(prefix => req.path === prefix || req.path.startsWith(prefix + '/'))) {
        return res.status(404).end();
    }
    next();
});

app.use(express.static(__dirname, {
    index: false,
    dotfiles: 'deny'
}));

// Simple brute-force protection. Production can later move this to Redis.
const loginAttempts = new Map();
function isRateLimited(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry) return false;
    if (now - entry.startedAt > 10 * 60 * 1000) {
        loginAttempts.delete(ip);
        return false;
    }
    return entry.count >= 5;
}
function recordFailedLogin(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || now - entry.startedAt > 10 * 60 * 1000) {
        loginAttempts.set(ip, { count: 1, startedAt: now });
    } else {
        entry.count += 1;
    }
}
function clearFailedLogin(ip) {
    loginAttempts.delete(ip);
}

function setAuthCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure: NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000,
        path: '/'
    });
}

function clearAuthCookie(res) {
    res.clearCookie(COOKIE_NAME, {
        httpOnly: true,
        secure: NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/'
    });
}

function readCookie(req, name) {
    const raw = req.headers.cookie || '';
    const parts = raw.split(';');
    for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim();
        const value = decodeURIComponent(part.slice(idx + 1).trim());
        if (key === name) return value;
    }
    return null;
}

function authenticate(req, res, next) {
    const token = readCookie(req, COOKIE_NAME);
    if (!token) {
        return res.status(401).json({ success: false, error: 'กรุณาเข้าสู่ระบบก่อน' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        const teacher = db.prepare('SELECT code, name, dept, role, active FROM teachers WHERE code = ?').get(payload.code);
        if (!teacher || !teacher.active) {
            clearAuthCookie(res);
            return res.status(401).json({ success: false, error: 'บัญชีนี้ไม่มีสิทธิ์ใช้งานแล้ว' });
        }
        req.user = {
            code: teacher.code,
            name: teacher.name,
            dept: teacher.dept,
            role: teacher.code === ADMIN_CODE ? 'admin' : 'teacher',
            permissions: permissionsForUser({ code: teacher.code, role: teacher.code === ADMIN_CODE ? 'admin' : 'teacher' })
        };
        next();
    } catch (err) {
        clearAuthCookie(res);
        return res.status(401).json({ success: false, error: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        authenticate(req, res, () => {
            if (!roles.includes(req.user.role)) {
                return res.status(403).json({ success: false, error: 'สิทธิ์ไม่เพียงพอ' });
            }
            next();
        });
    };
}

function permissionsForUser(user) {
    const isAdmin = user?.role === 'admin' && user?.code === ADMIN_CODE;
    return {
        isAdmin,
        canViewSchedules: true,
        canViewOwnSchedule: true,
        canEditOwnSchedule: true,
        canManageSystem: isAdmin,
        canUploadSchedules: isAdmin,
        canClearDatabase: isAdmin,
        canViewAuditLogs: isAdmin
    };
}

function requireAdmin(req, res, next) {
    authenticate(req, res, () => {
        if (req.user.role !== 'admin' || req.user.code !== ADMIN_CODE) {
            return res.status(403).json({ success: false, error: 'สิทธิ์ไม่เพียงพอ' });
        }
        next();
    });
}

// ============================================================
// HELPERS
// ============================================================
function safeUnlink(filePath) {
    if (!filePath) return;
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
        console.warn('⚠️ ลบไฟล์ชั่วคราวไม่สำเร็จ:', err.message);
    }
}

function normalizeCode(code) {
    return String(code ?? '').trim().replace(/\s+/g, '');
}

function sanitizeName(name) {
    return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function getScheduleKind(uploadType) {
    return uploadType === 'all_teachers' || uploadType === 'personal' ? 'teacher' : 'student';
}

function getSourcePriority(sourceType) {
    const priorities = {
        teacher_pdf: 100,
        manual: 90,
        student_pdf_reconciled: 60,
        gemini: 40,
        legacy_txt: 20
    };
    return priorities[sourceType] ?? 10;
}

function normalizeScheduleRecord(record, fallbackCode, sourceType) {
    const teacherCode = normalizeCode(record.teacherCode || record.teacher_id || fallbackCode);
    const period = Number.parseInt(record.period, 10);
    if (!teacherCode || !Number.isInteger(period) || period < 1 || period > 10) return null;

    return {
        teacherCode,
        day: String(record.day || '').trim(),
        period,
        subject: String(record.subject || '').trim().slice(0, 200),
        level: String(record.level || record.class_room || record.class_name || '').trim().slice(0, 100),
        room: String(record.room || record.room_number || '').trim().slice(0, 100),
        teacherName: sanitizeName(record.teacherName || record.teacher_name || ''),
        sourceType,
        sourcePriority: getSourcePriority(sourceType),
        datasetId: String(record.datasetId || '').trim().slice(0, 100)
    };
}

function upsertTeacher(code, name, role = 'teacher', schedule = []) {
    const teacherCode = normalizeCode(code);
    if (!teacherCode) return;
    const cleanName = sanitizeName(name) || `ครูรหัส ${teacherCode}`;
    const ts = nowISO();
    const dept = deptFromCode(teacherCode, schedule);

    db.prepare(`
        INSERT INTO teachers (code, name, dept, role, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
            name = excluded.name,
            dept = excluded.dept,
            role = CASE WHEN teachers.code = ? THEN 'admin' ELSE excluded.role END,
            active = 1,
            updated_at = excluded.updated_at
    `).run(teacherCode, cleanName, dept, role, ts, ts, ADMIN_CODE);
}

function upsertTeachersFromTeacherData(data) {
    if (!data || !Array.isArray(data.teachers)) return;
    const tx = db.transaction((teachers) => {
        for (const t of teachers) {
            const code = normalizeCode(t.teacher_id);
            if (!code) continue;
            upsertTeacher(code, t.teacher_name, code === ADMIN_CODE ? 'admin' : 'teacher', Array.isArray(t.schedule) ? t.schedule : []);
        }
    });
    tx(data.teachers);
}

function upsertSchedules(records) {
    const insert = db.prepare(`
        INSERT INTO schedules (
            teacher_code, day, period, subject, level, room,
            teacher_name, source_type, source_priority, dataset_id,
            created_at, updated_at
        ) VALUES (
            @teacherCode, @day, @period, @subject, @level, @room,
            @teacherName, @sourceType, @sourcePriority, @datasetId,
            @createdAt, @updatedAt
        )
        ON CONFLICT(teacher_code, day, period) DO UPDATE SET
            subject = CASE
                WHEN excluded.source_priority >= schedules.source_priority THEN excluded.subject
                ELSE schedules.subject END,
            level = CASE
                WHEN excluded.source_priority >= schedules.source_priority THEN excluded.level
                ELSE schedules.level END,
            room = CASE
                WHEN excluded.source_priority >= schedules.source_priority THEN excluded.room
                ELSE schedules.room END,
            teacher_name = CASE
                WHEN excluded.source_priority >= schedules.source_priority THEN excluded.teacher_name
                ELSE schedules.teacher_name END,
            source_type = CASE
                WHEN excluded.source_priority >= schedules.source_priority THEN excluded.source_type
                ELSE schedules.source_type END,
            source_priority = CASE
                WHEN excluded.source_priority >= schedules.source_priority THEN excluded.source_priority
                ELSE schedules.source_priority END,
            dataset_id = CASE
                WHEN excluded.source_priority >= schedules.source_priority THEN excluded.dataset_id
                ELSE schedules.dataset_id END,
            updated_at = excluded.updated_at
    `);

    const tx = db.transaction((items) => {
        const now = nowISO();
        for (const record of items) {
            insert.run({ ...record, createdAt: now, updatedAt: now });
        }
    });
    tx(records);
}

function clearTeacherSourceRecords(teacherCodes, sourceType) {
    if (!teacherCodes.length) return;
    const placeholders = teacherCodes.map(() => '?').join(',');
    db.prepare(`DELETE FROM schedules WHERE source_type = ? AND teacher_code IN (${placeholders})`)
      .run(sourceType, ...teacherCodes);
}


function getSwapRequestById(id) {
    const row = db.prepare(`
        SELECT
            r.id,
            r.requester_code AS requesterCode,
            rq.name AS requesterName,
            r.target_code AS targetCode,
            tg.name AS targetName,
            r.absence_date AS absenceDate,
            r.original_day AS originalDay,
            r.original_period AS originalPeriod,
            r.original_subject AS originalSubject,
            r.original_level AS originalLevel,
            r.original_room AS originalRoom,
            r.action_type AS actionType,
            r.return_day AS returnDay,
            r.return_period AS returnPeriod,
            r.return_subject AS returnSubject,
            r.return_level AS returnLevel,
            r.return_room AS returnRoom,
            r.status,
            r.note,
            r.created_at AS createdAt,
            r.responded_at AS respondedAt,
            r.updated_at AS updatedAt
        FROM swap_requests r
        LEFT JOIN teachers rq ON rq.code = r.requester_code
        LEFT JOIN teachers tg ON tg.code = r.target_code
        WHERE r.id = ?
    `).get(id);

    return row;
}

function serializeSwapRow(row) {
    if (!row) return null;
    return {
        ...row,
        // Legacy 'pending' records are treated as saved/document-preparation records in V10.6.
        status: row.status === 'pending' ? 'saved' : row.status,
        returnPeriod: row.returnPeriod === null ? null : Number(row.returnPeriod),
        originalPeriod: Number(row.originalPeriod),
        returnDateISO: row.returnDay && row.absenceDate ? computeNextReturnDateISO(row.absenceDate, row.returnDay) : '',
        returnDate: row.returnDay && row.absenceDate ? computeNextReturnDateISO(row.absenceDate, row.returnDay) : ''
    };
}

function computeNextReturnDateISO(baseISO, targetDay) {
    const base = new Date(`${baseISO}T00:00:00`);
    if (Number.isNaN(base.getTime())) return '';
    const dayMap = { 'อาทิตย์':0, 'จันทร์':1, 'อังคาร':2, 'พุธ':3, 'พฤหัสบดี':4, 'ศุกร์':5, 'เสาร์':6 };
    const target = dayMap[targetDay];
    if (target === undefined) return '';
    const current = base.getDay();
    let add = target - current;
    if (add <= 0) add += 7;
    base.setDate(base.getDate() + add);
    const y = base.getFullYear();
    const m = String(base.getMonth() + 1).padStart(2, '0');
    const d = String(base.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function normalizeComparableText(value) {
    return String(value ?? '')
        .normalize('NFC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, '')
        .trim()
        .toLowerCase();
}

function createSwapRequestRecord(req, body) {
    const requesterCode = normalizeCode(req.user.code);
    const targetCode = normalizeCode(body?.targetCode);
    const originalDay = cleanServerDay(body?.originalDay);
    const originalPeriod = Number.parseInt(body?.originalPeriod, 10);
    const actionType = body?.actionType === 'one_way' ? 'one_way' : 'swap';
    const absenceDate = String(body?.absenceDate || '').trim();
    const originalSubjectFromClient = String(body?.originalSubject || '').trim().slice(0, 200);
    const originalLevelFromClient = String(body?.originalLevel || '').trim().slice(0, 100);
    const originalRoomFromClient = String(body?.originalRoom || '').trim().slice(0, 100);
    const returnDay = cleanServerDay(body?.returnDay || '');
    const returnPeriod = body?.returnPeriod == null || body?.returnPeriod === '' ? null : Number.parseInt(body.returnPeriod, 10);
    const returnSubject = String(body?.returnSubject || '').trim().slice(0, 200);
    const returnLevel = String(body?.returnLevel || '').trim().slice(0, 100);
    const returnRoom = String(body?.returnRoom || '').trim().slice(0, 100);
    const note = String(body?.note || '').trim().slice(0, 500);

    if (!requesterCode) throw new Error('ไม่พบรหัสครูผู้ขอในเซสชัน');
    if (!targetCode || targetCode === requesterCode) throw new Error('ผู้สอนแทนไม่ถูกต้อง');
    if (!/^\d{3,4}$/.test(targetCode)) throw new Error('รหัสผู้สอนแทนไม่ถูกต้อง');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(absenceDate)) throw new Error('วันที่ลาไม่ถูกต้อง');
    if (!originalDay || !Number.isInteger(originalPeriod) || originalPeriod < 1 || originalPeriod > 10) throw new Error('คาบต้นทางไม่ถูกต้อง');

    const target = db.prepare('SELECT code, name, active FROM teachers WHERE code = ?').get(targetCode);
    if (!target || !target.active) throw new Error('ไม่พบครูผู้สอนแทนในฐานข้อมูล');

    const original = db.prepare(`
        SELECT teacher_code AS teacherCode, day, period, subject, level, room, teacher_name AS teacherName
        FROM schedules WHERE teacher_code = ? AND day = ? AND period = ?
    `).get(requesterCode, originalDay, originalPeriod);

    if (!original) {
        throw new Error(
            `ไม่พบคาบต้นทางของคุณในฐานข้อมูลกลาง (${requesterCode} / ${originalDay} / คาบ ${originalPeriod}) ` +
            'กรุณารีเฟรชตารางก่อน แล้วลองสร้างคำขออีกครั้ง'
        );
    }

    // V10.7: the server's schedule is authoritative. Client descriptive fields
    // are NOT allowed to block saving a document draft. We preserve the
    // server-side values and record any mismatch as a warning in the note.
    const warnings = [];
    if (
        originalSubjectFromClient && original.subject &&
        normalizeComparableText(originalSubjectFromClient) !== normalizeComparableText(original.subject)
    ) {
        warnings.push('รายวิชาที่หน้าเว็บส่งมาไม่ตรงกับข้อมูลกลาง ระบบใช้รายวิชาจากฐานข้อมูลกลาง');
    }
    if (
        originalLevelFromClient && original.level &&
        normalizeComparableText(originalLevelFromClient) !== normalizeComparableText(original.level)
    ) {
        warnings.push('ชั้น/ห้องที่หน้าเว็บส่งมาไม่ตรงกับข้อมูลกลาง ระบบใช้ข้อมูลจากฐานข้อมูลกลาง');
    }
    if (
        originalRoomFromClient && original.room &&
        normalizeComparableText(originalRoomFromClient) !== normalizeComparableText(original.room)
    ) {
        warnings.push('ห้องสอนที่หน้าเว็บส่งมาไม่ตรงกับข้อมูลกลาง ระบบใช้ข้อมูลจากฐานข้อมูลกลาง');
    }

    if (actionType === 'swap') {
        if (!returnDay || !Number.isInteger(returnPeriod) || returnPeriod < 1 || returnPeriod > 10) {
            throw new Error('คาบสอนคืนไม่ถูกต้อง');
        }

        const targetReturn = db.prepare(`
            SELECT teacher_code AS teacherCode, day, period, subject, level, room, teacher_name AS teacherName
            FROM schedules WHERE teacher_code = ? AND day = ? AND period = ?
        `).get(targetCode, returnDay, returnPeriod);

        // V10.7: because this is only a saved request/document draft,
        // a stale/missing return slot should not prevent the user from saving.
        // It is recorded as a warning instead of altering schedules.
        if (!targetReturn) {
            warnings.push('ไม่พบคาบสอนคืนของครูเป้าหมายในข้อมูลกลาง ณ เวลาบันทึก อาจต้องตรวจสอบอีกครั้งก่อนนำใบ วก.11 ไปดำเนินการ');
        } else {
            if (
                returnSubject && targetReturn.subject &&
                normalizeComparableText(returnSubject) !== normalizeComparableText(targetReturn.subject)
            ) {
                warnings.push('รายวิชาสอนคืนในหน้าจอไม่ตรงกับข้อมูลกลาง');
            }
            if (
                returnLevel && targetReturn.level &&
                normalizeComparableText(returnLevel) !== normalizeComparableText(targetReturn.level)
            ) {
                warnings.push('ชั้น/ห้องสอนคืนในหน้าจอไม่ตรงกับข้อมูลกลาง');
            }
            if (
                returnRoom && targetReturn.room &&
                normalizeComparableText(returnRoom) !== normalizeComparableText(targetReturn.room)
            ) {
                warnings.push('ห้องสอนคืนในหน้าจอไม่ตรงกับข้อมูลกลาง');
            }
        }
    }

    const id = `SW-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const ts = nowISO();
    const finalNote = [note, ...warnings].filter(Boolean).join(' | ').slice(0, 500);

    db.prepare(`
        INSERT INTO swap_requests (
            id, requester_code, target_code, absence_date,
            original_day, original_period, original_subject, original_level, original_room,
            action_type, return_day, return_period, return_subject, return_level, return_room,
            status, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'saved', ?, ?, ?)
    `).run(
        id, requesterCode, targetCode, absenceDate,
        originalDay, originalPeriod, original.subject || '', original.level || '', original.room || '',
        actionType, returnDay, returnPeriod,
        actionType === 'swap' ? returnSubject : '',
        actionType === 'swap' ? returnLevel : '',
        actionType === 'swap' ? returnRoom : '',
        finalNote, ts, ts
    );

    auditLog({
        actorCode: requesterCode,
        actorName: req.user.name,
        actorRole: req.user.role,
        action: 'swap_request_created',
        targetType: 'swap_request',
        targetId: id,
        details: {
            targetCode,
            actionType,
            absenceDate,
            originalDay,
            originalPeriod,
            returnDay,
            returnPeriod,
            warnings
        },
        ip: req.ip
    });

    console.log(`✅ Saved swap request ${id} by ${requesterCode} → ${targetCode}`);
    if (warnings.length) console.warn(`⚠️ Swap request warnings ${id}: ${warnings.join(' | ')}`);

    return { id, warnings };
}

function cleanServerDay(day) {
    const v = String(day || '').replace(/วัน/g, '').replace(/\s+/g, '').trim();
    if (!v) return '';
    if (v === 'จ.' || v.includes('จันทร์')) return 'จันทร์';
    if (v === 'อ.' || v.includes('อังคาร')) return 'อังคาร';
    if (v === 'พ.' || v.includes('พุธ')) return 'พุธ';
    if (v === 'พฤ.' || v.includes('พฤหัส')) return 'พฤหัสบดี';
    if (v === 'ศ.' || v.includes('ศุกร์')) return 'ศุกร์';
    return v;
}

function normalizeClassServer(value) {
    return String(value || '').trim().replace(/\s+/g, '').replace(/^ม\.\s*/, 'ม.');
}

function applyAcceptedSwap(requestId, actor) {
    const request = getSwapRequestById(requestId);
    if (!request) throw new Error('ไม่พบคำขอแลกคาบ');
    if (request.status !== 'pending') throw new Error(`คำขอนี้อยู่ในสถานะ ${request.status} แล้ว`);
    if (actor.role !== 'admin' && actor.code !== request.targetCode) throw new Error('เฉพาะครูผู้รับคำขอหรือ Admin เท่านั้นที่ตอบรับได้');

    const tx = db.transaction(() => {
        const original = db.prepare(`SELECT * FROM schedules WHERE teacher_code = ? AND day = ? AND period = ?`).get(request.requesterCode, request.originalDay, request.originalPeriod);
        if (!original) throw new Error('คาบต้นทางถูกเปลี่ยนไปแล้ว ไม่สามารถทำรายการได้');

        if (request.actionType === 'swap') {
            const returnSlot = db.prepare(`SELECT * FROM schedules WHERE teacher_code = ? AND day = ? AND period = ?`).get(request.targetCode, request.returnDay, request.returnPeriod);
            if (!returnSlot) throw new Error('คาบสอนคืนถูกเปลี่ยนไปแล้ว ไม่สามารถทำรายการได้');

            db.prepare(`DELETE FROM schedules WHERE teacher_code = ? AND day = ? AND period = ?`).run(request.requesterCode, request.originalDay, request.originalPeriod);
            db.prepare(`DELETE FROM schedules WHERE teacher_code = ? AND day = ? AND period = ?`).run(request.targetCode, request.returnDay, request.returnPeriod);

            const now = nowISO();
            const insert = db.prepare(`
                INSERT INTO schedules (teacher_code, day, period, subject, level, room, teacher_name, source_type, source_priority, dataset_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'swap_transaction', 120, ?, ?, ?)
            `);

            insert.run(
                request.targetCode, request.originalDay, request.originalPeriod,
                original.subject, original.level, original.room,
                (db.prepare('SELECT name FROM teachers WHERE code = ?').get(request.targetCode)?.name || ''),
                requestId, now, now
            );

            insert.run(
                request.requesterCode, request.returnDay, request.returnPeriod,
                returnSlot.subject, returnSlot.level, returnSlot.room,
                (db.prepare('SELECT name FROM teachers WHERE code = ?').get(request.requesterCode)?.name || ''),
                requestId, now, now
            );
        } else {
            const subId = `SUB-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
            const exists = db.prepare('SELECT id FROM substitution_assignments WHERE request_id = ?').get(requestId);
            if (!exists) {
                db.prepare(`
                    INSERT INTO substitution_assignments (id, request_id, requester_code, target_code, date, day, period, subject, level, room, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
                `).run(subId, requestId, request.requesterCode, request.targetCode, request.absenceDate, request.originalDay, request.originalPeriod, request.originalSubject, request.originalLevel, request.originalRoom, nowISO());
            }
        }

        db.prepare(`UPDATE swap_requests SET status='accepted', responded_at=?, updated_at=? WHERE id=?`).run(nowISO(), nowISO(), requestId);
        auditLog({
            actorCode: actor.code,
            actorName: actor.name,
            actorRole: actor.role,
            action: 'swap_request_accepted',
            targetType: 'swap_request',
            targetId: requestId,
            details: { actionType: request.actionType, requesterCode: request.requesterCode, targetCode: request.targetCode },
            ip: ''
        });
    });
    tx();
    return getSwapRequestById(requestId);
}

function getState() {
    const teachers = db.prepare(`SELECT code, name, dept, role, active, updated_at FROM teachers WHERE active = 1 ORDER BY code`).all();
    const timetable = db.prepare(`
        SELECT teacher_code AS teacherCode, day, period, subject, level, room,
               teacher_name AS teacherName, source_type AS sourceType,
               source_priority AS sourcePriority, dataset_id AS datasetId
        FROM schedules
        ORDER BY teacher_code, day, period
    `).all();

    return { teachers, timetable };
}

function syncAdminState(body) {
    const teachers = Array.isArray(body.teachers) ? body.teachers : [];
    const timetable = Array.isArray(body.timetable) ? body.timetable : [];

    const tx = db.transaction(() => {
        // Preserve admin identity even if frontend state is stale.
        db.prepare(`DELETE FROM teachers WHERE code <> ?`).run(ADMIN_CODE);
        db.prepare(`DELETE FROM schedules`).run();

        const teacherScheduleMap = new Map();
        for (const item of timetable) {
            const c = normalizeCode(item.teacherCode || item.teacher_code);
            if (!c) continue;
            if (!teacherScheduleMap.has(c)) teacherScheduleMap.set(c, []);
            teacherScheduleMap.get(c).push(item);
        }
        for (const t of teachers) {
            const code = normalizeCode(t.code);
            if (!code) continue;
            upsertTeacher(code, t.name, code === ADMIN_CODE ? 'admin' : 'teacher', teacherScheduleMap.get(code) || []);
        }

        const normalized = [];
        for (const item of timetable) {
            const record = normalizeScheduleRecord(
                item,
                item.teacherCode,
                item.sourceType || 'manual'
            );
            if (record) normalized.push(record);
        }
        upsertSchedules(normalized);
    });
    tx();
}

function syncTeacherOwnState(userCode, items) {
    const code = normalizeCode(userCode);
    const normalized = [];
    for (const item of Array.isArray(items) ? items : []) {
        const record = normalizeScheduleRecord(item, code, item.sourceType || 'manual');
        if (!record || record.teacherCode !== code) continue;
        normalized.push(record);
    }

    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM schedules WHERE teacher_code = ? AND source_type IN ('manual', 'teacher_override')`).run(code);
        upsertSchedules(normalized);
    });
    tx();
}

// ============================================================
// UPLOAD
// ============================================================
const allowedMimeTypes = new Set([
    'application/pdf',
    'application/json',
    'text/plain',
    'image/jpeg',
    'image/png'
]);

const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const allowedExt = new Set(['.pdf', '.json', '.txt', '.jpg', '.jpeg', '.png']);
        if (allowedExt.has(ext) || allowedMimeTypes.has(file.mimetype)) cb(null, true);
        else cb(new Error('ชนิดไฟล์ไม่รองรับ'));
    }
});

function runPythonSGS(pdfPath, kind) {
    return new Promise((resolve, reject) => {
        const child = spawn(PYTHON_BIN, [SGS_ENGINE_PATH, pdfPath, '--type', kind], {
            cwd: __dirname,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timeout = setTimeout(() => {
            if (finished) return;
            finished = true;
            child.kill('SIGTERM');
            reject(new Error('SGS Python Engine ใช้เวลานานเกิน 180 วินาที'));
        }, 180000);

        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });

        child.on('error', err => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            reject(err);
        });

        child.on('close', code => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            if (code !== 0) {
                reject(new Error(stderr.trim() || `Python Engine exited with code ${code}`));
                return;
            }
            try {
                const result = JSON.parse(stdout.trim());
                if (!result.success) {
                    reject(new Error(result.error || 'SGS Engine อ่านไฟล์ไม่สำเร็จ'));
                    return;
                }
                resolve(result);
            } catch (err) {
                reject(new Error(`ผลลัพธ์จาก Python ไม่ใช่ JSON ที่ถูกต้อง: ${err.message}`));
            }
        });
    });
}

async function runGeminiFallback(filePath, mimeType, originalFilename, uploadType) {
    if (!GEMINI_API_KEY) throw new Error('ไม่พบ GEMINI_API_KEY และ SGS Engine ไม่สามารถอ่านไฟล์นี้ได้');
    const fileData = await fs.promises.readFile(filePath);
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = uploadType === 'all_students'
        ? `คุณคือผู้ช่วยฝ่ายวิชาการของโรงเรียนไทย จงอ่านตารางเรียนจากไฟล์นี้และแปลงเป็น JSON เพียว ๆ ตาม schema: {"classes":[{"class_name":"ม.1/1","schedule":[{"day":"จ.","period":1,"subject":"ท21101","teacher_id":"228","teacher_name":"ครู...","room_number":""}]}]} ห้ามอธิบายเพิ่ม ห้ามใส่ Markdown`
        : `คุณคือผู้ช่วยฝ่ายวิชาการของโรงเรียนไทย จงอ่านตารางสอนครูจากไฟล์นี้และแปลงเป็น JSON เพียว ๆ ตาม schema: {"teachers":[{"teacher_id":"228","teacher_name":"...","schedule":[{"day":"จ.","period":1,"subject":"ท21101","class_room":"ม.1/1","room_number":"512"}]}]} ห้ามอธิบายเพิ่ม ห้ามใส่ Markdown`;
    const imagePart = { inlineData: { data: fileData.toString('base64'), mimeType } };
    const result = await model.generateContent([prompt, imagePart]);
    const text = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
    return { success: true, engine: 'gemini_fallback', data: JSON.parse(text), filename: originalFilename };
}

// ============================================================
// AUTH API
// ============================================================
// ============================================================
// AUTH STATUS / FIRST SETUP
// ============================================================
app.get('/api/system/version', (req, res) => {
    res.json({ success: true, version: '10.12.0', swapMode: 'simulation_only', form: 'วก.11', sgsEngine: 'V7' });
});

app.get('/api/auth/status', (req, res) => {
    const teacherCount = db.prepare(`SELECT COUNT(*) AS count FROM teachers WHERE role = 'teacher' AND active = 1`).get().count;
    const scheduleCount = db.prepare('SELECT COUNT(*) AS count FROM schedules').get().count;
    res.json({
        success: true,
        setupRequired: teacherCount === 0,
        teacherCount,
        scheduleCount,
        adminCode: ADMIN_CODE,
        adminPinConfigured: Boolean(ADMIN_PIN),
        envFileExpected: path.join(__dirname, '.env')
    });
});

// Local diagnostic: reveals only whether the server can read ADMIN_PIN and its length/fingerprint.
// It never returns the PIN itself.
app.get('/api/auth/admin-pin-check', (req, res) => {
    const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(req.hostname) ||
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);
    if (!isLocal) {
        return res.status(404).end();
    }
    const configured = normalizeAdminPin(process.env.ADMIN_PIN || '');
    res.json({
        success: true,
        configured: Boolean(configured),
        length: configured.length,
        fingerprint: fingerprintSecret(configured),
        envFileExpected: path.join(__dirname, '.env')
    });
});

app.post('/api/auth/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
        return res.status(429).json({ success: false, error: 'พยายามเข้าสู่ระบบมากเกินไป กรุณารอประมาณ 10 นาที' });
    }

    const code = normalizeCode(req.body?.code);
    const requestedAdmin = Boolean(req.body?.admin);
    const adminPin = normalizeAdminPin(req.body?.adminPin || '');

    if (!/^\d{3,4}$/.test(code)) {
        recordFailedLogin(ip);
        auditLog({ action: 'login_failed', targetType: 'auth', targetId: code, details: { reason: 'invalid_code' }, ip });
        return res.status(400).json({ success: false, error: 'รหัสประจำตัวครูต้องเป็นตัวเลข 3-4 หลัก' });
    }

    const teacher = db.prepare('SELECT code, name, dept, role, active FROM teachers WHERE code = ?').get(code);

    // 613 is the one and only admin identity.
    if (code === ADMIN_CODE) {
        if (!requestedAdmin) {
            recordFailedLogin(ip);
            return res.status(403).json({ success: false, error: 'รหัส 613 ต้องเข้าสู่ระบบผ่านปุ่มผู้ดูแลระบบ' });
        }
        // The admin PIN is the real secret. The code 613 identifies the account only.
        if (!ADMIN_PIN) {
            console.error('[AUTH] ADMIN_PIN is not configured. Check .env beside server.js');
            recordFailedLogin(ip);
            return res.status(503).json({ success: false, error: 'ระบบยังไม่ได้ตั้งค่า ADMIN_PIN ในไฟล์ .env' });
        }

        if (!secretsEqual(adminPin, ADMIN_PIN)) {
            console.warn(`[AUTH] Admin PIN mismatch | enteredLength=${adminPin.length} configuredLength=${ADMIN_PIN.length} enteredFP=${fingerprintSecret(adminPin)} configuredFP=${fingerprintSecret(ADMIN_PIN)}`);
            recordFailedLogin(ip);
            auditLog({ action: 'login_failed', targetType: 'auth', targetId: code, details: { reason: 'admin_pin_mismatch' }, ip });
            return res.status(401).json({ success: false, error: 'รหัสผ่านผู้ดูแลไม่ถูกต้อง' });
        }
    } else {
        if (requestedAdmin) {
            recordFailedLogin(ip);
            return res.status(403).json({ success: false, error: 'เฉพาะรหัส 613 เท่านั้นที่เป็นผู้ดูแลระบบ' });
        }
        if (!teacher || !teacher.active) {
            recordFailedLogin(ip);
            auditLog({ action: 'login_failed', targetType: 'auth', targetId: code, details: { reason: 'teacher_not_found' }, ip });
            return res.status(401).json({ success: false, error: 'ไม่พบรหัสครูนี้ในฐานข้อมูลตารางสอน' });
        }
    }

    if (code === ADMIN_CODE && (!teacher || !teacher.active)) {
        upsertTeacher(ADMIN_CODE, ADMIN_NAME, 'admin');
    }

    const current = db.prepare('SELECT code, name, dept, role, active FROM teachers WHERE code = ?').get(code);
    if (!current || !current.active) {
        recordFailedLogin(ip);
        return res.status(401).json({ success: false, error: 'บัญชีไม่พร้อมใช้งาน' });
    }

    clearFailedLogin(ip);

    const role = code === ADMIN_CODE ? 'admin' : 'teacher';
    auditLog({
        actorCode: current.code,
        actorName: current.name,
        actorRole: role,
        action: 'login_success',
        targetType: 'auth',
        targetId: current.code,
        details: { admin: role === 'admin' },
        ip
    });
    const payload = { code, role, jti: crypto.randomUUID() };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    setAuthCookie(res, token);

    return res.json({
        success: true,
        user: {
            code: current.code,
            name: current.name,
            dept: current.dept,
            isAdmin: role === 'admin',
            permissions: permissionsForUser({ code: current.code, role })
        }
    });
});

app.get('/api/auth/me', authenticate, (req, res) => {
    res.json({
        success: true,
        user: {
            code: req.user.code,
            name: req.user.name,
            dept: req.user.dept,
            isAdmin: req.user.role === 'admin',
            permissions: permissionsForUser(req.user)
        }
    });
});

app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ success: true });
});


// ============================================================
// SWAP TRANSACTION API (V10)
// ============================================================
app.get('/api/swap-requests/mine', authenticate, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const rows = db.prepare(`
        SELECT * FROM swap_requests
        WHERE requester_code = ?
        ORDER BY datetime(created_at) DESC LIMIT 200
    `).all(req.user.code);
    return res.json({ success: true, requests: rows.map(serializeSwapRow) });
});
app.get('/api/swap-requests/:id', authenticate, (req, res) => {
    const row = getSwapRequestById(String(req.params.id || ''));
    if (!row) return res.status(404).json({ success: false, error: 'ไม่พบคำขอแลกคาบ' });
    const isAdmin = req.user.role === 'admin' && req.query.scope === 'all';
    const owns = String(row.requesterCode) === String(req.user.code) || String(row.targetCode) === String(req.user.code);
    if (!isAdmin && !owns) return res.status(403).json({ success: false, error: 'ไม่มีสิทธิ์เข้าถึงคำขอนี้' });
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return res.json({ success: true, request: serializeSwapRow(row) });
});

app.get('/api/swap-requests', authenticate, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    let rows;
    if (req.user.role === 'admin' && req.query.scope === 'all') {
        rows = db.prepare(`
            SELECT * FROM swap_requests ORDER BY datetime(created_at) DESC LIMIT 200
        `).all();
    } else {
        rows = db.prepare(`
            SELECT * FROM swap_requests
            WHERE requester_code = ? OR target_code = ?
            ORDER BY datetime(created_at) DESC LIMIT 100
        `).all(req.user.code, req.user.code);
    }
    res.json({ success: true, requests: rows.map(serializeSwapRow) });
});

app.post('/api/swap-requests', requireRole('teacher', 'admin'), (req, res) => {
    try {
        const result = createSwapRequestRecord(req, req.body || {});
        res.status(201).json({
            success: true,
            request: serializeSwapRow(getSwapRequestById(result.id)),
            warnings: result.warnings || []
        });
    } catch (error) {
        console.error('❌ CREATE SWAP REQUEST FAILED:', error.message);
        console.error('   User:', req.user?.code, req.user?.name);
        console.error('   Payload:', {
            targetCode: req.body?.targetCode,
            absenceDate: req.body?.absenceDate,
            originalDay: req.body?.originalDay,
            originalPeriod: req.body?.originalPeriod,
            actionType: req.body?.actionType,
            returnDay: req.body?.returnDay,
            returnPeriod: req.body?.returnPeriod
        });
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/swap-requests/:id/accept', requireRole('teacher', 'admin'), (req, res) => {
    res.status(403).json({ success: false, error: 'ระบบ V10.6 ยังอยู่ในโหมดจัดทำเอกสาร จึงยังไม่อนุญาตให้ยอมรับคำขอและเปลี่ยนตารางสอนจริง' });
});

app.post('/api/swap-requests/:id/reject', requireRole('teacher', 'admin'), (req, res) => {
    res.status(403).json({ success: false, error: 'ระบบ V10.6 ใช้สำหรับบันทึกคำขอและจัดทำใบ วก.11 เท่านั้น ยังไม่เปิด workflow อนุมัติ/ปฏิเสธในระบบ' });
});

app.post('/api/swap-requests/:id/cancel', requireRole('teacher', 'admin'), (req, res) => {
    try {
        const request = getSwapRequestById(req.params.id);
        if (!request) throw new Error('ไม่พบคำขอ');
        if (!['saved', 'pending'].includes(request.status)) throw new Error('คำขอนี้ถูกดำเนินการไปแล้ว');
        if (req.user.role !== 'admin' && req.user.code !== request.requesterCode) throw new Error('ไม่มีสิทธิ์ยกเลิกคำขอนี้');
        db.prepare(`UPDATE swap_requests SET status='cancelled', responded_at=?, updated_at=? WHERE id=?`).run(nowISO(), nowISO(), request.id);
        auditLog({ actorCode: req.user.code, actorName: req.user.name, actorRole: req.user.role, action: 'swap_request_cancelled', targetType: 'swap_request', targetId: request.id, details: {}, ip: req.ip });
        res.json({ success: true, request: serializeSwapRow(getSwapRequestById(request.id)) });
    } catch (error) {
        res.status(409).json({ success: false, error: error.message });
    }
});

app.get('/api/substitutions', authenticate, (req, res) => {
    const rows = req.user.role === 'admin'
        ? db.prepare(`SELECT * FROM substitution_assignments ORDER BY datetime(created_at) DESC LIMIT 200`).all()
        : db.prepare(`SELECT * FROM substitution_assignments WHERE requester_code = ? OR target_code = ? ORDER BY datetime(created_at) DESC LIMIT 100`).all(req.user.code, req.user.code);
    res.json({ success: true, substitutions: rows });
});

// ============================================================
// SHARED STATE API
// ============================================================
app.get('/api/state', authenticate, (req, res) => {
    res.json({
        success: true,
        permissions: permissionsForUser(req.user),
        me: { code: req.user.code, name: req.user.name, role: req.user.role },
        ...getState()
    });
});

// Strict read API: returns only the currently authenticated teacher's schedule.
app.get('/api/teacher/me', requireRole('teacher', 'admin'), (req, res) => {
    const schedule = db.prepare(`
        SELECT teacher_code AS teacherCode, day, period, subject, level, room,
               teacher_name AS teacherName, source_type AS sourceType,
               source_priority AS sourcePriority, dataset_id AS datasetId
        FROM schedules
        WHERE teacher_code = ?
        ORDER BY day, period
    `).all(req.user.code);
    res.json({ success: true, teacher: { code: req.user.code, name: req.user.name }, schedule });
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
    const teacherCount = db.prepare(`SELECT COUNT(*) AS count FROM teachers WHERE role = 'teacher' AND active = 1`).get().count;
    const scheduleCount = db.prepare(`SELECT COUNT(*) AS count FROM schedules`).get().count;
    const auditCount = db.prepare(`SELECT COUNT(*) AS count FROM audit_logs`).get().count;
    const latestImport = db.prepare(`SELECT id, filename, upload_type AS uploadType, imported_by AS importedBy, status, record_count AS recordCount, warning_count AS warningCount, conflict_count AS conflictCount, created_at AS createdAt FROM import_sessions ORDER BY created_at DESC LIMIT 1`).get() || null;
    res.json({ success: true, teacherCount, scheduleCount, auditCount, latestImport });
});

app.get('/api/admin/audit-logs', requireAdmin, (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '50', 10) || 50, 1), 200);
    const rows = db.prepare(`
        SELECT id, actor_code AS actorCode, actor_name AS actorName, actor_role AS actorRole,
               action, target_type AS targetType, target_id AS targetId, details, ip, created_at AS createdAt
        FROM audit_logs ORDER BY id DESC LIMIT ?
    `).all(limit).map(row => {
        let details = {};
        try { details = JSON.parse(row.details || '{}'); } catch {}
        return { ...row, details };
    });
    res.json({ success: true, logs: rows });
});


app.put('/api/admin/state', requireAdmin, (req, res) => {
    try {
        syncAdminState(req.body || {});
        auditLog({ actorCode: req.user.code, actorName: req.user.name, actorRole: req.user.role, action: 'admin_state_sync', targetType: 'database', details: { teachers: Array.isArray(req.body?.teachers) ? req.body.teachers.length : 0, timetable: Array.isArray(req.body?.timetable) ? req.body.timetable.length : 0 }, ip: req.ip });
        res.json({ success: true, ...getState() });
    } catch (error) {
        console.error('admin state sync error', error);
        res.status(500).json({ success: false, error: 'บันทึกฐานข้อมูลกลางไม่สำเร็จ' });
    }
});

app.put('/api/teacher/schedule', authenticate, (req, res) => {
    try {
        syncTeacherOwnState(req.user.code, req.body?.schedule || []);
        auditLog({ actorCode: req.user.code, actorName: req.user.name, actorRole: req.user.role, action: 'teacher_own_schedule_sync', targetType: 'teacher', targetId: req.user.code, details: { schedule: Array.isArray(req.body?.schedule) ? req.body.schedule.length : 0 }, ip: req.ip });
        res.json({ success: true });
    } catch (error) {
        console.error('teacher schedule sync error', error);
        res.status(500).json({ success: false, error: 'บันทึกตารางส่วนตัวไม่สำเร็จ' });
    }
});

// ============================================================
// UPLOAD API — ADMIN ONLY
// ============================================================
app.post('/api/upload', requireAdmin, upload.single('timetableFile'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'ไม่พบไฟล์' });

    const uploadType = req.body.uploadType || 'all_students';
    const originalFilename = req.file.originalname || '';
    const ext = path.extname(originalFilename.toLowerCase());
    const datasetId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const importCreatedAt = nowISO();
    db.prepare(`INSERT INTO import_sessions (id, filename, upload_type, imported_by, status, created_at) VALUES (?, ?, ?, ?, 'processing', ?)`)
      .run(datasetId, originalFilename, uploadType, req.user.code, importCreatedAt);

    try {
        if (ext === '.json') {
            const fileContent = await fs.promises.readFile(req.file.path, 'utf8');
            const parsed = JSON.parse(fileContent);
            const recordCount = Array.isArray(parsed?.teachers)
                ? parsed.teachers.reduce((n, t) => n + (Array.isArray(t.schedule) ? t.schedule.length : 0), 0)
                : Array.isArray(parsed?.classes)
                    ? parsed.classes.reduce((n, c) => n + (Array.isArray(c.schedule) ? c.schedule.length : 0), 0)
                    : 0;
            db.prepare(`UPDATE import_sessions SET status='completed', record_count=? WHERE id=?`).run(recordCount, datasetId);
            auditLog({ actorCode: req.user.code, actorName: req.user.name, actorRole: req.user.role, action: 'import_completed', targetType: 'import', targetId: datasetId, details: { filename: originalFilename, uploadType, source: 'json_upload', records: recordCount }, ip: req.ip });
            return res.json({ success: true, source: 'json_upload', data: parsed, datasetId });
        }

        if (ext === '.txt') {
            const rawText = await fs.promises.readFile(req.file.path, 'utf8');
            db.prepare(`UPDATE import_sessions SET status='completed', record_count=0 WHERE id=?`).run(datasetId);
            auditLog({ actorCode: req.user.code, actorName: req.user.name, actorRole: req.user.role, action: 'import_completed', targetType: 'import', targetId: datasetId, details: { filename: originalFilename, uploadType, source: 'txt_upload', records: 0 }, ip: req.ip });
            return res.json({ success: true, source: 'txt_upload', rawText, data: [], datasetId });
        }

        if (ext === '.pdf') {
            const kind = getScheduleKind(uploadType);
            try {
                const pythonResult = await runPythonSGS(req.file.path, kind);
                if (pythonResult.data) {
                    if (kind === 'teacher') {
                        upsertTeachersFromTeacherData(pythonResult.data);
                    }
                }
                db.prepare(`UPDATE import_sessions SET status='completed', record_count=?, warning_count=? WHERE id=?`).run(Number(pythonResult.metadata?.records || 0), Array.isArray(pythonResult.metadata?.warnings) ? pythonResult.metadata.warnings.length : 0, datasetId);
                auditLog({ actorCode: req.user.code, actorName: req.user.name, actorRole: req.user.role, action: 'import_completed', targetType: 'import', targetId: datasetId, details: { filename: originalFilename, uploadType, source: 'sgs_python', records: Number(pythonResult.metadata?.records || 0) }, ip: req.ip });
                return res.json({
                    success: true,
                    source: 'sgs_python',
                    engine: pythonResult.engine,
                    metadata: pythonResult.metadata,
                    data: pythonResult.data,
                    datasetId,
                    warnings: pythonResult.metadata?.warnings || []
                });
            } catch (pythonError) {
                console.warn('⚠️ SGS Engine ล้มเหลว:', pythonError.message);
                if (GEMINI_API_KEY) {
                    const fallback = await runGeminiFallback(
                        req.file.path,
                        req.file.mimetype || 'application/pdf',
                        originalFilename,
                        uploadType
                    );
                    const fallbackRecords = Array.isArray(fallback.data?.teachers)
                        ? fallback.data.teachers.reduce((n, t) => n + (Array.isArray(t.schedule) ? t.schedule.length : 0), 0)
                        : Array.isArray(fallback.data?.classes)
                            ? fallback.data.classes.reduce((n, c) => n + (Array.isArray(c.schedule) ? c.schedule.length : 0), 0)
                            : 0;
                    db.prepare(`UPDATE import_sessions SET status='completed', record_count=?, warning_count=1 WHERE id=?`).run(fallbackRecords, datasetId);
                    auditLog({ actorCode: req.user.code, actorName: req.user.name, actorRole: req.user.role, action: 'import_completed', targetType: 'import', targetId: datasetId, details: { filename: originalFilename, uploadType, source: 'gemini_fallback', records: fallbackRecords }, ip: req.ip });
                    return res.json({ success: true, source: 'gemini_fallback', data: fallback.data, datasetId, warning: 'SGS Engine ล้มเหลว จึงใช้ Gemini fallback' });
                }
                throw pythonError;
            }
        }

        if (['.jpg', '.jpeg', '.png'].includes(ext)) {
            const fallback = await runGeminiFallback(
                req.file.path,
                req.file.mimetype || 'image/jpeg',
                originalFilename,
                uploadType
            );
            const fallbackRecords = Array.isArray(fallback.data?.teachers)
                ? fallback.data.teachers.reduce((n, t) => n + (Array.isArray(t.schedule) ? t.schedule.length : 0), 0)
                : Array.isArray(fallback.data?.classes)
                    ? fallback.data.classes.reduce((n, c) => n + (Array.isArray(c.schedule) ? c.schedule.length : 0), 0)
                    : 0;
            db.prepare(`UPDATE import_sessions SET status='completed', record_count=?, warning_count=1 WHERE id=?`).run(fallbackRecords, datasetId);
            auditLog({ actorCode: req.user.code, actorName: req.user.name, actorRole: req.user.role, action: 'import_completed', targetType: 'import', targetId: datasetId, details: { filename: originalFilename, uploadType, source: 'gemini', records: fallbackRecords }, ip: req.ip });
            return res.json({ success: true, source: 'gemini', data: fallback.data, datasetId });
        }

        return res.status(400).json({ success: false, error: 'ชนิดไฟล์ไม่รองรับ' });
    } catch (error) {
        db.prepare(`UPDATE import_sessions SET status='failed' WHERE id=?`).run(datasetId);
        auditLog({ actorCode: req.user.code, actorName: req.user.name, actorRole: req.user.role, action: 'import_failed', targetType: 'import', targetId: datasetId, details: { filename: originalFilename, uploadType, error: error.message }, ip: req.ip });
        console.error('❌ Upload Error:', error);
        return res.status(500).json({ success: false, error: error.message || 'ระบบอ่านไฟล์ไม่สำเร็จ' });
    } finally {
        safeUnlink(req.file.path);
    }
});

// ============================================================
// ROOT / ERROR
// ============================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((err, req, res, next) => {
    console.error('❌ Server error:', err.message);
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: 'ไฟล์ใหญ่เกิน 25 MB' });
    }
    if (err.message === 'ชนิดไฟล์ไม่รองรับ') {
        return res.status(415).json({ success: false, error: err.message });
    }
    return res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
});

function reclassifyTeachersFromSchedule() {
    const teachers = db.prepare('SELECT code FROM teachers WHERE active = 1').all();
    const getRowsStmt = db.prepare('SELECT subject, level, room FROM schedules WHERE teacher_code = ?');
    const update = db.prepare('UPDATE teachers SET dept = ?, updated_at = ? WHERE code = ?');
    const tx = db.transaction(() => {
        for (const t of teachers) {
            const rows = getRowsStmt.all(t.code);
            update.run(deptFromCode(t.code, rows), nowISO(), t.code);
        }
    });
    tx();
}
reclassifyTeachersFromSchedule();

app.listen(PORT, () => {
    console.log('======================================');
    console.log(`🚀 School Exchange server: http://localhost:${PORT}`);
    console.log(`🐍 SGS Engine: ${SGS_ENGINE_PATH}`);
    console.log(`🗄️ SQLite DB: ${DB_PATH}`);
    console.log(`👑 Admin Code: ${ADMIN_CODE}`);
    console.log(`🔐 Admin PIN configured: ${ADMIN_PIN ? 'YES' : 'NO'}`);
    console.log(`🔑 Gemini Fallback: ${GEMINI_API_KEY ? 'ON' : 'OFF'}`);
    console.log('======================================');
});
