/**
 * Real-time "box opened" alert — fired once per dispense cycle, the moment
 * the FIRST paperless usage-log entry is recorded against a box via the
 * public QR page (see index.html's submitPubUsage(), which only triggers
 * this workflow when logDrugUsageTx()'s transaction result reports
 * `openedNow: true`). Lets the pharmacy respond immediately by preparing a
 * replacement box, instead of finding out only when the box is eventually
 * returned or someone happens to check the dashboard — directly closes the
 * real-world gap behind KPI HA-2 (box readiness): a box that's been opened
 * is no longer guaranteed complete/verified (see returnBoxAndDrugsTx's
 * force-re-verify-on-return invariant elsewhere in this app), so the sooner
 * the pharmacy knows, the sooner a fresh verified box can take its place.
 *
 * Sent as a LINE Flex card (not a plain text bubble) so "which box, which
 * department, what was used, how much" reads at a glance instead of as a
 * run-on sentence — the pharmacist receiving this needs to grab the right
 * replacement box fast, not parse a paragraph. Uses the same rounded-card/
 * pill-badge visual language as buildFlexMessages()'s near-expiry cards in
 * check-expiry.js (a distinct amber header color keeps it visually
 * distinguishable from that daily report's own cards at a glance, even
 * though the shapes are the same family).
 *
 * Deliberately excludes HN/patient name — this message may be seen by
 * anyone in the LINE group MOPH Notify posts into, and the only thing
 * needed to act (which box, which department, what was used, when) never
 * requires identifying the patient. HN/patient name stay recorded in
 * usage_log for audit purposes, same as they always were; this alert just
 * doesn't repeat them into a wider channel than necessary.
 *
 * Uses only Node's built-in `https` — no firebase-admin/nodemailer needed
 * for this one job, so the workflow that runs this skips `npm ci` entirely.
 */
const https = require('https');

function sendMOPHNotifyOnce(clientKey, secretKey, messages) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ messages });
    const req = https.request({
      hostname: 'morpromt2f.moph.go.th',
      path: '/api/notify/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'client-key': clientKey,
        'secret-key': secretKey,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          console.error(`❌ MOPH Notify: ${res.statusCode} — ${data}`);
          resolve(false);
        }
      });
    });
    req.setTimeout(30000, () => { console.error('❌ MOPH Notify timeout (30s)'); req.destroy(); });
    req.on('error', err => { if (err.code !== 'ERR_SOCKET_DESTROYED') console.error('❌ MOPH Notify error:', err.message); resolve(false); });
    req.write(payload);
    req.end();
  });
}

// This alert fires exactly once per dispense cycle with no other retry path
// anywhere in the app if it fails silently — unlike daily-notify.yml (which
// gets another chance tomorrow) or the in-app manual trigger (which the
// admin can just click again), a missed box-opened alert is gone for good;
// the pharmacy simply never finds out the box was opened until someone
// happens to check the dashboard. A single transient blip talking to a
// government API (morpromt2f.moph.go.th) — a momentary DNS hiccup, a 5xx,
// the 30s timeout above — must not be the difference between "pharmacy
// notified" and "pharmacy never knows", so retry once after a short delay
// before giving up. Real duplicate delivery from this retry is not a
// practical concern: it only re-fires when the FIRST attempt was already
// confirmed to have failed (non-2xx/timeout/network error), never after an
// ambiguous outcome.
async function sendMOPHNotify(clientKey, secretKey, messages) {
  const first = await sendMOPHNotifyOnce(clientKey, secretKey, messages);
  if (first) { console.log('✅ MOPH Notify: ส่งเข้ากลุ่ม LINE สำเร็จ'); return true; }
  console.warn('⚠️  MOPH Notify: ครั้งแรกไม่สำเร็จ กำลังลองอีกครั้ง...');
  await new Promise(r => setTimeout(r, 3000));
  const second = await sendMOPHNotifyOnce(clientKey, secretKey, messages);
  if (second) { console.log('✅ MOPH Notify: ส่งเข้ากลุ่ม LINE สำเร็จ (ลองครั้งที่ 2)'); return true; }
  console.error('❌ MOPH Notify: ล้มเหลวทั้ง 2 ครั้ง — ไม่สามารถแจ้งเตือนห้องยาได้');
  return false;
}

// One row: a muted label on the left, the real value bold on the right —
// same "label : value" row shape used throughout this app's other Flex
// messages, kept here as its own helper since this file has no shared
// module to import it from (see the file header for why that's fine at
// this size).
function row(label, value) {
  return {
    type: 'box', layout: 'horizontal', margin: 'md',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#78909C', flex: 2 },
      { type: 'text', text: value, size: 'sm', weight: 'bold', color: '#1A1A2E', flex: 3, wrap: true },
    ],
  };
}

