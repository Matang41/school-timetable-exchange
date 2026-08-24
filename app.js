const days = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์'];

// 🟢 ฐานข้อมูลกลาง (State)
let globalTimetableDB = []; 
let globalTeachersDB = []; 
let currentUser = null;
let currentPermissions = {};
let currentViewedTeacherCode = null; 
let selectedSlotForAction = null; 
let currentViewedTeacherForSwap = null; 
let isSmartMatchMode = false; 
let selectedAbsenceDateObj = null; 
let currentSwapEvaluation = null;
let dragSourceInfo = null;
let currentReplacementFormData = null;
let selectedSwapRequestIds = new Set();
let cachedSavedSwapRequests = [];

// ==================== 🧠 Helpers & Engine ====================
const dayMapTH = {'อาทิตย์':0, 'จันทร์':1, 'อังคาร':2, 'พุธ':3, 'พฤหัสบดี':4, 'ศุกร์':5, 'เสาร์':6};

function formatThaiDateFull(dateObj) {
    if (!dateObj) return "";
    const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    let year = dateObj.getFullYear();
    // 🛡️ อุดบั๊กปี พ.ศ. (ถ้าเป็น 2569 อยู่แล้ว ไม่ต้องบวก 543 เพิ่ม)
    if (year < 2500) year += 543; 
    return `${dateObj.getDate()} ${months[dateObj.getMonth()]} ${year}`;
}

function getNextTargetDate(baseDateObj, targetDayTH) {
    if (!baseDateObj) return new Date();
    let resultDate = new Date(baseDateObj);
    let targetDayNum = dayMapTH[targetDayTH];
    let currentDayNum = resultDate.getDay();
    let daysToAdd = targetDayNum - currentDayNum;
    if (daysToAdd <= 0) daysToAdd += 7; 
    resultDate.setDate(resultDate.getDate() + daysToAdd);
    return resultDate;
}

function extractGradeLevel(levelStr) {
    if(!levelStr) return null;
    let match = levelStr.match(/\d+/);
    return match ? match[0] : null; 
}

function isHeavySubject(subjectCode) {
    let heavy = ['ค', 'ว', 'อ', 'EN', 'SC', 'MA', 'อ3', 'อ2', 'ค3', 'ค2', 'ว3', 'ว2']; 
    return subjectCode && heavy.some(h => subjectCode.startsWith(h));
}

function checkStudentFatigueForReturnSlot(mySubject, targetReturnDay, targetReturnPeriod, targetLevel) {
    if (!isHeavySubject(mySubject)) return null; 
    const studentSchedule = globalTimetableDB.filter(d => d.level === targetLevel && d.day === targetReturnDay);
    let prevPeriod = studentSchedule.find(d => parseInt(d.period) === parseInt(targetReturnPeriod) - 1);
    let nextPeriod = studentSchedule.find(d => parseInt(d.period) === parseInt(targetReturnPeriod) + 1);
    
    if ((prevPeriod && isHeavySubject(prevPeriod.subject)) && (nextPeriod && isHeavySubject(nextPeriod.subject))) {
        return `⚠️ คำเตือน: ถ้ารับคาบนี้ นักเรียนจะเรียนวิชาหนักติดกัน 3 คาบ!`;
    }
    return null;
}

const DEFAULT_DEPARTMENT_RULES = {
    groups: [
        { id:100, code:'TH', name:'ภาษาไทย' },
        { id:200, code:'MATH', name:'คณิตศาสตร์' },
        { id:300, code:'SCI', name:'วิทยาศาสตร์และเทคโนโลยี' },
        { id:400, code:'SOC', name:'สังคมศึกษาศาสนาและวัฒนธรรม' },
        { id:500, code:'PE', name:'สุขศึกษาและพละศึกษา' },
        { id:600, code:'ART', name:'ศิลปศึกษา' },
        { id:700, code:'CAR', name:'การงานอาชีพ' },
        { id:800, code:'FL', name:'ภาษาต่างประเทศ' },
        { id:900, code:'ACT', name:'กิจกรรมพัฒนาผู้เรียน' },
        { id:910, code:'EXP', name:'ครูต่างประเทศ' },
        { id:920, code:'OFFICE', name:'เจ้าหน้าที่สำนักงาน' }
    ],
    subject_prefix_map: { 'ท':'TH','ค':'MATH','MA':'MATH','ว':'SCI','SC':'SCI','I':'SCI','ส':'SOC','SO':'SOC','พ':'PE','HP':'PE','ศ':'ART','ง':'CAR','OC':'CAR','อ':'FL','EN':'FL','จ':'FL','ต':'FL','ก':'ACT' },
    code_rules: [[100,199,'TH'],[200,299,'MATH'],[300,399,'SCI'],[400,499,'SOC'],[500,599,'PE'],[600,699,'ART'],[700,750,'SCI'],[751,799,'CAR'],[800,899,'FL'],[900,949,'ACT'],[950,999,'CAR']],
    special_code_prefix_rules: [],
    special_code_range_rules: [[9000,9999,'EXP']],
    overrides: { teacher_code: {}, office_teacher_codes: [] },
    evidence: { dominance_threshold:0.55, minimum_recognized_courses:3 }
};
let departmentRules = DEFAULT_DEPARTMENT_RULES;
const mockDepartments = [];
function rebuildMockDepartments(){
    mockDepartments.splice(0, mockDepartments.length);
    mockDepartments.push({id:0,name:'✨ แนะนำที่ดีที่สุด (AI Smart Match)'});
    for(const g of departmentRules.groups) mockDepartments.push({id:g.id,name:g.name});
}
rebuildMockDepartments();
async function loadDepartmentRules(){
    try{
        const r=await fetch('/config/department_rules.json',{cache:'no-store'});
        if(!r.ok) throw new Error(`HTTP ${r.status}`);
        const d=await r.json();
        if(d && Array.isArray(d.groups)) { departmentRules={...DEFAULT_DEPARTMENT_RULES,...d}; rebuildMockDepartments(); }
    }catch(e){ console.warn('⚠️ ใช้กฎกลุ่มสาระสำรอง:',e.message); }
}
function groupByCode(code){ return departmentRules.groups.find(g=>g.code===code)||null; }
function subjectGroupFromCode(subject){
    const raw=String(subject||'').trim().toUpperCase();
    const map=departmentRules.subject_prefix_map||{};
    for(const k of Object.keys(map).sort((a,b)=>b.length-a.length)) if(raw.startsWith(k)) return map[k];
    return null;
}
function codeGroupCode(code){
    const raw=String(code||'').trim(); const numeric=parseInt(raw.replace(/\D/g,''),10);
    if(!Number.isFinite(numeric)) return null;
    for(const r of (departmentRules.special_code_prefix_rules||[])) if(raw.startsWith(r.prefix||r[0])) return r.group||r[1];
    for(const r of (departmentRules.code_rules||[])){ const min=r.min??r[0], max=r.max??r[1], group=r.group??r[2]; if(numeric>=min&&numeric<=max)return group; }
    return null;
}
function resolveTeacherDepartment(teacherCode,schedule=[]){
    const code=String(teacherCode||'').trim();
    const override=departmentRules.overrides?.teacher_code?.[code];
    if(override) return groupByCode(override);
    if((departmentRules.overrides?.office_teacher_codes||[]).map(String).includes(code)) return groupByCode('OFFICE');

    const numeric=parseInt(code.replace(/\D/g,''),10);
    // โรงเรียนกำหนดช่วงรหัสเหล่านี้เป็นกฎหลัก ห้าม subject evidence override
    if(Number.isFinite(numeric) && numeric>=9000 && numeric<=9999) return groupByCode('EXP');
    if(Number.isFinite(numeric)) {
        const fixedRanges=[[700,750,'SCI'],[751,799,'CAR'],[800,899,'FL'],[900,949,'ACT'],[950,999,'CAR']];
        for(const [min,max,group] of fixedRanges){ if(numeric>=min && numeric<=max) return groupByCode(group); }
    }

    const codeGroup=codeGroupCode(code);
    if(codeGroup) return groupByCode(codeGroup);

    // กรณีรหัสครูไม่อยู่ในกฎ ให้ใช้รหัสวิชาเป็น fallback เท่านั้น
    const counts={}; let recognized=0;
    for(const item of (Array.isArray(schedule)?schedule:[])){
        const g=subjectGroupFromCode(item?.subject||item?.subject_code||'');
        if(!g || g==='ACT') continue;
        counts[g]=(counts[g]||0)+1; recognized++;
    }
    if(recognized){
        const d=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
        const threshold=Number(departmentRules.evidence?.dominance_threshold||.55);
        const min=Number(departmentRules.evidence?.minimum_recognized_courses||3);
        if(d && d[1]>=min && d[1]/recognized>=threshold) return groupByCode(d[0]);
    }
    return groupByCode('ACT');
}
function getTeacherDepartmentName(teacherCode){
    const t=globalTeachersDB.find(x=>normalizeTeacherCode(x.code)===normalizeTeacherCode(teacherCode));
    if(t?.groupCode) return groupByCode(t.groupCode)?.name||'';
    if(t?.dept!=null){ const g=departmentRules.groups.find(x=>x.id===Number(t.dept)); if(g)return g.name; }
    return resolveTeacherDepartment(teacherCode)?.name||'';
}

// ==================== 🛠️ Initialization & Event Delegation ====================
async function bootstrapAuth() {
    await loadDepartmentRules();
    try {
        const response = await fetch('/api/auth/me', {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error('not_authenticated');
        }

        const result = await response.json();
        currentUser = result.user;
        currentPermissions = result.user?.permissions || {};
        currentViewedTeacherCode = currentUser.code;

        await loadSharedState();
        showMainApp();
    } catch (error) {
        currentUser = null;
        currentViewedTeacherCode = null;
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('mainApp').classList.add('hidden');
        localStorage.removeItem('schoolUser');
    }
}

async function loadAuthStatus() {
    const response = await fetch('/api/auth/status', {
        method: 'GET',
        credentials: 'include'
    });
    if (!response.ok) throw new Error('โหลดสถานะระบบไม่สำเร็จ');
    return response.json();
}

function renderAuthScreen(mode = 'teacher', status = null) {
    const root = document.getElementById('loginScreen');
    if (!root) return;

    const setupRequired = Boolean(status?.setupRequired);

    if (mode === 'admin') {
        root.innerHTML = `
        <div class="bg-white p-8 md:p-10 rounded-2xl shadow-2xl w-full max-w-md border-t-4 border-red-500">
            <div class="text-center mb-7">
                <div class="bg-red-100 text-red-600 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4 text-3xl">👑</div>
                <h2 class="text-2xl font-bold text-gray-800">ระบบผู้ดูแลระบบวิชาการ</h2>
                <p class="text-sm text-gray-500 mt-1">สำหรับผู้ดูแลรหัส 613 เท่านั้น</p>
            </div>
            <div class="space-y-4">
                <div>
                    <label class="block text-sm font-semibold text-gray-700 mb-1">รหัสผู้ดูแลระบบ</label>
                    <input id="adminCodeInput" type="text" inputmode="numeric" value="613" readonly class="w-full border border-gray-300 px-4 py-3 rounded-lg font-bold text-red-800 bg-gray-100 outline-none">
                </div>
                <div>
                    <label class="block text-sm font-semibold text-gray-700 mb-1">รหัสผ่านผู้ดูแล</label>
                    <input id="adminPinInput" type="password" autocomplete="current-password" placeholder="กรอกรหัสผ่านผู้ดูแล" class="w-full border border-gray-300 px-4 py-3 rounded-lg focus:ring-2 focus:ring-red-500 outline-none font-bold">
                </div>
                <button onclick="login(true)" class="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg shadow-md transition-colors">เข้าสู่ระบบผู้ดูแล</button>
                <button onclick="showTeacherLogin()" class="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-3 rounded-lg transition-colors">← กลับเข้าสู่ระบบครู</button>
            </div>
            ${setupRequired ? `
            <div class="mt-6 bg-orange-50 border border-orange-200 text-orange-800 rounded-xl p-4 text-sm">
                <div class="font-bold mb-1">⚠️ ระบบยังไม่มีฐานข้อมูลครู</div>
                <div>หลังเข้าสู่ระบบ Admin กรุณานำเข้า “ตารางรวมครู” จาก SGS เพื่อสร้างบัญชีครูทั้งหมด</div>
            </div>` : ''}
        </div>`;
        const pin = document.getElementById('adminPinInput');
        if (pin) pin.focus();
        return;
    }

    root.innerHTML = `
    <div class="bg-white p-8 md:p-10 rounded-2xl shadow-2xl w-full max-w-md border-t-4 border-blue-600">
        <div class="text-center mb-7">
            <div class="bg-blue-100 text-blue-600 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4 text-3xl">🔄</div>
            <h2 class="text-2xl font-bold text-gray-800">พี่คร้าบผมขอแลกคาบหน่อย</h2>
            <p class="text-sm text-gray-500 mt-1">โรงเรียนสรรพวิทยาคม</p>
        </div>
        <div class="space-y-5">
            <div>
                <label class="block text-sm font-semibold text-gray-700 mb-1">รหัสประจำตัวครู</label>
                <input id="teacherCode" type="text" inputmode="numeric" autocomplete="username" placeholder="เช่น 228" class="w-full border border-gray-300 px-4 py-3 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-all font-bold text-blue-900 bg-gray-50">
                <p class="text-xs text-gray-500 mt-2">ระบบจะดึงชื่อ-นามสกุลจากฐานข้อมูลครูอัตโนมัติเมื่อเข้าสู่ระบบ</p>
            </div>
            <button onclick="login(false)" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg shadow-md transition-colors">เข้าสู่ระบบครู</button>
            <button onclick="showAdminLogin()" class="w-full bg-white hover:bg-gray-50 text-red-600 border border-red-200 font-bold py-3 rounded-lg transition-colors">👑 สำหรับผู้ดูแลระบบ</button>
            ${setupRequired ? `
            <div class="bg-orange-50 border border-orange-200 text-orange-800 rounded-xl p-4 text-sm">
                <div class="font-bold">⚠️ ระบบอยู่ในขั้นตอนเตรียมใช้งานครั้งแรก</div>
                <div class="mt-1">ขณะนี้ยังไม่มีบัญชีครูในฐานข้อมูล ผู้ดูแลระบบต้องนำเข้าตารางรวมครูจาก SGS ก่อน</div>
            </div>` : ''}
        </div>
    </div>`;
    const input = document.getElementById('teacherCode');
    if (input) {
        input.focus();
        input.addEventListener('keydown', e => { if (e.key === 'Enter') login(false); });
    }
}

async function showTeacherLogin() {
    try { renderAuthScreen('teacher', await loadAuthStatus()); }
    catch { renderAuthScreen('teacher', null); }
}

async function showAdminLogin() {
    try { renderAuthScreen('admin', await loadAuthStatus()); }
    catch { renderAuthScreen('admin', null); }
}

document.addEventListener('DOMContentLoaded', async () => {
    setupTableEventDelegation();
    try {
        const status = await loadAuthStatus();
        renderAuthScreen('teacher', status);
    } catch (error) {
        console.warn('auth status unavailable', error);
        renderAuthScreen('teacher', null);
    }
    await bootstrapAuth();
});

async function loadSharedState() {
    const response = await fetch('/api/state', {
        method: 'GET',
        credentials: 'include'
    });

    if (!response.ok) {
        throw new Error('ไม่สามารถโหลดฐานข้อมูลกลางได้');
    }

    const result = await response.json();
    globalTeachersDB = Array.isArray(result.teachers) ? result.teachers : [];
    globalTimetableDB = Array.isArray(result.timetable) ? result.timetable : [];
    currentPermissions = result.permissions || currentUser?.permissions || {};

    // Keep a local cache for fast UI rendering only. The server remains authoritative.
    saveDatabase();
}

async function syncAdminStateToServer() {
    if (!currentUser?.isAdmin) return;

    const response = await fetch('/api/admin/state', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            teachers: globalTeachersDB,
            timetable: globalTimetableDB
        })
    });

    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'บันทึกฐานข้อมูลกลางไม่สำเร็จ');
    }
    if (currentUser?.isAdmin) refreshAdminSecurityPanel().catch(() => {});
}

