import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// mend: applies AI-written edits in four formats (unified, SEARCH/REPLACE,
// V4A, JSON) to a tree of text files. Written from SPEC.md only.

// ---------- small helpers ----------

function isBlank(s) {
  return s.trim() === '';
}

function stripTrail(s) {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s) {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s) {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function isSafePath(p) {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

function byteCompare(a, b) {
  const ba = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  return Buffer.compare(ba, bb);
}

// Split a patch's text into lines: split at \n, strip one trailing \r each,
// drop the empty piece after a final \n.
function splitPatchLines(text) {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// Split a file's text into lines under its own line break.
function splitFile(text) {
  if (text === '') return { lines: [], crlf: false, final: false };
  const firstNl = text.indexOf('\n');
  const crlf = firstNl > 0 && text[firstNl - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, crlf, final };
}

function joinFile(lines, crlf, final) {
  if (lines.length === 0) return '';
  const br = crlf ? '\r\n' : '\n';
  return lines.join(br) + (final ? br : '');
}

// ---------- line matching (SPEC section 5) ----------

function tierMatch(a, b, tier) {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function findOccurrences(lines, oTexts, tier) {
  const out = [];
  const k = oTexts.length;
  if (k === 0) return out;
  for (let i = 0; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!tierMatch(oTexts[j], lines[i + j], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiersToTry(strict) {
  return strict ? [0] : [0, 1, 2];
}

// First tier (in order) with at least one occurrence at/after minPos.
// eofOnly: only occurrences ending at the file's last line.
function firstTierOcc(lines, oTexts, strict, minPos, eofOnly) {
  for (const tier of tiersToTry(strict)) {
    const occ = findOccurrences(lines, oTexts, tier).filter((i) => {
      if (i < minPos) return false;
      if (eofOnly && i + oTexts.length !== lines.length) return false;
      return true;
    });
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

// Build the replacement lines for N. nItems: {text, isContext, oIndex}.
// Context lines are written as the file's own matched line. At tier 2,
// other lines are re-indented per SPEC section 5.
function buildReplacement(nItems, oTexts, fileLines, pos, tier) {
  let F = '';
  let P = '';
  if (tier === 2 && oTexts.length > 0) {
    F = leadingWs(fileLines[pos] || '');
    P = leadingWs(oTexts[0]);
  }
  return nItems.map((it) => {
    if (it.isContext) return fileLines[pos + it.oIndex];
    let t = it.text;
    if (tier === 2) {
      if (t !== '' && t.replace(/[ \t]/g, '') !== '' && t.startsWith(P)) {
        t = F + t.slice(P.length);
      }
    }
    return t;
  });
}

// Turn body lines (unified/V4A, already stripped of '\' lines) into O/N.
// ctxText: text of a context line; oldText/newText for -/+ lines.
function bodyToON(body, getKind) {
  // getKind(line) -> {kind:'ctx'|'old'|'new', text}
  const oTexts = [];
  const nItems = [];
  for (const line of body) {
    const g = getKind(line);
    if (g.kind === 'ctx') {
      const oIndex = oTexts.length;
      oTexts.push(g.text);
      nItems.push({ text: g.text, isContext: true, oIndex });
    } else if (g.kind === 'old') {
      oTexts.push(g.text);
    } else {
      nItems.push({ text: g.text, isContext: false, oIndex: -1 });
    }
  }
  return { oTexts, nItems };
}

// Does a '\' line follow the hunk/chunk's last context or '+' line?
function backslashAfterLastCtxOrPlus(body, isCtxOrPlus) {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (isCtxOrPlus(body[i])) last = i;
  }
  if (last < 0) return false;
  return last + 1 < body.length && body[last + 1].startsWith('\\');
}

// ---------- format detection (SPEC section 4) ----------

function detectFormat(lines) {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) { firstNonBlank = i; break; }
  }
  if (firstNonBlank < 0) return null;
  if (lines[firstNonBlank].trim() === '*** Begin Patch') return 'v4a';
  const firstChar = lines[firstNonBlank].trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (stripTrail(lines[i]) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------- unified parser (SPEC section 6) ----------

function parseHeaderPath(line) {
  // line starts with '--- ' or '+++ '; text after the four characters,
  // up to the first tab, surrounding spaces removed.
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function unifiedBodyToHunk(body, A) {
  const clean = body.filter((l) => !l.startsWith('\\'));
  const { oTexts, nItems } = bodyToON(clean, (line) => {
    if (line === '' || line.startsWith(' ')) return { kind: 'ctx', text: line === '' ? '' : line.slice(1) };
    if (line.startsWith('-')) return { kind: 'old', text: line.slice(1) };
    return { kind: 'new', text: line.slice(1) }; // '+'
  });
  const noNl = backslashAfterLastCtxOrPlus(body, (l) => l === '' || l.startsWith(' ') || l.startsWith('+'));
  return { A, body, oTexts, nItems, noNl };
}

function parseUnified(lines) {
  const sections = [];
  let cur = null; // current section
  let phase = 'outside'; // 'outside' | 'header' | 'afterHunk'
  let i = 0;
  const n = lines.length;

  function newSection() {
    const s = {
      pairOld: undefined, pairNew: undefined,
      renameOld: undefined, renameNew: undefined,
      diffOld: undefined, diffNew: undefined,
      isCreateFlag: false, isDeleteFlag: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  }

  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) return { parseError: i + 1 };
      cur = newSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      phase = 'header';
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (phase === 'header' && cur && cur.pairOld === undefined) {
        // The section's own header pair (diff --git section).
        cur.pairOld = parseHeaderPath(line);
        cur.pairNew = parseHeaderPath(lines[i + 1]);
        i += 2;
        continue;
      }
      // A new section starting at this pair.
      cur = newSection();
      cur.pairOld = parseHeaderPath(line);
      cur.pairNew = parseHeaderPath(lines[i + 1]);
      phase = 'header';
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (phase === 'header' && cur) {
        // A --- line in a section header not followed by +++.
        return { parseError: i + 2 };
      }
      i++; // prose outside a header: ignored
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) return { parseError: i + 1 };
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) return { parseError: i + 1 };
      const A = parseInt(m[1], 10);
      let j = i + 1;
      const body = [];
      while (j < n) {
        const l = lines[j];
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && j + 1 < n && lines[j + 1].startsWith('+++ ')) break;
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
          body.push(l);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(unifiedBodyToHunk(body, A));
      phase = 'afterHunk';
      i = j;
      continue;
    }
    if (phase === 'header' && cur) {
      if (line.startsWith('+++ ')) {
        cur.pairNew = parseHeaderPath(line);
      } else if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreateFlag = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDeleteFlag = true;
      }
      // every other header line is ignored
      i++;
      continue;
    }
    i++; // prose / anything else outside bodies: ignored
  }

  const edits = sections.map((s) => {
    const oldPath = s.pairOld !== undefined ? s.pairOld
      : (s.renameOld !== undefined ? s.renameOld : (s.diffOld !== undefined ? s.diffOld : null));
    const newPath = s.pairNew !== undefined ? s.pairNew
      : (s.renameNew !== undefined ? s.renameNew : (s.diffNew !== undefined ? s.diffNew : null));
    const isCreate = s.isCreateFlag || oldPath === null;
    const isDelete = s.isDeleteFlag || newPath === null;
    return { kind: 'unified', oldPath, newPath, isCreate, isDelete, hunks: s.hunks };
  });
  return { edits };
}

// Apply a section's hunks to a file's text. Returns {text} or {fail:true}.
function applyUnifiedHunks(fileText, hunks, strict) {
  const cur = splitFile(fileText);
  let curLines = cur.lines.slice();
  let curFinal = cur.final;
  let d = 0;
  for (const hunk of hunks) {
    if (hunk.oTexts.length > 0) {
      const found = firstTierOcc(curLines, hunk.oTexts, strict, 0, false);
      if (!found) return { fail: true };
      const target = hunk.A - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) { best = pos; bestDist = dist; }
      }
      const pos = best;
      const newLines = buildReplacement(hunk.nItems, hunk.oTexts, curLines, pos, found.tier);
      let newFinal = curFinal;
      if (pos + hunk.oTexts.length === curLines.length) {
        newFinal = !hunk.noNl;
      }
      curLines = curLines.slice(0, pos).concat(newLines, curLines.slice(pos + hunk.oTexts.length));
      curFinal = newFinal;
      d += hunk.nItems.length - hunk.oTexts.length;
    } else {
      const insertPos = Math.min(Math.max(hunk.A + d, 0), curLines.length);
      const newLines = hunk.nItems.map((it) => it.text);
      let newFinal = curFinal;
      if (insertPos === curLines.length) newFinal = !hunk.noNl;
      curLines = curLines.slice(0, insertPos).concat(newLines, curLines.slice(insertPos));
      curFinal = newFinal;
      d += hunk.nItems.length;
    }
  }
  return { text: joinFile(curLines, cur.crlf, curFinal) };
}

// ---------- SEARCH/REPLACE parser (SPEC section 7) ----------

function parseSearchReplace(lines) {
  const edits = [];
  let prevReplace = -1; // index of previous block's REPLACE line
  let prevPath = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (stripTrail(lines[i]) !== '<<<<<<< SEARCH') { i++; continue; }
    const s = i;
    let e = -1;
    for (let j = s + 1; j < n; j++) {
      if (stripTrail(lines[j]) === '=======') { e = j; break; }
    }
    let r = -1;
    if (e >= 0) {
      for (let j = e + 1; j < n; j++) {
        if (stripTrail(lines[j]) === '>>>>>>> REPLACE') { r = j; break; }
      }
    }
    if (e < 0 || r < 0) return { parseError: s + 1 };
    const oldLines = lines.slice(s + 1, e);
    const newLines = lines.slice(e + 1, r);
    // Path: nearest line before SEARCH, after previous REPLACE, not blank
    // and (trimmed) not starting with three backticks.
    let path = null;
    for (let j = s - 1; j > prevReplace; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else return { parseError: s + 1 };
    }
    edits.push({ kind: 'sr', path, oldLines, newLines });
    prevPath = path;
    prevReplace = r;
    i = r + 1;
  }
  return { edits };
}

// ---------- V4A parser (SPEC section 8) ----------

function parseV4a(lines) {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!isBlank(lines[i])) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) return { parseError: 1 };
  if (lines[first].trim() !== '*** Begin Patch') return { parseError: first + 1 };
  if (lines[last].trim() !== '*** End Patch') return { parseError: n + 1 };

  const edits = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let type = null;
    let prefix = '';
    if (line.startsWith('*** Add File: ')) { type = 'add'; prefix = '*** Add File: '; }
    else if (line.startsWith('*** Delete File: ')) { type = 'delete'; prefix = '*** Delete File: '; }
    else if (line.startsWith('*** Update File: ')) { type = 'update'; prefix = '*** Update File: '; }
    else return { parseError: i + 1 };
    const sectionLine = i + 1;
    const path = line.slice(prefix.length).trim();
    // Find the next section start (or End Patch).
    let nxt = last;
    for (let j = i + 1; j < last; j++) {
      if (lines[j].startsWith('*** Add File: ') || lines[j].startsWith('*** Delete File: ') || lines[j].startsWith('*** Update File: ')) { nxt = j; break; }
    }
    let raw = lines.slice(i + 1, nxt);
    while (raw.length > 0 && isBlank(raw[raw.length - 1])) raw.pop();

    if (type === 'add') {
      const fileLines = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k];
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else return { parseError: i + 2 + k };
      }
      edits.push({ kind: 'v4a-add', path, fileLines });
    } else if (type === 'delete') {
      if (raw.length > 0) return { parseError: i + 2 };
      edits.push({ kind: 'v4a-delete', path });
    } else {
      // update
      let moveTo = null;
      let k0 = 0;
      if (raw.length > 0 && raw[0].startsWith('*** Move to:')) {
        moveTo = raw[0].slice('*** Move to:'.length).trim();
        k0 = 1;
      }
      const chunks = [];
      let curChunk = null;
      let firstChunk = true;
      for (let k = k0; k < raw.length; k++) {
        const l = raw[k];
        const lineNo = i + 2 + k;
        if (l === '*** End of File') {
          if (!curChunk) return { parseError: lineNo };
          curChunk.isEOF = true;
          chunks.push(curChunk);
          curChunk = null;
          firstChunk = false;
          continue;
        }
        if (l.startsWith('@@')) {
          if (curChunk) { chunks.push(curChunk); curChunk = null; }
          const anchor = l.slice(2).trim();
          curChunk = { anchor, isEOF: false, body: [] };
          firstChunk = false;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (!curChunk) {
            if (!firstChunk) return { parseError: lineNo };
            curChunk = { anchor: '', isEOF: false, body: [] };
            firstChunk = false;
          }
          curChunk.body.push(l);
          continue;
        }
        return { parseError: lineNo };
      }
      if (curChunk) chunks.push(curChunk);
      if (chunks.length === 0 && moveTo === null) return { parseError: sectionLine };
      // Precompute O/N per chunk.
      for (const ch of chunks) {
        const { oTexts, nItems } = bodyToON(ch.body, (line) => {
          if (line === '' || line.startsWith(' ')) return { kind: 'ctx', text: line === '' ? '' : line.slice(1) };
          if (line.startsWith('-')) return { kind: 'old', text: line.slice(1) };
          return { kind: 'new', text: line.slice(1) };
        });
        ch.oTexts = oTexts;
        ch.nItems = nItems;
      }
      edits.push({ kind: 'v4a-update', path, moveTo, chunks });
    }
    i = nxt;
  }
  return { edits };
}

