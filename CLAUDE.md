# Emergency Box Notify — KPN Hospital

Pharmacy department app for tracking emergency drug boxes: register, dispense, return, expiry alerts.

**Live app**: https://emergencyboxnotyfykpnhos.web.app  
**Deploy branch**: `claude/eloquent-heisenberg-vqrypu` (auto-deploys to Firebase Hosting on push)

---

## Architecture

### Runtime
Single `index.html` using a custom React-like wrapper called **DC Runtime** (`support.js`).
- Component class extends `DCComponent`
- `renderVals()` returns a `vals` object consumed by `{{ }}` template bindings
- `setState()` triggers re-render; `this.state` holds all UI + data state
- `this.BOXES`, `this.AUDIT`, `this.BOX_DRUGS` are mutable class properties synced from Firestore

### Firebase
- **Firestore** (compat SDK v10): real-time listeners via `onSnapshot`
- **Anonymous Auth**: required for Firestore read/write (security rules: `request.auth != null`)
- `firebase-init.js`: synchronous init, sets `window.EB_Firebase = {app, db, auth}`
- `firebase-sync.js`: all Firestore interaction via `window.EB_Sync`
- `notify.js`: expiry alert logic, LINE/email via GitHub Actions

### Data collections
| Collection | Doc ID | Key fields |
|---|---|---|
| `boxes` | box ID (`eb1`, `eb2`, …) | `dispense`, `receiver`, `mfg`, `expiry`, `nearDrug`, `preparer`, `checker`, `openedAt`, `preparedAt`, `registeredAt`, `rejectedAt`, `rejectedReason` |
| `box_drugs` | box ID | `boxId`, `drugs[]` (with `lots[]`, each drug has `verified: boolean`) |
| `audit_log` | auto-ID | `date`, `time`, `action`, `person`, `eb`, `dept`, `drug` (append-only — rules block update/delete) |
| `usage_log` | auto-ID | `boxId`, `dept`, `drugName`, `qty`, `hn`, `patientName`, `recordedAt`, `recordedTime` (append-only, paperless usage records — see below) |
| `users` | **username** (string) | `name`, `username`, `password`, `role`, `dept`, `status`, `lastLogin`, `id` |
| `app_settings/dept_pins` | fixed doc | `{ER:{hash}, WARD:{hash}, LR:{hash}}` — per-department PIN hashes for paperless usage logging |

---

## Critical Invariants — DO NOT BREAK

### 1. User identity key = `username`
After Firestore loads users, `uid` = Firestore doc ID = username string. The legacy numeric `id` field is unreliable — it is undefined for Firestore-loaded users.

**Always use `username` for user comparisons:**
```js
// CORRECT
users.find(x => x.username === target)
users.map(x => x.username === target ? updated : x)

// WRONG — breaks after Firestore sync (id is undefined)
users.find(x => x.id === target)
users.map(x => x.id === u.id ? updated : x)
```

`syncUsers(user)` uses `uid || user.username` as the Firestore doc ID. Do not change this.

### 2. Boxes have no `status` field
Boxes are "out" when `box.dispense && !box.receiver`. There is no `box.status === 'out'` field.

```js
// CORRECT
const isOut = b.dispense && !b.receiver;

// WRONG — always false/undefined
const isOut = b.status === 'out';
```

### 3. Anonymous auth lifecycle
- `initUsersOnly(comp)` — called from `componentDidMount`, signs in anon + starts `listenUsers`
- `initFirebaseSync(comp)` — called after login, starts boxes/audit/boxDrugs listeners
- `stopSync()` — called on logout, stops only boxes/audit/boxDrugs
- `stopAll()` — called from `componentWillUnmount`, stops everything
- `auth.signOut()` is NOT called on logout — anonymous session must persist so the users listener keeps running for next login

### 4. Seeding flow
`seedIfEmpty()` (called by `initFirebaseSync`) seeds boxes + box_drugs if collections are empty.  
`_startUsersListener()` (called by `initUsersOnly`) seeds admin to users collection if empty.  
Do NOT seed users inside `seedIfEmpty`.

### 5. `listenUsers` dedup by username
Firestore may have duplicate username docs from historical bugs. `listenUsers` deduplicates:
```js
const seen = new Set();
snap.forEach(doc => {
  const u = {uid: doc.id, ...doc.data()};
  if (u.username && !seen.has(u.username)) { seen.add(u.username); users.push(u); }
});
```
Do not remove this dedup.

---

## User Management Flow (admin only)

