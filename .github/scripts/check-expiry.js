/**
 * Daily Drug Expiry Check & Notification
 * Runs via GitHub Actions every day at 09:00 AM Bangkok time (02:00 UTC)
 *
 * Required GitHub Secrets:
 *   FIREBASE_SERVICE_ACCOUNT   - Firebase Admin SDK JSON (already set)
 *   MOPH_NOTIFY_CLIENT_KEY     - client-key จาก CMS MOPH Notify (ส่งเข้ากลุ่ม LINE หมอพร้อม)
 *   MOPH_NOTIFY_SECRET_KEY     - secret-key จาก CMS MOPH Notify
 *   EMAIL_FROM                 - Gmail address (sender)
 *   EMAIL_PASS                 - Gmail App Password (16-char, not account password)
 *   EMAIL_TO                   - Recipient email (comma-separated for multiple)
 *   NOTIFY_DAYS_AHEAD          - (optional) days threshold, default 60
 */

'use strict';

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const https = require('https');

// ── Init Firebase Admin ────────────────────────────────────────
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT ไม่ถูกต้อง — ไม่ใช่ JSON ที่ valid:', e.message);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// แจ้งเตือนยาที่หมดอายุภายใน NOTIFY_DAYS_AHEAD วัน (default 60 วัน)
const _rawDays = parseInt(process.env.NOTIFY_DAYS_AHEAD || '60', 10);
const THRESHOLD_DAYS = isNaN(_rawDays) || _rawDays <= 0 ? 60 : Math.min(_rawDays, 365);
// Use Bangkok time (UTC+7) so expiry comparisons match Thai calendar day
// Use Intl.DateTimeFormat with en-CA (yields ISO YYYY-MM-DD) to avoid unreliable
// locale-string parsing which is implementation-defined in Node.js on Linux
const _todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
const TODAY = new Date(_todayISO + 'T00:00:00');
const TODAY_ISO = `${TODAY.getFullYear()}-${String(TODAY.getMonth()+1).padStart(2,'0')}-${String(TODAY.getDate()).padStart(2,'0')}`;
// workflow_dispatch = user pressed button → always send; schedule = cron → dedup
const IS_MANUAL = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

async function getLastSentDate() {
  try {
    const doc = await db.collection('app_settings').doc('notifications').get();
    return doc.exists ? (doc.data().lastSentDate || '') : '';
  } catch { return ''; }
}

async function markSentToday() {
  try {
    await db.collection('app_settings').doc('notifications').set({ lastSentDate: TODAY_ISO }, { merge: true });
  } catch (err) { console.warn('⚠️  บันทึก lastSentDate ล้มเหลว:', err.message); }
}

// ── Helpers ────────────────────────────────────────────────────
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isValidISODate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return false;
  // round-trip check: rolled-over dates (e.g. 2025-02-30) parse without error in V8
  // but the reconstructed ISO string differs from the input
  const y = d.getFullYear(), mo = String(d.getMonth()+1).padStart(2,'0'), dy = String(d.getDate()).padStart(2,'0');
  return `${y}-${mo}-${dy}` === s;
}

function daysUntil(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  return Math.round((d - TODAY) / 86400000);
}

function thaiDate(isoDate) {
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const d = new Date(isoDate + 'T00:00:00');
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function addDaysISO(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function statusLabel(days) {
  if (days < 0)   return 'หมดอายุแล้ว';
  if (days === 0) return 'หมดอายุวันนี้';
  if (days <= 15) return 'วิกฤต — ต้องส่งคืนด่วน';
  if (days <= 30) return 'ใกล้กำหนดส่งคืน';
  return 'เตือนล่วงหน้า';
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
    if (!data) return;
    const boxId = doc.id;
    if (!boxes[boxId]) console.warn(`[checkExpiry] box_drugs doc "${boxId}" has no matching box — dept will show as 'ห้องยา'`);
    const box = boxes[boxId] || {};
    const drugs = data.drugs || [];

    drugs.forEach(drug => {
      const lots = drug.lots || [];
      lots.forEach(lot => {
        if (!lot.expiry || typeof lot.expiry !== 'string' || !isValidISODate(lot.expiry)) return;
        const days = daysUntil(lot.expiry);
        if (days <= THRESHOLD_DAYS) {
          const returnDeadline = addDaysISO(lot.expiry, -15);
          const isOut = !!(box.dispense && !box.receiver);
          alerts.push({
            boxId,
            location: isOut ? (box.dept || 'หน่วยงาน') : 'ห้องยา',
            isOut,
            drugName: drug.name || '—',
            isHAD: !!drug.had,
            expiry: lot.expiry,
            expiryThai: thaiDate(lot.expiry),
            lot: lot.lot || '',
            qty: lot.qty || 0,
            returnDeadline,
            returnDeadlineThai: thaiDate(returnDeadline),
            daysLeft: days,
            status: days <= 0 ? 'expired' : days <= 15 ? 'critical' : days <= 30 ? 'warning' : 'notice',
            statusLabel: statusLabel(days),
          });
        }
      });
    });
  });

  alerts.sort((a, b) => a.daysLeft - b.daysLeft);
  return alerts;
}

// ── Per-box status summary (used for the "all clear" report — no near-expiry
// drugs found, but the admin/pharmacist still wants to see each box's
// current state at a glance rather than just a bare count) ────────────────
async function fetchBoxSummaries() {
  const boxSnap = await db.collection('boxes').get();
  const bdSnap = await db.collection('box_drugs').get();
  const bd = {};
  bdSnap.forEach(doc => { bd[doc.id] = (doc.data() && doc.data().drugs) || []; });

  const summaries = [];
  boxSnap.forEach(doc => {
    const box = doc.data() || {};
    const drugs = bd[doc.id] || [];
    let nearestExpiry = null;
    drugs.forEach(d => (d.lots || []).forEach(lot => {
      if (lot.expiry && typeof lot.expiry === 'string' && isValidISODate(lot.expiry)) {
        if (!nearestExpiry || lot.expiry < nearestExpiry) nearestExpiry = lot.expiry;
      }
    }));
    const isOut = !!(box.dispense && !box.receiver);
    const stage = box.registeredAt ? 'verified' : box.preparedAt ? 'prepared' : 'none';
    summaries.push({
      boxId: doc.id,
      isOut,
      dept: box.dept || '',
      drugCount: drugs.length,
      nearestExpiry,
      daysLeft: nearestExpiry ? daysUntil(nearestExpiry) : null,
      stage,
    });
  });

  summaries.sort((a, b) => {
    const na = parseInt(a.boxId.replace(/\D/g, ''), 10) || 0;
    const nb = parseInt(b.boxId.replace(/\D/g, ''), 10) || 0;
    return na - nb;
  });
  return summaries;
}