// Apply a V4A update's chunks. Returns {text} or {fail:true}.
function applyV4aChunks(fileText, chunks, strict) {
  const cur = splitFile(fileText);
  let curLines = cur.lines.slice();
  let cursor = 0;
  for (const ch of chunks) {
    // SPEC section 8, read literally: the anchor names a line BEFORE the
    // chunk's own lines. The cursor moves PAST the anchor line, and O is
    // then searched at or after the new cursor — so an anchor equal to O's
    // first line does not match O itself, it must occur again after it.
    if (ch.anchor !== '') {
      let foundIdx = -1;
      for (const tier of tiersToTry(strict)) {
        for (let idx = cursor; idx < curLines.length; idx++) {
          if (tierMatch(ch.anchor, curLines[idx], tier)) { foundIdx = idx; break; }
        }
        if (foundIdx >= 0) break;
      }
      if (foundIdx < 0) return { fail: true };
      cursor = foundIdx + 1;
    }
    if (ch.oTexts.length === 0) {
      const insertPos = ch.isEOF ? curLines.length : cursor;
      const newLines = ch.nItems.map((it) => it.text);
      curLines = curLines.slice(0, insertPos).concat(newLines, curLines.slice(insertPos));
      cursor = insertPos + newLines.length;
    } else {
      const found = firstTierOcc(curLines, ch.oTexts, strict, cursor, ch.isEOF);
      if (!found) return { fail: true };
      const pos = found.occ[0];
      const newLines = buildReplacement(ch.nItems, ch.oTexts, curLines, pos, found.tier);
      curLines = curLines.slice(0, pos).concat(newLines, curLines.slice(pos + ch.oTexts.length));
      cursor = pos + newLines.length;
    }
  }
  return { text: joinFile(curLines, cur.crlf, cur.final) };
}

