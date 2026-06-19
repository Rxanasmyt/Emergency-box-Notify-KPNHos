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
| `boxes` | box ID (`eb1`, `eb2`, …) | `dispense`, `receiver`, `mfg`, `expiry`, `nearDrug`, `preparer`, `checker` |
| `box_drugs` | box ID | `boxId`, `drugs[]` (with `lots[]`) |
| `audit_log` | auto-ID | `date`, `time`, `action`, `person`, `eb`, `dept`, `drug` |
| `users` | **username** (string) | `name`, `username`, `password`, `role`, `dept`, `status`, `lastLogin`, `id` |

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

Role hierarchy: `admin` > `pharmacist` > `technician`

---

## Submit Flow

All 3 modes call `_syncBox(updated)` + `resetForm()` at the end.

`_syncBox(box)`: updates `this.BOXES` in memory AND calls `EB_Sync.syncBoxes(box)` for Firestore.

```
register: sets mfg, expiry, nearDrug, preparer, checker, registeredAt; clears dispense/receiver
dispense:  sets dispense dept, dispDate, dispenser; clears receiver; if swapReturn also syncs swap box
return:    sets receiver, retDate
```

---

## GitHub Actions

| Workflow | Trigger | Purpose |
|---|---|---|
| `firebase-deploy.yml` | push to `claude/eloquent-heisenberg-vqrypu` or `main` | Deploy to Firebase Hosting |
| `daily-notify.yml` | 08:00 Thai time (01:00 UTC) | Check expiry + send LINE/email alerts |
| `reset-data.yml` | manual, requires "YES" | Clear ALL Firestore test data |
| `auto-release.yml` | push to main | GitHub release |

**Required secrets**: `FIREBASE_SERVICE_ACCOUNT`, `LINE_CHANNEL_TOKEN`, `LINE_USER_ID`, `EMAIL_FROM`, `EMAIL_PASS`, `EMAIL_TO`  
**Required var**: `NOTIFY_DAYS_AHEAD` (default `30`)

---

## Common Pitfalls

- Do not add `x.id`-based user lookups — `id` is legacy and unreliable after Firestore sync
- Do not add `box.status` comparisons — the field does not exist
- Do not call `auth.signOut()` on logout
- Do not call `listenUsers()` from `initFirebaseSync` — it's already subscribed from `initUsersOnly`
- Do not call `initUsersOnly` more than once without first calling `stopAll` — it guards with `if(_usersUnsub)return`
- Do not hardcode dates anywhere in state initialization — use empty string `''`
- `currentUser` is updated in state via `setState` after login. To detect "self" row in user table: `u.username === st.currentUser.username`