function requireAdminUI() {
    if (!currentUser?.isAdmin || currentUser.code !== '613' || currentPermissions.canManageSystem !== true) {
        alert('⛔ เฉพาะผู้ดูแลระบบรหัส 613 เท่านั้นที่สามารถนำเข้าและจัดการข้อมูลกลางได้');
        return false;
    }
    return true;
}



const LEGACY_SWAP_DRAFT_STORAGE_KEY = 'savedSwapRequestsDrafts';

function getSwapDraftStorageKey() {
    const code = String(currentUser?.code || 'anonymous').replace(/[^0-9A-Za-z_-]/g, '_');
    return `savedSwapRequestsDrafts:${code}`;
}

function loadLocalSwapDrafts() {
    try {
        const key = getSwapDraftStorageKey();
        const raw = localStorage.getItem(key);
        if (raw) {
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        }
        // One-time migration from the older shared cache.
        const legacy = JSON.parse(localStorage.getItem(LEGACY_SWAP_DRAFT_STORAGE_KEY) || '[]');
        const mine = Array.isArray(legacy)
            ? legacy.filter(x => String(x.requesterCode) === String(currentUser?.code))
            : [];
        if (mine.length) localStorage.setItem(key, JSON.stringify(mine.slice(0, 200)));
        return mine;
    } catch (_) {
        return [];
    }
}

function saveLocalSwapDrafts(items) {
    try {
        localStorage.setItem(getSwapDraftStorageKey(), JSON.stringify(items.slice(0, 200)));
    } catch (_) {}
}

function upsertLocalSwapDraft(request) {
    if (!request?.id) return;
    const current = loadLocalSwapDrafts().filter(x => String(x.id) !== String(request.id));
    current.unshift(request);
    saveLocalSwapDrafts(current);
}

function removeLocalSwapDraft(requestId) {
    const current = loadLocalSwapDrafts().filter(x => String(x.id) !== String(requestId));
    saveLocalSwapDrafts(current);
}

