'use strict';
/**
 * One-off production smoke test for Emergency-box-Notify-KPNHos.
 *
 * Creates a temporary "TEST-1" box (never a real EB-1..EB-10 box), drives it
 * through register -> dispense -> return using the exact same Firestore
 * transaction the live app uses (returnBoxAndDrugsTx), verifies:
 *   1. the atomic return+decrement transaction works end-to-end
 *   2. the double-return race guard actually rejects a concurrent second return
 *   3. firestore.rules actually blocks delete on boxes/box_drugs/audit_log
 *      from an anonymous client (the same auth every real user gets)
 * then deletes every trace of TEST-1 regardless of outcome, via the Admin SDK
 * (which bypasses rules, so cleanup always succeeds even though rule #3 above
 * blocks the client SDK from doing it).
 *
 * Run manually via the "Test Lifecycle (safe, temp box)" GitHub Action.
 * Never touches EB-1..EB-10, audit_log entries besides its own throwaway one,
 * or any user account.
 */
const admin = require('firebase-admin');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, deleteDoc, setDoc, runTransaction } = require('firebase/firestore');
const { getAuth, signInAnonymously } = require('firebase/auth');

const PROJECT_ID = 'emergencyboxnotyfykpnhos';
const TEST_BOX_ID = 'TEST-1';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ---- Admin SDK: setup + cleanup only (bypasses rules on purpose) ----
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const adminDb = admin.firestore();

// ---- Client SDK: same public config the live app ships, same anonymous
// auth every real user (staff or public QR viewer) gets — this is what
// actually exercises firestore.rules, unlike the Admin SDK above.
const firebaseConfig = {
  apiKey: 'AIzaSyCTIEdwRCwQsrh61dY87dvcPwtK5q_isqU',
  authDomain: 'emergencyboxnotyfykpnhos.firebaseapp.com',
  projectId: PROJECT_ID,
  storageBucket: 'emergencyboxnotyfykpnhos.firebasestorage.app',
  messagingSenderId: '825126916',
  appId: '1:825126916:web:0de8d3c1454a15990bc551',
};
const clientApp = initializeApp(firebaseConfig);
const clientDb = getFirestore(clientApp);
const clientAuth = getAuth(clientApp);

// Mirrors firebase-sync.js's returnBoxAndDrugsTx exactly, against the client SDK.
async function returnBoxAndDrugsTx(boxId, boxFields, usageMap) {
  const boxRef = doc(clientDb, 'boxes', boxId);
  const drugsRef = doc(clientDb, 'box_drugs', boxId);
  return runTransaction(clientDb, async (tx) => {
    const [boxSnap, drugsSnap] = await Promise.all([tx.get(boxRef), tx.get(drugsRef)]);
    const boxData = boxSnap.exists() ? boxSnap.data() : {};
    const isOut = !!(boxData.dispense && !boxData.receiver);
    if (!isOut) { const err = new Error('NOT_OUT'); err.code = 'NOT_OUT'; throw err; }
    tx.update(boxRef, boxFields);
    const drugs = (drugsSnap.exists() ? drugsSnap.data().drugs : null) || [];
    let updatedDrugs = null;
    if (drugs.length > 0) {
      updatedDrugs = drugs.map((d, di) => ({
        ...d,
        lots: (d.lots || []).map((l, li) => ({ ...l, qty: Math.max(0, (l.qty || 0) - ((usageMap[di] || {})[li] || 0)) })).filter((l) => l.qty > 0),
      }));
      tx.set(drugsRef, { boxId, drugs: updatedDrugs }, { merge: true });
    }
    return { drugs: updatedDrugs };
  });
}

async function resetTestBoxToOut() {
  await adminDb.collection('boxes').doc(TEST_BOX_ID).set({
    id: TEST_BOX_ID, dept: 'ER', mfg: '2026-01-01', expiry: '2027-01-01', nearDrug: 'Test Drug',
    preparer: 'ทดสอบระบบ', checker: 'ทดสอบระบบ', registeredAt: '2026-01-01',
    dispense: '2026-07-01', dispenser: 'ทดสอบระบบ', receiver: '', retDate: '',
  }, { merge: true });
  await adminDb.collection('box_drugs').doc(TEST_BOX_ID).set({
    boxId: TEST_BOX_ID,
    drugs: [{ name: 'Test Drug', had: false, par: 10, lots: [{ lot: 'T1', qty: 10, expiry: '2027-01-01' }] }],
  });
}

async function cleanup() {
  await adminDb.collection('boxes').doc(TEST_BOX_ID).delete().catch(() => {});
  await adminDb.collection('box_drugs').doc(TEST_BOX_ID).delete().catch(() => {});
  await adminDb.collection('audit_log').doc('TEST-1-rules-check').delete().catch(() => {});
  console.log('🧹 cleaned up TEST-1 box, box_drugs, and test audit_log doc');
}