function stageIconLabel(stage) {
  if (stage === 'verified') return { icon: '🟢', label: 'ยืนยันแล้ว' };
  if (stage === 'prepared') return { icon: '🟡', label: 'รอตรวจสอบ' };
  return { icon: '⚪', label: 'ยังไม่จัดเตรียม' };
}

// ── Build the all-clear LINE message as a Flex carousel — mirrors
// buildFlexMessages' premium card style (stat tiles + colored box cards)
// instead of a wall of plain text, so the per-box breakdown is scannable
// at a glance rather than requiring the reader to parse line-by-line.
function buildAllClearFlexMessages(summaries) {
  const dateStr = TODAY.toLocaleDateString('th-TH', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Bangkok',
  });
  const verifiedCount = summaries.filter(s => s.stage === 'verified').length;
  const outCount = summaries.filter(s => s.isOut).length;
  const needsAttnCount = summaries.filter(s => s.stage !== 'verified').length;

  function statBox(emoji, count, label, bg) {
    return {
      type: 'box', layout: 'vertical', flex: 1, margin: 'sm',
      backgroundColor: bg, cornerRadius: '14px', paddingAll: '14px',
      contents: [
        { type: 'text', text: String(count), size: '3xl', weight: 'bold', color: '#FFFFFF', align: 'center' },
        { type: 'text', text: emoji, size: 'lg', align: 'center', margin: 'xs' },
        { type: 'text', text: label, size: 'xs', color: '#FFFFFF', align: 'center', wrap: true, margin: 'xs' },
      ],
    };
  }

  function pill(text, bg, fg = '#FFFFFF') {
    return {
      type: 'box', layout: 'vertical', flex: 0,
      backgroundColor: bg, cornerRadius: '20px',
      paddingTop: '4px', paddingBottom: '4px', paddingStart: '10px', paddingEnd: '10px',
      contents: [{ type: 'text', text, color: fg, size: 'xs', weight: 'bold' }],
    };
  }

  function boxCard(s, borderColor, itemBg) {
    const { label: stageLabel } = stageIconLabel(s.stage);
    const locText = s.isOut ? `🏥  จ่ายออก → ${s.dept || 'หน่วยงาน'}` : '💊  อยู่ห้องยา';
    const expText = s.nearestExpiry ? `เหลือ ${s.daysLeft} วัน (${thaiDate(s.nearestExpiry)})` : 'ไม่มีข้อมูล';
    return {
      type: 'box', layout: 'vertical', margin: 'md',
      backgroundColor: borderColor, cornerRadius: '14px', paddingAll: '2px',
      contents: [{
        type: 'box', layout: 'vertical',
        backgroundColor: itemBg, cornerRadius: '12px', paddingAll: '14px',
        contents: [
          { type: 'box', layout: 'horizontal', alignItems: 'center', contents: [
            pill(s.boxId.toUpperCase(), borderColor),
            { type: 'text', text: stageLabel, size: 'sm', weight: 'bold', color: '#1A1A2E', flex: 1, margin: 'sm' },
          ] },
          { type: 'box', layout: 'horizontal', margin: 'sm', alignItems: 'center',
            backgroundColor: '#EEF2F7', cornerRadius: '20px',
            paddingTop: '6px', paddingBottom: '6px', paddingStart: '12px', paddingEnd: '12px',
            contents: [{ type: 'text', text: locText, size: 'xs', color: '#455A64' }] },
          { type: 'box', layout: 'horizontal', margin: 'sm', alignItems: 'center', contents: [
            { type: 'text', text: `💊 ${s.drugCount} รายการ`, size: 'xs', color: '#78909C', flex: 1 },
            { type: 'text', text: `หมดอายุสุด: ${expText}`, size: 'xs', color: '#78909C', wrap: true },
          ] },
        ],
      }],
    };
  }

  const bubbles = [];

  // ── Summary bubble (green, mirrors the alert carousel's dark-navy one) ──
  bubbles.push({
    type: 'bubble', size: 'mega',
    body: {
      type: 'box', layout: 'vertical', backgroundColor: '#0F6E4F', paddingAll: '20px', spacing: 'none',
      contents: [
        { type: 'text', text: '✅  EB Notify', weight: 'bold', size: 'xl', color: '#FFFFFF' },
        { type: 'text', text: 'โรงพยาบาลกรงปินัง · ห้องยา', size: 'xs', color: '#B9E4D0', margin: 'xs' },
        { type: 'text', text: `📅  ${dateStr}`, size: 'xs', color: '#CFEFDF', margin: 'sm', wrap: true },
        { type: 'separator', margin: 'lg', color: '#1E8F68' },
        { type: 'text', text: `ไม่พบยาใกล้หมดอายุภายใน ${THRESHOLD_DAYS} วัน`, size: 'sm', color: '#FFFFFF', weight: 'bold', margin: 'lg', wrap: true },
        { type: 'box', layout: 'horizontal', margin: 'lg', contents: [
          statBox('📦', summaries.length, 'กล่องทั้งหมด', '#169C7F'),
          statBox('🟢', verifiedCount, 'พร้อมจ่าย', '#169C7F'),
        ] },
        { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
          statBox('📤', outCount, 'จ่ายออกอยู่', '#1A6FA3'),
          statBox('⏳', needsAttnCount, 'รอดำเนินการ', needsAttnCount > 0 ? '#D97706' : '#2C3E50'),
        ] },
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', backgroundColor: '#0A4A36', paddingAll: '14px',
      contents: [{
        type: 'button', style: 'primary', color: '#169C7F', height: 'sm',
        action: { type: 'uri', label: '🔗  เปิดแอป EB Notify', uri: 'https://emergencyboxnotyfykpnhos.web.app' },
      }],
    },
  });

  // ── Per-box detail bubbles, chunked 6/bubble — carousel limit 12 total ──
  for (let i = 0; i < summaries.length && bubbles.length < 12; i += 6) {
    const chunk = summaries.slice(i, i + 6);
    const titleSuffix = summaries.length > 6 ? ` (${Math.floor(i / 6) + 1}/${Math.ceil(summaries.length / 6)})` : '';
    bubbles.push({
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'horizontal', backgroundColor: '#169C7F', paddingAll: '16px', alignItems: 'center',
        contents: [
          { type: 'text', text: '📦', size: 'xxl', flex: 0 },
          { type: 'box', layout: 'vertical', margin: 'md', flex: 1, contents: [
            { type: 'text', text: `สถานะกล่อง${titleSuffix}`, color: '#FFFFFF', weight: 'bold', size: 'lg' },
            { type: 'text', text: `${chunk.length} กล่อง`, color: '#D2F0E4', size: 'xs', margin: 'xs' },
          ] },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', backgroundColor: '#F5FBF8', paddingAll: '12px', spacing: 'none',
        contents: chunk.map(s => boxCard(s, s.stage === 'verified' ? '#169C7F' : s.stage === 'prepared' ? '#D97706' : '#90A4AE', '#FFFFFF')),
      },
    });
  }

  return [{
    type: 'flex',
    altText: `✅ EB Notify — ไม่พบยาใกล้หมดอายุ · ${summaries.length} กล่องพร้อมใช้งาน`,
    contents: { type: 'carousel', contents: bubbles },
  }];
}

