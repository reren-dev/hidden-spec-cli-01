// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md: the command line (1), output and exit codes (2), files,
// lines and paths (3), format detection (4), three-tier line matching (5),
// unified diffs (6), SEARCH/REPLACE blocks (7), V4A patches (8), JSON edits
// (9), and order and atomicity (10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n (section 3). */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit performed, as [old, new] pairs, for the R lines of section 2. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- matching (section 5) ----

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

/** Positions where O occurs in lines at one tier; occurrences may overlap. */
function occurrences(O: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > lines.length) return out;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(O: string[], lines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, lines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** A line of a hunk or chunk: context, old (-), new (+), or a backslash line. */
interface Item {
  kind: 'ctx' | 'del' | 'add' | 'esc';
  text: string;
}

/**
 * Build the lines that replace a matched run: a context line is written as the
 * file's own matched line, never the patch's; at tier 2 every other new line
 * that starts with O's first line's leading whitespace has that prefix
 * replaced by the file's first matched line's leading whitespace.
 */
function buildReplacement(oItems: Item[], nItems: Item[], fileLines: string[], pos: number, tier: number): string[] {
  const ctxFile: string[] = [];
  for (let j = 0; j < oItems.length; j++) {
    if (oItems[j]!.kind === 'ctx') ctxFile.push(fileLines[pos + j]!);
  }
  const f = leadWs(fileLines[pos]!);
  const p = leadWs(oItems[0]!.text);
  const out: string[] = [];
  let ci = 0;
  for (const it of nItems) {
    if (it.kind === 'ctx') {
      out.push(ctxFile[ci++]!);
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Whether a `\` line follows the hunk's last context or `+` line (section 6). */
function noNewline(items: Item[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.kind === 'ctx' || items[i]!.kind === 'add') last = i;
  }
  if (last < 0) return false;
  return items[last + 1] !== undefined && items[last + 1]!.kind === 'esc';
}

// ---- JSON edits (section 9) ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const m = splitFile(before);
      if (line < 0 || line > m.lines.length) throw new Fail('no-match', p);
      m.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(m));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (section 6) ----

interface Hunk {
  a: number;
  items: Item[];
}

interface Section {
  oldPath: string | null | undefined; // undefined: no ---/+++ pair; null: /dev/null
  newPath: string | null | undefined;
  gitA: string | undefined;
  gitB: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` or `+++ ` header line: after the four characters, up to the first tab, surrounding spaces removed, one leading a/ or b/ removed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHunks = false;
  let i = 0;
  const startSection = (oldP: string | null | undefined, newP: string | null | undefined, gitA?: string, gitB?: string): void => {
    const s: Section = {
      oldPath: oldP,
      newPath: newP,
      gitA,
      gitB,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHunks = false;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(undefined, undefined, m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), items: [] };
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          hunk.items.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') {
          hunk.items.push({ kind: 'ctx', text: b.slice(1) });
          i++;
          continue;
        }
        if (c === '-') {
          hunk.items.push({ kind: 'del', text: b.slice(1) });
          i++;
          continue;
        }
        if (c === '+') {
          hunk.items.push({ kind: 'add', text: b.slice(1) });
          i++;
          continue;
        }
        if (c === '\\') {
          hunk.items.push({ kind: 'esc', text: b });
          i++;
          continue;
        }
        break;
      }
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.items.pop();
        else break;
      }
      cur.hunks.push(hunk);
      inHunks = true;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !inHunks) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
      } else {
        startSection(headerPath(line), headerPath(lines[i + 1]!));
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && !inHunks) throw new Exit2(`error: parse ${i + 2}`);
    if (cur !== null && !inHunks) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (/^new file mode( |$)/.test(line)) cur.newFile = true;
      else if (/^deleted file mode( |$)/.test(line)) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks in order to a file's text, each to the result of the ones before it. */