async function main() {
  console.log(`🧪 Lifecycle smoke test against project "${PROJECT_ID}" using throwaway box "${TEST_BOX_ID}"\n`);

  await signInAnonymously(clientAuth);
  console.log('✅ Anonymous auth OK (same auth every real user gets)\n');

  // ---- 1. Functional: register (seed) -> dispense (seed) -> return (real transaction) ----
  await resetTestBoxToOut();
  const before = (await adminDb.collection('box_drugs').doc(TEST_BOX_ID).get()).data();
  record('setup: TEST-1 seeded as dispensed-out with qty=10', before.drugs[0].lots[0].qty === 10);

  const retResult = await returnBoxAndDrugsTx(TEST_BOX_ID, { receiver: 'ผู้ทดสอบ', retDate: '2026-07-08' }, { 0: { 0: 3 } })
    .catch((e) => e);
  const retOk = retResult && !(retResult instanceof Error);
  record('return transaction succeeds on first return', retOk, retOk ? '' : String(retResult));
  if (retOk) {
    record('return transaction decremented qty 10 -> 7 correctly', retResult.drugs[0].lots[0].qty === 7, `got ${retResult.drugs?.[0]?.lots?.[0]?.qty}`);
    const boxAfter = (await adminDb.collection('boxes').doc(TEST_BOX_ID).get()).data();
    record('box marked receiver+retDate after return', boxAfter.receiver === 'ผู้ทดสอบ' && boxAfter.retDate === '2026-07-08');
  }

  // ---- 2. Concurrency: double-return race guard ----
  await resetTestBoxToOut();
  const [r1, r2] = await Promise.allSettled([
    returnBoxAndDrugsTx(TEST_BOX_ID, { receiver: 'คนที่ 1', retDate: '2026-07-08' }, { 0: { 0: 2 } }),
    returnBoxAndDrugsTx(TEST_BOX_ID, { receiver: 'คนที่ 2', retDate: '2026-07-08' }, { 0: { 0: 4 } }),
  ]);
  const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled').length;
  const rejectedNotOut = [r1, r2].filter((r) => r.status === 'rejected' && r.reason && r.reason.code === 'NOT_OUT').length;
  record('double-return race: exactly one of two concurrent returns succeeds', fulfilled === 1, `fulfilled=${fulfilled}`);
  record('double-return race: the other is rejected with NOT_OUT (not silently overwritten)', rejectedNotOut === 1, `rejectedNotOut=${rejectedNotOut}`);

  // ---- 3. Rules enforcement: delete must be blocked for anonymous clients ----
  const boxDeleteBlocked = await deleteDoc(doc(clientDb, 'boxes', TEST_BOX_ID)).then(() => false, (e) => e.code === 'permission-denied');
  record('firestore.rules blocks delete on boxes (client-side)', boxDeleteBlocked);
  const drugsDeleteBlocked = await deleteDoc(doc(clientDb, 'box_drugs', TEST_BOX_ID)).then(() => false, (e) => e.code === 'permission-denied');
  record('firestore.rules blocks delete on box_drugs (client-side)', drugsDeleteBlocked);

  await setDoc(doc(clientDb, 'audit_log', 'TEST-1-rules-check'), { cat: 'test', action: 'ทดสอบ', eb: TEST_BOX_ID, dept: '-', drug: '-' });
  const auditDeleteBlocked = await deleteDoc(doc(clientDb, 'audit_log', 'TEST-1-rules-check')).then(() => false, (e) => e.code === 'permission-denied');
  record('firestore.rules blocks delete on audit_log (append-only)', auditDeleteBlocked);
}

// `node test-lifecycle.js --cleanup-only` just deletes TEST-1 and exits —
// used as a separate, always-run workflow step (see test-lifecycle.yml) so
// TEST-1 still gets cleaned up even if someone cancels the main test step
// (or the runner is killed) partway through: this script's own .finally()
// below only runs if the Node process itself gets to unwind normally, which
// a GitHub Actions cancellation of a *running* step does not guarantee.
if (process.argv.includes('--cleanup-only')) {
  cleanup().then(() => process.exit(0)).catch((err) => { console.error('❌ cleanup-only failed:', err.message); process.exit(1); });
} else {
  main()
    .catch((err) => { console.error('❌ Unexpected error during test:', err); results.push({ name: 'unexpected error', pass: false, detail: err.message }); })
    .finally(async () => {
      await cleanup();
      const failed = results.filter((r) => !r.pass);
      console.log(`\n${'='.repeat(50)}`);
      console.log(`RESULT: ${results.length - failed.length}/${results.length} checks passed`);
      if (failed.length) {
        console.log('FAILED:');
        failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ' (' + f.detail + ')' : ''}`));
        process.exit(1);
      }
      process.exit(0);
    });
}