function mergeRequestLists(serverRequests, localRequests) {
    const map = new Map();
    [...serverRequests, ...localRequests].forEach(item => {
        if (!item?.id) return;
        map.set(String(item.id), item);
    });
    return [...map.values()].sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function setupSwapRequestUI() {
    if (!currentUser || document.getElementById('swapRequestPanel')) return;

    const host = document.querySelector('#myTimetableTab main') || document.getElementById('myTimetableTab');
    if (!host) return;

    const panel = document.createElement('div');
    panel.id = 'swapRequestPanel';
    panel.className = 'bg-white p-5 rounded-xl shadow-sm border border-indigo-100 mb-6';
    panel.innerHTML = `
        <div class="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3 border-b pb-3 mb-4">
            <div>
                <h3 class="font-bold text-lg text-indigo-900">📋 คำขอแลกคาบที่บันทึกไว้</h3>
                <p class="text-xs text-gray-500 mt-1">ระบบจะเก็บรายการที่คุณเลือกไว้ก่อน โดยยังไม่เปลี่ยนตารางสอนจริง และสามารถรวมหลายคาบ/หลายวันเพื่อจัดทำใบ วก.11 ได้</p>
            </div>
            <div class="flex flex-wrap gap-2">
                <button id="selectAllSwapRequestsBtn" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 px-3 py-2 rounded-lg text-xs font-bold">☑️ เลือกทั้งหมด</button>
                <button id="printSelectedSwapRequestsBtn" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg text-xs font-bold shadow-sm">🖨️ พิมพ์ใบ วก.11 ที่เลือก</button>
                <button id="refreshSwapRequestsBtn" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg text-xs font-bold">↻ รีเฟรช</button>
            </div>
        </div>
        <div id="swapRequestList" class="space-y-3"></div>
    `;

    const firstCard = document.querySelector('#myTimetableTab > div.bg-white');
    if (firstCard && firstCard.parentElement) {
        firstCard.parentElement.insertBefore(panel, firstCard);
    } else {
        host.prepend(panel);
    }

    document.getElementById('refreshSwapRequestsBtn')?.addEventListener('click', refreshSwapRequestUI);
    document.getElementById('selectAllSwapRequestsBtn')?.addEventListener('click', toggleSelectAllSavedSwapRequests);
    document.getElementById('printSelectedSwapRequestsBtn')?.addEventListener('click', printSelectedSavedSwapRequests);
}

function toggleSelectAllSavedSwapRequests() {
    const boxes = [...document.querySelectorAll('#swapRequestList input.swap-request-check')];
    if (!boxes.length) return alert('ยังไม่มีคำขอที่บันทึกไว้สำหรับพิมพ์ใบ วก.11');
    const allSelected = boxes.every(b => b.checked);
    boxes.forEach(box => {
        box.checked = !allSelected;
        if (box.checked) selectedSwapRequestIds.add(box.value);
        else selectedSwapRequestIds.delete(box.value);
    });
    syncSelectedSwapRequestButton();
}

function syncSelectedSwapRequestButton() {
    const btn = document.getElementById('printSelectedSwapRequestsBtn');
    if (btn) btn.innerText = selectedSwapRequestIds.size ? `🖨️ พิมพ์ใบ วก.11 (${selectedSwapRequestIds.size} รายการ)` : '🖨️ พิมพ์ใบ วก.11 ที่เลือก';
}

function onSwapRequestCheckChanged(id, checked) {
    if (checked) selectedSwapRequestIds.add(id);
    else selectedSwapRequestIds.delete(id);
    syncSelectedSwapRequestButton();
}

function escapeHtmlClient(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function swapStatusBadge(status) {
    const map = {
        saved: ['💾 บันทึกไว้รอจัดทำใบ วก.11', 'bg-indigo-50 text-indigo-800 border-indigo-200'],
        pending: ['💾 บันทึกไว้รอจัดทำใบ วก.11', 'bg-indigo-50 text-indigo-800 border-indigo-200'],
        accepted: ['✅ ดำเนินการแล้ว', 'bg-green-50 text-green-800 border-green-200'],
        rejected: ['❌ ไม่ดำเนินการ', 'bg-red-50 text-red-800 border-red-200'],
        cancelled: ['↩️ ยกเลิก', 'bg-gray-50 text-gray-700 border-gray-200']
    };
    const item = map[status] || [status, 'bg-gray-50 text-gray-700 border-gray-200'];
    return `<span class="text-xs font-bold px-2 py-1 rounded border ${item[1]}">${item[0]}</span>`;
}

async function fetchSwapRequests() {
    const endpoint = currentUser?.isAdmin ? '/api/swap-requests?scope=all' : '/api/swap-requests/mine';
    const response = await fetch(endpoint, {
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'โหลดคำขอแลกคาบไม่สำเร็จ');
    return Array.isArray(result.requests) ? result.requests : [];
}

function renderSwapRequests(requests) {
    const box = document.getElementById('swapRequestList');
    if (!box) return;

    // สำหรับหน้า “ตารางของฉัน” ให้เลือกพิมพ์เฉพาะคำขอของผู้ใช้ที่ยังบันทึกไว้
    const savedMine = requests.filter(req =>
        String(req.requesterCode) === String(currentUser?.code) &&
        (req.status === 'saved' || req.status === 'pending')
    );
    cachedSavedSwapRequests = savedMine;

    // ล้าง id ที่หายไปจากชุดที่เลือก
    const validIds = new Set(savedMine.map(r => r.id));
    selectedSwapRequestIds = new Set([...selectedSwapRequestIds].filter(id => validIds.has(id)));

    if (!savedMine.length) {
        box.innerHTML = `<div class="text-sm text-gray-500 bg-gray-50 border rounded-lg p-4 text-center">ยังไม่มีคำขอที่บันทึกไว้ — เมื่อคุณกดยืนยันการแลกคาบ ระบบจะเก็บรายการไว้ตรงนี้โดยไม่เปลี่ยนตารางจริง</div>`;
        syncSelectedSwapRequestButton();
        return;
    }

    box.innerHTML = savedMine.map(req => {
        const title = req.actionType === 'one_way' ? 'ฝากคาบ' : 'แลกคาบ';
        const returnText = req.actionType === 'one_way'
            ? 'ไม่มีคาบสอนคืน'
            : `สอนคืน: วัน${escapeHtmlClient(req.returnDay)} คาบ ${req.returnPeriod} · วันที่ ${escapeHtmlClient(req.returnDate || '-')} · ${escapeHtmlClient(req.returnLevel || '')}`;
        const checked = selectedSwapRequestIds.has(req.id) ? 'checked' : '';
        const targetText = req.targetName ? `${escapeHtmlClient(req.targetName)} (${escapeHtmlClient(req.targetCode)})` : escapeHtmlClient(req.targetCode);

        return `<div class="border rounded-xl p-4 bg-white shadow-sm">
            <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                <div class="flex items-start gap-3">
                    <input type="checkbox" class="swap-request-check mt-1.5 w-4 h-4 text-indigo-600" value="${escapeHtmlClient(req.id)}" ${checked} onchange="onSwapRequestCheckChanged('${escapeHtmlClient(req.id)}', this.checked)">
                    <div>
                        <div class="font-bold text-gray-800">${title} · ${escapeHtmlClient(req.id)}</div>
                        <div class="text-sm text-gray-600 mt-1">วันที่ ${escapeHtmlClient(req.absenceDate || '-')} · ขอแลกกับ ${targetText}</div>
                        <div class="text-sm text-gray-700 mt-1">วัน${escapeHtmlClient(req.originalDay)} คาบ ${req.originalPeriod} · ${escapeHtmlClient(req.originalLevel)} · ${escapeHtmlClient(req.originalSubject)} · ห้อง ${escapeHtmlClient(req.originalRoom || '-')}</div>
                        <div class="text-xs text-gray-500 mt-1">${returnText}</div>
                    </div>
                </div>
                <div>${swapStatusBadge(req.status)}</div>
            </div>
            <div class="flex flex-wrap gap-2 mt-3 ml-7">
                <button onclick="printSingleSavedSwapRequest('${escapeHtmlClient(req.id)}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 px-3 py-2 rounded-lg text-xs font-bold">🖨️ พิมพ์เฉพาะรายการนี้</button>
                <button onclick="respondToSwapRequest('${escapeHtmlClient(req.id)}','cancel')" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg text-xs font-bold">ยกเลิกคำขอ</button>
            </div>
        </div>`;
    }).join('');

    syncSelectedSwapRequestButton();
}

function mergeSavedSwapRequestIntoUI(request) {
    if (!request || !request.id) return;
    upsertLocalSwapDraft(request);
    const current = mergeRequestLists(cachedSavedSwapRequests || [], [request]);
    renderSwapRequests(current);
}

async function refreshSwapRequestUI() {
    const box = document.getElementById('swapRequestList');
    if (!box || !currentUser) return;

    const localMine = loadLocalSwapDrafts().filter(req =>
        String(req.requesterCode) === String(currentUser.code) &&
        (req.status === 'saved' || req.status === 'pending')
    );

    if (localMine.length) renderSwapRequests(localMine);
    else box.innerHTML = `<div class="text-sm text-gray-500 bg-gray-50 border rounded-lg p-4 text-center">กำลังโหลดคำขอที่บันทึกไว้...</div>`;

    try {
        const serverRequests = await fetchSwapRequests();
        const merged = mergeRequestLists(serverRequests, localMine);
        renderSwapRequests(merged);

        // Keep local drafts as a durable UI backup. They are intentionally not deleted
        // when the same record exists on the server. This prevents a transient API/UI
        // issue from making saved requests appear to disappear.
        const mergedMine = merged.filter(req =>
            String(req.requesterCode) === String(currentUser.code) &&
            (req.status === 'saved' || req.status === 'pending')
        );
        saveLocalSwapDrafts(mergedMine);
    } catch (error) {
        if (!localMine.length) {
            box.innerHTML = `<div class="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-4">${escapeHtmlClient(error.message)}</div>`;
        }
        console.warn('⚠️ โหลดคำขอจาก server ไม่สำเร็จ แต่ยังคงใช้ Local Draft:', error);
    }
}

function requestToReplacementFormData(req) {
    const returnInfo = req.actionType === 'swap' && req.returnDay
        ? {
            day: req.returnDay,
            period: req.returnPeriod,
            date: req.returnDate || '',
            isoDate: req.returnDateISO || '',
            level: req.returnLevel || '',
            subject: req.returnSubject || '',
            room: req.returnRoom || ''
        }
        : null;
    return buildReplacementFormData({
        requestId: req.id,
        actionType: req.actionType === 'one_way' ? 'one_way' : 'swap',
        absenceDate: req.absenceDate || '',
        originalDay: req.originalDay || '',
        originalPeriod: req.originalPeriod || '',
        originalSubject: req.originalSubject || '',
        originalLevel: req.originalLevel || '',
        originalRoom: req.originalRoom || '',
        requesterCode: req.requesterCode || currentUser.code,
        requesterName: req.requesterName || currentUser.name,
        targetCode: req.targetCode || '',
        targetName: req.targetName || '',
        returnInfo
    });
}

function getAllSavedRequestsForCurrentUser() {
    const localMine = loadLocalSwapDrafts().filter(req => String(req.requesterCode) === String(currentUser?.code));
    return mergeRequestLists(cachedSavedSwapRequests || [], localMine)
        .filter(req => req.status === 'saved' || req.status === 'pending');
}

function findSavedSwapRequest(requestId) {
    return getAllSavedRequestsForCurrentUser().find(item => String(item.id) === String(requestId)) || null;
}

function printSingleSavedSwapRequest(requestId) {
    const req = findSavedSwapRequest(requestId);
    if (!req) return alert('ไม่พบข้อมูลคำขอที่ต้องการพิมพ์ใบ วก.11');
    openReplacementFormPrintPreview([requestToReplacementFormData(req)]);
}

function printSelectedSavedSwapRequests() {
    const all = getAllSavedRequestsForCurrentUser();
    const selected = all.filter(req => selectedSwapRequestIds.has(String(req.id)));
    if (!selected.length) return alert('กรุณาเลือกคำขออย่างน้อย 1 รายการเพื่อจัดทำใบ วก.11');
    openReplacementFormPrintPreview(selected.map(requestToReplacementFormData));
}

async function respondToSwapRequest(requestId, action) {
    // V10.6 อยู่ในโหมดจัดทำเอกสารเท่านั้น จึงไม่อนุญาตให้ “ยอมรับ/ปฏิเสธ” แล้วเปลี่ยนตารางจริง
    if (action !== 'cancel') {
        return alert('ℹ️ รุ่นนี้ใช้สำหรับบันทึกและจัดทำใบ วก.11 เท่านั้น การเปลี่ยนตารางจริงยังไม่เปิดใช้งาน');
    }
    if (!confirm(`ยืนยันยกเลิกคำขอ ${requestId} ใช่หรือไม่?`)) return;

    try {
        const response = await fetch(`/api/swap-requests/${encodeURIComponent(requestId)}/cancel`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) throw new Error(result.error || 'ไม่สามารถยกเลิกคำขอได้');
        selectedSwapRequestIds.delete(requestId);
        alert('✅ ยกเลิกคำขอเรียบร้อยแล้ว');
        await refreshSwapRequestUI();
    } catch (error) {
        alert(`❌ ${error.message}`);
    }
}

function setupTableEventDelegation() {
    const tbody = document.getElementById('timetableBody');
    
    // 1. จัดการ Click (เปิด Modal)
    tbody.addEventListener('click', (e) => {
        const td = e.target.closest('td[data-period]');
        if (!td) return;
        const day = td.dataset.day;
        const period = parseInt(td.dataset.period);
        const myExtractedData = globalTimetableDB.filter(d => d.teacherCode === currentViewedTeacherCode);
        const classData = myExtractedData.find(d => d.day === day && parseInt(d.period) === period);
        
        if (classData) openActionModal(day, period, classData);
        else openAddSlotModal(day, period);
    });

    // 2. จัดการ Drag & Drop
    tbody.addEventListener('dragstart', (e) => {
        const td = e.target.closest('td[draggable="true"]');
        if(!td) { e.preventDefault(); return; }
        dragSourceInfo = { day: td.dataset.day, period: parseInt(td.dataset.period) };
        e.dataTransfer.effectAllowed = "move";
        setTimeout(() => td.classList.add('dragging'), 0);
    });

    tbody.addEventListener('dragover', (e) => {
        const td = e.target.closest('td[data-period]');
        if (!td) return;
        e.preventDefault(); 
        e.dataTransfer.dropEffect = "move";
        if (!dragSourceInfo || dragSourceInfo.day !== td.dataset.day || dragSourceInfo.period !== parseInt(td.dataset.period)) {
            td.classList.add('drag-over');
        }
    });

    tbody.addEventListener('dragleave', (e) => {
        const td = e.target.closest('td[data-period]');
        if (td) td.classList.remove('drag-over');
    });

    tbody.addEventListener('drop', (e) => {
        const td = e.target.closest('td[data-period]');
        if (!td) return;
        e.preventDefault();
        td.classList.remove('drag-over');
        if (!dragSourceInfo) return; 
        
        const targetDay = td.dataset.day;
        const targetPeriod = parseInt(td.dataset.period);

        if (dragSourceInfo.day === targetDay && dragSourceInfo.period === targetPeriod) return; 

        let sourceIdx = globalTimetableDB.findIndex(d => d.teacherCode === currentViewedTeacherCode && d.day === dragSourceInfo.day && parseInt(d.period) === dragSourceInfo.period);
        let targetIdx = globalTimetableDB.findIndex(d => d.teacherCode === currentViewedTeacherCode && d.day === targetDay && parseInt(d.period) === targetPeriod);

        if (sourceIdx !== -1) {
            if (targetIdx !== -1) {
                if (confirm(`ช่องเป้าหมายมีสอนชั้น ${globalTimetableDB[targetIdx].level} อยู่แล้ว\n\nต้องการ "สลับคาบสอน" กันใช่หรือไม่?`)) {
                    let tempDay = globalTimetableDB[targetIdx].day;
                    let tempPeriod = globalTimetableDB[targetIdx].period;
                    globalTimetableDB[targetIdx].day = dragSourceInfo.day;
                    globalTimetableDB[targetIdx].period = dragSourceInfo.period;
                    globalTimetableDB[sourceIdx].day = tempDay;
                    globalTimetableDB[sourceIdx].period = tempPeriod;
                }
            } else {
                globalTimetableDB[sourceIdx].day = targetDay;
                globalTimetableDB[sourceIdx].period = targetPeriod;
            }
            saveDatabase(); renderTimetable(); populateStudentRooms();
        }
    });

    tbody.addEventListener('dragend', (e) => {
        const td = e.target.closest('td[draggable="true"]');
        if (td) td.classList.remove('dragging');
        dragSourceInfo = null;
    });
}

function saveDatabase() {
    // Local storage is only a UI cache now. Server-side database is authoritative.
    localStorage.setItem('globalTimetableDB', JSON.stringify(globalTimetableDB));
    localStorage.setItem('globalTeachersDB', JSON.stringify(globalTeachersDB));
}

async function persistCurrentUserChanges() {
    // Admin changes are centrally synchronized. Teacher manual edits remain local
    // until the later teacher-override module is enabled.
    if (currentUser?.isAdmin) {
        try {
            await syncAdminStateToServer();
        } catch (error) {
            console.error(error);
            alert(`⚠️ บันทึกฐานข้อมูลกลางไม่สำเร็จ\n${error.message}`);
        }
    }
    saveDatabase();
}

function renderAdminSecurityPanel() {
    if (!currentUser?.isAdmin) return;
    const adminPanel = document.getElementById('adminPanel');
    if (!adminPanel) return;
    let panel = document.getElementById('adminSecurityPanel');
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'adminSecurityPanel';
    panel.className = 'mt-5 bg-white rounded-xl border border-red-100 shadow-sm overflow-hidden';
    panel.innerHTML = `
        <div class="p-4 border-b border-gray-100 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
                <div class="font-bold text-gray-800">🛡️ สถานะระบบและสิทธิ์</div>
                <div class="text-xs text-gray-500 mt-1">V9: Role & Permission + Audit Log</div>
            </div>
            <button onclick="refreshAdminSecurityPanel()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg text-xs font-bold">↻ รีเฟรช</button>
        </div>
        <div id="adminSecuritySummary" class="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"></div>
        <div class="p-4 border-t border-gray-100">
            <div class="flex items-center justify-between mb-3">
                <div class="font-bold text-gray-800 text-sm">📜 Audit Log ล่าสุด</div>
                <button onclick="loadAdminAuditLogs()" class="text-blue-700 text-xs font-bold hover:underline">โหลดใหม่</button>
            </div>
            <div id="adminAuditLogList" class="max-h-72 overflow-y-auto space-y-2"></div>
        </div>`;
    adminPanel.appendChild(panel);
}

async function refreshAdminSecurityPanel() {
    if (!currentUser?.isAdmin || currentUser.code !== '613') return;
    renderAdminSecurityPanel();
    const summaryEl = document.getElementById('adminSecuritySummary');
    if (!summaryEl) return;
    try {
        const response = await fetch('/api/admin/summary', { credentials: 'include' });
        if (!response.ok) throw new Error('ไม่สามารถโหลดสถานะ Admin ได้');
        const data = await response.json();
        const cards = [
            ['👨‍🏫', 'ครูในระบบ', data.teacherCount ?? 0],
            ['📚', 'รายการตารางสอน', data.scheduleCount ?? 0],
            ['📜', 'Audit Logs', data.auditCount ?? 0],
            ['📥', 'Import ล่าสุด', data.latestImport ? (data.latestImport.filename || '-') : 'ยังไม่มี']
        ];
        summaryEl.innerHTML = cards.map(([icon, label, value]) => `
            <div class="bg-gray-50 border border-gray-200 rounded-lg p-3">
                <div class="text-xs text-gray-500">${icon} ${label}</div>
                <div class="font-bold text-gray-800 mt-1 truncate" title="${String(value)}">${String(value)}</div>
            </div>`).join('');
        await loadAdminAuditLogs();
    } catch (error) {
        summaryEl.innerHTML = `<div class="sm:col-span-2 lg:col-span-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">⚠️ ${error.message}</div>`;
    }
}

async function loadAdminAuditLogs() {
    if (!currentUser?.isAdmin) return;
    const list = document.getElementById('adminAuditLogList');
    if (!list) return;
    try {
        const response = await fetch('/api/admin/audit-logs?limit=30', { credentials: 'include' });
        if (!response.ok) throw new Error('โหลด Audit Log ไม่สำเร็จ');
        const data = await response.json();
        if (!Array.isArray(data.logs) || data.logs.length === 0) {
            list.innerHTML = '<div class="text-xs text-gray-400 text-center py-4">ยังไม่มี Audit Log</div>';
            return;
        }
        list.innerHTML = data.logs.map(log => {
            const time = new Date(log.createdAt).toLocaleString('th-TH');
            const detail = log.details && Object.keys(log.details).length ? JSON.stringify(log.details) : '';
            return `<div class="border border-gray-100 rounded-lg p-3 bg-gray-50">
                <div class="flex flex-wrap gap-2 items-center justify-between">
                    <div class="text-xs font-bold text-gray-800">${escapeHtml(log.action)} · ${escapeHtml(log.actorCode)} ${escapeHtml(log.actorName || '')}</div>
                    <div class="text-[10px] text-gray-400">${escapeHtml(time)}</div>
                </div>
                ${detail ? `<div class="text-[10px] text-gray-500 mt-1 break-all">${escapeHtml(detail)}</div>` : ''}
            </div>`;
        }).join('');
    } catch (error) {
        list.innerHTML = `<div class="text-xs text-red-600">⚠️ ${escapeHtml(error.message)}</div>`;
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function clearAllDatabase() {
    if (!requireAdminUI()) return;

    if (!confirm("⚠️ ล้างข้อมูล 'ตารางสอนและรายชื่อครูทั้งหมด' ในฐานข้อมูลกลางใช่หรือไม่?")) {
        return;
    }

    globalTimetableDB = [];
    globalTeachersDB = [{
        code: '613',
        name: currentUser?.name || 'นายนนทพัทธ์ วงค์มูล',
        dept: resolveTeacherDepartment('613')?.id || 900,
        groupCode: resolveTeacherDepartment('613')?.code || 'ACT',
        groupName: resolveTeacherDepartment('613')?.name || '',
        role: 'admin',
        status: '🟢 ว่าง'
    }];

    try {
        await syncAdminStateToServer();
        saveDatabase();
        location.reload();
    } catch (error) {
        alert(`❌ ล้างฐานข้อมูลไม่สำเร็จ\n${error.message}`);
    }
}

// 🔐 Server-side Authentication
async function login(attemptAdmin) {
    const code = attemptAdmin
        ? '613'
        : (document.getElementById('teacherCode')?.value || '').trim();

    if (!code) {
        return alert('กรุณากรอกรหัสประจำตัวครู');
    }

    let adminPin = '';
    if (attemptAdmin) {
        adminPin = (document.getElementById('adminPinInput')?.value || '').trim();
        if (!adminPin) return alert('กรุณากรอกรหัสผ่านผู้ดูแล');
    }

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, admin: attemptAdmin, adminPin })
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) {
            throw new Error(result.error || 'เข้าสู่ระบบไม่สำเร็จ');
        }

        currentUser = result.user;
        currentPermissions = result.user?.permissions || {};
        currentViewedTeacherCode = currentUser.code;
        localStorage.setItem('schoolUser', JSON.stringify(currentUser));

        await loadSharedState();
        showMainApp();

        if (currentUser.isAdmin) {
            const status = await loadAuthStatus();
            if (status.setupRequired) {
                setTimeout(() => {
                    alert(`👑 ยินดีต้อนรับผู้ดูแลระบบ\n\nระบบยังไม่มีบัญชีครูในฐานข้อมูลกลาง กรุณาใช้แผง Admin Dashboard นำเข้า “ตารางรวมครู” จาก SGS เพื่อเริ่มสร้างบัญชีครู`);
                    document.getElementById('adminPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 250);
            }
        }
    } catch (error) {
        alert(`❌ ${error.message}`);
    }
}
async function logout() {
    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });
    } catch (error) {
        console.warn('logout request failed', error);
    }

    localStorage.removeItem('schoolUser');
    currentUser = null;
    currentViewedTeacherCode = null;
    location.reload();
}

function showMainApp() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');

    const roleText = currentUser.isAdmin ? "👑 Admin" : "👤 ครูผู้สอน";
    document.getElementById('userInfoDisplay').innerText = `รหัส: ${currentUser.code} | ${currentUser.name} [${roleText}]`;

    if (currentUser.isAdmin) {
        document.getElementById('adminPanel').classList.remove('hidden');
        populateAdminDropdown();
        renderAdminSecurityPanel();
        refreshAdminSecurityPanel();
    } else {
        document.getElementById('adminPanel').classList.add('hidden');
    }

    renderTimetable();
    populateStudentRooms();
    setupSwapRequestUI();
    refreshSwapRequestUI();
}

function registerTeacher(code, name, schedule = []) {
    code = normalizeTeacherCode(code); name = normalizeTeacherName(name); if (!code) return;
    const resolved = resolveTeacherDepartment(code, schedule); const dept = resolved?.id ?? 900;
    let exists = globalTeachersDB.find(t => normalizeTeacherCode(t.code) === code);
    if (!exists) globalTeachersDB.push({ code, name: name || `ครูรหัส ${code}`, dept, groupCode: resolved?.code || 'ACT', groupName: resolved?.name || '', status:'🟢 ว่าง' });
    else { if(name && (!exists.name||exists.name.startsWith('ครูรหัส')||exists.name.startsWith('TEMP_'))) exists.name=name; exists.dept=dept; exists.groupCode=resolved?.code||'ACT'; exists.groupName=resolved?.name||''; }
    saveDatabase();
}

function populateAdminDropdown() {
    const select = document.getElementById('adminTeacherSelect');
    select.innerHTML = '';
    globalTeachersDB.forEach(t => {
        const option = document.createElement('option');
        option.value = t.code; option.text = `รหัส ${t.code} - ${t.name}`;
        if(t.code === currentViewedTeacherCode) option.selected = true;
        select.appendChild(option);
    });
}

function changeAdminView() {
    currentViewedTeacherCode = document.getElementById('adminTeacherSelect').value;
    renderTimetable();
}

function switchTab(tabId) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('[id^="tab-"]').forEach(el => el.classList.remove('tab-active', 'bg-blue-50', 'text-blue-800'));
    
    document.getElementById(tabId).classList.remove('hidden');
    document.getElementById('tab-' + tabId).classList.add('tab-active', 'bg-blue-50', 'text-blue-800');
    
    if(tabId === 'myTimetableTab') {
        isSmartMatchMode = false; selectedSlotForAction = null;
        document.getElementById('browseTitle').innerText = 'กรุณาเลือกกลุ่มสาระ';
        document.getElementById('teacherListArea').innerHTML = '';
    } else if (tabId === 'studentTab') {
        populateStudentRooms();
    }
}

// ==================== 🛠️ Data Parser Engine ====================
function cleanDayString(dayStr) {
    if (!dayStr) return "";
    let d = String(dayStr).replace(/วัน/g, '').replace(/\s+/g, '').trim();
    if (d === 'จ.' || d.includes('จันทร์')) return 'จันทร์';
    if (d === 'อ.' || d.includes('อังคาร')) return 'อังคาร';
    if (d === 'พ.' || d.includes('พุธ')) return 'พุธ';
    if (d === 'พฤ.' || d.includes('พฤหัส')) return 'พฤหัสบดี';
    if (d === 'ศ.' || d.includes('ศุกร์')) return 'ศุกร์';
    return d;
}

