// =====================================================================
// EB Notify — Firebase Cleanup Script (ใช้ครั้งเดียวก่อน Go-Live)
// วิธีใช้:
//   1. เปิดแอพใน browser แล้ว Login ด้วย admin
//   2. กด F12 → แท็บ Console
//   3. Copy โค้ดทั้งหมดนี้ วาง แล้วกด Enter
//   4. รอจนเห็น "เสร็จแล้ว!" แล้ว Ctrl+Shift+R (hard refresh)
// =====================================================================

(async function ebCleanup() {
  if (!window.EB_Firebase || !window.EB_Firebase.db) {
    console.error('❌ ไม่พบ Firebase — กรุณาเปิดแอพแล้ว login ก่อนครับ');
    return;
  }
  const db = window.EB_Firebase.db;

  async function clearCollection(name) {
    const snap = await db.collection(name).get();
    if (snap.empty) { console.log(`⏭  ${name}: ว่างอยู่แล้ว`); return 0; }
    // ลบทีละ 400 (Firestore batch limit = 500)
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    console.log(`✓  ลบ ${docs.length} รายการจาก "${name}"`);
    return docs.length;
  }

  console.log('🧹 เริ่มล้างข้อมูลทดสอบ...');

  // 1. Audit log — ลบทั้งหมด
  await clearCollection('audit_log');

  // 2. Boxes — ลบทั้งหมด (จะ seed ใหม่จาก code ที่สะอาดเมื่อ reload)
  await clearCollection('boxes');

  // 3. Box drugs — ลบทั้งหมด (จะ seed ใหม่)
  await clearCollection('box_drugs');

  // 4. Users — ลบเฉพาะที่ไม่ใช่ admin
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

  console.log('');
  console.log('🎉 เสร็จแล้ว! กด Ctrl+Shift+R เพื่อ hard refresh แอพ');
  console.log('   (แอพจะ load ข้อมูลใหม่ที่สะอาดจาก Firebase)');
})();