// ---------- JSON parser (SPEC section 9) ----------

function validateJsonEdit(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.path !== 'string' || typeof obj.command !== 'string') return null;
  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') return null;
    return { kind: 'json-create', path: obj.path, fileText: obj.file_text };
  }
  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str.length === 0) return null;
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') return null;
    return { kind: 'json-str', path: obj.path, oldStr: obj.old_str, newStr: obj.new_str === undefined ? '' : obj.new_str };
  }
  if (obj.command === 'insert') {
    if (!Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== 'string') return null;
    return { kind: 'json-insert', path: obj.path, insertLine: obj.insert_line, newStr: obj.new_str };
  }
  return null;
}

function parseJson(lines, patchText) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) { first = i; break; }
  }
  if (first < 0) return { edits: [] };
  if (lines[first].trimStart().startsWith('[')) {
    // Array form: any fault -> parse at the line where the array starts.
    const startLine = first + 1;
    let parsed;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      return { parseError: startLine };
    }
    if (!Array.isArray(parsed)) return { parseError: startLine };
    const edits = [];
    for (const el of parsed) {
      const e = validateJsonEdit(el);
      if (!e) return { parseError: startLine };
      edits.push(e);
    }
    return { edits };
  }
  // JSON Lines form.
  const edits = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      return { parseError: i + 1 };
    }
    const e = validateJsonEdit(parsed);
    if (!e) return { parseError: i + 1 };
    edits.push(e);
  }
  return { edits };
}