function extractPeriods(periodRaw) {
    let pStr = String(periodRaw).trim();
    if (pStr.includes('-')) {
        let match = pStr.match(/(\d+)\s*-\s*(\d+)/);
        if(match) {
            let arr = [];
            for(let i=parseInt(match[1]); i<=parseInt(match[2]); i++) arr.push(i);
            return arr;
        }
    }
    if (pStr.includes(',')) return pStr.split(',').map(x => parseInt(x.match(/\d+/)?.[0])).filter(x => !isNaN(x));
    let match = pStr.match(/\d+/);
    return match ? [parseInt(match[0])] : [];
}

// 🚀 ยุบโค้ดการอ่าน JSON ให้สั้นลงและเป็นระเบียบ
function normalizeTeacherCode(code) {
    return String(code || '').trim();
}

function normalizeTeacherName(name) {
    return String(name || '')
        .replace(/^คุณครู\s*/, '')
        .replace(/^ครู\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function deterministicTempTeacherCode(name) {
    const normalized = normalizeTeacherName(name);
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
        hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
        hash |= 0;
    }
    return `TEMP_${Math.abs(hash)}`;
}

const SOURCE_PRIORITY = {
    teacher_pdf: 100,
    manual: 90,
    student_pdf_reconciled: 60,
    gemini: 40,
    legacy_txt: 20
};

function getSourcePriority(sourceType) {
    return SOURCE_PRIORITY[sourceType] ?? 0;
}

function normalizeClassNameForMatch(value) {
    let v = String(value || '').trim();
    v = v.replace(/^ม\.\s*/, 'ม.');
    v = v.replace(/\s+/g, '');
    v = v.replace(/^ม\.(\d+)[ก-ฮ]\.?\.?([0-9]+)$/, 'ม.$1$2');
    return v;
}

function teacherMasterMatch(code, name) {
    const cleanCode = normalizeTeacherCode(code);
    const cleanName = normalizeTeacherName(name);
    let teacher = null;

    if (cleanCode) {
        teacher = globalTeachersDB.find(t => normalizeTeacherCode(t.code) === cleanCode) || null;
    }

    if (!teacher && cleanName) {
        teacher = globalTeachersDB.find(t => normalizeTeacherName(t.name) === cleanName) || null;
    }

    if (!teacher) return null;

    // If both code and name exist, require consistency.
    if (cleanCode && cleanName) {
        const masterName = normalizeTeacherName(teacher.name);
        if (masterName && masterName !== cleanName) {
            return null;
        }
    }

    return teacher;
}

function scheduleSlotKey(record) {
    return [
        normalizeTeacherCode(record.teacherCode),
        cleanDayString(record.day),
        parseInt(record.period),
    ].join('|');
}

function annotateRecordSource(record, sourceType) {
    return {
        ...record,
        sourceType: record.sourceType || sourceType,
        sourcePriority: Number.isFinite(record.sourcePriority)
            ? record.sourcePriority
            : getSourcePriority(sourceType),
        verified: record.verified !== false
    };
}


function processScheduleArray(scheduleArray, tCode, levelFallback, tNameFallback) {
    let results = [];
    if (!Array.isArray(scheduleArray)) return results;

    scheduleArray.forEach(s => {
        let periods = extractPeriods(s.period);
        if (periods.length === 0) {
            const one = parseInt(s.period);
            if (!isNaN(one)) periods = [one];
        }

        periods.forEach(p => {
            if (!Number.isInteger(p) || p < 1 || p > 10) return;

            const roomName = String(
                levelFallback || s.class_room || s.level || s.className || ''
            ).trim();

            const teacherName = normalizeTeacherName(
                s.teacher_name || s.teacher || tNameFallback || ''
            );

            const linkedTeacherCode = normalizeTeacherCode(
                s.teacher_id || s.teacherCode || ''
            );

            results.push({
                teacherCode: normalizeTeacherCode(tCode),
                linkedTeacherCode,
                day: cleanDayString(s.day),
                period: p,
                subject: String(s.subject || s.subject_code || '').trim(),
                level: roomName,
                room: String(s.room_number || s.room || '').trim(),
                teacherName,
                raw: String(s.raw || '').trim(),
                source: s.source || null
            });
        });
    });

    return results;
}

function formatIncomingJSON(data, fallbackCode, uploadType) {
    let result = [];

    // ========================================================
    // STUDENT / CLASS SCHEDULE
    // ========================================================
    if (data && Array.isArray(data.classes)) {
        data.classes.forEach(c => {
            const roomName = String(c.class_name || c.room || '').trim();
            if (!Array.isArray(c.schedule)) return;

            const studentRecords = processScheduleArray(
                c.schedule,
                'std_' + roomName,
                roomName,
                ''
            );

            studentRecords.forEach(pData => {
                const studentRecord = annotateRecordSource(
                    {
                        ...pData,
                        verified: true
                    },
                    'student_pdf_reconciled'
                );

                // Always keep the class/student record.
                result.push(studentRecord);

                // Resolve teacher ONLY against the existing Teacher Master.
                // Never create a new teacher from Student PDF.
                const candidateCode = normalizeTeacherCode(pData.linkedTeacherCode);
                const candidateName = normalizeTeacherName(pData.teacherName);
                const matchedTeacher = teacherMasterMatch(candidateCode, candidateName);

                if (matchedTeacher) {
                    result.push(annotateRecordSource({
                        ...pData,
                        teacherCode: normalizeTeacherCode(matchedTeacher.code),
                        teacherName: matchedTeacher.name,
                        verified: true,
                        reconciliation: 'student_pdf_to_teacher_master'
                    }, 'student_pdf_reconciled'));
                }
            });
        });

        return result;
    }

    // ========================================================
    // TEACHER SCHEDULE
    // ========================================================
    if (data && Array.isArray(data.teachers)) {
        data.teachers.forEach(t => {
            const tCode = normalizeTeacherCode(
                t.teacher_id || t.teacherCode || fallbackCode
            );

            const tName = normalizeTeacherName(
                t.teacher_name || t.name || ''
            );

            if (tCode) registerTeacher(tCode, tName, Array.isArray(t.schedule) ? t.schedule : []);

            if (Array.isArray(t.schedule)) {
                result = result.concat(
                    processScheduleArray(
                        t.schedule,
                        tCode,
                        '',
                        tName
                    ).map(r => annotateRecordSource(r, 'teacher_pdf'))
                );
            }
        });

        return result;
    }

    // ========================================================
    // FLAT ARRAY / LEGACY JSON
    // ========================================================
    if (Array.isArray(data)) {
        data.forEach(item => {
            const tCode = normalizeTeacherCode(
                item.teacherCode || item.teacher_id || fallbackCode
            );

            result = result.concat(
                processScheduleArray(
                    [item],
                    tCode,
                    '',
                    item.teacherName || item.teacher_name || ''
                ).map(r => annotateRecordSource(r, 'legacy_txt'))
            );
        });
    }

    return result;
}

function parseOfflineTextTimetable(rawText, fallbackCode) {
    const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let result = []; let currentTeacherCode = fallbackCode; let currentDay = ''; let periodCounter = 1;
    const daysRegex = /^(จ\.|อ\.|พ\.|พฤ\.|ศ\.)/; const teacherIdRegex = /^([1-9]\d{2,3})$/; const subjectRegex = /^([ก-ฮa-zA-Z]{1,2}\d{4,5})/; 

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (teacherIdRegex.test(line)) {
            currentTeacherCode = line.match(teacherIdRegex)[1];
            let teacherName = (lines[i+1] && !daysRegex.test(lines[i+1])) ? lines[i+1].replace(/นาย|นางสาว|นาง|Ms\.|Mr\.|Mrs\./g, '').trim() : "ไม่ทราบชื่อ";
            registerTeacher(currentTeacherCode, teacherName);
            continue;
        }
        let dayMatch = line.match(daysRegex);
        if (dayMatch) { currentDay = cleanDayString(dayMatch[1]); periodCounter = 1; continue; }

        let subMatch = line.match(subjectRegex);
        if (subMatch && currentDay) {
            let subject = subMatch[1];
            let context = lines.slice(Math.max(0, i-2), Math.min(lines.length, i+3)).join(' ');
            let levelMatch = context.match(/(\d\/\d+|ม\.\d\s*[ก-ฮ]\.\d+)/);
            if(periodCounter === 4 || periodCounter === 5) periodCounter++;
            if (periodCounter <= 10) {
                result.push({ teacherCode: currentTeacherCode, day: currentDay, period: periodCounter, subject: subject, level: levelMatch?levelMatch[1]:"", room: "" });
                periodCounter++;
            }
        }
    }
    return result;
}

async function handleFileUpload() {
    if (!requireAdminUI()) return;
    const fileInput = document.getElementById('fileInput');
    const uploadType = document.getElementById('uploadType').value;
    if(fileInput.files.length === 0) return alert("⚠️ กรุณาเลือกไฟล์ก่อนครับ");

    const file = fileInput.files[0];
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith('.json')) {
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                let cleanJsonString = e.target.result.replace(/08\.30-09\.20ฉันไม่สามารถ.*/g, '08.30-09.20" }]} ] }');
                processDataToGlobalDB(formatIncomingJSON(JSON.parse(cleanJsonString), currentViewedTeacherCode, uploadType), uploadType);
                fileInput.value = "";
            } catch (err) { alert("❌ โครงสร้างไฟล์ JSON ไม่ถูกต้อง"); }
        };
        reader.readAsText(file);
        return; 
    }

    if (fileName.endsWith('.txt')) {
        const reader = new FileReader();
        reader.onload = function(e) {
            let formattedData = parseOfflineTextTimetable(e.target.result, currentViewedTeacherCode);
            if(formattedData.length > 0) {
                alert(`⚠️ อ่านไฟล์ TXT ออฟไลน์สำเร็จ!\nระบบอาจจัดเรียงคาบไม่ตรง 100% โปรดใช้ "ลาก-วาง" ขยับคาบให้ตรงอีกครั้งครับ`);
                processDataToGlobalDB(formattedData, uploadType);
            } else alert("❌ ไม่พบข้อมูลตารางสอนในไฟล์นี้");
            fileInput.value = "";
        };
        reader.readAsText(file);
        return;
    }
    simulateAIRead(file, uploadType);
}

async function simulateAIRead(file, uploadType) {
    if (!requireAdminUI()) return;

    const btn = document.querySelector('button[onclick="handleFileUpload()"]');
    const originalText = btn ? btn.innerText : 'อัปโหลดไฟล์';
    if (btn) {
        btn.innerText = '⏳ กำลังอ่านตาราง...';
        btn.disabled = true;
    }

    const formData = new FormData();
    formData.append('timetableFile', file);
    formData.append('uploadType', uploadType);
    formData.append('targetTeacherCode', currentViewedTeacherCode || '');

    const apiUrl = '/api/upload';

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            credentials: 'include',
            body: formData
        });

        const responseText = await response.text();
        let result = {};
        try { result = JSON.parse(responseText); }
        catch { throw new Error(`เซิร์ฟเวอร์ส่งข้อมูลไม่ถูกต้อง (HTTP ${response.status})`); }

        if (!response.ok || !result.success) {
            throw new Error(result.error || `เซิร์ฟเวอร์ตอบ HTTP ${response.status}`);
        }

        if (result.warnings?.length) {
            console.warn('SGS Import warnings:', result.warnings);
        }

        const normalized = formatIncomingJSON(
            result.data,
            currentViewedTeacherCode,
            uploadType
        ).map(record => ({
            ...record,
            datasetId: result.datasetId || '',
            importedAt: new Date().toISOString()
        }));

        processDataToGlobalDB(normalized, uploadType);

        if (currentUser?.isAdmin) {
            await syncAdminStateToServer();
        }

        alert(`✅ นำเข้าตารางสำเร็จ\n\nEngine: ${result.engine || result.source || '-'}\nรายการข้อมูล: ${normalized.length}`);
    } catch (error) {
        console.error('❌ Upload Error:', error);
        alert(`❌ ไม่สามารถนำเข้าตารางได้\n\n${error.message}`);
    } finally {
        renderTimetable();
        populateStudentRooms();
        saveDatabase();
        if (btn) {
            btn.innerText = originalText;
            btn.disabled = false;
        }
        document.getElementById('fileInput').value = '';
    }
}

function dedupeScheduleRecords(records) {
    const seen = new Set();
    const result = [];

    records.forEach(record => {
        const key = [
            record.teacherCode,
            cleanDayString(record.day),
            parseInt(record.period),
            record.level || '',
            record.subject || '',
            record.room || ''
        ].join('|');

        if (!seen.has(key)) {
            seen.add(key);
            result.push(record);
        }
    });

    return result;
}

function processDataToGlobalDB(newDataArray, uploadType) {
    if (!Array.isArray(newDataArray) || newDataArray.length === 0) {
        return alert('❌ ไม่พบข้อมูลในไฟล์ที่นำเข้า');
    }

    newDataArray = newDataArray.map(record => {
        const inferredSource = uploadType === 'all_teachers'
            ? 'teacher_pdf'
            : uploadType === 'all_students'
                ? 'student_pdf_reconciled'
                : 'manual';
        return annotateRecordSource(record, inferredSource);
    });

    newDataArray = dedupeScheduleRecords(newDataArray);

    let stats = {
        incoming: newDataArray.length,
        teacherRecords: 0,
        studentRecords: 0,
        conflicts: 0,
        protected: 0,
        inserted: 0
    };

    if (uploadType === 'all_teachers') {
        // Teacher PDF is the authoritative source for teacher schedules.
        const incomingTeacherCodes = new Set(
            newDataArray
                .map(d => normalizeTeacherCode(d.teacherCode))
                .filter(c => c && !c.startsWith('std_'))
        );

        globalTimetableDB = globalTimetableDB.filter(d => {
            const code = normalizeTeacherCode(d.teacherCode);
            return !incomingTeacherCodes.has(code) || code.startsWith('std_');
        });

        globalTimetableDB.push(...newDataArray);
        stats.teacherRecords = newDataArray.length;
        stats.inserted = newDataArray.length;

        alert(`✅ อัปเดตตารางครูสำเร็จ!\n\n${newDataArray.length} รายการ`);

    } else if (uploadType === 'all_students') {
        // IMPORTANT V7:
        // Never delete or overwrite teacher_pdf records.
        // Replace only the student's own std_ records and reconciled student-derived records.
        globalTimetableDB = globalTimetableDB.filter(d => {
            const source = d.sourceType || '';
            if (String(d.teacherCode || '').startsWith('std_')) return false;
            if (source === 'student_pdf_reconciled') return false;
            return true;
        });

        for (const record of newDataArray) {
            if (String(record.teacherCode || '').startsWith('std_')) {
                stats.studentRecords++;
            } else if (record.sourceType === 'student_pdf_reconciled') {
                stats.teacherRecords++;
            }

            const key = scheduleSlotKey(record);
            const existing = globalTimetableDB.find(d => scheduleSlotKey(d) === key);

            if (existing) {
                const existingPriority = getSourcePriority(existing.sourceType);
                const incomingPriority = getSourcePriority(record.sourceType);

                if (incomingPriority < existingPriority) {
                    stats.protected++;
                    continue;
                }

                if (incomingPriority === existingPriority) {
                    const sameClass =
                        normalizeClassNameForMatch(existing.level) ===
                        normalizeClassNameForMatch(record.level);
                    const sameSubject =
                        String(existing.subject || '').trim() ===
                        String(record.subject || '').trim();

                    if (!sameClass || !sameSubject) {
                        stats.conflicts++;
                        continue;
                    }
                }
            }

            globalTimetableDB.push(record);
            stats.inserted++;
        }

        alert(
            `✅ นำเข้าตารางนักเรียนสำเร็จ!\n\n` +
            `ตารางนักเรียน: ${stats.studentRecords} รายการ\n` +
            `เชื่อมโยงครู: ${stats.teacherRecords} รายการ\n` +
            `ป้องกันการทับข้อมูลครู: ${stats.protected} รายการ\n` +
            `Conflict ที่ไม่เขียนทับ: ${stats.conflicts} รายการ`
        );

    } else {
        // Personal schedule import remains a direct replacement for the current teacher only.
        const currentCode = normalizeTeacherCode(currentViewedTeacherCode);

        globalTimetableDB = globalTimetableDB.filter(
            d => normalizeTeacherCode(d.teacherCode) !== currentCode
        );

        newDataArray.forEach(item => {
            item.teacherCode = currentCode;
            globalTimetableDB.push(annotateRecordSource(item, 'manual'));
        });

        alert('✅ อัปเดตตารางส่วนตัวสำเร็จ');
    }

    saveDatabase();

    if (currentUser && currentUser.isAdmin) {
        populateAdminDropdown();
        syncAdminStateToServer().catch(error => {
            console.error('Central DB sync failed:', error);
            alert(`⚠️ ระบบบันทึกข้อมูลในเครื่องแล้ว แต่ส่งฐานข้อมูลกลางไม่สำเร็จ\n${error.message}`);
        });
    }

    renderTimetable();
    populateStudentRooms();
}

