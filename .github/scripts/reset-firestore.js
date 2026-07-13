'use strict';

const admin = require('firebase-admin');

const EXPECTED_PROJECT_ID = 'emergencyboxnotyfykpnhos';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
// Unlike test-lifecycle.js (which hardcodes + logs its target project id),
// this script previously never verified or even printed which project it
// was about to wipe — the workflow's "YES" confirmation gives the approving
// human zero indication which project's data is actually being deleted if
// the FIREBASE_SERVICE_ACCOUNT secret is ever rotated to point at a
// different project (e.g. a copy-paste mistake during key rotation).
console.log(`🎯 Target Firestore project: ${serviceAccount.project_id}`);
if (serviceAccount.project_id !== EXPECTED_PROJECT_ID) {
  console.error(`❌ Refusing to run — expected project "${EXPECTED_PROJECT_ID}" but FIREBASE_SERVICE_ACCOUNT points to "${serviceAccount.project_id}"`);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function clearCollection(name) {
  const snap = await db.collection(name).get();
  if (snap.empty) { console.log(`⏭  ${name}: ว่างอยู่แล้ว`); return 0; }
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  console.log(`✓  ลบ ${docs.length} รายการจาก "${name}"`);
  return docs.length;
}

async function main() {
  console.log('🧹 เริ่มล้างข้อมูลทดสอบ Firebase...\n');

  await clearCollection('audit_log');
  await clearCollection('boxes');
  await clearCollection('box_drugs');
  await clearCollection('usage_log');

  // users — ลบเฉพาะที่ไม่ใช่ admin
  // Chunked the same way clearCollection() batches everything else — a
  // single unchunked batch.commit() hard-rejects past Firestore's 500-op
  // cap, which a hospital could plausibly reach after years of onboarding
  // technicians/pharmacists/nurses with none ever purged. Without chunking,
  // hitting that cap here would throw AFTER audit_log/boxes/box_drugs/
  // usage_log were already fully cleared, leaving users untouched — a
  // silently inconsistent reset despite the "เสร็จแล้ว!" success message.
  const usersSnap = await db.collection('users').get();
  const nonAdmin = usersSnap.docs.filter(d => d.data().role !== 'admin');
  if (nonAdmin.length) {
    for (let i = 0; i < nonAdmin.length; i += 400) {
      const batch = db.batch();
      nonAdmin.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    console.log(`✓  ลบ ${nonAdmin.length} user ที่ไม่ใช่ admin`);
  } else {
    console.log('⏭  users: ไม่มี user อื่นนอกจาก admin');
  }

  console.log('\n🎉 เสร็จแล้ว! Firestore สะอาดพร้อมใช้งานจริง');
  console.log('   (แอพจะ seed กล่อง EB ใหม่ที่สะอาดเมื่อโหลดครั้งต่อไป)');
  process.exit(0);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
