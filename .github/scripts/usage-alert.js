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
 * Deliberately a plain LINE text message, not a Flex card like the daily
 * report — this is a one-line operational ping meant to be read in a
 * glance, not a report to review, and should visually read as a different
 * *kind* of notification from the daily near-expiry summary.
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

function sendMOPHNotify(clientKey, secretKey, messages) {
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
          console.log('✅ MOPH Notify: ส่งเข้ากลุ่ม LINE สำเร็จ');
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
  const time = process.env.TIME || '—';

  const text = `🔔 กล่องยาฉุกเฉิน ${boxId} (${dept}) ถูกเปิดใช้งานแล้ว\n` +
    `ยาที่ใช้: ${drugName} จำนวน ${qty}\n` +
    `เวลา ${time} น.\n` +
    `กรุณาเตรียมกล่องสำรองเปลี่ยนให้พร้อมใช้งานโดยเร็ว`;

  const ok = await sendMOPHNotify(clientKey, secretKey, [{ type: 'text', text }]);
  if (!ok) process.exitCode = 1;
}

main().catch(err => { console.error('❌ usage-alert.js error:', err.message); process.exitCode = 1; });