// ==================== 🚀 UI RENDERING (Refactored for Performance) ====================
function renderTimetable() {
    const tbody = document.getElementById('timetableBody');
    let html = '';
    const myData = globalTimetableDB.filter(d => d.teacherCode === currentViewedTeacherCode);
    const tName = globalTeachersDB.find(t => t.code === currentViewedTeacherCode)?.name || '';
    document.getElementById('timetableTitle').innerText = `ตารางสอนของ: ${tName}`;

    days.forEach(day => {
        html += `<tr><td class="border border-gray-200 p-2 text-center font-bold bg-gray-100 text-gray-700">${day}</td>`;
        for (let period = 1; period <= 10; period++) {
            let cData = myData.find(d => d.day === day && parseInt(d.period) === period);
            if (cData) {
                html += `<td data-day="${day}" data-period="${period}" draggable="true" class="border border-gray-200 p-2 text-center text-sm relative h-[80px] hover:bg-gray-50 cursor-pointer transition-colors bg-blue-50 text-blue-900 border-blue-100">
                            <div class="pointer-events-none font-bold text-[14px] leading-tight">${cData.level}</div>
                            <div class="pointer-events-none text-[11px] mt-1 text-gray-500">${cData.subject}</div>
                         </td>`;
            } else {
                html += `<td data-day="${day}" data-period="${period}" class="border border-gray-200 p-2 text-center text-sm relative h-[80px] hover:bg-gray-50 cursor-pointer transition-colors">
                            <span class="pointer-events-none text-gray-300 hover:text-green-500 font-bold text-2xl transition-colors">+</span>
                         </td>`;
            }
        }
        html += `</tr>`;
    });
    tbody.innerHTML = html; // Write to DOM once per render (Fast!)
}

function drawStudentTimetable() {
    const room = document.getElementById('studentRoomSelect').value;
    const tbody = document.getElementById('studentTimetableBody');
    if(!room) { tbody.innerHTML = '<tr><td colspan="11" class="p-8 text-center text-gray-400">กรุณาเลือกห้องเรียนจากเมนูด้านบน</td></tr>'; return; }

    const roomData = globalTimetableDB.filter(d => d.level === room && d.teacherCode.startsWith('std_'));
    let html = '';

    days.forEach(day => {
        html += `<tr><td class="border border-indigo-100 p-2 text-center font-bold bg-indigo-50 text-indigo-800">${day}</td>`;
        for (let period = 1; period <= 10; period++) {
            let classData = roomData.find(d => d.day === day && parseInt(d.period) === period);
            if (classData) {
                let tName = classData.teacherName || globalTeachersDB.find(t => t.code === classData.teacherCode)?.name || '';
                if(tName) tName = `<div class="text-[9px] text-gray-500 mt-1 truncate">ครู${tName.split(' ')[0]}</div>`;
                html += `<td class="border border-gray-200 p-2 text-center text-sm relative h-[80px] hover:bg-gray-50 transition-colors bg-white text-gray-800">
                            <div class="font-bold text-[13px] text-indigo-700">${classData.subject}</div>${tName}
                         </td>`;
            } else { html += `<td class="border border-gray-200 p-2 text-center text-sm relative h-[80px] hover:bg-gray-50 transition-colors"><span class="text-gray-200">-</span></td>`; }
        }
        html += `</tr>`;
    });
    tbody.innerHTML = html;
}

function openActionModal(day, period, data) {
    selectedSlotForAction = { day, period, data };
    document.getElementById('modalTitle').innerText = `วัน${day} คาบ ${period}`;
    document.getElementById('modalDetail').innerText = `ห้อง: ${data.level} | วิชา: ${data.subject}`;
    document.getElementById('absenceDateInput').value = '';
    document.getElementById('actionModal').classList.remove('hidden');
}

function openAddSlotModal(day, period) {
    selectedSlotForAction = { day, period };
    document.getElementById('addSubject').value = ''; document.getElementById('addLevel').value = '';
    document.getElementById('addSlotModal').classList.remove('hidden');
}

function confirmAddSlot() {
    globalTimetableDB.push({ teacherCode: currentViewedTeacherCode, day: selectedSlotForAction.day, period: selectedSlotForAction.period, subject: document.getElementById('addSubject').value, level: document.getElementById('addLevel').value, room: document.getElementById('addRoom').value });
    saveDatabase(); document.getElementById('addSlotModal').classList.add('hidden'); renderTimetable(); populateStudentRooms();
}

function editSlot() {
    const newVal = prompt("แก้ไขระดับชั้น/วิชา:", selectedSlotForAction.data.level);
    if(newVal) {
        let idx = globalTimetableDB.findIndex(d => d.teacherCode === currentViewedTeacherCode && d.day === selectedSlotForAction.day && parseInt(d.period) === selectedSlotForAction.period);
        if(idx !== -1) { globalTimetableDB[idx].level = newVal; saveDatabase(); renderTimetable(); populateStudentRooms(); }
        document.getElementById('actionModal').classList.add('hidden');
    }
}

function deleteSlot() {
    if (!currentUser.isAdmin) {
        const pass = prompt(`ใส่รหัสครู (${currentViewedTeacherCode}) เพื่อยืนยันการลบ:`);
        if (pass !== currentViewedTeacherCode) return alert("รหัสไม่ถูกต้อง ยกเลิกการลบ");
    }
    globalTimetableDB = globalTimetableDB.filter(d => !(d.teacherCode === currentViewedTeacherCode && d.day === selectedSlotForAction.day && parseInt(d.period) === selectedSlotForAction.period));
    saveDatabase(); document.getElementById('actionModal').classList.add('hidden'); renderTimetable(); populateStudentRooms();
}

function populateStudentRooms() {
    const select = document.getElementById('studentRoomSelect');
    let currentVal = select.value;
    select.innerHTML = '<option value="">-- เลือกห้องเรียน --</option>';
    let rooms = [...new Set(globalTimetableDB.filter(d => d.teacherCode.startsWith('std_')).map(d => d.level))];
    rooms.sort((a, b) => a.localeCompare(b, 'th', {numeric: true}));
    rooms.forEach(r => {
        let opt = document.createElement('option'); opt.value = r; opt.text = r;
        if(r === currentVal) opt.selected = true; select.appendChild(opt);
    });
    drawStudentTimetable();
}

// ==================== 🧠 SMART MATCH ENGINE ====================
function evaluateSwapScore(targetTeacherCode, targetData, mySlot, myData) {
    let myRoom = mySlot.data.level; let myGrade = extractGradeLevel(myRoom); let myDay = mySlot.day; let myPeriod = parseInt(mySlot.period);
    if (!(!targetData.some(d => d.day === myDay && parseInt(d.period) === myPeriod))) return { score: 0, text: "เป้าหมายมีสอน", type: "unavailable", returnSlots: [] };

    let perfectReturnSlots = []; let timeReturnSlots = [];    
    targetData.forEach(tSlot => {
        if(!myData.some(d => d.day === tSlot.day && parseInt(d.period) === parseInt(tSlot.period))) {
            let slotInfo = { ...tSlot, studentWarning: checkStudentFatigueForReturnSlot(mySlot.data.subject, tSlot.day, parseInt(tSlot.period), tSlot.level) };
            if (tSlot.level === myRoom) perfectReturnSlots.push(slotInfo); 
            else timeReturnSlots.push(slotInfo); 
        }
    });

    if (targetData.some(d => d.day === myDay && d.level === myRoom && (parseInt(d.period) === myPeriod - 1 || parseInt(d.period) === myPeriod + 1)) && perfectReturnSlots.length > 0) 
        return { score: 100, text: `🥇 แลกคาบสอนควบ (ห้อง ${myRoom})`, type: "perfect_swap", returnSlots: perfectReturnSlots };
    if (targetData.some(d => d.day === myDay && d.level === myRoom) && perfectReturnSlots.length > 0) 
        return { score: 95, text: `🥇 แลกคาบวันเดียวกัน (ห้อง ${myRoom})`, type: "perfect_swap", returnSlots: perfectReturnSlots };
    if (perfectReturnSlots.length > 0) return { score: 90, text: `🥇 แลกคาบสมบูรณ์ (ห้อง ${myRoom})`, type: "perfect_swap", returnSlots: perfectReturnSlots };

    if (timeReturnSlots.length > 0) {
        if (targetData.some(d => extractGradeLevel(d.level) === myGrade)) return { score: 85, text: `🥈 แลกเวลาว่าง (สอนชั้น ม.${myGrade})`, type: "time_swap", returnSlots: timeReturnSlots };
        return { score: 80, text: `🥈 แลกเวลาว่าง (ต่างห้อง)`, type: "time_swap", returnSlots: timeReturnSlots };
    }

    let myDept = globalTeachersDB.find(t=> t.code === currentViewedTeacherCode)?.dept || 0;
    let targetDept = globalTeachersDB.find(t=> t.code === targetTeacherCode)?.dept || 0;
    if (myDept !== 0 && myDept === targetDept) return { score: 75, text: `🥉 ฝากสอนแทน (หมวดเดียวกัน)`, type: "one_way", returnSlots: [] };
    return { score: 60, text: `🥉 ฝากสอนแทน (ครูต่างหมวด)`, type: "one_way", returnSlots: [] };
}

function startSmartMatch() {
    const dateInput = document.getElementById('absenceDateInput');
    if(!dateInput.value) return alert("⚠️ กรุณาระบุวันที่ต้องการลา/แลกคาบ ก่อนครับ");
    selectedAbsenceDateObj = new Date(dateInput.value);
    isSmartMatchMode = true; document.getElementById('actionModal').classList.add('hidden'); switchTab('browseTab');
    document.getElementById('badgeSwapMode').classList.remove('hidden'); document.getElementById('normalBrowseBanner').classList.add('hidden'); document.getElementById('swapTargetBanner').classList.remove('hidden');
    document.getElementById('swapTargetText').innerHTML = `ลาวันที่ ${formatThaiDateFull(selectedAbsenceDateObj)} <br>วัน<span class="font-bold text-blue-600">${selectedSlotForAction.day}</span> คาบ <span class="font-bold text-blue-600">${selectedSlotForAction.period}</span> (ชั้น ${selectedSlotForAction.data.level})`;
    renderDepartments(); showTeachersInDept(0, '✨ แนะนำที่ดีที่สุด (AI Smart Match)');
}

function renderDepartments() {
    const ul = document.getElementById('departmentList'); ul.innerHTML = '';
    if(isSmartMatchMode) ul.innerHTML += `<li onclick="showTeachersInDept(0, '✨ แนะนำที่ดีที่สุด (AI Smart Match)')" class="p-3 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg cursor-pointer hover:shadow-md font-bold text-blue-800 mb-3 transition-all">✨ แนะนำที่ดีที่สุด</li>`;
    let presentDepts = [...new Set(globalTeachersDB.map(t => t.dept))].sort();
    presentDepts.forEach(deptId => {
        let dName = mockDepartments.find(d => d.id === deptId)?.name || `หมวดหมู่รหัส ${deptId}`;
        ul.innerHTML += `<li onclick="showTeachersInDept(${deptId}, '${dName}')" class="p-2.5 bg-gray-50 border border-gray-200 rounded-lg cursor-pointer hover:bg-blue-50 hover:border-blue-300 text-gray-700 transition-colors mb-2">${dName}</li>`;
    });
}

function showTeachersInDept(deptId, deptName) {
    document.getElementById('browseTitle').innerText = `รายชื่อครู: ${deptName}`;
    const listArea = document.getElementById('teacherListArea'); listArea.innerHTML = '';
    let teachersToShow = []; const myData = globalTimetableDB.filter(d => d.teacherCode === currentViewedTeacherCode);

    if (deptId === 0 && isSmartMatchMode) {
        globalTeachersDB.forEach(t => {
            if(t.code === currentViewedTeacherCode) return;
            const targetData = globalTimetableDB.filter(d => d.teacherCode === t.code);
            const evalResult = evaluateSwapScore(t.code, targetData, selectedSlotForAction, myData);
            if(evalResult.score > 0) teachersToShow.push({ teacher: t, eval: evalResult });
        });
        teachersToShow.sort((a, b) => b.eval.score - a.eval.score);
    } else {
        let teachers = globalTeachersDB.filter(t => t.dept === deptId && t.code !== currentViewedTeacherCode);
        teachersToShow = teachers.map(t => {
            let evalRes = { score: 0, text: "" };
            if (isSmartMatchMode && selectedSlotForAction) evalRes = evaluateSwapScore(t.code, globalTimetableDB.filter(d => d.teacherCode === t.code), selectedSlotForAction, myData);
            return { teacher: t, eval: evalRes };
        });
    }

    if(teachersToShow.length === 0) return listArea.innerHTML = '<div class="col-span-2 text-gray-500 bg-gray-50 p-4 rounded text-center border">ไม่พบผู้สอนแทนที่เหมาะสม หรือไม่มีครูในหมวดหมู่นี้</div>';

    teachersToShow.forEach(item => {
        let btnClass = item.eval.score >= 90 ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700';
        let badgeHtml = !isSmartMatchMode || !selectedSlotForAction ? '' : 
            item.eval.score === 0 ? `<span class="bg-red-50 text-red-700 text-xs px-2.5 py-1 rounded border border-red-200">❌ มีสอนคาบนี้</span>` :
            item.eval.score >= 90 ? `<span class="bg-green-100 text-green-800 text-xs px-2.5 py-1 rounded border border-green-300 font-bold shadow-sm">🎯 ${item.eval.text}</span>` :
            item.eval.score >= 80 ? `<span class="bg-blue-50 text-blue-700 text-xs px-2.5 py-1 rounded border border-blue-200 font-medium">⭐ ${item.eval.text}</span>` :
            `<span class="bg-gray-100 text-gray-600 text-xs px-2.5 py-1 rounded border border-gray-200">${item.eval.text}</span>`;
            
        let buttonHtml = isSmartMatchMode && selectedSlotForAction 
            ? `<button onclick="openComparisonModal('${item.teacher.code}', '${item.teacher.name}', ${item.teacher.dept})" class="mt-4 ${btnClass} text-white text-xs px-3 py-2.5 rounded-lg font-bold shadow-sm transition-transform transform hover:scale-[1.02] w-full">🔄 วิเคราะห์และจัดการแลกคาบ</button>`
            : `<button onclick="viewNormalTimetable('${item.teacher.code}', '${item.teacher.name}')" class="mt-4 bg-gray-600 text-white text-xs px-3 py-2.5 rounded-lg font-bold shadow-sm hover:bg-gray-700 transition-colors w-full">👀 ขอดูตารางสอน 10 คาบ</button>`;
        
        listArea.innerHTML += `<div class="border border-gray-200 p-5 rounded-xl bg-white shadow-sm flex flex-col justify-between hover:border-blue-400 hover:shadow-md transition-all">
                                <div><div class="font-bold text-gray-800 text-base">${item.teacher.name} <span class="text-[10px] text-gray-400 ml-1">(${item.teacher.code})</span></div><div class="mt-3">${badgeHtml}</div></div>${buttonHtml}</div>`;
    });
}