// Same short Thai-date format (Buddhist calendar) as check-expiry.js's own
// thaiDate() helper — kept as a local copy rather than a shared import, same
// reasoning as row() above (this file has no shared module to pull from).
// isoDate is expected to already be a plain YYYY-MM-DD string (the app's
// own this.isoOf(this.TODAY), Bangkok-anchored — see index.html's `TODAY`
// getter comment for why this app never uses a raw device-local date here).
function thaiDate(isoDate) {
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const d = new Date(isoDate + 'T00:00:00');
  if (isNaN(d.getTime())) return isoDate || '—'; // malformed/missing date input — show raw rather than crash
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function buildUsageAlertFlex({ boxId, dept, drugName, qty, date, time }) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#D97706', paddingAll: '16px',
      contents: [
        { type: 'text', text: '🔔 กล่องยาฉุกเฉินถูกเปิดใช้งาน', color: '#FFFFFF', weight: 'bold', size: 'md' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '18px', spacing: 'sm',
      contents: [
        // box ID front and center, large — the single most important thing
        // to see in under a second — with the department as a pill beside it
        {
          type: 'box', layout: 'horizontal', alignItems: 'center',
          contents: [
            { type: 'text', text: boxId, size: 'xxl', weight: 'bold', color: '#1A1A2E', flex: 0 },
            {
              type: 'box', layout: 'vertical', backgroundColor: '#1A6FA3', cornerRadius: '20px',
              paddingTop: '4px', paddingBottom: '4px', paddingStart: '12px', paddingEnd: '12px', margin: 'md',
              contents: [{ type: 'text', text: dept, color: '#FFFFFF', size: 'sm', weight: 'bold' }],
            },
          ],
        },
        { type: 'separator', margin: 'lg' },
        row('💊  ยาที่ใช้', drugName),
        row('🔢  จำนวน', String(qty)),
        row('📅  วันเวลา', `${thaiDate(date)} · ${time} น.`),
        { type: 'separator', margin: 'lg' },
        {
          type: 'text', margin: 'lg', wrap: true, size: 'sm', weight: 'bold', color: '#B45F06',
          text: '⚠️ กรุณาเตรียมกล่องสำรองเปลี่ยนให้พร้อมใช้งานโดยเร็ว',
        },
      ],
    },
    // "ดูรายละเอียดกล่อง" deep-links straight to this box's own real-time QR
    // status page (no login needed — see the Paperless Usage Logging section
    // of CLAUDE.md) so the pharmacist can check the box's current drug/lot
    // data immediately from the alert, instead of only reading this
    // snapshot-in-time card. Hardcoding the production Hosting URL here
    // (rather than deriving it, the way showDrugQR() does client-side) is
    // fine specifically because this workflow only ever runs against the
    // one deployed production app — there's no "current origin" concept for
    // a GitHub Actions job the way there is for a page loaded in a browser.
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
      contents: [
        {
          type: 'button', style: 'primary', color: '#1A6FA3', height: 'sm',
          action: { type: 'uri', label: '📋 ดูรายละเอียดกล่อง', uri: `https://emergencyboxnotyfykpnhos.web.app/?view=box&id=${encodeURIComponent(boxId)}` },
        },
      ],
    },
  };
}

async function main() {
  const clientKey = process.env.MOPH_NOTIFY_CLIENT_KEY;
  const secretKey = process.env.MOPH_NOTIFY_SECRET_KEY;
  if (!clientKey || !secretKey) {
    console.log('⚠️  ไม่ได้ตั้งค่า MOPH_NOTIFY_CLIENT_KEY / MOPH_NOTIFY_SECRET_KEY — ข้ามการแจ้งเตือน');
    return;
  }
  // all untrusted input arrives via env (workflow_dispatch inputs), never
  // spliced into a shell command — see reset-data.yml's own comment on this
  // exact class of risk for workflow-dispatch inputs.
  const boxId = process.env.BOX_ID || '—';
  const dept = process.env.DEPT || '—';
  const drugName = process.env.DRUG_NAME || '—';
  const qty = process.env.QTY || '—';
  const date = process.env.DATE || '—';
  const time = process.env.TIME || '—';

  const flex = buildUsageAlertFlex({ boxId, dept, drugName, qty, date, time });
  const ok = await sendMOPHNotify(clientKey, secretKey, [
    { type: 'flex', altText: `🔔 กล่อง ${boxId} (${dept}) ถูกเปิดใช้งานแล้ว — ${drugName} × ${qty}`, contents: flex },
  ]);
  if (!ok) process.exitCode = 1;
}

main().catch(err => { console.error('❌ usage-alert.js error:', err.message); process.exitCode = 1; });