function applyHunks(hunks: Hunk[], text: string, strict: boolean, path: string): string {
  const m = splitFile(text);
  let cur = m.lines;
  let curFinal = m.final;
  let d = 0;
  for (const h of hunks) {
    const oItems = h.items.filter((x) => x.kind === 'ctx' || x.kind === 'del');
    const nItems = h.items.filter((x) => x.kind === 'ctx' || x.kind === 'add');
    const O = oItems.map((x) => x.text);
    const N = nItems.map((x) => x.text);
    const noNl = noNewline(h.items);
    if (O.length === 0) {
      // Insert after the first A + d lines (all of them when the file has fewer);
      // A + d can go below zero when earlier hunks deleted lines, and then the
      // insertion is at the top, never a negative index into the lines.
      const at = Math.max(0, Math.min(h.a + d, cur.length));
      const atEnd = at === cur.length;
      cur = [...cur.slice(0, at), ...N, ...cur.slice(at)];
      if (atEnd) curFinal = !noNl;
      d += N.length;
      continue;
    }
    const found = findTier(O, cur, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bd = Math.abs(best - target);
    for (const p of found.occ) {
      const dd = Math.abs(p - target);
      if (dd < bd) {
        best = p;
        bd = dd;
      }
    }
    const repl = buildReplacement(oItems, nItems, cur, best, found.tier);
    const endAtEnd = best + O.length === cur.length;
    cur = [...cur.slice(0, best), ...repl, ...cur.slice(best + O.length)];
    if (endAtEnd) curFinal = !noNl;
    d += N.length - O.length;
  }
  return joinFile({ lines: cur, br: m.br, final: curFinal });
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldP: string | null = s.oldPath !== undefined ? s.oldPath : s.renameFrom !== undefined ? s.renameFrom : (s.gitA ?? null);
  const newP: string | null = s.newPath !== undefined ? s.newPath : s.renameTo !== undefined ? s.renameTo : (s.gitB ?? null);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null || s.newFile) {
      // Creation: the new path does not exist; the file is the + lines of all its hunks.
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noNl = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.items.length; k++) {
          if (h.items[k]!.kind === 'add') {
            plus.push(h.items[k]!.text);
            noNl = h.items[k + 1] !== undefined && h.items[k + 1]!.kind === 'esc';
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (newP === null || s.deletedFile) {
      // Deletion: the old path exists; it is deleted, its hunks not read.
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      // Move: hunks apply to the old file's lines, the result is written at the new path.
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const res = applyHunks(s.hunks, before, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, res);
      tree.moves.push([oldP, newP]);
      return;
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(s.hunks, before, strict, oldP));
  };
}

// ---- SEARCH/REPLACE blocks (section 7) ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) }, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const m = splitFile(before);
    const found = findTier(b.oldLines, m.lines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const oItems: Item[] = b.oldLines.map((t) => ({ kind: 'del' as const, text: t }));
    const nItems: Item[] = b.newLines.map((t) => ({ kind: 'add' as const, text: t }));
    const repl = buildReplacement(oItems, nItems, m.lines, pos, found.tier);
    const out = [...m.lines.slice(0, pos), ...repl, ...m.lines.slice(pos + b.oldLines.length)];
    tree.now.set(p, joinFile({ lines: out, br: m.br, final: m.final }));
  };
}

// ---- V4A patches (section 8) ----

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

