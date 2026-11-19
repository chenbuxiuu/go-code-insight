// Lightweight, dependency-free helpers for extracting declaration facts from Go
// source text. Used to label gopls results without opening documents (which would
// make VS Code send didOpen to gopls and allocate editor models).

export interface Pos {
  line: number;
  character: number; // UTF-16 code units, same as LSP/VS Code
}

export interface DeclInfo {
  name: string;
  isInterface: boolean;
  /** Methods declared directly in the interface body: name -> offset. */
  methods: Map<string, number>;
}

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;
const RECEIVER_RE = /\bfunc\s*\(\s*(?:[\p{L}_][\p{L}\p{N}_]*\s+)?\*?\s*([\p{L}_][\p{L}\p{N}_]*)/du;

export function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && IDENT_START.test(c);
}

export function isIdentPart(c: string | undefined): boolean {
  return c !== undefined && IDENT_PART.test(c);
}

export function isExported(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

/** Finds the receiver type name in `func (r *T[K]) Name(...)`, searching from `from`. */
export function parseReceiver(text: string, from = 0): { name: string; offset: number } | undefined {
  const slice = text.slice(from, from + 400);
  const m = RECEIVER_RE.exec(slice);
  if (!m || !m.indices || !m.indices[1]) {
    return undefined;
  }
  return { name: m[1], offset: from + m.indices[1][0] };
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  return i;
}

function skipQuoted(text: string, i: number, quote: string): number {
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote || c === '\n') {
      return i + 1;
    }
    i++;
  }
  return i;
}

/** Skips a balanced bracket group starting at text[i] (one of ( [ {). */
function skipBalanced(text: string, i: number): number {
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(text, i, c);
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
    i++;
  }
  return i;
}

/** Collects method names declared directly in an interface body; `open` is the offset of '{'. */
export function scanInterfaceMethods(text: string, open: number): Map<string, number> {
  const methods = new Map<string, number>();
  const n = text.length;
  let i = open + 1;
  let depth = 0;
  let lineStart = true;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(text, i, c);
      lineStart = false;
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      i = end < 0 ? n : end + 1;
      lineStart = false;
      continue;
    }
    if (c === '\n' || c === ';') {
      if (depth === 0) {
        lineStart = true;
      }
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      lineStart = false;
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        break; // end of interface body
      }
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && lineStart && isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(text[j])) {
        j++;
      }
      let k = j;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) {
        k++;
      }
      if (text[k] === '(') {
        methods.set(text.slice(i, j), i);
      }
      lineStart = false;
      i = j;
      continue;
    }
    lineStart = false;
    i++;
  }
  return methods;
}

const isWordCode = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127;
const DOC_LINK = /\[[\p{L}_][\p{L}\p{N}_.*]*\]/gu;

/**
 * Hash of the Go token stream, ignoring comments, blank lines and formatting.
 * Two texts with the same hash type-check identically, so gopls answers (other
 * than positions) cannot differ. Newlines are kept because Go inserts semicolons
 * at line ends; doc links in comments ([Name]) are kept because gopls may resolve
 * them as references.
 */
export function semanticHash(text: string): number {
  let h = 0x811c9dc5;
  const mix = (c: number) => {
    h ^= c;
    h = Math.imul(h, 0x01000193);
  };
  let prev = 10; // last emitted char code
  let gapNewline = false;
  let gap = false;
  const n = text.length;
  let i = 0;
  const comment = (body: string) => {
    for (const m of body.matchAll(DOC_LINK)) {
      for (let k = 0; k < m[0].length; k++) {
        mix(m[0].charCodeAt(k));
      }
    }
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 13 || c === 10) {
      gap = true;
      gapNewline ||= c === 10;
      i++;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 47) {
      let end = text.indexOf('\n', i);
      if (end < 0) {
        end = n;
      }
      comment(text.slice(i, end));
      gap = true;
      i = end;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      let end = text.indexOf('*/', i + 2);
      end = end < 0 ? n : end + 2;
      const body = text.slice(i, end);
      comment(body);
      gap = true;
      gapNewline ||= body.includes('\n');
      i = end;
      continue;
    }
    if (gap) {
      if (gapNewline && prev !== 10) {
        mix(10);
        prev = 10;
      } else if (!gapNewline && isWordCode(prev) && isWordCode(c)) {
        mix(32);
      }
      gap = gapNewline = false;
    }
    if (c === 34 || c === 39 || c === 96) {
      // string, rune or raw string: hash verbatim
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 92 && c !== 96) {
          j += 2;
          continue;
        }
        j++;
        if (d === c || (d === 10 && c !== 96)) {
          break;
        }
      }
      for (let k = i; k < j; k++) {
        mix(text.charCodeAt(k));
      }
      prev = c;
      i = j;
      continue;
    }
    mix(c);
    prev = c;
    i++;
  }
  return h >>> 0;
}

