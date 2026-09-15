/**
 * One-off, read-only reporting script for academic/QI reporting — computes a
 * monthly breakdown of several operational indicators directly from
 * production Firestore for a given date range. Writes NOTHING to Firestore.
 *
 * Requested breakdown (per calendar month, มิ.ย.–ส.ค. 2569 by default):
 *   1. Dispense/return transaction counts       (audit_log: cat 'dispense'/'return')
 *   2. QR page-view / scan counts               (kpi_events: type 'qr_pageview')
 *   3. Stage 2 rejection counts                 (audit_log: cat 'register', action 'ตีกลับให้แก้ไข')
 *   4. Near-expiry incidents flagged            (kpi_events: type 'expiry_incident')
 *      NOTE: this is a proxy, not a literal "alerts sent" count — see the
 *      printed caveat. "Resolved in time" is NOT derivable from any
 *      persisted field (see caveat) and is reported as "ไม่สามารถคำนวณได้"
 *      rather than guessed.
 *   5. Average Stage 2 wait time (days)         (kpi_events: type 'stage2_wait', field waitDays)
 *   6. Median registration/verification time    (kpi_events: type 'reg_timing', field durationSec)
 *
 * Env: FIREBASE_SERVICE_ACCOUNT (already configured as a repo secret, same
 * credential every other script in this folder uses — read-only queries
 * here, no writes).
 * Optional env: REPORT_FROM (YYYY-MM-DD, default 2026-06-01),
 *               REPORT_TO   (YYYY-MM-DD, default 2026-08-31)
 */
const admin = require('firebase-admin');

const EXPECTED_PROJECT_ID = 'emergencyboxnotyfykpnhos';

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT ไม่ถูกต้อง — ไม่ใช่ JSON ที่ valid:', e.message);
  process.exit(1);
}
if (serviceAccount.project_id !== EXPECTED_PROJECT_ID) {
  console.error(`❌ ปฏิเสธการทำงาน: service account ชี้ไปที่โปรเจกต์ "${serviceAccount.project_id}" ไม่ตรงกับที่คาดไว้ "${EXPECTED_PROJECT_ID}"`);
  process.exit(1);
}
console.log(`✅ ยืนยันโปรเจกต์ Firestore: ${serviceAccount.project_id} (read-only queries only)`);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const FROM = process.env.REPORT_FROM || '2026-06-01';
const TO = process.env.REPORT_TO || '2026-08-31';

function monthKey(isoDate) {
  return isoDate.slice(0, 7); // 'YYYY-MM'
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function fetchAll(collection, field, from, to) {
  const snap = await db.collection(collection)
    .where(field, '>=', from)
    .where(field, '<=', to)
    .get({ source: 'server' }); // never trust local cache for a completeness-critical report
  return snap.docs.map(d => d.data());
}

async function main() {
  console.log(`\n📅 ช่วงเวลา: ${FROM} ถึง ${TO}\n`);

  const [auditRows, kpiRows] = await Promise.all([
    fetchAll('audit_log', 'date', FROM, TO),
    fetchAll('kpi_events', 'date', FROM, TO),
  ]);
  console.log(`(ดึงข้อมูลจริงจาก Firestore: audit_log ${auditRows.length} รายการ, kpi_events ${kpiRows.length} รายการ ในช่วงที่กำหนด)\n`);

  const months = {};
  function m(key) {
    if (!months[key]) {
      months[key] = {
        dispense: 0, return: 0, qrViews: 0, stage2Rejects: 0,
        expiryIncidents: 0, stage2WaitDays: [], regTimingSec: [],
      };
    }
    return months[key];
  }

  for (const r of auditRows) {
    const key = monthKey(r.date);
    if (r.cat === 'dispense' && r.action === 'จ่าย') m(key).dispense++;
    else if (r.cat === 'return' && r.action === 'รับคืน') m(key).return++;
    else if (r.cat === 'register' && r.action === 'ตีกลับให้แก้ไข') m(key).stage2Rejects++;
  }

  for (const r of kpiRows) {
    const key = monthKey(r.date);
    if (r.type === 'qr_pageview') m(key).qrViews++;
    else if (r.type === 'expiry_incident') m(key).expiryIncidents++;
    else if (r.type === 'stage2_wait' && typeof r.waitDays === 'number') m(key).stage2WaitDays.push(r.waitDays);
    else if (r.type === 'reg_timing' && typeof r.durationSec === 'number') m(key).regTimingSec.push(r.durationSec);
  }

  const sortedKeys = Object.keys(months).sort();
  console.log('='.repeat(78));
  console.log('รายงานสรุปรายเดือน (ข้อมูลจริงจาก Firestore Production)');
  console.log('='.repeat(78));

  for (const key of sortedKeys) {
    const d = months[key];
    const avgWait = mean(d.stage2WaitDays);
    const medRegSec = median(d.regTimingSec);
    console.log(`\n### ${key}`);
    console.log(`  1. ธุรกรรมจ่าย: ${d.dispense} ครั้ง  |  รับคืน: ${d.return} ครั้ง`);
    console.log(`  2. สแกน/เปิดหน้า QR: ${d.qrViews} ครั้ง`);
    console.log(`  3. กล่องถูกตีกลับ Stage 2: ${d.stage2Rejects} ครั้ง`);
    console.log(`  4. รายการยาใกล้หมดอายุที่ถูกตรวจพบ (expiry_incident): ${d.expiryIncidents} รายการ`);
    console.log(`     ⚠️  หมายเหตุ: ตัวเลขนี้คือจำนวน "รายการยา/ล็อต" ที่ระบบตรวจพบว่าใกล้หมดอายุในแต่ละรอบ ไม่ใช่จำนวน "ข้อความแจ้งเตือน" ที่ส่งออกจริง (1 ข้อความอาจรวมหลายรายการ) และ`);
    console.log(`         "จำนวนที่ดำเนินการแก้ไขทันเวลา" ไม่มีข้อมูลใน Firestore ที่คำนวณได้ตรงตามคำถามนี้ — ไม่มีฟิลด์บันทึกว่ารายการใดถูกจัดการแล้วหรือไม่ (ไม่ขอเดา)`);
    console.log(`  5. เวลาเฉลี่ยรอตรวจสอบ Stage 2: ${avgWait !== null ? avgWait.toFixed(2) + ' วัน' : 'ไม่มีข้อมูล'}  (n=${d.stage2WaitDays.length})`);
    console.log(`  6. เวลาลงทะเบียน/ตรวจนับ 1 กล่อง (ค่ากลาง/median): ${medRegSec !== null ? (medRegSec / 60).toFixed(1) + ' นาที' : 'ไม่มีข้อมูล'}  (n=${d.regTimingSec.length})`);
  }

  if (!sortedKeys.length) {
    console.log('\n⚠️  ไม่พบข้อมูลใดๆ ในช่วงเวลาที่กำหนด (audit_log หรือ kpi_events ว่างเปล่าในช่วงนี้)');
  }

  console.log('\n' + '='.repeat(78));
  console.log('จบรายงาน — ไม่มีการเขียนข้อมูลใดๆ ลง Firestore (read-only)');
  console.log('='.repeat(78));
}

main().catch(err => { console.error('❌ monthly-kpi-report.js error:', err.message); process.exitCode = 1; });