function viewNormalTimetable(teacherCode, teacherName) {
    document.getElementById('comparisonModalTitle').innerText = `ตารางสอนของ ${teacherName}`;
    document.getElementById('smartMatchHeaderBox').classList.add('hidden'); document.getElementById('actionMessageContainer').classList.add('hidden'); document.getElementById('myTableContainer').classList.add('hidden');
    document.getElementById('targetTableContainer').className = 'w-full'; document.getElementById('compareTargetNameTitle').innerText = teacherName;
    drawTargetMiniTable(teacherCode, false); document.getElementById('comparisonModal').classList.remove('hidden');
}

function openComparisonModal(teacherCode, teacherName, deptId) {
    document.getElementById('comparisonModalTitle').innerText = `วิเคราะห์การแลกคาบ (Priority Smart Match)`;
    document.getElementById('smartMatchHeaderBox').classList.remove('hidden'); document.getElementById('myTableContainer').classList.remove('hidden'); document.getElementById('actionMessageContainer').classList.remove('hidden');
    document.getElementById('targetTableContainer').className = 'w-1/2 min-w-[600px]';
    currentViewedTeacherForSwap = { code: teacherCode, name: teacherName, dept: deptId };
    document.getElementById('compareTargetDetails').innerText = `วัน${selectedSlotForAction.day} คาบ ${selectedSlotForAction.period} (ชั้น ${selectedSlotForAction.data.level})`;
    document.getElementById('compareTeacherName').innerText = teacherName; document.getElementById('compareTargetNameTitle').innerText = teacherName;
    document.querySelector('input[value="swap"]').checked = true;
    drawMyMiniTable(); drawTargetMiniTable(teacherCode, true); toggleActionType(); document.getElementById('comparisonModal').classList.remove('hidden');
}

function drawMyMiniTable() {
    const tbody = document.getElementById('compareMyTable'); let html = ''; const myData = globalTimetableDB.filter(d => d.teacherCode === currentViewedTeacherCode);
    days.forEach(day => {
        html += `<tr><td class="border border-gray-300 p-1 text-center font-bold bg-gray-100 text-gray-700">${day.substring(0,1)}.</td>`;
        for (let period = 1; period <= 10; period++) {
            if(day === selectedSlotForAction.day && period === parseInt(selectedSlotForAction.period)) html += `<td class="border border-gray-200 p-1 text-center text-[10px] h-[30px] bg-blue-100 border-blue-400 pulse-border"><div class="font-bold text-blue-800">คาบนี้</div></td>`;
            else {
                let c = myData.find(d => d.day === day && parseInt(d.period) === period);
                html += `<td class="border border-gray-200 p-1 text-center text-[10px] h-[30px] ${c?'bg-gray-50 text-gray-600':''}">${c?c.level:'-'}</td>`;
            }
        } html += `</tr>`;
    }); tbody.innerHTML = html;
}

function drawTargetMiniTable(targetTeacherCode, isMatchMode) {
    const tbody = document.getElementById('compareTargetTable'); let html = '';
    const targetData = globalTimetableDB.filter(d => d.teacherCode === targetTeacherCode);
    const myData = globalTimetableDB.filter(d => d.teacherCode === currentViewedTeacherCode);

    if(isMatchMode) currentSwapEvaluation = evaluateSwapScore(targetTeacherCode, targetData, selectedSlotForAction, myData);
    
    days.forEach(day => {
        html += `<tr><td class="border border-indigo-200 p-1 text-center font-bold bg-indigo-50 text-indigo-900">${day.substring(0,1)}.</td>`;
        for (let period = 1; period <= 10; period++) {
            let isBreak = (period === 4 || period === 5); let classData = targetData.find(d => d.day === day && parseInt(d.period) === period);
            let hasClass = !!classData; let tdClass = 'border border-gray-200 p-1 text-center text-[10px] h-[30px] relative transition-all';
            let tdContent = '-';

            if (isMatchMode && day === selectedSlotForAction.day && period === parseInt(selectedSlotForAction.period)) {
                tdClass += hasClass ? ' bg-red-500 text-white font-bold border-red-600' : (currentSwapEvaluation.score >= 90 ? ' bg-green-500 text-white font-bold border-green-600 shadow-inner' : ' bg-blue-500 text-white font-bold border-green-600 shadow-inner');
                tdContent = hasClass ? `มีสอน!<br>แลกไม่ได้` : `ว่าง<br>✅`;
            } else if (isBreak) { tdClass += ' bg-gray-50 text-gray-400'; tdContent = 'พัก';
            } else if (hasClass) {
                let isReturn = currentSwapEvaluation?.returnSlots?.some(rs => rs.day === day && parseInt(rs.period) === period);
                if (isReturn && isMatchMode) tdClass += ' bg-yellow-100 text-yellow-800 font-bold border-yellow-400 pulse-border-yellow cursor-pointer';
                else tdClass += ' bg-red-50 text-red-500';
                tdContent = classData.level; 
            } else if (!isMatchMode) { tdClass += ' bg-green-50 text-green-600'; tdContent = 'ว่าง'; }
            
            html += `<td class="${tdClass}">${tdContent}</td>`;
        } html += `</tr>`;
    }); tbody.innerHTML = html;
}

function toggleActionType() {
    const isSub = document.querySelector('input[name="actionType"]:checked').value === 'sub';
    const returnBox = document.getElementById('returnSlotSelectionArea'); const returnSelectContainer = document.getElementById('returnSlotOptionsContainer');
    const btnProceed = document.getElementById('btnProceedSwap'); const title = document.getElementById('actionMessageTitle');

    if (isSub) {
        if(!confirm("⚠️ คำเตือน: คุณกำลังเลือก 'ฝากคาบ'\n\nการฝากคาบหมายถึงคุณจะไม่ไปสอนคืนในรายวิชาของคุณ ซึ่งอาจทำให้ผู้เรียนเสียผลประโยชน์\n\nคุณยืนยันที่จะฝากคาบใช่หรือไม่?")) {
            document.querySelector('input[value="swap"]').checked = true; return toggleActionType(); 
        }
        returnBox.classList.add('hidden'); btnProceed.innerText = "ดำเนินการฝากคาบ ➡️"; btnProceed.className = "w-full sm:w-2/3 bg-red-600 hover:bg-red-700 text-white px-5 py-3 rounded-xl font-bold shadow-md transition-transform transform hover:scale-[1.02] text-lg";
        title.innerText = "✅ ผลการประเมิน: ฝากคาบ (ไม่สอนคืน)"; currentSwapEvaluation.type = "one_way"; currentSwapEvaluation.text = "ฝากคาบ (ไม่สอนคืน)";
    } else {
        btnProceed.innerText = "ดำเนินการแลกคาบ ➡️"; btnProceed.className = "w-full sm:w-2/3 bg-blue-600 hover:bg-blue-700 text-white px-5 py-3 rounded-xl font-bold shadow-md transition-transform transform hover:scale-[1.02] text-lg";
        currentSwapEvaluation = evaluateSwapScore(currentViewedTeacherForSwap.code, globalTimetableDB.filter(d => d.teacherCode === currentViewedTeacherForSwap.code), selectedSlotForAction, globalTimetableDB.filter(d => d.teacherCode === currentViewedTeacherCode));
        title.innerText = `✅ แนะนำ: ${currentSwapEvaluation.text}`;

        if(currentSwapEvaluation.returnSlots && currentSwapEvaluation.returnSlots.length > 0) {
            returnBox.classList.remove('hidden'); returnSelectContainer.innerHTML = '';
            currentSwapEvaluation.returnSlots.forEach((rs, idx) => {
                const nextReturnDate = getNextTargetDate(selectedAbsenceDateObj, rs.day);
                let fDate = formatThaiDateFull(nextReturnDate);
                let safeReturn = {
                    day: rs.day || '',
                    period: Number(rs.period),
                    date: fDate,
                    isoDate: nextReturnDate.toISOString().slice(0, 10),
                    level: rs.level || '',
                    subject: rs.subject || '',
                    room: rs.room || ''
                };
                let wHtml = rs.studentWarning ? `<div class="text-[10px] text-red-500 mt-1 font-bold">${rs.studentWarning}</div>` : `<div class="text-[10px] text-green-600 mt-1">✅ ตารางนักเรียนเหมาะสม</div>`;
                let card = document.createElement('label'); card.className = `flex items-start gap-3 p-3 border border-gray-300 rounded-lg cursor-pointer hover:bg-blue-50 transition-colors bg-white`;
                card.innerHTML = `<input type="radio" name="returnSlotChoice" value='${escapeHtmlClient(JSON.stringify(safeReturn))}' ${idx===0?'checked':''} class="mt-1 w-4 h-4 text-blue-600">
                                  <div><div class="font-bold text-sm text-blue-900">วัน${rs.day} คาบ ${rs.period} <span class="text-xs text-gray-500 ml-1">(${fDate})</span></div>
                                  <div class="text-xs text-gray-600 mt-0.5">ไปสอนห้อง ${rs.level} คืนให้ ${currentViewedTeacherForSwap.name}</div>${wHtml}</div>`;
                card.querySelector('input').addEventListener('change', generateLineMessage); returnSelectContainer.appendChild(card);
            });
        } else { returnBox.classList.add('hidden'); title.innerText = `⚠️ ไม่พบคาบว่างตรงกันสำหรับสอนคืน (บังคับฝากคาบ)`; }
    } generateLineMessage();
}

function generateLineMessage() {
    let msg = ""; let room = selectedSlotForAction.data.level; let day = selectedSlotForAction.day; let period = selectedSlotForAction.period; let absDate = formatThaiDateFull(selectedAbsenceDateObj);
    let retDate = "";
    if (currentSwapEvaluation.type !== "one_way" && currentSwapEvaluation.returnSlots && currentSwapEvaluation.returnSlots.length > 0) {
        let selOpt = document.querySelector('input[name="returnSlotChoice"]:checked');
        if(selOpt) { let rs = JSON.parse(selOpt.value); retDate = ` วัน${rs.day} คาบ ${rs.period} (วันที่ ${rs.date})`; }
    }
    if (currentSwapEvaluation.type === "one_way") msg = `สวัสดีครับ ${currentViewedTeacherForSwap.name} ผม${currentUser.name}ครับ\nรบกวนฝากคาบสอนหน่อยครับ วัน${day} ที่ ${absDate} คาบ ${period} ชั้น ${room} พอจะสะดวกคุมห้องแทนให้ผมไหมครับ พอดีผมติดธุระครับ ขอบคุณครับ 🙏`;
    else if (currentSwapEvaluation.type === "perfect_swap" || currentSwapEvaluation.type === "time_swap" || currentSwapEvaluation.type === "adjacent_same_room") msg = `สวัสดีครับ ${currentViewedTeacherForSwap.name} ผม${currentUser.name}ครับ\nรบกวนสอบถามครับ วัน${day} ที่ ${absDate} คาบ ${period} พอจะสะดวกสลับคาบสอนห้อง ${room} ให้ผมได้ไหมครับ พอดีผมติดธุระครับ\n\nแล้วเดี๋ยวผมไปสอนคืนให้ใน${retDate} ครับ 🙏`;
    else msg = `สวัสดีครับ ${currentViewedTeacherForSwap.name} ผม${currentUser.name}ครับ\nรบกวนฝากคาบสอนหน่อยครับ วัน${day} ที่ ${absDate} คาบ ${period} ชั้น ${room} พี่พอจะสะดวกสอนแทนให้ผมไหมครับ พอดีผมติดธุระครับ ขอบคุณครับ 🙏`;
    document.getElementById('lineMessageText').value = msg;
}

function copyLineMessage() {
    document.getElementById('lineMessageText').select(); document.execCommand("copy"); alert("คัดลอกข้อความสำเร็จ! นำไปวางใน LINE ได้เลยครับ");
}


function prepareReplacementFormFromCurrentSelection() {
    if (!currentUser || !selectedSlotForAction || !currentViewedTeacherForSwap || !currentSwapEvaluation) return null;
    const isOneWay = currentSwapEvaluation.type === 'one_way';
    let returnInfo = null;
    if (!isOneWay && currentSwapEvaluation.returnSlots?.length > 0) {
        const selOpt = document.querySelector('input[name="returnSlotChoice"]:checked');
        if (selOpt) {
            try { returnInfo = JSON.parse(selOpt.value); } catch (_) { returnInfo = null; }
        }
    }
    const absenceDate = document.getElementById('absenceDateInput')?.value || selectedAbsenceDateObj?.toISOString().slice(0, 10) || '';
    currentReplacementFormData = buildReplacementFormData({
        requestId: '',
        actionType: isOneWay ? 'one_way' : 'swap',
        absenceDate,
        originalDay: selectedSlotForAction.day,
        originalPeriod: Number(selectedSlotForAction.period),
        originalSubject: selectedSlotForAction.data?.subject || '',
        originalLevel: selectedSlotForAction.data?.level || '',
        originalRoom: selectedSlotForAction.data?.room || '',
        requesterCode: currentUser.code,
        requesterName: currentUser.name,
        targetCode: currentViewedTeacherForSwap.code,
        targetName: currentViewedTeacherForSwap.name,
        returnInfo
    });
    return currentReplacementFormData;
}

