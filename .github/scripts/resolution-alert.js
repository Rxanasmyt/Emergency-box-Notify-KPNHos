/**
 * Follow-up "resolved" confirmation — fired once a pharmacist/admin saves
 * an expiry-action or box-opened-action resolution in the authenticated
 * app (index.html's saveExpiryResolution()/saveBoxOpenResolution()), right
 * after that Firestore write is confirmed. Sends a plain confirmation LINE
 * card into the SAME group the original alert went to, so the pharmacy
 * sees the loop was closed (who, what action, when) without anyone having
 * to reopen the app to check. Purely a convenience notification — the real
 * record of what happened already lives in expiry_actions/box_open_actions
 * and audit_log; a failed send here never blocks or rolls back that write
 * (see index.html's fire-and-forget call site).
 *
 * Uses only Node's built-in `https` — same as usage-alert.js, no
 * firebase-admin/nodemailer needed, so this workflow skips `npm ci` too.
 */
const https = require('https');

// sendMOPHNotifyOnce/sendMOPHNotify: identical copy of usage-alert.js's
// retry-safe MOPH Notify sender — kept as its own copy rather than a shared
// module, matching this project's existing no-shared-module design for
// these small standalone Action scripts (see usage-alert.js's own note on
// why, and check-expiry.js's local thaiDate() for the same pattern).
function sendMOPHNotifyOnce(clientKey, secretKey, messages) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; resolve(val); };
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
          finish(true);
        } else {
          console.error(`❌ MOPH Notify: ${res.statusCode} — ${data}`);
          finish(false);
        }
      });
    });
    req.setTimeout(30000, () => { console.error('❌ MOPH Notify timeout (30s)'); req.destroy(); finish(false); });
    req.on('error', err => { if (err.code !== 'ERR_SOCKET_DESTROYED') console.error('❌ MOPH Notify error:', err.message); finish(false); });
    req.write(payload);
    req.end();
  });
}

async function sendMOPHNotify(clientKey, secretKey, messages) {
  const first = await sendMOPHNotifyOnce(clientKey, secretKey, messages);
  if (first) { console.log('✅ MOPH Notify: ส่งเข้ากลุ่ม LINE สำเร็จ'); return true; }
  console.warn('⚠️  MOPH Notify: ครั้งแรกไม่สำเร็จ กำลังลองอีกครั้ง...');
  await new Promise(r => setTimeout(r, 3000));
  const second = await sendMOPHNotifyOnce(clientKey, secretKey, messages);
  if (second) { console.log('✅ MOPH Notify: ส่งเข้ากลุ่ม LINE สำเร็จ (ลองครั้งที่ 2)'); return true; }
  console.error('❌ MOPH Notify: ล้มเหลวทั้ง 2 ครั้ง');
  return false;
}

function row(label, value) {
  return {
    type: 'box', layout: 'horizontal', margin: 'md',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#78909C', flex: 2 },
      { type: 'text', text: value, size: 'sm', weight: 'bold', color: '#1A1A2E', flex: 3, wrap: true },
    ],
  };
}

// Same short Thai-date format (Buddhist calendar) as check-expiry.js's/
// usage-alert.js's own copies — see usage-alert.js's header comment on why
// this stays a local copy rather than a shared import at this file size.
function thaiDate(isoDate) {
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const d = new Date(isoDate + 'T00:00:00');
  if (isNaN(d.getTime())) return isoDate || '—';
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function buildResolutionFlex({ kind, boxId, detail, action, note, resolvedBy, date, time }) {
  const detailLabel = kind === 'boxopen' ? '🏥  หน่วยงาน' : '💊  ยา';
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#0F6E4F', paddingAll: '16px',
      contents: [
        { type: 'text', text: '✅ ดำเนินการเรียบร้อยแล้ว', color: '#FFFFFF', weight: 'bold', size: 'md' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '18px', spacing: 'sm',
      contents: [
        { type: 'text', text: boxId, size: 'xxl', weight: 'bold', color: '#1A1A2E' },
        { type: 'separator', margin: 'lg' },
        row(detailLabel, detail || '—'),
        row('🛠️  การดำเนินการ', action || '—'),
        note ? row('📝  หมายเหตุ', note) : null,
        row('👤  บันทึกโดย', resolvedBy || '—'),
        row('📅  วันเวลา', `${thaiDate(date)} · ${time} น.`),
      ].filter(Boolean),
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
  // spliced into a shell command — same discipline as usage-alert.js/
  // reset-data.yml.
  const kind = process.env.KIND || 'expiry';
  const boxId = process.env.BOX_ID || '—';
  const detail = process.env.DETAIL || '—';
  const action = process.env.ACTION || '—';
  const note = process.env.NOTE || '';
  const resolvedBy = process.env.RESOLVED_BY || '—';
  const date = process.env.DATE || '—';
  const time = process.env.TIME || '—';

  const flex = buildResolutionFlex({ kind, boxId, detail, action, note, resolvedBy, date, time });
  const ok = await sendMOPHNotify(clientKey, secretKey, [
    { type: 'flex', altText: `✅ ${boxId} ดำเนินการเรียบร้อยแล้ว — ${action}`, contents: flex },
  ]);
  if (!ok) process.exitCode = 1;
}

main().catch(err => { console.error('❌ resolution-alert.js error:', err.message); process.exitCode = 1; });