// ── Build Flex Messages (premium carousel) ─────────────────────
function buildFlexMessages(alerts) {
  const expired  = alerts.filter(a => a.status === 'expired');
  const critical = alerts.filter(a => a.status === 'critical');
  const warning  = alerts.filter(a => a.status === 'warning');
  const notice   = alerts.filter(a => a.status === 'notice');

  const todayStr = TODAY.toLocaleDateString('th-TH', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Bangkok',
  });

  // ── Helper: stat box (2×2 grid in summary) ──
  function statBox(emoji, count, label, activeBg) {
    const bg = count > 0 ? activeBg : '#2C3E50';
    const fg = count > 0 ? '#FFFFFF' : '#607D8B';
    return {
      type: 'box', layout: 'vertical', flex: 1, margin: 'sm',
      backgroundColor: bg, cornerRadius: '14px', paddingAll: '14px',
      contents: [
        { type: 'text', text: String(count), size: '3xl', weight: 'bold', color: '#FFFFFF', align: 'center' },
        { type: 'text', text: emoji, size: 'lg', align: 'center', margin: 'xs' },
        { type: 'text', text: label, size: 'xs', color: fg, align: 'center', wrap: true, margin: 'xs' },
      ],
    };
  }

  // ── Helper: pill badge ──
  function pill(text, bg, fg = '#FFFFFF') {
    return {
      type: 'box', layout: 'vertical', flex: 0,
      backgroundColor: bg, cornerRadius: '20px',
      paddingTop: '4px', paddingBottom: '4px', paddingStart: '10px', paddingEnd: '10px',
      contents: [{ type: 'text', text, color: fg, size: 'xs', weight: 'bold' }],
    };
  }

  // ── Helper: drug card (colored-border style) ──
  function drugCard(a, borderColor, itemBg) {
    const locText = a.isOut ? `🏥  เบิกออก → ${a.location}` : '💊  ห้องยา';
    const dayText = a.daysLeft < 0
      ? `เกิน ${Math.abs(a.daysLeft)} วัน`
      : a.daysLeft === 0 ? 'หมดวันนี้' : `เหลือ ${a.daysLeft} วัน`;
    const dayBadgeColor = a.daysLeft < 0 ? '#B71C1C' : a.daysLeft <= 7 ? '#C62828' : a.daysLeft <= 15 ? '#E64A19' : '#1565C0';

    const nameRow = [
      pill(a.boxId.toUpperCase(), borderColor),
      { type: 'text', text: a.drugName, size: 'sm', weight: 'bold', color: '#1A1A2E', flex: 1, margin: 'sm', wrap: true },
    ];
    if (a.isHAD) nameRow.push(pill('⚠ HAD', '#B71C1C'));

    return {
      // Outer colored border (2px padding trick)
      type: 'box', layout: 'vertical', margin: 'md',
      backgroundColor: borderColor, cornerRadius: '14px', paddingAll: '2px',
      contents: [{
        type: 'box', layout: 'vertical',
        backgroundColor: itemBg, cornerRadius: '12px', paddingAll: '14px',
        contents: [
          { type: 'box', layout: 'horizontal', alignItems: 'center', contents: nameRow },
          {
            type: 'box', layout: 'horizontal', margin: 'sm', alignItems: 'center',
            backgroundColor: '#EEF2F7', cornerRadius: '20px',
            paddingTop: '6px', paddingBottom: '6px', paddingStart: '12px', paddingEnd: '12px',
            contents: [{ type: 'text', text: locText, size: 'xs', color: '#455A64' }],
          },
          {
            type: 'box', layout: 'horizontal', margin: 'sm', alignItems: 'center',
            contents: [
              { type: 'text', text: `หมดอายุ  ${a.expiryThai}`, size: 'xs', color: '#78909C', flex: 1 },
              pill(dayText, dayBadgeColor),
            ],
          },
        ],
      }],
    };
  }

  const bubbles = [];

  // ── Summary bubble (dark navy) ──
  bubbles.push({
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', paddingAll: '0px',
      contents: [{ type: 'image', url: 'https://cdns.yellow-idea.com/moph/20250602/moph-flex-header-1.png', size: 'full', aspectRatio: '3120:885', aspectMode: 'cover' }],
    },
    body: {
      type: 'box', layout: 'vertical', backgroundColor: '#1B2A4A', paddingAll: '20px', spacing: 'none',
      contents: [
        { type: 'text', text: '🏥  EB Notify', weight: 'bold', size: 'xl', color: '#FFFFFF' },
        { type: 'text', text: 'โรงพยาบาลกรงปินัง · ห้องยา', size: 'xs', color: '#90CAF9', margin: 'xs' },
        { type: 'text', text: `📅  ${todayStr}`, size: 'xs', color: '#B0BEC5', margin: 'sm', wrap: true },
        { type: 'separator', margin: 'lg', color: '#2E4272' },
        { type: 'box', layout: 'horizontal', margin: 'lg',
          contents: [
            statBox('🔴', expired.length,  'หมดอายุ',     '#C62828'),
            statBox('🟠', critical.length, 'วิกฤต',       '#E64A19'),
          ],
        },
        { type: 'box', layout: 'horizontal', margin: 'sm',
          contents: [
            statBox('🟡', warning.length,  'ใกล้กำหนด',   '#E65100'),
            statBox('🔵', notice.length,   'เตือนล่วงหน้า','#1565C0'),
          ],
        },
        { type: 'separator', margin: 'lg', color: '#2E4272' },
        { type: 'text', text: `รวม ${alerts.length} รายการที่ต้องดำเนินการ`, size: 'xs', color: '#90A4AE', align: 'center', margin: 'md' },
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', backgroundColor: '#0D1B2E', paddingAll: '14px',
      contents: [{
        type: 'button', style: 'primary', color: '#1E88E5', height: 'sm',
        action: { type: 'uri', label: '🔗  เปิดแอป EB Notify', uri: 'https://emergencyboxnotyfykpnhos.web.app' },
      }],
    },
  });

  // ── Per-severity bubbles ──
  const severities = [
    { list: expired,  label: 'หมดอายุแล้ว',        emoji: '🔴', hBg: '#B71C1C', hFg: '#FFFFFF', bodyBg: '#FFF5F5', borderColor: '#C62828', itemBg: '#FFFFFF' },
    { list: critical, label: 'วิกฤต ≤ 15 วัน',     emoji: '🟠', hBg: '#BF360C', hFg: '#FFFFFF', bodyBg: '#FFF8F5', borderColor: '#E64A19', itemBg: '#FFFFFF' },
    { list: warning,  label: 'ใกล้กำหนด ≤ 30 วัน', emoji: '🟡', hBg: '#E65100', hFg: '#FFFFFF', bodyBg: '#FFFBF0', borderColor: '#F57F17', itemBg: '#FFFFFF' },
    { list: notice,   label: 'เตือนล่วงหน้า',      emoji: '🔵', hBg: '#0D47A1', hFg: '#FFFFFF', bodyBg: '#F0F8FF', borderColor: '#1565C0', itemBg: '#FFFFFF' },
  ];

  // LINE carousel limit = 12 bubbles; 1 reserved for summary → max 11 severity bubbles
  let severityBubbleCount = 0;
  severities.forEach(({ list, label, emoji, hBg, hFg, bodyBg, borderColor, itemBg }) => {
    if (!list.length) return;
    for (let i = 0; i < list.length; i += 6) {
      if (severityBubbleCount >= 11) break;
      const chunk = list.slice(i, i + 6);
      const titleSuffix = list.length > 6 ? ` (${Math.floor(i/6)+1}/${Math.ceil(list.length/6)})` : '';

      bubbles.push({
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'horizontal', backgroundColor: hBg, paddingAll: '16px', alignItems: 'center',
          contents: [
            { type: 'text', text: emoji, size: 'xxl', flex: 0 },
            {
              type: 'box', layout: 'vertical', margin: 'md', flex: 1,
              contents: [
                { type: 'text', text: `${label}${titleSuffix}`, color: hFg, weight: 'bold', size: 'lg' },
                { type: 'text', text: `${chunk.length} รายการ`, color: hFg, size: 'xs', margin: 'xs' },
              ],
            },
          ],
        },
        body: {
          type: 'box', layout: 'vertical', backgroundColor: bodyBg, paddingAll: '12px', spacing: 'none',
          contents: chunk.map(a => drugCard(a, borderColor, itemBg)),
        },
      });
      severityBubbleCount++;
    }
  });

  return [{
    type: 'flex',
    altText: `🏥 EB Notify — พบยาที่ต้องดำเนินการ ${alerts.length} รายการ`,
    contents: { type: 'carousel', contents: bubbles },
  }];
}

