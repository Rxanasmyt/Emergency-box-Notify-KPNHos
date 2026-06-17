#!/usr/bin/env bash
# ================================================================
# auto-release.sh — Git Automation: commit → tag → push → release
# ใช้: bash scripts/auto-release.sh "feat: ข้อความ" [patch|minor|major]
# ต้องตั้ง: export GITHUB_PAT=<token> ก่อนรัน
# ================================================================
set -e

if [ -z "$GITHUB_PAT" ]; then
  echo "❌ กรุณาตั้ง environment variable: export GITHUB_PAT=<your_token>"
  exit 1
fi

OWNER="Rxanasmyt"
REPO="Emergency-box-Notify-KPNHos"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMIT_MSG="${1:-chore: update}"
BUMP="${2:-patch}"   # patch | minor | major

echo "🔍 [1/5] วิเคราะห์การเปลี่ยนแปลง..."
git status --short

# ── 2. Commit ──────────────────────────────────────────────────
echo ""
echo "📦 [2/5] Commit..."
git add .
if git diff --cached --quiet; then
  echo "   ไม่มีการเปลี่ยนแปลง — ข้ามขั้นตอน commit"
else
  git commit -m "${COMMIT_MSG}"
  echo "   ✅ committed: ${COMMIT_MSG}"
fi

# ── 3. Version bump (SemVer) ───────────────────────────────────
echo ""
echo "🏷️  [3/5] คำนวณเวอร์ชัน..."
LATEST=$(git tag -l "v*" | sort -V | tail -n 1)
if [ -z "$LATEST" ]; then
  LATEST="v0.0.0"
fi
echo "   Tag ล่าสุด: ${LATEST}"

IFS='.' read -r MAJOR MINOR PATCH <<< "${LATEST#v}"
case "$BUMP" in
  major) MAJOR=$((MAJOR+1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR+1)); PATCH=0 ;;
  *)     PATCH=$((PATCH+1)) ;;
esac
NEW_TAG="v${MAJOR}.${MINOR}.${PATCH}"
echo "   เวอร์ชันใหม่: ${NEW_TAG}"

git tag "${NEW_TAG}"
echo "   ✅ สร้าง local tag: ${NEW_TAG}"

# ── 4. Push branch via proxy ───────────────────────────────────
echo ""
echo "🚀 [4/5] Push branch..."
git push -u origin "${BRANCH}"
echo "   ✅ pushed branch: ${BRANCH}"

# ── 5. Create tag + release via GitHub API ────────────────────
echo ""
echo "📣 [5/5] สร้าง GitHub Tag + Release..."
SHA=$(git rev-parse HEAD)

# Create tag object
TAG_RESP=$(curl -s -X POST \
  -H "Authorization: token ${GITHUB_PAT}" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/${OWNER}/${REPO}/git/tags" \
  -d "{
    \"tag\": \"${NEW_TAG}\",
    \"message\": \"Release ${NEW_TAG}\",
    \"object\": \"${SHA}\",
    \"type\": \"commit\"
  }")

TAG_SHA=$(echo "$TAG_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null)

if [ -n "$TAG_SHA" ]; then
  curl -s -X POST \
    -H "Authorization: token ${GITHUB_PAT}" \
    -H "Content-Type: application/json" \
    "https://api.github.com/repos/${OWNER}/${REPO}/git/refs" \
    -d "{\"ref\": \"refs/tags/${NEW_TAG}\", \"sha\": \"${TAG_SHA}\"}" > /dev/null
  echo "   ✅ สร้าง tag บน GitHub: ${NEW_TAG}"
else
  echo "   ⚠️  tag อาจมีอยู่แล้ว"
fi

# Create release
RELEASE_RESP=$(curl -s -X POST \
  -H "Authorization: token ${GITHUB_PAT}" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/${OWNER}/${REPO}/releases" \
  -d "{
    \"tag_name\": \"${NEW_TAG}\",
    \"name\": \"${NEW_TAG} — Emergency Box Management\",
    \"body\": \"## ${NEW_TAG}\\n\\n${COMMIT_MSG}\\n\\nBranch: \\`${BRANCH}\\`\",
    \"draft\": false,
    \"prerelease\": false
  }")

RELEASE_URL=$(echo "$RELEASE_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('html_url','error'))" 2>/dev/null)

echo ""
echo "════════════════════════════════════"
echo "✅ เสร็จสิ้น! ${NEW_TAG} อยู่บน GitHub แล้ว"
echo "   Branch : ${BRANCH}"
echo "   Release: ${RELEASE_URL}"
echo "════════════════════════════════════"
