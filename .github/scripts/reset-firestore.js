'use strict';

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
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
  const usersSnap = await db.collection('users').get();
  const nonAdmin = usersSnap.docs.filter(d => d.data().role !== 'admin');
  if (nonAdmin.length) {
    const batch = db.batch();
    nonAdmin.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`✓  ลบ ${nonAdmin.length} user ที่ไม่ใช่ admin`);
  } else {
    console.log('⏭  users: ไม่มี user อื่นนอกจาก admin');
  }

  console.log('\n🎉 เสร็จแล้ว! Firestore สะอาดพร้อมใช้งานจริง');
  console.log('   (แอพจะ seed กล่อง EB ใหม่ที่สะอาดเมื่อโหลดครั้งต่อไป)');
  process.exit(0);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