// ── Send MOPH Notify ──────────────────────────────────────────
// ส่งข้อความเข้ากลุ่ม LINE ที่บอท หมอพร้อม อยู่ในกลุ่ม
// Endpoint: POST https://morpromt2f.moph.go.th/api/notify/send
// messages = array of LINE message objects (text, flex, etc.)
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

// ── Build HTML Email ───────────────────────────────────────────
function buildHtmlEmail(alerts) {
  const expired  = alerts.filter(a => a.status === 'expired');
  const critical = alerts.filter(a => a.status === 'critical');
  const warning  = alerts.filter(a => a.status === 'warning');
  const notice   = alerts.filter(a => a.status === 'notice');
  const hadAlerts = alerts.filter(a => a.isHAD);

  // ── HAD Section ──
  const hadSection = hadAlerts.length ? `
    <div style="background:#FFF0F0;border:2px solid #E03E3E;border-radius:12px;padding:18px 22px;margin-bottom:20px">
      <div style="font-size:15px;font-weight:700;color:#B42121;margin-bottom:12px">
        ⚠️ ยากลุ่มเฝ้าระวังพิเศษ (High Alert Drug) — ${hadAlerts.length} รายการ
      </div>
      <div style="font-size:12px;color:#7B2020;margin-bottom:10px;line-height:1.6">
        ยากลุ่มนี้มีความเสี่ยงสูง ต้องดำเนินการตามโปรโตคอล HAD ของโรงพยาบาลอย่างเคร่งครัด
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#FCEDED">
            <th style="padding:8px 10px;text-align:left;color:#7B2020;font-weight:600;border-bottom:1px solid #F5C6C6">กล่อง</th>
            <th style="padding:8px 10px;text-align:left;color:#7B2020;font-weight:600;border-bottom:1px solid #F5C6C6">สถานะกล่อง</th>
            <th style="padding:8px 10px;text-align:left;color:#7B2020;font-weight:600;border-bottom:1px solid #F5C6C6">ชื่อยา HAD</th>
            <th style="padding:8px 10px;text-align:left;color:#7B2020;font-weight:600;border-bottom:1px solid #F5C6C6">จำนวน</th>
            <th style="padding:8px 10px;text-align:left;color:#7B2020;font-weight:600;border-bottom:1px solid #F5C6C6">ต้องส่งคืนภายใน</th>
            <th style="padding:8px 10px;text-align:left;color:#7B2020;font-weight:600;border-bottom:1px solid #F5C6C6">วันหมดอายุ</th>
            <th style="padding:8px 10px;text-align:left;color:#7B2020;font-weight:600;border-bottom:1px solid #F5C6C6">สถานะ</th>
          </tr>
        </thead>
        <tbody>
          ${hadAlerts.map(a => {
            const color = a.status === 'expired' ? '#B42121' : a.status === 'critical' ? '#9A5000' : '#7B4F00';
            const boxStatusLabel = a.isOut ? `<span style="color:#D9810F;font-weight:700">จ่ายออก</span><br><span style="font-size:11px;color:#7B6030">${escHtml(a.location)}</span>` : `<span style="color:#169C7F;font-weight:700">อยู่ที่คลัง</span>`;
            const days = a.daysLeft < 0 ? `เกิน ${Math.abs(a.daysLeft)} วัน` : a.daysLeft === 0 ? 'หมดอายุวันนี้' : `เหลือ ${a.daysLeft} วัน`;
            return `<tr style="background:#FFF8F8">
              <td style="padding:8px 10px;border-bottom:1px solid #F5C6C6;font-weight:700;color:#B42121">${escHtml(a.boxId)}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #F5C6C6">${boxStatusLabel}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #F5C6C6;font-weight:600">${escHtml(a.drugName)} <span style="background:#E03E3E;color:#fff;font-size:10px;font-weight:700;padding:2px 5px;border-radius:4px">HAD</span></td>
              <td style="padding:8px 10px;border-bottom:1px solid #F5C6C6;text-align:center">${Number(a.qty) || 0}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #F5C6C6;color:#B42121;font-weight:600">${a.returnDeadlineThai}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #F5C6C6">${a.expiryThai}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #F5C6C6;color:${color};font-weight:600">${a.statusLabel}<br><span style="font-size:11px">${days}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : '';

  // ── Action Section ──
  const actions = [];
  if (expired.length)  actions.push(`แจ้งฝ่ายเภสัชกรรมและหน่วยงานที่เกี่ยวข้องเพื่อเรียกคืน <strong>ยาหมดอายุแล้ว ${expired.length} รายการ</strong> โดยเร่งด่วน`);
  if (critical.length) actions.push(`ประสานหน่วยงานที่ถือกล่อง EB ให้ส่งคืน <strong>ยาที่ถึงกำหนดส่งคืน ${critical.length} รายการ</strong> ภายใน 24–48 ชั่วโมง`);
  if (hadAlerts.filter(a => a.status === 'expired' || a.status === 'critical').length)
    actions.push(`ดำเนินการตาม<strong>โปรโตคอล HAD</strong> สำหรับยาเฝ้าระวังพิเศษ — บันทึกในระบบและรายงานผู้รับผิดชอบ`);
  if (warning.length)  actions.push(`วางแผนนัดหมายส่งคืน <strong>ยาที่ใกล้กำหนด ${warning.length} รายการ</strong> ภายใน 7–15 วัน`);
  if (notice.length)   actions.push(`ติดตามสถานะ <strong>ยาเตือนล่วงหน้า ${notice.length} รายการ</strong> เพื่อวางแผนล่วงหน้า`);
  actions.push('ตรวจสอบและอัปเดตข้อมูลในระบบ EB Notify ให้เป็นปัจจุบัน');

  const actionSection = `
    <div style="background:#EEF5FF;border:1.5px solid #B3CCE8;border-radius:12px;padding:18px 22px;margin-bottom:20px">
      <div style="font-size:15px;font-weight:700;color:#1A4F7A;margin-bottom:12px">📋 สิ่งที่ต้องดำเนินการ</div>
      <ol style="margin:0;padding-left:20px;font-size:13px;color:#2C4A63;line-height:2">
        ${actions.map(a => `<li>${a}</li>`).join('')}
      </ol>
    </div>`;

  // ── Main Table ──
  const rows = alerts.slice(0, 50).map((a, i) => {
    const color = a.status === 'expired' ? '#B42121' : a.status === 'critical' ? '#9A5000' : a.status === 'warning' ? '#7B4F00' : '#1A6FA3';
    const rowBg = i % 2 === 0 ? '#FFFFFF' : '#F9FBFC';
    const days = a.daysLeft < 0 ? `เกิน ${Math.abs(a.daysLeft)} วัน` : a.daysLeft === 0 ? 'หมดอายุวันนี้' : `เหลือ ${a.daysLeft} วัน`;
    const boxStatusLabel = a.isOut
      ? `<span style="color:#D9810F;font-weight:700">จ่ายออก</span><br><span style="font-size:11px;color:#7B6030">${escHtml(a.location)}</span>`
      : `<span style="color:#169C7F;font-weight:700">อยู่ที่คลัง</span>`;
    return `
      <tr style="background:${rowBg}">
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8;font-weight:600">${escHtml(a.boxId)}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8">${boxStatusLabel}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8">${escHtml(a.drugName)}${a.isHAD ? ' <span style="background:#E03E3E;color:#fff;font-size:10px;font-weight:700;padding:2px 5px;border-radius:4px">HAD</span>' : ''}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8;text-align:center">${Number(a.qty) || 0}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8;color:${color};font-weight:600;white-space:nowrap">${a.returnDeadlineThai}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8;white-space:nowrap">${a.expiryThai}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #F0F4F8;color:${color};font-weight:600">${a.statusLabel}<br><span style="font-size:11px;font-weight:400">${days}</span></td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="th">
<head><meta charset="utf-8"><title>EB Notify</title></head>
<body style="margin:0;padding:20px;background:#F0F4F8;font-family:'Sarabun',Arial,sans-serif">
  <div style="max-width:780px;margin:0 auto">
    <div style="background:linear-gradient(135deg,#1A6FA3 0%,#168C84 100%);padding:28px 32px;border-radius:16px 16px 0 0;color:#fff">
      <div style="font-size:13px;opacity:.8;margin-bottom:4px">ฝ่ายเภสัชกรรม · โรงพยาบาลกรงปินัง</div>
      <h1 style="margin:0;font-size:22px;font-weight:700">🏥 แจ้งเตือนยาใกล้หมดอายุ — Emergency Box</h1>
      <div style="margin-top:8px;font-size:14px;opacity:.85">
        ${new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Bangkok' })}
      </div>
    </div>
    <div style="background:#fff;padding:24px 32px;border:1px solid #E2E8F0;border-top:0">
      <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
        ${expired.length ? `<span style="background:#FCEDED;color:#B42121;border-radius:8px;padding:8px 16px;font-weight:700;font-size:14px">🔴 หมดอายุแล้ว ${expired.length} รายการ</span>` : ''}
        ${critical.length ? `<span style="background:#FBF1E0;color:#9A5000;border-radius:8px;padding:8px 16px;font-weight:700;font-size:14px">🟠 วิกฤต ${critical.length} รายการ</span>` : ''}
        ${warning.length ? `<span style="background:#FEF8EC;color:#7B4F00;border-radius:8px;padding:8px 16px;font-weight:700;font-size:14px">🟡 ใกล้กำหนด ${warning.length} รายการ</span>` : ''}
        ${hadAlerts.length ? `<span style="background:#FCEDED;color:#B42121;border:1.5px solid #E03E3E;border-radius:8px;padding:8px 16px;font-weight:700;font-size:14px">⚠️ HAD ${hadAlerts.length} รายการ</span>` : ''}
        <span style="background:#E8F0F6;color:#1A6FA3;border-radius:8px;padding:8px 16px;font-weight:700;font-size:14px">รวมทั้งหมด ${alerts.length} รายการ</span>
      </div>

      ${hadAlerts.length ? hadSection : ''}
      ${actionSection}

      <div style="font-size:14px;font-weight:700;color:#334155;margin-bottom:10px">รายละเอียดยาทั้งหมด</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#F5F7FA">
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">กล่อง</th>
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">สถานะกล่อง</th>
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">ชื่อยา</th>
            <th style="padding:10px 12px;text-align:center;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">จำนวน</th>
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">ต้องส่งคืนภายใน</th>
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">วันหมดอายุ</th>
            <th style="padding:10px 12px;text-align:left;color:#5A6B79;font-weight:600;border-bottom:2px solid #E2E8F0">สถานะ</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${alerts.length > 50 ? `<p style="color:#7B8D9C;font-size:12px;margin-top:12px">... และอีก ${alerts.length - 50} รายการ — ดูทั้งหมดในระบบ</p>` : ''}
      <div style="margin-top:24px;padding-top:20px;border-top:1px solid #F0F4F8">
        <a href="https://emergencyboxnotyfykpnhos.web.app" style="display:inline-block;background:#1A6FA3;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px">เปิดระบบ EB Notify →</a>
      </div>
    </div>
    <div style="background:#F5F7FA;padding:14px 32px;border:1px solid #E2E8F0;border-top:0;border-radius:0 0 16px 16px;font-size:11px;color:#9AAAB8;text-align:center">
      ส่งอัตโนมัติทุกวัน 09:00 น. โดยระบบ EB Notify — ฝ่ายเภสัชกรรม รพ.กรงปินัง · <a href="https://emergencyboxnotyfykpnhos.web.app" style="color:#1A6FA3;text-decoration:none">emergencyboxnotyfykpnhos.web.app</a>
    </div>
  </div>
</body>
</html>`;
}

// ── Build plain-text fallback ──────────────────────────────────
function buildPlainText(alerts) {
  const expired   = alerts.filter(a => a.status === 'expired');
  const critical  = alerts.filter(a => a.status === 'critical');
  const warning   = alerts.filter(a => a.status === 'warning');
  const notice    = alerts.filter(a => a.status === 'notice');
  const hadAlerts = alerts.filter(a => a.isHAD);
  const dateStr   = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Bangkok' });

  const line = (a) => {
    const boxInfo = a.isOut ? `จ่ายออก → ${a.location}` : 'อยู่ที่คลัง';
    const days = a.daysLeft < 0 ? `เกิน ${Math.abs(a.daysLeft)} วัน` : a.daysLeft === 0 ? 'หมดอายุวันนี้' : `เหลือ ${a.daysLeft} วัน`;
    return `  - ${a.boxId} [${boxInfo}]  ${a.drugName}${a.isHAD ? ' [HAD]' : ''}  จำนวน ${Number(a.qty) || 0}  ส่งคืนภายใน: ${a.returnDeadlineThai}  หมดอายุ: ${a.expiryThai} (${days})`;
  };

  let t = `แจ้งเตือนยาใกล้หมดอายุ — Emergency Box รพ.กรงปินัง\n`;
  t += `วันที่: ${dateStr}\n`;
  t += `พบยาที่ต้องดำเนินการ ${alerts.length} รายการ`;
  if (hadAlerts.length) t += `  |  HAD: ${hadAlerts.length} รายการ`;
  t += `\n${'─'.repeat(60)}\n\n`;

  // สิ่งที่ต้องดำเนินการ
  t += `สิ่งที่ต้องดำเนินการ\n`;
  let n = 1;
  if (expired.length)  t += `${n++}. เรียกคืนยาหมดอายุแล้ว ${expired.length} รายการ โดยเร่งด่วน\n`;
  if (critical.length) t += `${n++}. ประสานหน่วยงานส่งคืนยาที่ถึงกำหนด ${critical.length} รายการ ภายใน 24–48 ชั่วโมง\n`;
  if (hadAlerts.filter(a => a.status === 'expired' || a.status === 'critical').length)
    t += `${n++}. ดำเนินการตามโปรโตคอล HAD สำหรับยาเฝ้าระวังพิเศษ\n`;
  if (warning.length)  t += `${n++}. วางแผนส่งคืนยาใกล้กำหนด ${warning.length} รายการ ภายใน 7–15 วัน\n`;
  if (notice.length)   t += `${n++}. ติดตามสถานะยาเตือนล่วงหน้า ${notice.length} รายการ\n`;
  t += `${n++}. ตรวจสอบและอัปเดตข้อมูลในระบบ EB Notify ให้เป็นปัจจุบัน\n`;
  t += '\n';

  if (hadAlerts.length) {
    t += `${'═'.repeat(60)}\n`;
    t += `⚠️  ยากลุ่มเฝ้าระวังพิเศษ (High Alert Drug) — ${hadAlerts.length} รายการ\n`;
    t += `${'═'.repeat(60)}\n`;
    hadAlerts.forEach(a => { t += line(a) + '\n'; });
    t += '\n';
  }

  if (expired.length) {
    t += `หมดอายุแล้ว (${expired.length} รายการ)\n${'─'.repeat(40)}\n`;
    expired.forEach(a => { t += line(a) + '\n'; });
    t += '\n';
  }
  if (critical.length) {
    t += `วิกฤต — ถึงหรือเกินวันส่งคืน (${critical.length} รายการ)\n${'─'.repeat(40)}\n`;
    critical.forEach(a => { t += line(a) + '\n'; });
    t += '\n';
  }
  if (warning.length) {
    t += `ใกล้กำหนดส่งคืน (${warning.length} รายการ)\n${'─'.repeat(40)}\n`;
    warning.forEach(a => { t += line(a) + '\n'; });
    t += '\n';
  }
  if (notice.length) {
    t += `เตือนล่วงหน้า (${notice.length} รายการ)\n${'─'.repeat(40)}\n`;
    notice.slice(0, 15).forEach(a => { t += line(a) + '\n'; });
    if (notice.length > 15) t += `  ... และอีก ${notice.length - 15} รายการ\n`;
    t += '\n';
  }
  t += `ตรวจสอบเพิ่มเติม: https://emergencyboxnotyfykpnhos.web.app\n`;
  t += `\nอีเมลนี้ส่งอัตโนมัติทุกวัน 09:00 น. โดยระบบ EB Notify ฝ่ายเภสัชกรรม รพ.กรงปินัง`;
  return t;
}

// ── Send Email via Gmail SMTP ──────────────────────────────────
async function sendEmail(alerts) {
  const from = process.env.EMAIL_FROM;
  const pass = process.env.EMAIL_PASS;
  const to   = process.env.EMAIL_TO;
  if (!from || !pass || !to || !to.trim()) { console.log('⚠️  Email: ไม่ได้ตั้งค่า secrets (EMAIL_FROM / EMAIL_PASS / EMAIL_TO)'); return false; }

  console.log(`📧 Email: from=${from} to=${to}`);

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: from, pass },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });

  const expired  = alerts.filter(a => a.status === 'expired').length;
  const critical = alerts.filter(a => a.status === 'critical').length;
  let subject = `รายงานยาใกล้หมดอายุ Emergency Box ${alerts.length} รายการ รพ.กรงปินัง`;
  if (expired)        subject = `[ด่วน] ยาหมดอายุแล้ว ${expired} รายการ Emergency Box รพ.กรงปินัง`;
  else if (critical)  subject = `[ด่วน] ยาต้องส่งคืนด่วน ${critical} รายการ Emergency Box รพ.กรงปินัง`;

  const toList = to.split(',').map(e => e.trim()).filter(Boolean);
  const msgId  = `<eb-notify-${Date.now()}@emergencyboxnotyfykpnhos.web.app>`;

  try {
    await transporter.sendMail({
      from: `"EB Notify รพ.กรงปินัง" <${from}>`,
      to: toList,
      replyTo: from,
      subject,
      text: buildPlainText(alerts),
      html: buildHtmlEmail(alerts),
      headers: {
        'Message-ID': msgId,
        'X-Entity-Ref-ID': msgId,
      },
    });
    console.log(`✅ Email: ส่งถึง ${to} สำเร็จ`);
    return true;
  } catch (err) {
    console.error('❌ Email error:', err.message);
    return false;
  }
}