/**
 * Indexed Go source text. Instances are immutable; derived facts are memoized.
 */
export class GoText {
  private lineStarts: number[] | undefined;
  private pkg: string | undefined;
  private decls = new Map<number, DeclInfo>();

  constructor(readonly text: string) {}

  private starts(): number[] {
    if (!this.lineStarts) {
      const s = [0];
      const t = this.text;
      for (let i = 0; i < t.length; i++) {
        if (t.charCodeAt(i) === 10) {
          s.push(i + 1);
        }
      }
      this.lineStarts = s;
    }
    return this.lineStarts;
  }

  offsetAt(p: Pos): number {
    const s = this.starts();
    const line = Math.min(Math.max(p.line, 0), s.length - 1);
    return Math.min(s[line] + p.character, this.text.length);
  }

  positionAt(offset: number): Pos {
    const s = this.starts();
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo, character: offset - s[lo] };
  }

  lineText(line: number): string {
    const s = this.starts();
    if (line < 0 || line >= s.length) {
      return '';
    }
    const end = line + 1 < s.length ? s[line + 1] - 1 : this.text.length;
    return this.text.slice(s[line], end).replace(/\r$/, '');
  }

  packageName(): string {
    if (this.pkg === undefined) {
      const m = /^\s*package\s+([\p{L}_][\p{L}\p{N}_]*)/mu.exec(this.text);
      this.pkg = m ? m[1] : '';
    }
    return this.pkg;
  }

  identAt(offset: number): string {
    let j = offset;
    while (j < this.text.length && isIdentPart(this.text[j])) {
      j++;
    }
    return this.text.slice(offset, j);
  }

  /** Describes the type declared with its name at `offset` (e.g. `Reader` in `type Reader interface {`). */
  declAt(offset: number): DeclInfo {
    let info = this.decls.get(offset);
    if (info) {
      return info;
    }
    const t = this.text;
    const name = this.identAt(offset);
    let i = skipSpace(t, offset + name.length);
    if (t[i] === '[') {
      i = skipSpace(t, skipBalanced(t, i)); // type parameters
    }
    if (t[i] === '=') {
      i = skipSpace(t, i + 1); // alias
    }
    let isInterface = false;
    let methods = new Map<string, number>();
    if (t.startsWith('interface', i) && !isIdentPart(t[i + 9])) {
      isInterface = true;
      const open = skipSpace(t, i + 9);
      if (t[open] === '{') {
        methods = scanInterfaceMethods(t, open);
      }
    }
    info = { name, isInterface, methods };
    this.decls.set(offset, info);
    return info;
  }

  /** True if the identifier at `pos` is the name of a `func` declaration (function or method). */
  isFuncDeclName(pos: Pos): boolean {
    const before = this.lineText(pos.line).slice(0, pos.character);
    return /^\s*func\b/.test(before);
  }

  /** Receiver type of the method whose name is at `pos`, if it is a method declaration. */
  receiverOf(pos: Pos): string | undefined {
    const lineStart = this.offsetAt({ line: pos.line, character: 0 });
    const r = parseReceiver(this.text.slice(lineStart, this.offsetAt(pos)));
    return r?.name;
  }
}