All 5 user management functions (`setUserRole`, `toggleUserStatus`, `openChangePw`, `deleteUser`, `addUser`) check `currentUser.role === 'admin'` at entry.

`addUser()` assigns a numeric `id` for legacy compatibility. After Firestore sync, `usedIds` is built from `users.map(u => u.id).filter(x => typeof x === 'number')` — this correctly handles mixed Firestore/local users.

`addUser()` guards against concurrent double-invocation with `this._addingUser` (checked synchronously before the first `await`) — without it, a double-click/double-submit could fire it twice before the first call's `hashPw`/write settled, and both calls would pass the "username doesn't exist yet" check and each locally append their own copy of the new user, showing duplicate rows until the next Firestore snapshot reconciled them.

Role hierarchy: `admin` > `pharmacist` > `technician`. `nurse` (พยาบาล/หน่วยงาน) is view-only per the RBAC chart — dashboard + box status only, never register/dispense/return. Enforced in 3 places: `go()` refuses to navigate to `'entry'` for `role==='nurse'`, the sidebar/mobile nav omit the entry item for nurses, the Detail screen's quick-action dispense/return buttons are hidden for nurses, and `submit()` itself refuses to record a transaction for a nurse as defense in depth (in case any of the above is bypassed).

History/audit log **viewing** (`screen === 'history'`) is open to every role — only **exporting** (`exportCSV`) is admin-only (`canExportCSV`), gated both by hiding the button and inside `exportCSV()` itself as defense in depth.

`setUserRole`/`toggleUserStatus`/`deleteUser`/`addUser`/`saveChangePw` all `await` their `EB_Sync.syncUsers`/`deleteUser` call and only update local `state.users`/flash success/`logAction` if it resolves — `syncUsers`/`deleteUser` in firebase-sync.js `throw` on failure (not swallow), matching the box-operation pattern above. `setUserRole`/`toggleUserStatus`/`deleteUser` also refuse (via `_activeAdminCount()`) to demote/suspend/delete the last remaining active admin — without it, two admins racing to demote each other simultaneously could leave zero admins with no in-app recovery path.

Login lockout (`_failLogin`/`_loadLockStateFor`) is scoped **per username** (sessionStorage key includes the username), not one shared counter for the whole browser — a shared ward workstation must not let one person's mistyped password lock every other username out of that device.

---

## Submit Flow

All 3 modes call `_syncBox(updated)` + `resetForm()` at the end.

`_syncBox(box)`: updates `this.BOXES` in memory AND calls `EB_Sync.syncBoxes(box)` for Firestore.

```
register (Stage 1, จพ.): sets mfg, preparer, preparedAt; clears checker/registeredAt, dispense/receiver, openedAt=''
register (Stage 2, เภสัชกร/admin): sets expiry, nearDrug, checker, registeredAt — box_drugs drugs[].verified=true for every drug
dispense:  sets dispense dept, dispDate, dispenser; clears receiver; if swapReturn also syncs swap box
return:    via returnBoxAndDrugsTx() atomic transaction — sets receiver, retDate, openedAt='', AND resets preparedAt/registeredAt/checker='' + box_drugs drugs[].verified=false for every drug (a returned box must go through Stage 1 restock + Stage 2 re-verify again before it can be dispensed a second time); NOT a plain _syncBox() call (see below)
```

`_syncBox()` diffs `updated` against the last-known box and only writes CHANGED fields — never resend the full object from a stale local snapshot, or a concurrent write from another device can be silently clobbered even under `{merge:true}`.

`_syncBox()` returns a promise resolving `true`/`false` (never rejects) so a caller that must not log/toast a false success can `await` it. **Any code path that calls `logAction`/`logBoxHist` after a `_syncBox`/`_syncBoxDrugs` write must `await` that write first and bail out if it resolves falsy/rejects** — logging to the append-only `audit_log` before confirming the write landed leaves a permanent false record if it failed (network drop, etc.). `submit()`'s dispense/register branches and `rejectReg()` all follow this pattern; keep it when adding new write+log call sites.

