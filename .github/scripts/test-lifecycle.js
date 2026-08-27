'use strict';
/**
 * One-off production smoke test for Emergency-box-Notify-KPNHos.
 *
 * Creates a temporary "TEST-1" box (never a real EB-1..EB-10 box), drives it
 * through register -> dispense -> return using the exact same Firestore
 * transactions the live app uses (returnBoxAndDrugsTx, logDrugUsageTx),
 * verifies:
 *   1. the atomic return+decrement transaction works end-to-end
 *   2. the double-return race guard actually rejects a concurrent second return
 *   3. the paperless QR usage-logging transaction (logDrugUsageTx) decrements
 *      correctly, sets openedAt only on the first entry of a cycle, rejects
 *      an over-limit qty without clamping it, rejects logging against a box
 *      that's no longer out, and survives two concurrent usage entries on
 *      different drugs of the same box with no array-index corruption
 *   4. firestore.rules actually blocks delete on boxes/box_drugs/audit_log
 *      from an anonymous client (the same auth every real user gets)
 * then deletes every trace of TEST-1 regardless of outcome, via the Admin SDK
 * (which bypasses rules, so cleanup always succeeds even though rule #4 above
 * blocks the client SDK from doing it).
 *
 * Run manually via the "Test Lifecycle (safe, temp box)" GitHub Action.
 * Never touches EB-1..EB-10, audit_log entries besides its own throwaway one,
 * or any user account.
 */
const admin = require('firebase-admin');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, deleteDoc, setDoc, runTransaction, collection } = require('firebase/firestore');
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
        verified: false,
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
    dispense: '2026-07-01', dispenser: 'ทดสอบระบบ', receiver: '', retDate: '', openedAt: '',
  }, { merge: true });
  // two drugs (not one) specifically so the usage-logging concurrency test
  // below can decrement two DIFFERENT drugs' lots at once and confirm
  // neither call's array index shifts under the other — the real invariant
  // logDrugUsageTx's own no-filter-empty-lots comment in firebase-sync.js
  // depends on and this smoke test never exercised until now.
  await adminDb.collection('box_drugs').doc(TEST_BOX_ID).set({
    boxId: TEST_BOX_ID,
    drugs: [
      { name: 'Test Drug', had: false, par: 10, verified: true, lots: [{ lot: 'T1', qty: 10, expiry: '2027-01-01' }] },
      { name: 'Test Drug 2', had: false, par: 5, verified: true, lots: [{ lot: 'T2', qty: 5, expiry: '2027-01-01' }] },
    ],
  });
}

// Mirrors firebase-sync.js's logDrugUsageTx exactly, against the client
// SDK — this is the paperless QR-page usage-logging transaction, never
// previously covered by this smoke test even though the entire paperless
// rollout depends on it. Deliberately does NOT filter out an emptied lot
// (matching the real implementation) — see that function's own comment on
// why: dropping a lot would shift later lots' array indices for a
// concurrently-running transaction re-reading the same array.
async function logDrugUsageTx(boxId, dept, drugIdx, lotIdx, qty, hn, patientName, recordedAt, recordedTime) {
  if (!(qty > 0)) { const err = new Error('BAD_QTY'); err.code = 'BAD_QTY'; throw err; }
  const boxRef = doc(clientDb, 'boxes', boxId);
  const drugsRef = doc(clientDb, 'box_drugs', boxId);
  const usageRef = doc(collection(clientDb, 'usage_log'));
  return runTransaction(clientDb, async (tx) => {
    const [boxSnap, drugsSnap] = await Promise.all([tx.get(boxRef), tx.get(drugsRef)]);
    const boxData = boxSnap.exists() ? boxSnap.data() : {};
    const isOut = !!(boxData.dispense && !boxData.receiver);
    if (!isOut) { const err = new Error('NOT_OUT'); err.code = 'NOT_OUT'; throw err; }
    const drugs = (drugsSnap.exists() ? drugsSnap.data().drugs : null) || [];
    const drug = drugs[drugIdx];
    const lot = drug && (drug.lots || [])[lotIdx];
    if (!drug || !lot) { const err = new Error('NOT_FOUND'); err.code = 'NOT_FOUND'; throw err; }
    if (qty > (lot.qty || 0)) { const err = new Error('INSUFFICIENT_QTY'); err.code = 'INSUFFICIENT_QTY'; throw err; }
    const updatedDrugs = drugs.map((d, di) => di !== drugIdx ? d : {
      ...d,
      lots: (d.lots || []).map((l, li) => li !== lotIdx ? l : { ...l, qty: l.qty - qty }),
    });
    tx.set(drugsRef, { boxId, drugs: updatedDrugs }, { merge: true });
    if (!boxData.openedAt) tx.update(boxRef, { openedAt: recordedAt });
    tx.set(usageRef, { boxId, dept: dept || boxData.dept || '', drugName: drug.name, qty, hn: hn || '', patientName: patientName || '', recordedAt, recordedTime });
    return { drugs: updatedDrugs, drugName: drug.name, openedNow: !boxData.openedAt };
  });
}