// ── All-clear email (Monday, no alerts) ───────────────────────
function buildAllClearHtml(boxCount) {
  const dateStr = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Bangkok' });
  return `<!DOCTYPE html>
<html lang="th">
<head><meta charset="utf-8"><title>EB Notify — ปลอดภัย</title></head>
<body style="margin:0;padding:20px;background:#F0F4F8;font-family:'Sarabun',Arial,sans-serif">
  <div style="max-width:640px;margin:0 auto">
    <div style="background:linear-gradient(135deg,#169C7F 0%,#1A6FA3 100%);padding:28px 32px;border-radius:16px 16px 0 0;color:#fff">
      <div style="font-size:13px;opacity:.8;margin-bottom:4px">ฝ่ายเภสัชกรรม · โรงพยาบาลกรงปินัง</div>
      <h1 style="margin:0;font-size:22px;font-weight:700">รายงานประจำสัปดาห์ — Emergency Box</h1>
      <div style="margin-top:8px;font-size:14px;opacity:.85">${dateStr}</div>
    </div>
    <div style="background:#fff;padding:32px;border:1px solid #E2E8F0;border-top:0;text-align:center">
      <div style="width:72px;height:72px;border-radius:50%;background:#E4F4EF;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;font-size:36px">✅</div>
      <h2 style="margin:0 0 10px;font-size:20px;color:#169C7F;font-weight:700">Emergency Box ทุกกล่องปลอดภัย</h2>
      <p style="margin:0 0 6px;font-size:15px;color:#4A5C6A">ไม่พบยาที่ใกล้หมดอายุภายใน <strong>${THRESHOLD_DAYS} วัน</strong></p>
      <p style="margin:0 0 24px;font-size:13px;color:#9AAAB8">ตรวจสอบ ${boxCount} กล่อง · ระบบอัตโนมัติ</p>
      <div style="background:#F0FAF6;border:1.5px solid #B2DED4;border-radius:12px;padding:16px 24px;display:inline-block;text-align:left">
        <div style="font-size:13px;color:#169C7F;font-weight:700;margin-bottom:8px">สรุปสถานะ</div>
        <div style="font-size:13px;color:#4A5C6A;line-height:2">
          ✅ &nbsp;ยาทุกรายการมีอายุการใช้งานเหลืออีกกว่า ${THRESHOLD_DAYS} วัน<br>
          ✅ &nbsp;ไม่มียากลุ่มวิกฤตหรือยาที่หมดอายุแล้ว<br>
          ✅ &nbsp;Emergency Box พร้อมใช้งานทุกกล่อง
        </div>
      </div>
    </div>
    <div style="background:#F5F7FA;padding:16px 32px;border:1px solid #E2E8F0;border-top:0;border-radius:0 0 16px 16px;text-align:center">
      <a href="https://emergencyboxnotyfykpnhos.web.app" style="color:#1A6FA3;font-size:13px;font-weight:600;text-decoration:none">emergencyboxnotyfykpnhos.web.app</a>
      <div style="font-size:11px;color:#9AAAB8;margin-top:4px">รายงานอัตโนมัติประจำสัปดาห์ · ฝ่ายเภสัชกรรม รพ.กรงปินัง</div>
    </div>
  </div>
</body>
</html>`;
}

