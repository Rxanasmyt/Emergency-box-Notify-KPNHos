/**
 * Daily Drug Expiry Check & Notification
 * Runs via GitHub Actions every day at 08:00 AM Bangkok time (01:00 UTC)
 *
 * Required GitHub Secrets:
 *   FIREBASE_SERVICE_ACCOUNT - Firebase Admin SDK JSON (already set)
 *   LINE_NOTIFY_TOKEN        - Token from https://notify-bot.line.me
 *   EMAIL_FROM               - Gmail address (sender)
 *   EMAIL_PASS               - Gmail App Password (16-char, not account password)
 *   EMAIL_TO                 - Recipient email (comma-separated for multiple)
 *   NOTIFY_DAYS_AHEAD        - (optional) days threshold, default 30
 */

'use strict';

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const https = require('https');

// ── Init Firebase Admin ────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const THRESHOLD_DAYS = parseInt(process.env.NOTIFY_DAYS_AHEAD || '30', 10);
const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);

// ── Helpers ────────────────────────────────────────────────────
function daysUntil(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  return Math.round((d - TODAY) / 86400000);
}

function thaiDate(isoDate) {
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const d = new Date(isoDate + 'T00:00:00');
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function statusLabel(days) {
  if (days < 0)  return '🔴 หมดอายุแล้ว';
  if (days === 0) return '🔴 หมดอายุวันนี้';
  if (days <= 7)  return '🟠 วิกฤต';
  if (days <= 15) return '🟡 ใกล้กำหนด';
  return '🔵 เตือนล่วงหน้า';
}

// ── Read Firestore ─────────────────────────────────────────────
async function fetchExpiringDrugs() {
  const alerts = [];

  // Get all boxes
  const boxSnap = await db.collection('boxes').get();
  const boxes = {};
  boxSnap.forEach(doc => { boxes[doc.id] = doc.data(); });
  console.log(`📦 boxes collection: ${boxSnap.size} documents`);

  // Get all box_drugs
  const bdSnap = await db.collection('box_drugs').get();
  console.log(`💊 box_drugs collection: ${bdSnap.size} documents`);
  bdSnap.forEach(doc => {
    const data = doc.data();
    const boxId = doc.id;
    const box = boxes[boxId] || {};
    const drugs = data.drugs || [];

    drugs.forEach(drug => {
      const lots = drug.lots || [];
      lots.forEach(lot => {
        if (!lot.expiry) return;
        const days = daysUntil(lot.expiry);
        if (days <= THRESHOLD_DAYS) {
          alerts.push({
            boxId,
            dept: box.dept || '—',
            drugName: drug.name || '—',
            isHAD: !!drug.had,
            expiry: lot.expiry,
            expiryThai: thaiDate(lot.expiry),
            lot: lot.lot || '',
            qty: lot.qty || 0,
            daysLeft: days,
            status: days < 0 ? 'expired' : days <= 7 ? 'critical' : days <= 15 ? 'warning' : 'notice',
            statusLabel: statusLabel(days),
          });
        }
      });
    });
  });

  alerts.sort((a, b) => a.daysLeft - b.daysLeft);
  return alerts;
}

// ── Build LINE message ─────────────────────────────────────────
function buildLineMessage(alerts) {
  const expired  = alerts.filter(a => a.status === 'expired');
  const critical = alerts.filter(a => a.status === 'critical');
  const warning  = alerts.filter(a => a.status === 'warning');
  const notice   = alerts.filter(a => a.status === 'notice');

  const todayStr = new Date().toLocaleDateString('th-TH', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  let msg = `\n🏥 EB Notify — รพ.กรงปินัง\n`;
  msg += `📅 ${todayStr}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `พบยาที่ต้องดำเนินการ ${alerts.length} รายการ\n`;

  if (expired.length) {
    msg += `\n🔴 หมดอายุแล้ว (${expired.length} รายการ)\n`;
    expired.forEach(a => {
      msg += `• ${a.boxId} · ${a.dept}\n  ${a.drugName}${a.isHAD ? ' ⚠️HAD' : ''}\n  หมด: ${a.expiryThai} (เกิน ${Math.abs(a.daysLeft)} วัน)\n`;
    });
  }
  if (critical.length) {
    msg += `\n🟠 วิกฤต ≤7 วัน (${critical.length} รายการ)\n`;
    critical.forEach(a => {
      msg += `• ${a.boxId} · ${a.dept}\n  ${a.drugName}${a.isHAD ? ' ⚠️HAD' : ''}\n  หมด: ${a.expiryThai} (เหลือ ${a.daysLeft} วัน)\n`;
    });
  }
  if (warning.length) {
    msg += `\n🟡 ใกล้กำหนด ≤15 วัน (${warning.length} รายการ)\n`;
    warning.forEach(a => {
      msg += `• ${a.boxId} · ${a.dept}  ${a.drugName} (${a.daysLeft} วัน)\n`;
    });
  }
  if (notice.length) {
    msg += `\n🔵 เตือนล่วงหน้า (${notice.length} รายการ)\n`;
    notice.slice(0, 8).forEach(a => {
      msg += `• ${a.boxId} · ${a.drugName.split(' ')[0]}... (${a.daysLeft} วัน)\n`;
    });
    if (notice.length > 8) msg += `  ... อีก ${notice.length - 8} รายการ\n`;
  }

  msg += `\n🔗 emergencyboxnotyfykpnhos.web.app`;
  return msg;
}

// ── Send LINE Messaging API ────────────────────────────────────
// ส่งแบบ push (ถ้ามี LINE_USER_ID) หรือ broadcast (ส่งถึงทุก follower)
function sendLineMessage(channelToken, message, userId) {
  return new Promise((resolve) => {
    const useBroadcast = !userId;
    const path = useBroadcast
      ? '/v2/bot/message/broadcast'
      : '/v2/bot/message/push';

    // LINE Messaging API รองรับข้อความสูงสุด 5000 ตัวอักษร ต่อ message object
    const messages = [];
    // ถ้าข้อความยาวเกิน แยกส่ง 2 bubble
    if (message.length > 4500) {
      messages.push({ type: 'text', text: message.slice(0, 4500) });
      messages.push({ type: 'text', text: message.slice(4500) });
    } else {
      messages.push({ type: 'text', text: message });
    }

    const payload = JSON.stringify(
      useBroadcast ? { messages } : { to: userId, messages }
    );

    const req = https.request({
      hostname: 'api.line.me',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${channelToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`✅ LINE Messaging API: ส่งสำเร็จ (${useBroadcast ? 'broadcast' : `push → ${userId}`})`);
          resolve(true);
        } else {
          console.error(`❌ LINE Messaging API: ${res.statusCode} — ${data}`);
          resolve(false);
        }
      });
    });
    req.on('error', err => { console.error('❌ LINE error:', err.message); resolve(false); });
    req.write(payload);
    req.end();
  });
}

// ── Build HTML Email ───────────────────────────────────────────
function buildHtmlEmail(alerts) {
  const rows = alerts.slice(0, 40).map(a => {
    const color = a.status === 'expired' ? '#E03E3E' : a.status === 'critical' ? '#D9810F' : a.status === 'warning' ? '#EE8A2B' : '#1A6FA3';
    const days = a.daysLeft < 0 ? `เกิน ${Math.abs(a.daysLeft)} วัน` : `เหลือ ${a.daysLeft} วัน`;
    return `
      <tr>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8;font-weight:600">${a.boxId}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8">${a.dept}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8">${a.drugName}${a.isHAD ? ' <span style="color:#E03E3E;font-size:11px;font-weight:700">HAD</span>' : ''}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8;color:${color};font-weight:600">${a.statusLabel}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8">${a.expiryThai}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8;color:${color};font-weight:600">${days}</td>
      </tr>`;
  }).join('');

  const expired  = alerts.filter(a => a.status === 'expired').length;
  const critical = alerts.filter(a => a.status === 'critical').length;

  return `<!DOCTYPE html>
<html lang="th">
<head><meta charset="utf-8"><title>EB Notify</title></head>
<body style="margin:0;padding:20px;background:#F0F4F8;font-family:'Sarabun',Arial,sans-serif">
  <div style="max-width:720px;margin:0 auto">
    <div style="background:linear-gradient(135deg,#1A6FA3 0%,#168C84 100%);padding:28px 32px;border-radius:16px 16px 0 0;color:#fff">
      <div style="font-size:13px;opacity:.8;margin-bottom:4px">ฝ่ายเภสัชกรรม · โรงพยาบาลกรงปินัง</div>
      <h1 style="margin:0;font-size:22px;font-weight:700">🏥 แจ้งเตือนยาใกล้หมดอายุ</h1>
      <div style="margin-top:8px;font-size:14px;opacity:.85">
        ${new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
      </div>
    </div>
    <div style="background:#fff;padding:24px 32px;border:1px solid #E2E8F0;border-top:0">
      <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
        ${expired ? `<span style="background:#FCEDED;color:#B42121;border-radius:8px;padding:8px 16px;font-weight:700;font-size:14px">🔴 หมดอายุแล้ว ${expired} รายการ</span>` : ''}
        ${critical ? `<span style="background:#FBF1E0;color:#9A5000;border-radius:8px;padding:8px 16px;font-weight:700;font-size:14px">🟠 วิกฤต ${critical} รายการ</span>` : ''}
        <span style="background:#E8F0F6;color:#1A6FA3;border-radius:8px;padding:8px 16px;font-weight:700;font-size:14px">รวมทั้งหมด ${alerts.length} รายการ</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#F5F7FA">
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">กล่อง</th>
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">แผนก</th>
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">ชื่อยา</th>
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">สถานะ</th>
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">วันหมดอายุ</th>
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">เวลาเหลือ</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${alerts.length > 40 ? `<p style="color:#7B8D9C;font-size:12px;margin-top:12px">... และอีก ${alerts.length - 40} รายการ</p>` : ''}
      <div style="margin-top:24px;padding-top:20px;border-top:1px solid #F0F4F8">
        <a href="https://emergencyboxnotyfykpnhos.web.app" style="display:inline-block;background:#1A6FA3;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px">เปิดระบบ EB Notify →</a>
      </div>
    </div>
    <div style="background:#F5F7FA;padding:14px 32px;border:1px solid #E2E8F0;border-top:0;border-radius:0 0 16px 16px;font-size:11px;color:#9AAAB8;text-align:center">
      ส่งอัตโนมัติทุกวัน 08:00 น. โดยระบบ EB Notify — ฝ่ายเภสัชกรรม รพ.กรงปินัง · <a href="https://emergencyboxnotyfykpnhos.web.app" style="color:#1A6FA3;text-decoration:none">emergencyboxnotyfykpnhos.web.app</a>
    </div>
  </div>
</body>
</html>`;
}

// ── Send Email via Gmail SMTP ──────────────────────────────────
async function sendEmail(alerts) {
  const from = process.env.EMAIL_FROM;
  const pass = process.env.EMAIL_PASS;
  const to   = process.env.EMAIL_TO;
  if (!from || !pass || !to) { console.log('⚠️  Email: ไม่ได้ตั้งค่า secrets (EMAIL_FROM / EMAIL_PASS / EMAIL_TO)'); return false; }

  console.log(`📧 Email: from=${from} to=${to}`);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: from, pass },
  });

  const expired  = alerts.filter(a => a.status === 'expired').length;
  const critical = alerts.filter(a => a.status === 'critical').length;
  let subject = `แจ้งเตือนยาใกล้หมดอายุ Emergency Box (${alerts.length} รายการ) - รพ.กรงปินัง`;
  if (expired)  subject = `[ด่วน] ยาหมดอายุแล้ว ${expired} รายการ - Emergency Box รพ.กรงปินัง`;
  else if (critical) subject = `[ด่วน] ยาวิกฤต ${critical} รายการ - Emergency Box รพ.กรงปินัง`;

  const toList = to.split(',').map(e => e.trim());

  try {
    await transporter.sendMail({
      from: `"ระบบ Emergency Box รพ.กรงปินัง" <${from}>`,
      to: toList,
      replyTo: from,
      subject,
      html: buildHtmlEmail(alerts),
      headers: {
        'X-Priority': expired || critical ? '1' : '3',
        'X-Mailer': 'EB-Notify/1.0',
        'List-Unsubscribe': `<mailto:${from}?subject=unsubscribe>`,
      },
    });
    console.log(`✅ Email: ส่งถึง ${to} สำเร็จ`);
    return true;
  } catch (err) {
    console.error('❌ Email error:', err.message);
    return false;
  }
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔍 ตรวจสอบยาใกล้หมดอายุ (ภายใน ${THRESHOLD_DAYS} วัน)...`);
  console.log(`📅 วันที่: ${TODAY.toLocaleDateString('th-TH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`);

  let alerts;
  try {
    alerts = await fetchExpiringDrugs();
  } catch (err) {
    console.error('❌ Firestore error:', err.message);
    process.exit(1);
  }

  if (!alerts.length) {
    console.log(`\n✅ ไม่พบยาใกล้หมดอายุภายใน ${THRESHOLD_DAYS} วัน — ไม่ต้องแจ้งเตือน`);
    console.log('💡 หมายเหตุ: ถ้าในแอปมียาแต่ที่นี่บอกว่าไม่พบ → ข้อมูลใน Firestore อาจยังไม่ถูก sync');
    console.log('   กรุณาเปิดแอปแล้ว login ด้วย admin เพื่อให้ระบบ sync ข้อมูลขึ้น Firestore');
    process.exit(0);
  }

  const expired  = alerts.filter(a => a.status === 'expired').length;
  const critical = alerts.filter(a => a.status === 'critical').length;
  const warning  = alerts.filter(a => a.status === 'warning').length;
  const notice   = alerts.filter(a => a.status === 'notice').length;

  console.log(`📊 สรุป: หมดอายุแล้ว ${expired} | วิกฤต ${critical} | ใกล้กำหนด ${warning} | เตือนล่วงหน้า ${notice}\n`);

  const lineResult = process.env.LINE_CHANNEL_TOKEN
    ? await sendLineMessage(process.env.LINE_CHANNEL_TOKEN, buildLineMessage(alerts), process.env.LINE_USER_ID || '')
    : (console.log('⚠️  LINE: ไม่ได้ตั้งค่า LINE_CHANNEL_TOKEN'), false);

  const emailResult = await sendEmail(alerts);

  console.log('\n── สรุปผลการแจ้งเตือน ──');
  console.log(`LINE:  ${lineResult ? '✅ สำเร็จ' : '❌ ล้มเหลว / ไม่ได้ตั้งค่า'}`);
  console.log(`Email: ${emailResult ? '✅ สำเร็จ' : '❌ ล้มเหลว / ไม่ได้ตั้งค่า'}`);

  // ต้องส่งได้อย่างน้อย 1 ช่องทาง — ถ้าไม่ได้เลย exit 1 ให้ GitHub Actions แสดงสีแดง
  const atLeastOneConfigured = process.env.LINE_CHANNEL_TOKEN || (process.env.EMAIL_FROM && process.env.EMAIL_PASS && process.env.EMAIL_TO);
  if (atLeastOneConfigured && !lineResult && !emailResult) {
    console.error('\n❌ การแจ้งเตือนล้มเหลวทุกช่องทาง');
    process.exit(1);
  }

  console.log(lineResult || emailResult ? '\n✅ แจ้งเตือนสำเร็จ' : '\n⚠️  ไม่ได้ตั้งค่า secrets — ข้ามการแจ้งเตือน');
}

main().catch(err => { console.error(err); process.exit(1); });