function injectConfirmationPrintButton() {
    const modal = document.getElementById('confirmationModal');
    if (!modal) return;
    const existing = document.getElementById('printReplacementFormBtnConfirm');
    if (existing) existing.remove();
    const actionRow = modal.querySelector('button[onclick="submitFinalSwap()"]')?.parentElement;
    if (!actionRow) return;
    const btn = document.createElement('button');
    btn.id = 'printReplacementFormBtnConfirm';
    btn.type = 'button';
    btn.className = 'w-full mt-3 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl font-bold shadow-md';
    btn.innerText = '🖨️ พิมพ์ใบ วก.11 ก่อนบันทึกคำขอ';
    btn.addEventListener('click', openReplacementFormPrintPreview);
    actionRow.parentElement.appendChild(btn);
}

function openFinalConfirmation() {
    prepareReplacementFormFromCurrentSelection();
    document.getElementById('comparisonModal').classList.add('hidden');
    document.getElementById('confMyName').innerText = currentUser.name; document.getElementById('confTargetName').innerText = currentViewedTeacherForSwap.name;
    document.getElementById('confDate').innerText = `${formatThaiDateFull(selectedAbsenceDateObj)} (คาบ ${selectedSlotForAction.period})`; document.getElementById('confSwapType').innerText = currentSwapEvaluation.text;
    if(currentSwapEvaluation.type !== "one_way" && currentSwapEvaluation.returnSlots?.length > 0) {
        let selOpt = document.querySelector('input[name="returnSlotChoice"]:checked');
        if(selOpt) {
            let rs = JSON.parse(selOpt.value); document.getElementById('confReturnDate').innerText = `วัน${rs.day} คาบ ${rs.period} (${rs.date})`;
            document.getElementById('confReturnContainer').className = "flex justify-between items-center bg-green-50 p-3 rounded-lg border border-green-200";
            document.getElementById('confReturnDate').className = "font-bold text-green-700 text-right";
        }
    } else {
        document.getElementById('confReturnDate').innerText = "ไม่มี (ฝากสอน)";
        document.getElementById('confReturnContainer').className = "flex justify-between items-center bg-red-50 p-3 rounded-lg border border-red-200";
        document.getElementById('confReturnDate').className = "font-bold text-red-600 text-right";
    }
    const confirmTitle = document.querySelector('#confirmationModal h3');
    if (confirmTitle) confirmTitle.innerText = '📝 ยืนยันการบันทึกคำขอแลกคาบ';
    const confirmButton = document.querySelector('#confirmationModal button[onclick="submitFinalSwap()"]');
    if (confirmButton) confirmButton.innerText = '💾 บันทึกคำขอไว้ก่อน';
    document.getElementById('confirmationModal').classList.remove('hidden');
}

async function submitFinalSwap() {
    if (!currentUser || !selectedSlotForAction || !currentViewedTeacherForSwap || !currentSwapEvaluation) {
        return alert('❌ ข้อมูลคำขอแลกคาบไม่ครบ');
    }

    const isOneWay = currentSwapEvaluation.type === 'one_way';
    let returnInfo = null;

    if (!isOneWay && currentSwapEvaluation.returnSlots?.length > 0) {
        const selOpt = document.querySelector('input[name="returnSlotChoice"]:checked');
        if (!selOpt) return alert('⚠️ กรุณาเลือกคาบที่จะสอนคืน');
        returnInfo = JSON.parse(selOpt.value);
    }

    try {
        const payload = {
            targetCode: currentViewedTeacherForSwap.code,
            absenceDate: document.getElementById('absenceDateInput')?.value || selectedAbsenceDateObj?.toISOString().slice(0, 10) || '',
            originalDay: selectedSlotForAction.day,
            originalPeriod: Number(selectedSlotForAction.period),
            originalSubject: selectedSlotForAction.data?.subject || '',
            originalLevel: selectedSlotForAction.data?.level || '',
            originalRoom: selectedSlotForAction.data?.room || '',
            actionType: isOneWay ? 'one_way' : 'swap',
            returnDay: returnInfo?.day || '',
            returnPeriod: returnInfo?.period ?? null,
            returnSubject: returnInfo?.subject || '',
            returnLevel: returnInfo?.level || '',
            returnRoom: returnInfo?.room || '',
            note: currentSwapEvaluation.text || ''
        };

        const response = await fetch('/api/swap-requests', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json().catch(() => ({}));
        console.log('📥 Swap request response:', result);
        if (!response.ok || !result.success) {
            const detail = result.error || `เซิร์ฟเวอร์ตอบกลับ HTTP ${response.status}`;
            throw new Error(detail);
        }

        if (Array.isArray(result.warnings) && result.warnings.length) {
            console.warn('⚠️ Swap request warnings:', result.warnings);
        }

        document.getElementById('confirmationModal').classList.add('hidden');

        const successTitle = document.querySelector('#successModal h3');
        if (successTitle) successTitle.innerText = 'บันทึกคำขอแลกคาบเรียบร้อย';
        const successText = document.querySelector('#successModal p');
        if (successText) successText.innerText = 'ระบบบันทึกรายการไว้ในรายการคำขอของคุณแล้ว ยังไม่มีการเปลี่ยนแปลงตารางสอนจริง คุณสามารถรวบรวมหลายรายการแล้วพิมพ์ใบ วก.11 จากหน้าตารางสอนของฉันได้';

        document.getElementById('pdfMyName').innerText = currentUser.name;
        document.getElementById('pdfTargetName').innerText = currentViewedTeacherForSwap.name;
        document.getElementById('pdfDate').innerText = formatThaiDateFull(selectedAbsenceDateObj);
        document.getElementById('pdfReturnDate').innerText = isOneWay ? 'ไม่มี (ฝากคาบ)' : (document.getElementById('confReturnDate')?.innerText || '-');

        const successCloseBtn = document.querySelector('#successModal button[onclick="closeAllModals()"]');
        if (successCloseBtn) successCloseBtn.innerText = 'กลับสู่ตารางของฉัน';

        let successPrintBtn = document.getElementById('successModalPrintBtn');
        if (!successPrintBtn) {
            successPrintBtn = document.createElement('button');
            successPrintBtn.id = 'successModalPrintBtn';
            successPrintBtn.className = 'bg-indigo-600 text-white font-bold py-3.5 px-8 rounded-xl shadow-lg hover:bg-indigo-700 transition-colors w-full sm:w-auto';
            successCloseBtn?.parentElement?.insertBefore(successPrintBtn, successCloseBtn);
        }
        successPrintBtn.innerText = '🖨️ พิมพ์ใบ วก.11 รายการนี้';

        document.getElementById('successModal').classList.remove('hidden');

        // เก็บคำขอที่เพิ่งสร้างลง local draft ทันที และใช้ข้อมูลจาก response โดยตรงสำหรับการพิมพ์
        if (result.request) {
            mergeSavedSwapRequestIntoUI(result.request);
            const savedRequestId = String(result.request.id);
            const successPrintBtn = document.getElementById('successModalPrintBtn');
            if (successPrintBtn) successPrintBtn.onclick = () => openReplacementFormPrintPreview([requestToReplacementFormData(result.request)]);
        }

        // โหลดจาก server แบบ background เท่านั้น ไม่ให้ลบรายการที่เพิ่งเพิ่มถ้า endpoint ตอบช้า/ผิดพลาด
        refreshSwapRequestUI().catch(err => console.warn('⚠️ Background swap request refresh failed:', err));
    } catch (error) {
        console.error('❌ submitFinalSwap failed:', error);
        alert(`❌ ไม่สามารถสร้างคำขอแลกคาบได้\n\n${error.message}`);
    }
}


// ============================================================
// 🖨️ V10.17 - OFFICIAL REPLACEMENT FORM GENERATOR
// อ้างอิงโครงสร้างแบบฟอร์ม วก.11 ของโรงเรียนสรรพวิทยาคม
// ============================================================

function getDepartmentGroupName(codeOrDept) {
    if (codeOrDept == null || codeOrDept === '') return '';
    const numeric = Number.parseInt(String(codeOrDept).replace(/\D/g, ''), 10);
    if (Number.isFinite(numeric) && departmentRules.groups.some(g => g.id === numeric)) return departmentRules.groups.find(g=>g.id===numeric)?.name||'';
    return getTeacherDepartmentName(codeOrDept);
}

function toThaiDateParts(dateValue) {
    if (!dateValue) return { day: '', month: '', year: '' };
    const d = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(d.getTime())) return { day: '', month: '', year: '' };
    const months = [
        'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
        'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'
    ];
    return {
        day: d.getDate(),
        month: months[d.getMonth()],
        year: d.getFullYear() + 543
    };
}

function buildReplacementFormData({
    requestId = '', actionType = 'swap', absenceDate = '',
    originalDay = '', originalPeriod = '', originalSubject = '',
    originalLevel = '', originalRoom = '', requesterCode = '',
    requesterName = '', targetCode = '', targetName = '', returnInfo = null, formMeta = null
}) {
    const originalDate = toThaiDateParts(absenceDate);
    return {
        requestId,
        actionType,
        createdDate: toThaiDateParts(new Date().toISOString().slice(0, 10)),
        absenceDate,
        originalDate,
        originalDay,
        originalPeriod,
        originalSubject,
        originalLevel,
        originalRoom,
        requesterCode,
        requesterName,
        requesterDepartment: getTeacherDepartmentName(requesterCode) || getDepartmentGroupName(requesterCode),
        targetCode,
        targetName,
        returnInfo: actionType === 'swap' ? (returnInfo || null) : null,
        formMeta: formMeta || null
    };
}

function getPrintAssetUrl() {
    return `${window.location.origin}/assets/school_logo.jpg`;
}