function buildAllClearPlainText(boxCount) {
  const dateStr = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Bangkok' });
  return [
    'รายงานประจำสัปดาห์ — Emergency Box รพ.กรงปินัง',
    `วันที่: ${dateStr}`,
    '',
    '✅ Emergency Box ทุกกล่องปลอดภัย',
    `ไม่พบยาที่ใกล้หมดอายุภายใน ${THRESHOLD_DAYS} วัน`,
    `ตรวจสอบ ${boxCount} กล่อง`,
    '',
    'สรุปสถานะ:',
    `- ยาทุกรายการมีอายุเหลืออีกกว่า ${THRESHOLD_DAYS} วัน`,
    '- ไม่มียากลุ่มวิกฤตหรือยาหมดอายุ',
    '- Emergency Box พร้อมใช้งานทุกกล่อง',
    '',
    'emergencyboxnotyfykpnhos.web.app',
    'รายงานอัตโนมัติ · ฝ่ายเภสัชกรรม รพ.กรงปินัง',
  ].join('\n');
}

async function sendAllClearEmail(boxCount) {
  const from = process.env.EMAIL_FROM;
  const pass = process.env.EMAIL_PASS;
  const to   = process.env.EMAIL_TO;
  if (!from || !pass || !to || !to.trim()) { console.log('⚠️  Email: ไม่ได้ตั้งค่า secrets'); return false; }

  const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: from, pass }, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000 });
  const msgId = `<eb-allclear-${Date.now()}@emergencyboxnotyfykpnhos.web.app>`;
  try {
    await transporter.sendMail({
      from: `"EB Notify รพ.กรงปินัง" <${from}>`,
      to: to.split(',').map(e => e.trim()).filter(Boolean),
      replyTo: from,
      subject: 'รายงานประจำสัปดาห์ Emergency Box — ทุกกล่องปลอดภัย',
      text: buildAllClearPlainText(boxCount),
      html: buildAllClearHtml(boxCount),
      headers: { 'Message-ID': msgId, 'X-Entity-Ref-ID': msgId },
    });
    console.log(`✅ Email all-clear: ส่งถึง ${to} สำเร็จ`);
    return true;
  } catch (err) {
    console.error('❌ Email all-clear error:', err.message);
    return false;
  }
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const isMonday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Bangkok' }).format(new Date()) === 'Mon';
  console.log(`\n🔍 ตรวจสอบยาใกล้หมดอายุ (ภายใน ${THRESHOLD_DAYS} วัน)...`);
  console.log(`📅 วันที่: ${TODAY.toLocaleDateString('th-TH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  console.log(`📋 โหมด: ${IS_MANUAL ? 'ส่งทันที (กดปุ่มจากแอป)' : isMonday ? 'รายงานประจำสัปดาห์ (วันจันทร์)' : 'ตรวจเฉพาะยาวิกฤต (อังคาร–อาทิตย์)'}\n`);

  // dedup: cron เช็คว่าส่งวันนี้ไปแล้วหรือยัง — กดปุ่มเองข้ามการเช็ค
  if (!IS_MANUAL) {
    const lastSent = await getLastSentDate();
    if (lastSent === TODAY_ISO) {
      console.log(`⏭  ส่งแจ้งเตือนไปแล้วในวันนี้ (${TODAY_ISO}) — ข้ามการส่งซ้ำ`);
      process.exit(0);
    }
  } else {
    console.log('📲 Manual trigger — ข้ามการเช็ค dedup ส่งทันที');
  }

  let alerts;
  try {
    alerts = await fetchExpiringDrugs();
  } catch (err) {
    console.error('❌ Firestore error:', err.message);
    process.exit(1);
  }

  if (!alerts.length) {
    console.log(`\n✅ ไม่พบยาใกล้หมดอายุภายใน ${THRESHOLD_DAYS} วัน`);
    console.log('💡 หมายเหตุ: ถ้าในแอปมียาแต่ที่นี่บอกว่าไม่พบ → ข้อมูลใน Firestore อาจยังไม่ถูก sync');
    if (isMonday || IS_MANUAL) {
      console.log('\n📬 ส่งรายงานสรุป (All Clear)');
      const summaries = await fetchBoxSummaries().catch(err => { console.error('❌ fetchBoxSummaries error:', err.message); return []; });
      const boxCount = summaries.length;
      if (!boxCount) { console.warn('⚠ boxes collection empty — skipping all-clear to avoid false report'); return; }
      const emailSent = await sendAllClearEmail(boxCount);
      let lineSentAC = false;
      if (process.env.MOPH_NOTIFY_CLIENT_KEY && process.env.MOPH_NOTIFY_SECRET_KEY) {
        // Flex carousel with a per-box breakdown (location/registration stage/
        // nearest expiry) instead of a bare count or a wall of plain text — so
        // the reader can scan each box's real status at a glance, matching the
        // same premium card style as the near-expiry alert carousel.
        lineSentAC = await sendMOPHNotify(process.env.MOPH_NOTIFY_CLIENT_KEY, process.env.MOPH_NOTIFY_SECRET_KEY, buildAllClearFlexMessages(summaries)).catch(err => { console.error('❌ MOPH Notify all-clear error:', err.message); return false; });
      }
      if (emailSent || lineSentAC) await markSentToday();
    } else {
      console.log('⏭  ไม่ใช่วันจันทร์ — ไม่ส่งแจ้งเตือน');
    }
    process.exit(0);
  }

  const expired  = alerts.filter(a => a.status === 'expired').length;
  const critical = alerts.filter(a => a.status === 'critical').length;
  const warning  = alerts.filter(a => a.status === 'warning').length;
  const notice   = alerts.filter(a => a.status === 'notice').length;

  console.log(`📊 สรุป: หมดอายุแล้ว ${expired} | วิกฤต ${critical} | ใกล้กำหนด ${warning} | เตือนล่วงหน้า ${notice}`);

  // ── Smart mode logic ──
  // วันจันทร์ → ส่งรายงานเต็มทุกรายการ
  // วันอื่น   → ส่งเฉพาะมียาหมดอายุแล้วหรือวิกฤต (≤15 วัน)
  const urgentAlerts = alerts.filter(a => a.status === 'expired' || a.status === 'critical');
  const shouldSend = IS_MANUAL || isMonday || urgentAlerts.length > 0;

  if (!shouldSend) {
    console.log('\n⏭  ไม่มียาวิกฤต และไม่ใช่วันจันทร์ — ข้ามการส่งแจ้งเตือนวันนี้');
    process.exit(0);
  }

  // จันทร์/กดปุ่มเอง → ส่งทุกรายการ / วันอื่น cron → ส่งเฉพาะวิกฤต
  const alertsToSend = (isMonday || IS_MANUAL) ? alerts : urgentAlerts;
  if (!isMonday && !IS_MANUAL) {
    console.log(`\n🚨 พบยาวิกฤต ${urgentAlerts.length} รายการ — ส่งแจ้งเตือนด่วน`);
  } else {
    console.log(`\n📬 ${IS_MANUAL ? 'กดปุ่มเอง' : 'วันจันทร์'} — ส่งรายงานทั้งหมด (${alertsToSend.length} รายการ)`);
  }

  const lineResult = (process.env.MOPH_NOTIFY_CLIENT_KEY && process.env.MOPH_NOTIFY_SECRET_KEY)
    ? await sendMOPHNotify(process.env.MOPH_NOTIFY_CLIENT_KEY, process.env.MOPH_NOTIFY_SECRET_KEY, buildFlexMessages(alertsToSend)).catch(err => { console.error('❌ MOPH Notify exception:', err.message); return false; })
    : (console.log('⚠️  MOPH Notify: ไม่ได้ตั้งค่า MOPH_NOTIFY_CLIENT_KEY / MOPH_NOTIFY_SECRET_KEY'), false);

  const emailResult = await sendEmail(alertsToSend).catch(err => { console.error('❌ Email exception:', err.message); return false; });

  console.log('\n── สรุปผลการแจ้งเตือน ──');
  console.log(`LINE:  ${lineResult ? '✅ สำเร็จ' : '❌ ล้มเหลว / ไม่ได้ตั้งค่า'}`);
  console.log(`Email: ${emailResult ? '✅ สำเร็จ' : '❌ ล้มเหลว / ไม่ได้ตั้งค่า'}`);

  // ต้องส่งได้อย่างน้อย 1 ช่องทาง — ถ้าไม่ได้เลย exit 1 ให้ GitHub Actions แสดงสีแดง
  const atLeastOneConfigured = (process.env.MOPH_NOTIFY_CLIENT_KEY && process.env.MOPH_NOTIFY_SECRET_KEY) || (process.env.EMAIL_FROM && process.env.EMAIL_PASS && process.env.EMAIL_TO);
  if (atLeastOneConfigured && !lineResult && !emailResult) {
    console.error('\n❌ การแจ้งเตือนล้มเหลวทุกช่องทาง');
    process.exit(1);
  }

  if (lineResult || emailResult) {
    await markSentToday();
    console.log(`\n✅ แจ้งเตือนสำเร็จ — บันทึก lastSentDate: ${TODAY_ISO}`);
  } else {
    console.log('\n⚠️  ไม่ได้ตั้งค่า secrets — ข้ามการแจ้งเตือน');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