`saveEditDrugs()` (Detail screen's drug/expiry editor) is a plain overwrite of the whole `box_drugs.drugs[]` array, not a transaction — it compares `this.BOX_DRUGS[id]` against the snapshot taken when editing started (`this._bdBackup`) and refuses to save if they differ, since a concurrent `returnBoxAndDrugsTx`/`logDrugUsageTx` could have changed quantities while the editor was open. Do not remove this check or the editor can silently revert a real return/usage decrement.

---

## 2-Stage Registration (จพ. เตรียม → เภสัชกร ตรวจสอบ)

Registration is split into two role-gated stages instead of one single-step save:

- **Stage 1 — จัดเตรียม (Prepared)**: any user fills in mfg date, preparer name, and per-lot qty/expiry for every drug, then saves. This writes `preparedAt` (NOT `registeredAt`) and clears any prior `checker`/`registeredAt` — a box always re-enters Stage 1 when its drug data is re-prepared, even if it was previously verified. Printing the physical EB label (`printEBForm()`) happens here — the printed "ผู้ตรวจสอบ" line is left blank for the pharmacist to hand-sign after physically checking the box in Stage 2; the print gate no longer requires `regChecker`.
- **Stage 2 — ตรวจสอบ/ยืนยัน (Verified)**: **pharmacist/admin only** (`_canVerifyReg()` — checks `role === 'pharmacist' || role === 'admin'`). Reviews the จพ.-entered data read-only against the physical box/printed label, ticks a per-drug `verified` checkbox (`box_drugs.drugs[].verified`, toggled via `toggleDrugVerified()`) for **every** drug, signs `checker`, then saves — this sets `registeredAt` (now means "verified", not "prepared") and computes `expiry`/`nearDrug`.
- **`_regStage(box)`** (index.html): returns `'none'` (no `preparedAt`) / `'prepared'` (`preparedAt` set, no `registeredAt`) / `'verified'` (`registeredAt` set). This is the single source of truth for which view (`regIsEditable` / `regIsVerifyStep` / `regIsLocked`) the register screen shows.
- **Hard-blocked from dispense**: `_resolveDispEB()` and the dispense box-chip list only include boxes with `registeredAt` set — a `'prepared'`-only box (จพ. done, not yet verified) cannot be dispensed under any circumstance, not just a warning.
- **Locked view**: a technician (or any non-verifier) viewing a `'prepared'` box sees a read-only "รอเภสัชกร/แอดมินตรวจสอบ" banner instead of the form — they cannot re-edit Stage 1 data or attempt Stage 2 while verification is pending.
- Do not add a `.par`-based or per-lot verification granularity — verification is intentionally **per-drug**, not per-lot.
- **Reject-to-edit**: in Stage 2, the pharmacist/admin can call `rejectReg(boxId, reason)` instead of verifying — clears `preparedAt`/`registeredAt`/`checker` and every drug's `verified` flag (mfg/preparer/drug data is left as-is so จพ. can see and fix it), logging the optional reason to `audit_log`/box history. This is the only way back from `'prepared'` to `'none'` short of the box being dispensed.
- **`rejectedReason`/`rejectedAt`** persist through the `'none'` stage (unlike `preparedAt`/`registeredAt`/`checker`, which `rejectReg()` clears) so จพ. sees why the box came back — shown as a red banner on the Stage 1 form and in a dashboard-wide "กล่องถูกตีกลับ" list. Stage 1 submit clears both once จพ. re-submits the fix — do not let them survive past the next `preparedAt`.
- **Dashboard "pending verification" banner**: the dashboard lists every `'prepared'`-stage box (จพ.จัดเตรียมเสร็จแล้ว รอตรวจสอบ) with a one-click jump into its register/verify view (`pendingVerifyBoxes` in `renderVals()`), so a pharmacist doesn't have to click through every EB chip to find pending work. Visible to all roles; only pharmacist/admin can actually act on what it links to.
- Selecting a box in the register EB-chip picker prefills `regMfg`/`regPreparer` from the box's persisted values **only if that box already has them** (e.g. reopened after a Stage 2 reject) — a brand-new (`'none'`-stage) box keeps whatever the user already typed, so a จพ. preparing several boxes in a row doesn't lose their own name each time they switch boxes.
- `selectRegBox()` must NOT set `this._regTouched = true` — it only marks a genuine edit (typing/ticking/printing) as dirty. It used to set this unconditionally on every box switch, which combined with the prefill above meant simply viewing any already-registered box (i.e. almost any real box) made `go()`/`go2()`/the "ล้างฟอร์ม" button's dirty-check fire on every subsequent navigation attempt for the rest of the session. The three dirty-checks (`go()`, `go2()`, `resetForm`'s clear-button handler) key off `this._regTouched` alone for this reason — do not reintroduce a raw `regMfg`/`regPreparer`/`regChecker` truthiness check into them.

---

## Paperless Usage Logging (QR public page)