interface RawSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerNo: number;
  body: Array<{ text: string; no: number }>;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const no = i + 1;
    if (line.startsWith('*** Add File: ')) {
      cur = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), headerNo: no, body: [] };
      sections.push(cur);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      cur = { kind: 'delete', path: line.slice('*** Delete File: '.length).trim(), headerNo: no, body: [] };
      sections.push(cur);
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      cur = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), headerNo: no, body: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${no}`);
    }
    cur.body.push({ text: line, no });
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    while (s.body.length > 0 && blank(s.body[s.body.length - 1]!.text)) s.body.pop();
    if (s.kind === 'add') {
      const fileLines: string[] = [];
      for (const b of s.body) {
        if (b.text === '') fileLines.push('');
        else if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.no}`);
      }
      edits.push(v4aAddEdit(s.path, fileLines));
      continue;
    }
    if (s.kind === 'delete') {
      if (s.body.length > 0) throw new Exit2(`error: parse ${s.body[0]!.no}`);
      edits.push(v4aDeleteEdit(s.path));
      continue;
    }
    // update
    let moveTo: string | null = null;
    let idx = 0;
    if (s.body.length > 0 && s.body[0]!.text.startsWith('*** Move to: ')) {
      moveTo = s.body[0]!.text.slice('*** Move to: '.length).trim();
      idx = 1;
    }
    const chunks: V4AChunk[] = [];
    let chunk: V4AChunk | null = null;
    let seenChunk = false;
    const endChunk = (): void => {
      if (chunk !== null) {
        chunks.push(chunk);
        chunk = null;
      }
    };
    for (; idx < s.body.length; idx++) {
      const b = s.body[idx]!;
      const line = b.text;
      if (line.startsWith('@@')) {
        endChunk();
        const anchor = line.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
        seenChunk = true;
        continue;
      }
      if (line === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${b.no}`);
        chunk.eof = true;
        endChunk();
        continue;
      }
      if (chunk === null) {
        if (seenChunk) throw new Exit2(`error: parse ${b.no}`);
        chunk = { anchor: null, eof: false, items: [] };
        seenChunk = true;
      }
      if (line === '') {
        chunk.items.push({ kind: 'ctx', text: '' });
        continue;
      }
      const c = line[0]!;
      if (c === ' ') {
        chunk.items.push({ kind: 'ctx', text: line.slice(1) });
        continue;
      }
      if (c === '-') {
        chunk.items.push({ kind: 'del', text: line.slice(1) });
        continue;
      }
      if (c === '+') {
        chunk.items.push({ kind: 'add', text: line.slice(1) });
        continue;
      }
      throw new Exit2(`error: parse ${b.no}`);
    }
    endChunk();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.headerNo}`);
    edits.push(v4aUpdateEdit(s.path, moveTo, chunks, strict));
  }
  return edits;
}

/** The first line at or after `from` equal to the anchor at the first tier where one is, or -1. */
function findAnchor(anchor: string, lines: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (tierEq(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

/** The first occurrence of O at or after `from` at the first tier with one (an end-of-file chunk takes only one ending at the file's last line). */
function findTierFrom(O: string[], lines: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, lines, t).filter((p) => p >= from);
    if (occ.length === 0) continue;
    if (eof) {
      const good = occ.filter((p) => p + O.length === lines.length);
      if (good.length === 0) continue;
      return { tier: t, pos: good[0]! };
    }
    return { tier: t, pos: occ[0]! };
  }
  return null;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = splitFile(before);
    let cur = m.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(ch.anchor, cur, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const oItems = ch.items.filter((x) => x.kind === 'ctx' || x.kind === 'del');
      const nItems = ch.items.filter((x) => x.kind === 'ctx' || x.kind === 'add');
      const O = oItems.map((x) => x.text);
      const N = nItems.map((x) => x.text);
      if (O.length === 0) {
        const at = ch.eof ? cur.length : cursor;
        cur = [...cur.slice(0, at), ...N, ...cur.slice(at)];
        cursor = at + N.length;
        continue;
      }
      const found = findTierFrom(O, cur, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const repl = buildReplacement(oItems, nItems, cur, found.pos, found.tier);
      cur = [...cur.slice(0, found.pos), ...repl, ...cur.slice(found.pos + O.length)];
      cursor = found.pos + repl.length;
    }
    const text = joinFile({ lines: cur, br: m.br, final: m.final });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

// ---- the run (sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (covered.has(oldP) || covered.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