function countOverlapping(text, needle) {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = text.indexOf(needle, pos);
    if (idx < 0) break;
    count++;
    pos = idx + 1;
  }
  return count;
}

// ---------- main run ----------

function run(argv) {
  // Section 1: argument parsing.
  let format = 'auto';
  let check = false;
  let strict = false;
  let positional = [];
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  let usage = false;
  for (const arg of argv) {
    if (!endOpts && arg === '--') { endOpts = true; continue; }
    if (!endOpts && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        if (seenFormat) { usage = true; break; }
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') { usage = true; break; }
        format = v;
      } else if (arg === '--check') {
        if (seenCheck) { usage = true; break; }
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) { usage = true; break; }
        seenStrict = true;
        strict = true;
      } else {
        usage = true;
        break;
      }
    } else {
      positional.push(arg);
      if (positional.length > 1) { usage = true; break; }
    }
  }
  if (usage) return { code: 2, out: ['error: usage'] };

  // Patch reading.
  let patchText;
  if (positional.length === 0 || positional[0] === '-') {
    try {
      patchText = readFileSync(0, 'utf-8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  } else {
    try {
      patchText = readFileSync(positional[0], 'utf-8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = splitPatchLines(patchText);

  // Format detection.
  let fmt = format;
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (!detected) return { code: 2, out: ['error: format'] };
    fmt = detected;
  }

  // Parsing (before any file is looked at).
  let parsed;
  if (fmt === 'unified') parsed = parseUnified(lines);
  else if (fmt === 'search-replace') parsed = parseSearchReplace(lines);
  else if (fmt === 'v4a') parsed = parseV4a(lines);
  else parsed = parseJson(lines, patchText);
  if (parsed.parseError !== undefined) return { code: 2, out: [`error: parse ${parsed.parseError}`] };
  const edits = parsed.edits;
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };

  // In-memory tree: current path -> text, or null when absent.
  const current = new Map();
  const original = new Map();
  function load(p) {
    if (!current.has(p)) {
      let v = null;
      try { v = readFileSync(p, 'utf-8'); } catch { v = null; }
      current.set(p, v);
      original.set(p, v);
    }
    return current.get(p);
  }
  function exists(p) { return load(p) !== null; }
  function setFile(p, v) {
    if (!original.has(p)) original.set(p, null);
    current.set(p, v);
  }

  const failures = [];
  const moves = []; // recorded successful move pairs [old, new]

  function applyEdit(edit) {
    // --- unified ---
    if (edit.kind === 'unified') {
      const oldP = edit.oldPath;
      const newP = edit.newPath;
      if (oldP !== null && !isSafePath(oldP)) return { code: 'unsafe', path: oldP };
      if (newP !== null && !isSafePath(newP)) return { code: 'unsafe', path: newP };
      if (oldP === null && newP === null) return { code: 'unsafe', path: '' };
      if (edit.isCreate) {
        if (exists(newP)) return { code: 'exists', path: newP };
        const plusLines = [];
        for (const h of edit.hunks) {
          for (const it of h.nItems) if (!it.isContext) plusLines.push(it.text);
        }
        // Final break: unless a '\' line follows the last '+' line overall.
        let finalBreak = true;
        let lastHunk = null;
        let lastIdx = -1;
        for (const h of edit.hunks) {
          for (let k = 0; k < h.body.length; k++) {
            if (h.body[k].startsWith('+')) { lastHunk = h; lastIdx = k; }
          }
        }
        if (lastHunk && lastIdx + 1 < lastHunk.body.length && lastHunk.body[lastIdx + 1].startsWith('\\')) finalBreak = false;
        setFile(newP, joinFile(plusLines, false, plusLines.length > 0 ? finalBreak : false));
        return null;
      }
      if (edit.isDelete) {
        if (!exists(oldP)) return { code: 'missing', path: oldP };
        setFile(oldP, null);
        return null;
      }
      if (oldP !== newP) {
        // move
        if (!exists(oldP)) return { code: 'missing', path: oldP };
        if (exists(newP)) return { code: 'exists', path: newP };
        const res = applyUnifiedHunks(load(oldP), edit.hunks, strict);
        if (res.fail) return { code: 'no-match', path: oldP };
        setFile(newP, res.text);
        setFile(oldP, null);
        moves.push([oldP, newP]);
        return null;
      }
      // change
      if (!exists(oldP)) return { code: 'missing', path: oldP };
      const res = applyUnifiedHunks(load(oldP), edit.hunks, strict);
      if (res.fail) return { code: 'no-match', path: oldP };
      setFile(oldP, res.text);
      return null;
    }

    // --- SEARCH/REPLACE ---
    if (edit.kind === 'sr') {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (edit.oldLines.length === 0) {
        if (exists(edit.path)) return { code: 'exists', path: edit.path };
        setFile(edit.path, joinFile(edit.newLines, false, edit.newLines.length > 0));
        return null;
      }
      if (!exists(edit.path)) return { code: 'missing', path: edit.path };
      const info = splitFile(load(edit.path));
      const found = firstTierOcc(info.lines, edit.oldLines, strict, 0, false);
      if (!found) return { code: 'no-match', path: edit.path };
      if (found.occ.length > 1) return { code: 'ambiguous', path: edit.path };
      const pos = found.occ[0];
      const nItems = edit.newLines.map((t) => ({ text: t, isContext: false, oIndex: -1 }));
      const newLines = buildReplacement(nItems, edit.oldLines, info.lines, pos, found.tier);
      const outLines = info.lines.slice(0, pos).concat(newLines, info.lines.slice(pos + edit.oldLines.length));
      setFile(edit.path, joinFile(outLines, info.crlf, info.final));
      return null;
    }

    // --- V4A ---
    if (edit.kind === 'v4a-add') {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (exists(edit.path)) return { code: 'exists', path: edit.path };
      setFile(edit.path, joinFile(edit.fileLines, false, edit.fileLines.length > 0));
      return null;
    }
    if (edit.kind === 'v4a-delete') {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (!exists(edit.path)) return { code: 'missing', path: edit.path };
      setFile(edit.path, null);
      return null;
    }
    if (edit.kind === 'v4a-update') {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (edit.moveTo !== null && !isSafePath(edit.moveTo)) return { code: 'unsafe', path: edit.moveTo };
      if (!exists(edit.path)) return { code: 'missing', path: edit.path };
      if (edit.moveTo !== null && exists(edit.moveTo)) return { code: 'exists', path: edit.moveTo };
      const res = applyV4aChunks(load(edit.path), edit.chunks, strict);
      if (res.fail) return { code: 'no-match', path: edit.path };
      if (edit.moveTo !== null) {
        setFile(edit.moveTo, res.text);
        setFile(edit.path, null);
        moves.push([edit.path, edit.moveTo]);
      } else {
        setFile(edit.path, res.text);
      }
      return null;
    }

    // --- JSON ---
    if (edit.kind === 'json-create') {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (exists(edit.path)) return { code: 'exists', path: edit.path };
      setFile(edit.path, edit.fileText);
      return null;
    }
    if (edit.kind === 'json-str') {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (!exists(edit.path)) return { code: 'missing', path: edit.path };
      const fileText = load(edit.path);
      const info = splitFile(fileText);
      let text;
      let oldS;
      let newS;
      if (info.crlf) {
        text = fileText.replace(/\r\n/g, '\n');
        oldS = edit.oldStr.replace(/\r\n/g, '\n');
        newS = edit.newStr.replace(/\r\n/g, '\n');
      } else {
        text = fileText;
        oldS = edit.oldStr;
        newS = edit.newStr;
      }
      const cnt = countOverlapping(text, oldS);
      if (cnt === 0) return { code: 'no-match', path: edit.path };
      if (cnt > 1) return { code: 'ambiguous', path: edit.path };
      const idx = text.indexOf(oldS);
      let result = text.slice(0, idx) + newS + text.slice(idx + oldS.length);
      if (info.crlf) result = result.replace(/\n/g, '\r\n');
      setFile(edit.path, result);
      return null;
    }
    if (edit.kind === 'json-insert') {
      if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
      if (!exists(edit.path)) return { code: 'missing', path: edit.path };
      const info = splitFile(load(edit.path));
      if (edit.insertLine < 0 || edit.insertLine > info.lines.length) return { code: 'no-match', path: edit.path };
      const insLines = splitPatchLines(edit.newStr);
      const outLines = info.lines.slice(0, edit.insertLine).concat(insLines, info.lines.slice(edit.insertLine));
      setFile(edit.path, joinFile(outLines, info.crlf, info.final));
      return null;
    }
    return null;
  }

  for (const edit of edits) {
    const f = applyEdit(edit);
    if (f) failures.push(f);
  }

  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out };
  }

  // Exit 0 output: rows for changed paths, with R lines for real moves.
  const allPaths = new Set([...original.keys(), ...current.keys()]);
  const rows = []; // {sortKey, text}
  for (const p of allPaths) {
    const before = original.has(p) ? original.get(p) : null;
    const after = current.has(p) ? current.get(p) : before;
    if (before === after) continue;
    if (before === null) rows.push({ sortKey: p, text: `A ${p}` });
    else if (after === null) rows.push({ sortKey: p, text: `D ${p}` });
    else rows.push({ sortKey: p, text: `M ${p}` });
  }
  for (const [oldP, newP] of moves) {
    const beforeOld = original.has(oldP) ? original.get(oldP) : null;
    const afterOld = current.has(oldP) ? current.get(oldP) : null;
    const beforeNew = original.has(newP) ? original.get(newP) : null;
    const afterNew = current.has(newP) ? current.get(newP) : null;
    if (beforeOld !== null && afterOld === null && beforeNew === null && afterNew !== null) {
      const di = rows.findIndex((r) => r.text === `D ${oldP}`);
      const ai = rows.findIndex((r) => r.text === `A ${newP}`);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ sortKey: newP, text: `R ${oldP} -> ${newP}` });
      }
    }
  }
  rows.sort((a, b) => byteCompare(a.sortKey, b.sortKey));
  const out = rows.map((r) => r.text);
  out.push(`ok: ${rows.length} file${rows.length === 1 ? '' : 's'}`);

  if (!check) {
    for (const p of allPaths) {
      const before = original.has(p) ? original.get(p) : null;
      const after = current.has(p) ? current.get(p) : before;
      if (before === after) continue;
      if (after === null) {
        try { rmSync(p); } catch { /* already gone */ }
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, after, 'utf-8');
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