Scanning a box's QR code (`?view=box&id=...`, no login) shows real-time box/drug data AND, while the box is dispensed-out, an "เปิดใช้งานกล่อง" button that lets ward staff log drug usage (drug, qty, HN, patient name) without a paper form.

- **Identity**: a per-department PIN (`ER`/`WARD`/`LR`), hashed with the same `hashPw()` SHA-256 helper as user passwords, stored in `app_settings/dept_pins`. Admin sets/rotates PINs from the Notify/Settings screen (`saveDeptPins()`) — the admin UI never displays an existing PIN, only whether one is set (`deptPinsSet`).
- **PIN check is client-side only** (fetches `dept_pins`, hashes the input, compares) — same trust model as the rest of the anonymous-auth architecture. It gates the UI, not Firestore rules; anyone with Firestore access already has write access to these collections. Do not treat it as a hard security boundary.
- **`openedAt`**: set once per dispense cycle, the first time `logDrugUsageTx()` runs on a box with no `openedAt` yet. Cleared to `''` on register and on return (`returnBoxAndDrugsTx`'s `boxFields` always includes `openedAt: ''`) — do not let a stale `openedAt` survive into the next cycle.
- **Return also forces re-verification**: `returnBoxAndDrugsTx`'s `boxFields` includes `preparedAt: '', registeredAt: '', checker: ''` and the transaction itself sets `verified: false` on every drug — a box that was just dispensed and used is no longer guaranteed full/verified, so `_regStage()` drops it back to `'none'` and `_resolveDispEB()` correctly excludes it from the dispense list until จพ. restocks (Stage 1) and a pharmacist re-verifies (Stage 2) again. Do not remove this — without it, a partially-used box could be re-dispensed immediately after return with no restock/recheck at all.
- **`logDrugUsageTx(boxId, dept, drugIdx, lotIdx, qty, hn, patientName, recordedAt, recordedTime)`** (firebase-sync.js): one atomic transaction — verifies the box is still out, verifies `qty` does not exceed the lot's current quantity (rejects with `INSUFFICIENT_QTY` rather than clamping), decrements `box_drugs`, sets `openedAt` if unset, and appends a `usage_log` entry. Mirrors `returnBoxAndDrugsTx`'s pattern so concurrent usage entries from different devices compose correctly instead of one clobbering another.
- **`submitPubUsage()`** (index.html) also writes a `cat: 'usage'` entry to `audit_log`/box history after a successful `logDrugUsageTx` — do not remove this. `usage_log` alone is invisible to the admin's main Audit screen/export, so without this a drug-administration event (exactly what an admin most needs to audit) would have no trace outside the separate usage-log panel. There's no individual login on the public page (only a per-department PIN), so the entry is attributed to `หน่วยงาน {dept} (สแกน QR)`, not a person's name.
- **`listenUsageLog(boxId, cb)`** filters by `boxId` only (no `orderBy`) — sorts client-side. Adding `.orderBy()` to that query would require a composite Firestore index that does not exist; do not add it without also creating the index.
- The paper label workflow still exists side-by-side: `regSkipPrint` (a checkbox on the register form) bypasses the `regPrinted` validation gate so a pharmacist can choose paper or paperless per registration — do not remove `printEBForm()`/the print button.
- **Registration stage badge**: the public page computes `this._regStage(pubBox)` and shows a real-time badge next to the in-stock/out-of-stock one — 🟡 "รอเภสัชกรตรวจสอบ — ยังไม่พร้อมจ่าย" for `'prepared'`, 🟢 "ยืนยันแล้ว — พร้อมจ่าย" for `'verified'`, nothing for `'none'`. The registration info card also shows `registeredAt` ("ยืนยันเมื่อ") when set. Without this, a box scanned mid-Stage-2 review would show mfg/preparer data with an empty checker field and no indication it isn't finalized yet — do not gate this card on `pubBox.mfg` alone as if any mfg value means the box is ready.

---

## GitHub Actions

| Workflow | Trigger | Purpose |
|---|---|---|
| `firebase-deploy.yml` | push to `claude/eloquent-heisenberg-vqrypu` or `main` | Deploy to Firebase Hosting AND deploy `firestore.rules` (via `google-github-actions/auth@v2` + `firebase-tools`) |
| `daily-notify.yml` | 09:00 Thai time (02:00 UTC) | Check expiry + send LINE/email alerts |
| `reset-data.yml` | manual, requires "YES" | Clear ALL Firestore test data |
| `test-lifecycle.yml` | manual | Safe smoke test against a throwaway `TEST-1` box — exercises `returnBoxAndDrugsTx`, the double-return race guard, and firestore.rules delete-blocking; cleans up after itself |
| `auto-release.yml` | push to main | GitHub release |

The service account behind `FIREBASE_SERVICE_ACCOUNT` needs the **Firebase Rules Admin** and **Service Usage Consumer** IAM roles (Google Cloud Console → IAM) — hosting deploy works with less, but `firestore:rules` deploy fails with a 403 on `serviceusage.googleapis.com` without them.

**Required secrets**: `FIREBASE_SERVICE_ACCOUNT`, `MOPH_NOTIFY_CLIENT_KEY`, `MOPH_NOTIFY_SECRET_KEY`, `EMAIL_FROM`, `EMAIL_PASS`, `EMAIL_TO`  
**Required var**: `NOTIFY_DAYS_AHEAD` (default `60`)

---

## Common Pitfalls

- Do not add `x.id`-based user lookups — `id` is legacy and unreliable after Firestore sync
- Do not add `box.status` comparisons — the field does not exist
- Do not call `auth.signOut()` on logout
- Do not call `listenUsers()` from `initFirebaseSync` — it's already subscribed from `initUsersOnly`
- Do not call `initUsersOnly` more than once without first calling `stopAll` — it guards with `if(_usersUnsub)return`
- Do not hardcode dates anywhere in state initialization — use empty string `''`
- `currentUser` is updated in state via `setState` after login. To detect "self" row in user table: `u.username === st.currentUser.username`
- Do not add `.orderBy()` to the `usage_log` Firestore query — it needs a composite index that doesn't exist; sort client-side instead
- Do not call `logAction`/`logBoxHist` before confirming a `_syncBox`/`_syncBoxDrugs` write actually succeeded — always `await` the write and check its result first (see Submit Flow above); logging success on a failed write leaves a permanent false record in the append-only `audit_log`
- Do not let a new drug-administration event skip `audit_log` — writing only to `usage_log` (or only `box_drugs`) creates a blind spot in the admin's main audit trail for exactly the kind of event (who gave what drug, when) that most needs to be auditable
- Do not let `openedAt` survive past a box's dispense cycle — always reset it to `''` alongside `dispense`/`receiver` on register and return
- Do not treat the department PIN as a real security boundary — it's a client-side UI gate only, consistent with this app's anonymous-auth trust model, not a Firestore rules restriction
- Do not dispense a box whose `registeredAt` is unset, even if `preparedAt` is set — `'prepared'` (จพ. done) is not the same as `'verified'` (เภสัชกร/admin checked); dispense eligibility must check `registeredAt`, not `preparedAt` or `mfg`/`expiry` presence
- Do not let Stage 1 (จพ.) submit set `registeredAt` or require `regChecker`/per-drug `verified` — those are Stage 2 (เภสัชกร/admin) only
- Do not let `rejectedReason`/`rejectedAt` survive past the box's next Stage 1 submit — always reset them to `''` alongside `preparedAt` there, or a stale rejection banner keeps showing on a box จพ. already fixed
- Do not let a returned box keep `registeredAt` set — `returnBoxAndDrugsTx` must always reset `preparedAt`/`registeredAt`/`checker` and every drug's `verified` flag, or a partially-used box could be re-dispensed immediately with no restock/recheck
- Selecting a box for the register screen (chip click OR the dashboard "pending verify"/"rejected" jump links) must go through `selectRegBox(id, opts)` — it's the only place that correctly prefills `regMfg`/`regPreparer` from the persisted box and refreshes `state.boxDrugs[id]` from `this.BOX_DRUGS` (never from `state.boxDrugs[id]` itself, which can hold a stale copy). Do not set `regEB` via a bare `setState()` from a new call site.
- `resetForm()`'s register branch must reset `boxDrugs: null`, never a pre-blanked copy of some guessed "next" box — it has no way to know if that guess is the box จพ. just submitted (very likely, since box order never changes), and blanking its lot expiry there would show an empty table for data that was actually saved correctly.
- Stage 2 (`submit()`'s verify branch) and `rejectReg()` must read drug/lot data from `this.BOX_DRUGS[id]`, never `state.boxDrugs[id]` — Stage 2 is read-only over lot data (only `verified` is locally toggled), so persisting from a stale local buffer risks silently overwriting real expiry data with blanks. `regNearISOof(id, BDOverride)` takes an optional override for exactly this reason — pass `this.BOX_DRUGS` explicitly rather than relying on its default state-first fallback.
