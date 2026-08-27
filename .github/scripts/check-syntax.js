'use strict';
/**
 * Pre-deploy syntax gate for index.html.
 *
 * firebase-deploy.yml previously had NO check of any kind before pushing
 * straight to the live production app — a syntax error in index.html's
 * inline <script> (the entire DCComponent app lives in one such block)
 * would deploy directly to the real hospital site with zero warning,
 * discovered only when someone opened it and found a blank/broken page.
 * This extracts every inline (non-src) <script> tag in index.html and runs
 * each one through `node --check`, failing the workflow (blocking the
 * deploy) if any of them don't parse — the same manual check this app's
 * own development process already runs before every commit, now enforced
 * automatically instead of relying on a human remembering to run it.
 *
 * Deliberately only a syntax check, not a full test suite — this repo has
 * no build step and no bundler, so there's nothing further to "compile";
 * catching a parse error is the cheap, high-value thing worth gating on.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const INDEX_HTML = path.join(__dirname, '..', '..', 'index.html');
let html = fs.readFileSync(INDEX_HTML, 'utf8');

// Strip HTML comments before scanning for <script> tags — this file's own
// documented gotcha (see CLAUDE.md's note on never writing "<x-dc" outside
// the real template block, "not even inside an HTML comment") applies
// equally here: an explanatory comment mentioning the literal text
// "<script>" (e.g. "...instead of starting only once each <script> tag is
// reached") is plain prose, not a real tag, but a naive regex can't tell
// the difference and will treat it as one, corrupting where it thinks the
// real script boundaries are.
html = html.replace(/<!--[\s\S]*?-->/g, '');

// Every remaining inline <script> (no src=) — there are two in this app:
// the small <head> service-worker-registration snippet, and the large
// DCComponent app script (type="text/x-dc" so a real browser never
// auto-executes it — support.js's own runtime evaluates it directly as
// JS instead, which is exactly why it still needs to be valid JS syntax).
// Check both, not just the biggest one, so a mistake in either is caught.
const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let match;
let count = 0;
let failed = false;

while ((match = scriptRe.exec(html))) {
  count++;
  const code = match[1];
  const tmpFile = path.join(os.tmpdir(), `eb-inline-script-${count}-${process.pid}.js`);
  fs.writeFileSync(tmpFile, code);
  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
    console.log(`✅ inline <script> #${count} (${code.length.toLocaleString()} chars): syntax OK`);
  } catch (err) {
    failed = true;
    console.error(`❌ inline <script> #${count}: SYNTAX ERROR`);
    console.error((err.stderr || err.message || '').toString());
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

if (!count) {
  console.error('❌ no inline <script> tags found in index.html — the extraction regex may be broken, or index.html was restructured. Fix this check, do not just ignore it.');
  process.exit(1);
}

if (failed) {
  console.error(`\n❌ ${count} inline <script> block(s) checked, at least one failed. Deploy blocked.`);
  process.exit(1);
}

console.log(`\n✅ All ${count} inline <script> block(s) in index.html parse correctly.`);