function escPrint(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function buildReplacementFormHtml(input, formMeta = {}) {
    const records = (Array.isArray(input) ? input : [input]).filter(Boolean);
    const first = records[0] || buildReplacementFormData({});
    const formTitle = 'แบบขอเปลี่ยน/แลกคาบสอน';
    const formCode = 'วก.11';
    const logoUrl = getPrintAssetUrl();

    function shortDate(value) {
        if (!value) return '';
        const p = toThaiDateParts(value);
        const d = new Date(`${value}T00:00:00`);
        if (Number.isNaN(d.getTime())) return '';
        return `${String(p.day).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${p.year}`;
    }

    const sorted = [...records].sort((a,b) => String(a.absenceDate||'').localeCompare(String(b.absenceDate||'')) || Number(a.originalPeriod||0)-Number(b.originalPeriod||0));
    const dates = sorted.map(r => r.absenceDate).filter(Boolean);
    const fromDate = dates[0] || '';
    const toDate = dates[dates.length - 1] || fromDate;
    const fromParts = toThaiDateParts(fromDate);
    const toParts = toThaiDateParts(toDate);

    const deptName = first.requesterDepartment || getDepartmentGroupName(first.requesterCode);
    const commandNumber = formMeta.commandNumber || '';
    const topicTitle = formMeta.topicTitle || '';
    const atPlace = formMeta.atPlace || '';
    const purposeChecks = formMeta.purposes || {};
    const purposeLine = [
        [purposeChecks.meeting, 'ประชุม meeting'],
        [purposeChecks.training, 'อบรม training'],
        [purposeChecks.seminar, 'สัมมนา seminar'],
        [purposeChecks.other, 'อื่นๆ others']
    ].map(([checked,label]) => `${checked ? '☑' : '☐'} ${label}`).join('&nbsp;&nbsp;&nbsp;');

    function rowFor(data) {
        const isSwap = data.actionType === 'swap';
        const ret = data.returnInfo || {};
        const retShort = isSwap && ret.isoDate ? shortDate(ret.isoDate) : '';
        const returnCell = isSwap
            ? `${escPrint(retShort)}${ret.day ? `<br>วัน${escPrint(ret.day)}` : ''}${ret.period !== undefined && ret.period !== null ? `<br>คาบ ${escPrint(ret.period)}` : ''}${ret.level ? `<br>ชั้น ${escPrint(ret.level)}` : ''}${ret.room ? `<br>ห้อง ${escPrint(ret.room)}` : ''}`
            : '<span class="dash">—</span>';
        return `<tr>
            <td class="data-date">${escPrint(shortDate(data.absenceDate))}</td>
            <td class="data-cell-small">${escPrint(data.originalLevel || '')}</td>
            <td class="wrap">${escPrint(data.originalSubject || '')}</td>
            <td>${escPrint(data.originalPeriod ?? '')}</td>
            <td class="wrap">${escPrint(data.originalRoom || '')}</td>
            <td class="wrap">${isSwap ? escPrint(ret.subject || '') : '<span class="dash">—</span>'}</td>
            <td class="wrap data-cell-small">${escPrint(data.targetName || '')}</td>
            <td class="wrap data-cell-small">${returnCell}</td>
            <td class="signature-cell"></td>
            <td class="signature-cell"></td>
        </tr>`;
    }

    function blankRows(count) {
        return Array.from({length: count}, () => `<tr class="blank-row"><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`).join('');
    }

    const rowsPerPage = 5;
    const chunks = [];
    for (let i = 0; i < sorted.length; i += rowsPerPage) chunks.push(sorted.slice(i, i + rowsPerPage));
    if (!chunks.length) chunks.push([]);

    const makeTable = (chunk, fillRows = true) => `
      <table class="form-table">
        <colgroup>
          <col class="c-date"><col class="c-class"><col class="c-subject"><col class="c-period"><col class="c-room">
          <col class="c-replace-subject"><col class="c-replace-teacher"><col class="c-return"><col class="c-sign"><col class="c-sign">
        </colgroup>
        <thead>
          <tr>
            <th>ว/ด/ป<br><small>D/M/Y</small></th>
            <th>ชั้น<br><small>M.</small></th>
            <th>รายวิชาที่ข้าพเจ้า<br>สอน<br><small>My Subject</small></th>
            <th>คาบ<br>ที่<br><small>Period</small></th>
            <th>ห้องที่<br>ใช้สอน<br><small>Room</small></th>
            <th>รายวิชาที่ใช้ใน<br>การแลกคาบสอน<br><small>Replacement<br>Subject</small></th>
            <th>ครูผู้ปฏิบัติหน้าที่<br>แลกคาบสอน<br><small>Substitute<br>Instructor Name</small></th>
            <th>กลับมาแล้ว<br>สอนคืน<br><small>Period<br>Replacement</small></th>
            <th>ผู้แลก<br><small>Your<br>Signature</small></th>
            <th>ผู้รับแลก<br><small>Substitute<br>Signature</small></th>
          </tr>
        </thead>
        <tbody>${chunk.map(rowFor).join('')}${fillRows ? blankRows(Math.max(0, rowsPerPage - chunk.length)) : ''}</tbody>
      </table>`;

    function signatures() {
        return `<div class="signature-block">
          <div class="signature-row"><span class="signature-line"></span><span>ผู้ขออนุญาต Request submitter</span></div>
          <div class="signature-row"><span class="signature-line"></span><span>หัวหน้ากลุ่มสาระฯ Department Head / หัวหน้าระดับชั้น Grade Head (พยาน/Witness)</span></div>
          <div class="signature-row"><span class="signature-line"></span><span>รองผู้อำนวยการฝ่ายบริหารวิชาการ Deputy Director for Academic Affairs</span></div>
          <div class="signature-row"><span class="signature-line"></span><span>ผู้อำนวยการโรงเรียนสรรพวิทยาคม Director of Sapphawitthayakhom School</span></div>
        </div>`;
    }

    const pages = chunks.map((chunk, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === chunks.length - 1;
        const continuation = !isFirst ? `<div class="continuation-title">${formCode} — รายการต่อเนื่อง ${idx + 1}</div>` : '';
        const header = isFirst ? `
          <div class="header">
            <img class="logo" src="${logoUrl}" alt="ตราโรงเรียนสรรพวิทยาคม">
            <div class="form-code">${formCode}</div>
            <div class="form-title">${formTitle}</div>
            <div class="school-repeat">โรงเรียนสรรพวิทยาคม Sapphawitthayakhom School</div>
            <div class="date-block">
              <div class="created-date">วันที่ ${escPrint(first.createdDate?.day || '')} เดือน ${escPrint(first.createdDate?.month || '')} พ.ศ. ${escPrint(first.createdDate?.year || '')}</div>
              <div class="english-date">Date &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Month &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Year</div>
            </div>
          </div>
          <div class="request-body">
            <div>เรื่อง &nbsp; ขออนุญาตเปลี่ยน/แลกคาบสอน</div>
            <div>Re: &nbsp; Instructor Replacement Request</div>
            <div>เรียน &nbsp; ผู้อำนวยการโรงเรียนสรรพวิทยาคม</div>
            <div>To the Director of Sapphawitthayakhom School</div>
            <div class="indent">ด้วยข้าพเจ้า Whereas, I(Mr./Mrs./Miss) <strong>${escPrint(first.requesterName)}</strong></div>
            <div>กลุ่มสาระการเรียนรู้ <strong>${escPrint(deptName)}</strong></div>
            <div>ได้รับคำสั่งที่ am assigned under the officer command number <strong>${escPrint(commandNumber)}</strong></div>
            <div>ได้ไป to attend &nbsp;${purposeLine}</div>
            <div>เรื่อง topic title <strong>${escPrint(topicTitle)}</strong> ณ at <strong>${escPrint(atPlace)}</strong></div>
            <div>ตั้งแต่ from วันที่ date <strong>${escPrint(fromParts.day)}</strong> เดือน <strong>${escPrint(fromParts.month)}</strong> พ.ศ. <strong>${escPrint(fromParts.year)}</strong> ถึง to</div>
            <div>วันที่ date <strong>${escPrint(toParts.day)}</strong> เดือน <strong>${escPrint(toParts.month)}</strong> พ.ศ. <strong>${escPrint(toParts.year)}</strong></div>
            <div class="indent">จึงเรียนมาเพื่อขออนุญาตมอบหมายให้ผู้มีรายชื่อต่อไปนี้ทำการแลกคาบสอน Please consider this request</div>
          </div>` : '';
        return `<section class="page ${isFirst ? 'first-page' : 'continuation-page'}">
          ${header}
          ${continuation}
          ${makeTable(chunk, true)}
          ${isLast ? signatures() : ''}
        </section>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="th"><head><meta charset="UTF-8"><title>${escPrint(formCode)} - ${escPrint(first.requesterName || '')}</title>
<style>
@page { size:A4 portrait; margin:8mm 10mm 8mm 10mm; }
*{box-sizing:border-box} html,body{margin:0;padding:0;background:#fff;color:#000}
body{font-family:'TH SarabunPSK','TH Sarabun New','Sarabun',sans-serif;font-size:13.2pt;line-height:1.02;font-weight:400}
.page{width:190mm;min-height:281mm;margin:0 auto;position:relative;page-break-after:always;overflow:hidden}.page:last-child{page-break-after:auto}
.header{text-align:center;position:relative}.form-code{position:absolute;top:-1mm;right:0;font-size:12pt;line-height:1}.logo{width:21mm;height:21mm;object-fit:contain;display:block;margin:0 auto 1mm}.form-title{font-size:16pt;margin-top:.3mm}.school-repeat{text-align:right;font-size:13pt;margin-top:.8mm}.date-block{text-align:right;margin-top:.6mm}.created-date{text-align:right;font-size:13pt;white-space:nowrap}.english-date{text-align:right;font-size:10.5pt;margin-top:-.4mm;padding-right:1px;letter-spacing:.02em}
.request-body{margin-top:1.8mm;text-align:left}.request-body>div{margin:0 0 .9mm;min-height:4.3mm}.request-body .indent{padding-left:9mm}
.form-table{width:100%;border-collapse:collapse;table-layout:fixed;margin-top:2mm}.form-table th,.form-table td{border:.32mm solid #111;text-align:center;vertical-align:middle;padding:.75mm .45mm}.form-table th{font-size:10.4pt;line-height:.96;font-weight:400}.form-table th small{font-size:8.6pt;line-height:.9}.form-table td{font-size:10.4pt;line-height:1.0;height:11.8mm}.form-table td.wrap{overflow-wrap:anywhere}.data-date{font-size:8.8pt!important;white-space:nowrap}.data-cell-small{font-size:9.5pt!important}.signature-cell{height:11.8mm}.dash{color:#777}.c-date{width:8.5%}.c-class{width:6.5%}.c-subject{width:13.5%}.c-period{width:5.7%}.c-room{width:8%}.c-replace-subject{width:14.2%}.c-replace-teacher{width:15.2%}.c-return{width:14.4%}.c-sign{width:7%}
.signature-block{margin-top:4.5mm;font-size:11.5pt;line-height:1.0}.signature-row{display:flex;align-items:flex-end;gap:2.8mm;margin:2.2mm 0}.signature-line{flex:0 0 62mm;border-bottom:.3mm dotted #000;height:4.5mm}.continuation-title{font-size:14pt;font-weight:700;margin-bottom:1.8mm}
.print-actions{position:fixed;top:10px;right:10px;z-index:1000;display:flex;gap:8px}.print-actions button{border:0;padding:8px 12px;border-radius:7px;font-family:inherit;font-size:13px;cursor:pointer}.print-btn{background:#2563eb;color:#fff}.close-btn{background:#e5e7eb;color:#111827}
@media print{.print-actions{display:none!important}.page{width:auto;min-height:auto;overflow:visible}a{color:#000;text-decoration:none}}
</style></head><body>
<div class="print-actions"><button class="print-btn" onclick="window.print()">🖨️ พิมพ์เอกสาร</button><button class="close-btn" onclick="window.close()">ปิดหน้าต่าง</button></div>
${pages}
<script>window.onload=function(){window.focus();};</script></body></html>`;
}

async function fetchLogoDataUrl() {
    try {
        const response = await fetch('/assets/school_logo.jpg', { cache: 'no-store' });
        if (!response.ok) return '';
        const blob = await response.blob();
        return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => resolve('');
            reader.readAsDataURL(blob);
        });
    } catch (_) {
        return '';
    }
}


let pendingReplacementPrintRecords = [];

function removeReplacementPrintModal() {
    const modal = document.getElementById('replacementPrintOptionsModal');
    if (modal) modal.remove();
}

function showReplacementPrintOptions(records) {
    const safeRecords = (Array.isArray(records) ? records : [records]).filter(Boolean);
    if (!safeRecords.length) {
        alert('ยังไม่มีข้อมูลสำหรับสร้างใบ วก.11');
        return;
    }
    pendingReplacementPrintRecords = safeRecords;
    removeReplacementPrintModal();

    const first = safeRecords[0] || {};
    const defaultReason = safeRecords.every(r => r.actionType === 'one_way') ? 'ขอฝากคาบสอน' : 'ขออนุญาตเปลี่ยน/แลกคาบสอน';
    const modal = document.createElement('div');
    modal.id = 'replacementPrintOptionsModal';
    modal.className = 'fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">
        <div class="px-6 py-5 border-b flex items-center justify-between">
          <div>
            <h3 class="text-xl font-bold text-gray-800">📝 เตรียมข้อมูลใบ วก.11 ก่อนพิมพ์</h3>
            <p class="text-sm text-gray-500 mt-1">กรอกข้อมูลเฉพาะส่วนที่ขึ้นกับเหตุการณ์จริงของการลา/ประชุม/อบรม/สัมมนา</p>
          </div>
          <button type="button" id="closeReplacementPrintOptions" class="text-gray-400 hover:text-red-500 text-3xl font-bold">&times;</button>
        </div>
        <div class="p-6 space-y-5">
          <div class="bg-indigo-50 border border-indigo-100 rounded-xl p-4 text-sm text-indigo-900">
            <div class="font-bold">รายการที่จะพิมพ์: ${safeRecords.length} รายการ</div>
            <div class="mt-1">ผู้ขอ: ${escPrint(first.requesterName || currentUser?.name || '')}</div>
          </div>

          <div>
            <label class="block text-sm font-bold text-gray-700 mb-2">ได้รับคำสั่งที่ / Officer Command Number</label>
            <input id="printCommandNumber" type="text" value="" placeholder="เช่น 123/2569" class="w-full border border-gray-300 rounded-lg p-3 bg-white outline-none focus:ring-2 focus:ring-indigo-500">
          </div>

          <div>
            <label class="block text-sm font-bold text-gray-700 mb-2">เรื่อง / Topic title</label>
            <input id="printTopicTitle" type="text" value="" placeholder="เช่น เข้าร่วมประชุมเชิงปฏิบัติการ..." class="w-full border border-gray-300 rounded-lg p-3 bg-white outline-none focus:ring-2 focus:ring-indigo-500">
          </div>

          <div>
            <label class="block text-sm font-bold text-gray-700 mb-2">ณ / At</label>
            <input id="printAtPlace" type="text" value="" placeholder="สถานที่ / หน่วยงาน / ห้องประชุม" class="w-full border border-gray-300 rounded-lg p-3 bg-white outline-none focus:ring-2 focus:ring-indigo-500">
          </div>

          <div>
            <label class="block text-sm font-bold text-gray-700 mb-2">เหตุการณ์ที่เกี่ยวข้องกับการไปปฏิบัติภารกิจ</label>
            <div class="grid grid-cols-2 gap-3">
              <label class="flex items-center gap-2 p-3 border rounded-lg bg-gray-50"><input type="checkbox" id="printMeeting" class="w-4 h-4">ประชุม (meeting)</label>
              <label class="flex items-center gap-2 p-3 border rounded-lg bg-gray-50"><input type="checkbox" id="printTraining" class="w-4 h-4">อบรม (training)</label>
              <label class="flex items-center gap-2 p-3 border rounded-lg bg-gray-50"><input type="checkbox" id="printSeminar" class="w-4 h-4">สัมมนา (seminar)</label>
              <label class="flex items-center gap-2 p-3 border rounded-lg bg-gray-50"><input type="checkbox" id="printOther" class="w-4 h-4">อื่นๆ (others)</label>
            </div>
          </div>

          <div class="bg-gray-50 border rounded-xl p-4 text-sm text-gray-700">
            <div class="font-bold mb-2">ช่วงวันที่ในเอกสาร</div>
            <div>ระบบจะคำนวณ “ตั้งแต่–ถึง” จากวันที่ของรายการที่เลือกโดยอัตโนมัติ</div>
            <div class="mt-1 text-xs text-gray-500">ไม่ต้องกรอกซ้ำในหน้านี้</div>
          </div>

          <div class="flex gap-3 pt-2">
            <button type="button" id="cancelReplacementPrintOptions" class="w-1/3 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-3 rounded-xl">ยกเลิก</button>
            <button type="button" id="confirmReplacementPrintOptions" class="w-2/3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl shadow-md">🖨️ สร้างใบ วก.11 และเปิดหน้าพิมพ์</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => removeReplacementPrintModal();
    modal.querySelector('#closeReplacementPrintOptions').onclick = close;
    modal.querySelector('#cancelReplacementPrintOptions').onclick = close;
    modal.querySelector('#confirmReplacementPrintOptions').onclick = async () => {
        const meta = {
            topicTitle: modal.querySelector('#printTopicTitle').value.trim(),
            atPlace: modal.querySelector('#printAtPlace').value.trim(),
            commandNumber: modal.querySelector('#printCommandNumber').value.trim(),
            purposes: {
                meeting: modal.querySelector('#printMeeting').checked,
                training: modal.querySelector('#printTraining').checked,
                seminar: modal.querySelector('#printSeminar').checked,
                other: modal.querySelector('#printOther').checked
            }
        };
        if (!meta.topicTitle) {
            alert('กรุณากรอก “เรื่อง / Topic title” ก่อนพิมพ์ครับ');
            return;
        }
        await printReplacementFormNow(pendingReplacementPrintRecords, meta);
        removeReplacementPrintModal();
    };
}

async function printReplacementFormNow(records, formMeta = {}) {
    const safeRecords = (Array.isArray(records) ? records : [records]).filter(Boolean);
    if (!safeRecords.length) {
        alert('ยังไม่มีข้อมูลสำหรับสร้างใบ วก.11');
        return;
    }
    const logoDataUrl = await fetchLogoDataUrl();
    const oldLogoPath = getPrintAssetUrl();
    let html = buildReplacementFormHtml(safeRecords, formMeta);
    if (logoDataUrl) html = html.replaceAll(oldLogoPath, logoDataUrl);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'width=1100,height=900');
    if (!win) {
        URL.revokeObjectURL(url);
        alert('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาต Pop-up สำหรับระบบนี้ แล้วลองอีกครั้ง');
        return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function openReplacementFormPrintPreview(recordsOrRecord) {
    const records = Array.isArray(recordsOrRecord) ? recordsOrRecord : (recordsOrRecord ? [recordsOrRecord] : []);
    showReplacementPrintOptions(records);
}

function injectPrintFormButton() {
    const modal = document.getElementById('successModal');
    if (!modal) return;
    const existing = document.getElementById('printReplacementFormBtn');
    if (existing) existing.remove();
    const closeBtn = modal.querySelector('button[onclick="closeAllModals()"]');
    if (!closeBtn || !closeBtn.parentElement) return;
    const btn = document.createElement('button');
    btn.id = 'printReplacementFormBtn';
    btn.type = 'button';
    btn.className = 'bg-indigo-600 text-white font-bold py-3.5 px-10 rounded-xl shadow-lg hover:bg-indigo-700 transition-colors w-full sm:w-auto mt-3';
    btn.innerText = '🖨️ พิมพ์ใบขอเปลี่ยน/แลกคาบ';
    btn.addEventListener('click', openReplacementFormPrintPreview);
    closeBtn.parentElement.insertBefore(btn, closeBtn);
}

async function closeAllModals() {
    document.getElementById('successModal')?.classList.add('hidden');
    document.getElementById('confirmationModal')?.classList.add('hidden');
    document.getElementById('comparisonModal')?.classList.add('hidden');
    document.getElementById('actionModal')?.classList.add('hidden');

    const btn = document.getElementById('printReplacementFormBtn');
    if (btn) btn.remove();

    // หลังบันทึกคำขอ ให้กลับไปที่ “ตารางของฉัน” โดยอัตโนมัติ
    // เพื่อให้ผู้ใช้เห็นรายการคำขอที่เพิ่งบันทึกทันที
    if (typeof switchTab === 'function') {
        switchTab('myTimetableTab');
    }

    setupSwapRequestUI();
    renderTimetable();

    // โหลดข้อมูล server แบบ background; local draft แสดงได้ทันที
    refreshSwapRequestUI().catch(error => console.warn('⚠️ รีเฟรชรายการคำขอหลังกลับหน้าหลักไม่สำเร็จ:', error));

    // เลื่อนหน้าจอขึ้นไปบริเวณแผงคำขอ
    const panel = document.getElementById('swapRequestPanel');
    if (panel) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}