async function cleanup() {
  // Each delete's error is surfaced (not blanket-swallowed) — a transient
  // Firestore/network/permission failure here must not let this function
  // (or the "--cleanup-only" step that's the ONLY guaranteed-cleanup path
  // after a cancelled/killed run, see below) silently report success while
  // TEST-1 actually still lingers in production Firestore.
  const jobs = [
    ['boxes', TEST_BOX_ID],
    ['box_drugs', TEST_BOX_ID],
    ['audit_log', 'TEST-1-rules-check'],
  ];
  // usage_log docs from the logDrugUsageTx tests below get random auto-IDs
  // (unlike the fixed-ID docs above), so they can't be named ahead of time —
  // query by boxId instead and queue up whatever's actually there. The
  // query itself is treated with the same rigor as the deletes below (not
  // silently swallowed) — a failed query here would otherwise leave
  // TEST-1's usage_log docs undeleted with the run still reporting success.
  const usageQuery = await Promise.allSettled([adminDb.collection('usage_log').where('boxId', '==', TEST_BOX_ID).get()]);
  if (usageQuery[0].status === 'fulfilled') {
    usageQuery[0].value.forEach((d) => jobs.push(['usage_log', d.id]));
  } else {
    console.error('❌ cleanup: usage_log query failed:', usageQuery[0].reason && usageQuery[0].reason.message);
  }
  const outcomes = await Promise.allSettled(jobs.map(([col, id]) => adminDb.collection(col).doc(id).delete()));
  const failed = outcomes.map((o, i) => ({ o, job: jobs[i] })).filter(({ o }) => o.status === 'rejected');
  if (failed.length || usageQuery[0].status === 'rejected') {
    failed.forEach(({ o, job }) => console.error(`❌ cleanup failed to delete ${job[0]}/${job[1]}:`, o.reason && o.reason.message));
    throw new Error(`cleanup left ${failed.length}/${jobs.length} doc(s) undeleted${usageQuery[0].status === 'rejected' ? ' (plus the usage_log query itself failed — any TEST-1 usage_log docs may still linger)' : ''}`);
  }
  console.log('🧹 cleaned up TEST-1 box, box_drugs, audit_log, and usage_log doc(s)');
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
    record('return transaction resets verified to false (must be re-checked before next dispense)', retResult.drugs[0].verified === false, `got ${retResult.drugs?.[0]?.verified}`);
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

  // ---- 3. Paperless QR usage-logging (logDrugUsageTx) — never previously
  // covered by this smoke test even though the entire paperless rollout
  // depends on it working correctly under real Firestore/firestore.rules. ----
  await resetTestBoxToOut();
  const use1 = await logDrugUsageTx(TEST_BOX_ID, 'ER', 0, 0, 3, 'HN001', 'ทดสอบ ระบบ', '2026-07-08', '10:00').catch((e) => e);
  const use1Ok = use1 && !(use1 instanceof Error);
  record('usage log: first entry succeeds and decrements 10 -> 7', use1Ok && use1.drugs[0].lots[0].qty === 7, use1Ok ? `got ${use1.drugs?.[0]?.lots?.[0]?.qty}` : String(use1));
  record('usage log: openedNow is true on the box\'s first usage entry', use1Ok && use1.openedNow === true, use1Ok ? `got ${use1.openedNow}` : '');
  if (use1Ok) {
    const boxAfterUse1 = (await adminDb.collection('boxes').doc(TEST_BOX_ID).get()).data();
    record('usage log: box.openedAt set after first usage', boxAfterUse1.openedAt === '2026-07-08', `got ${boxAfterUse1.openedAt}`);
  }

  const use2 = await logDrugUsageTx(TEST_BOX_ID, 'ER', 1, 0, 2, 'HN002', '', '2026-07-08', '10:05').catch((e) => e);
  const use2Ok = use2 && !(use2 instanceof Error);
  record('usage log: second entry (different drug) succeeds and decrements 5 -> 3', use2Ok && use2.drugs[1].lots[0].qty === 3, use2Ok ? `got ${use2.drugs?.[1]?.lots?.[0]?.qty}` : String(use2));
  record('usage log: openedNow is false on a SECOND entry in the same cycle (not re-triggered)', use2Ok && use2.openedNow === false, use2Ok ? `got ${use2.openedNow}` : '');

  const overQty = await logDrugUsageTx(TEST_BOX_ID, 'ER', 0, 0, 999, 'HN003', '', '2026-07-08', '10:10').catch((e) => e);
  record('usage log: over-limit qty is rejected with INSUFFICIENT_QTY, not silently clamped', overQty instanceof Error && overQty.code === 'INSUFFICIENT_QTY', overQty instanceof Error ? overQty.code : 'did not throw');
  const drugsAfterReject = (await adminDb.collection('box_drugs').doc(TEST_BOX_ID).get()).data();
  record('usage log: rejected over-limit request left quantity unchanged (transaction rolled back)', drugsAfterReject.drugs[0].lots[0].qty === 7, `got ${drugsAfterReject.drugs?.[0]?.lots?.[0]?.qty}`);

  // box not out -> must reject, mirroring the register-screen's own "already
  // dispensed" guard but for the inverse case a QR scan could hit if a box
  // was returned right before someone finished filling in the usage form.
  await adminDb.collection('boxes').doc(TEST_BOX_ID).set({ receiver: 'ผู้ทดสอบ', retDate: '2026-07-09' }, { merge: true });
  const notOutUse = await logDrugUsageTx(TEST_BOX_ID, 'ER', 0, 0, 1, 'HN004', '', '2026-07-09', '11:00').catch((e) => e);
  record('usage log: logging against a box that is no longer out is rejected with NOT_OUT', notOutUse instanceof Error && notOutUse.code === 'NOT_OUT', notOutUse instanceof Error ? notOutUse.code : 'did not throw');

  // ---- 4. Concurrency: two ward staff scanning the same box's QR at the
  // same time, logging usage against two DIFFERENT drugs at once — the real
  // scenario firebase-sync.js's "don't filter empty lots" comment exists
  // for. Both must succeed independently with no index-shift corruption. ----
  await resetTestBoxToOut();
  const [u1, u2] = await Promise.allSettled([
    logDrugUsageTx(TEST_BOX_ID, 'ER', 0, 0, 4, 'HN005', '', '2026-07-10', '09:00'),
    logDrugUsageTx(TEST_BOX_ID, 'ER', 1, 0, 1, 'HN006', '', '2026-07-10', '09:00'),
  ]);
  const bothFulfilled = u1.status === 'fulfilled' && u2.status === 'fulfilled';
  record('concurrent usage on two different drugs: both succeed independently', bothFulfilled, `u1=${u1.status} u2=${u2.status}`);
  if (bothFulfilled) {
    const finalDrugs = (await adminDb.collection('box_drugs').doc(TEST_BOX_ID).get()).data().drugs;
    record('concurrent usage: drug 0 correctly decremented 10 -> 6 (no index shift)', finalDrugs[0].lots[0].qty === 6, `got ${finalDrugs[0]?.lots?.[0]?.qty}`);
    record('concurrent usage: drug 1 correctly decremented 5 -> 4 (no index shift)', finalDrugs[1].lots[0].qty === 4, `got ${finalDrugs[1]?.lots?.[0]?.qty}`);
  }

  // ---- 5. Rules enforcement: delete must be blocked for anonymous clients ----
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
      // cleanup() now throws on a real delete failure (see above) instead of
      // silently swallowing it — catch it here so it doesn't become an
      // unhandled rejection that skips printing the test results below, but
      // still surface it as a failed check so a real cleanup failure can't
      // report as a fully-green run (the --cleanup-only workflow step is the
      // real safety net for a cancelled run; this is the normal-completion path).
      await cleanup().catch((err) => { console.error('❌', err.message); results.push({ name: 'cleanup', pass: false, detail: err.message }); });
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
