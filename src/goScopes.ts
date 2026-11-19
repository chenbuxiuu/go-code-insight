// Lightweight Go tokenizer and function-scope analysis for debugger inline values.
// No vscode dependency (unit-testable). Works on the text of one function only.

export type TokKind = 'ident' | 'kw' | 'op' | 'lit';

export interface Tok {
  kind: TokKind;
  text: string;
  start: number;
  end: number;
  /** A newline separates this token from the previous one. */
  nl: boolean;
}

const KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto',
  'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
]);
const OPS3 = ['...', '<<=', '>>=', '&^='];
const OPS2 = [':=', '<-', '&&', '||', '==', '!=', '<=', '>=', '<<', '>>', '&^', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];
const isIdStart = (c: string) => /[\p{L}_]/u.test(c);
const isIdPart = (c: string) => /[\p{L}\p{N}_]/u.test(c);

/** Tokenizes text[from, to). Comments are skipped (they count as newlines if they span one). */
export function tokenize(text: string, from = 0, to = text.length): Tok[] {
  const toks: Tok[] = [];
  let i = from;
  let nl = false;
  while (i < to) {
    const c = text[i];
    if (c === '\n') {
      nl = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? to : e;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? to : e + 2;
      if (text.slice(i, end).includes('\n')) {
        nl = true;
      }
      i = end;
      continue;
    }
    const start = i;
    let kind: TokKind;
    if (c === '"' || c === "'") {
      i++;
      while (i < to && text[i] !== c && text[i] !== '\n') {
        i += text[i] === '\\' ? 2 : 1;
      }
      i++;
      kind = 'lit';
    } else if (c === '`') {
      const e = text.indexOf('`', i + 1);
      i = e < 0 ? to : e + 1;
      kind = 'lit';
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      i++;
      while (i < to && /[0-9a-zA-Z_.]/.test(text[i])) {
        // exponent sign: 1e-5, 0x1p+3
        i += /[eEpP]/.test(text[i]) && /[+-]/.test(text[i + 1] ?? '') ? 2 : 1;
      }
      kind = 'lit';
    } else if (isIdStart(c)) {
      i++;
      while (i < to && isIdPart(text[i])) {
        i++;
      }
      kind = KEYWORDS.has(text.slice(start, i)) ? 'kw' : 'ident';
    } else {
      const three = text.slice(i, i + 3);
      const two = text.slice(i, i + 2);
      i += OPS3.includes(three) ? 3 : OPS2.includes(two) ? 2 : 1;
      kind = 'op';
    }
    toks.push({ kind, text: text.slice(start, i), start, end: i, nl });
    nl = false;
  }
  return toks;
}

/** Index of the token matching the bracket at `i` ( ( [ { ), or toks.length. */
function matchBracket(toks: Tok[], i: number): number {
  const open = toks[i].text;
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].text === open) {
      depth++;
    } else if (toks[j].text === close && --depth === 0) {
      return j;
    }
  }
  return toks.length;
}

interface FuncSig {
  /** Token index of the body '{' (or -1 if the function has no body). */
  body: number;
  /** Parameter / receiver / named result identifiers (token indices). */
  params: number[];
}

/** Parses a func declaration or literal starting at token `f` (the `func` keyword). */
function parseFunc(toks: Tok[], f: number): FuncSig {
  const params: number[] = [];
  const paramList = (open: number): number => {
    const close = matchBracket(toks, open);
    // Split into comma separated items at depth 0.
    const items: number[][] = [];
    let cur: number[] = [];
    let depth = 0;
    for (let j = open + 1; j < close; j++) {
      const t = toks[j].text;
      if (t === '(' || t === '[' || t === '{') {
        depth++;
      } else if (t === ')' || t === ']' || t === '}') {
        depth--;
      }
      if (depth === 0 && t === ',') {
        items.push(cur);
        cur = [];
      } else {
        cur.push(j);
      }
    }
    if (cur.length) {
      items.push(cur);
    }
    // Either all parameters are named or none is (Go spec).
    const named = items.some((it) => it.length >= 2 && toks[it[0]].kind === 'ident' && toks[it[1]].text !== '.');
    if (named) {
      for (const it of items) {
        if (it.length && toks[it[0]].kind === 'ident' && toks[it[0]].text !== '_') {
          params.push(it[0]);
        }
      }
    }
    return close;
  };
  let i = f + 1;
  if (toks[i]?.text === '(') {
    i = paramList(i) + 1; // receiver, or the parameters of a func literal
  }
  if (toks[i]?.kind === 'ident') {
    i++; // name
    if (toks[i]?.text === '[') {
      i = matchBracket(toks, i) + 1; // type parameters
    }
    if (toks[i]?.text === '(') {
      i = paramList(i) + 1;
    }
  }
  if (toks[i]?.text === '(') {
    i = paramList(i) + 1; // results (only named ones are recorded)
  }
  // Skip a result type up to the body brace.
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.text === '{') {
      const prev = toks[i - 1];
      if (prev && (prev.text === 'interface' || prev.text === 'struct')) {
        i = matchBracket(toks, i);
        continue;
      }
      return { body: i, params };
    }
    if (t.text === '(' || t.text === '[') {
      i = matchBracket(toks, i);
      continue;
    }
    if (t.nl && t.kind === 'kw' && (t.text === 'func' || t.text === 'type' || t.text === 'var' || t.text === 'const')) {
      break; // declaration without body
    }
  }
  return { body: -1, params };
}

export interface FuncRange {
  start: number;
  bodyStart: number;
  end: number;
}

/** Top-level function/method declarations with bodies. */
export function functionRanges(text: string): FuncRange[] {
  const toks = tokenize(text);
  const out: FuncRange[] = [];
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].text;
    if (t === '{' || t === '(' || t === '[') {
      depth++;
    } else if (t === '}' || t === ')' || t === ']') {
      depth--;
    } else if (depth === 0 && t === 'func' && toks[i].kind === 'kw') {
      const sig = parseFunc(toks, i);
      if (sig.body >= 0) {
        const close = matchBracket(toks, sig.body);
        out.push({ start: toks[i].start, bodyStart: toks[sig.body].start, end: toks[Math.min(close, toks.length - 1)].end });
        i = close;
      }
    }
  }
  return out;
}

interface Decl {
  name: string;
  offset: number;
  /** Parameters are initialized on entry, even when declared on the stop line. */
  param: boolean;
  scopeStart: number;
  scopeEnd: number;
}

export interface Occurrence {
  name: string;
  start: number;
  end: number;
}

/** True if the `{` at `j` inside an if/for/switch header opens a composite literal (e.g. `[]int{`). */
function isLiteralBrace(toks: Tok[], j: number): boolean {
  let k = j - 1;
  if (toks[k]?.text === '}') {
    return true; // struct{...}{ or nested literal
  }
  if (toks[k]?.kind !== 'ident') {
    return false;
  }
  k--;
  if (toks[k]?.text === '.' && toks[k - 1]?.kind === 'ident') {
    k -= 2;
  }
  while (toks[k]?.text === '*') {
    k--;
  }
  return toks[k]?.text === ']';
}

/** Index of the block brace of an if/for/switch/select statement whose keyword is at `kw`. */
function headerBlock(toks: Tok[], kw: number, limit: number): number {
  for (let j = kw + 1; j < limit; j++) {
    const t = toks[j];
    if (t.text === '(' || t.text === '[') {
      j = matchBracket(toks, j);
    } else if (t.kind === 'kw' && t.text === 'func') {
      const sig = parseFunc(toks, j);
      j = sig.body >= 0 ? matchBracket(toks, sig.body) : j;
    } else if (t.text === '{') {
      const prev = toks[j - 1];
      if (prev && (prev.text === 'struct' || prev.text === 'interface' || isLiteralBrace(toks, j))) {
        j = matchBracket(toks, j);
        continue;
      }
      return j;
    }
  }
  return -1;
}

/**
 * Identifiers worth an inline value when stopped at `stop` (an offset in `text`):
 * occurrences, from the start of the enclosing function up to the end of the stop
 * line, of local variables/parameters that are in scope at the stop, already
 * declared before the stop line, and not shadowed there.
 */
export function inlineValueTargets(text: string, stop: number, fn?: FuncRange): Occurrence[] {
  fn ??= functionRanges(text).find((f) => stop >= f.bodyStart && stop <= f.end);
  if (!fn) {
    return [];
  }
  const lineStart = text.lastIndexOf('\n', stop - 1) + 1;
  let lineEnd = text.indexOf('\n', stop);
  if (lineEnd < 0) {
    lineEnd = text.length;
  }
  const toks = tokenize(text, fn.start, fn.end);
  const decls: Decl[] = [];
  const blocks: Array<[number, number]> = []; // scope intervals
  const declare = (idx: number, scopeStart: number, scopeEnd: number, param = false) => {
    const t = toks[idx];
    if (t.kind === 'ident' && t.text !== '_') {
      decls.push({ name: t.text, offset: t.start, param, scopeStart, scopeEnd });
    }
  };
  const endOf = (idx: number) => (idx < toks.length ? toks[idx].end : fn!.end);

  // Pass 1: scopes and declarations.
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'kw' && t.text === 'func') {
      const sig = parseFunc(toks, i);
      if (sig.body >= 0) {
        const end = endOf(matchBracket(toks, sig.body));
        sig.params.forEach((p) => declare(p, t.start, end, true));
      }
    } else if (t.text === '{') {
      blocks.push([t.start, endOf(matchBracket(toks, i))]);
    } else if (t.kind === 'kw' && (t.text === 'if' || t.text === 'for' || t.text === 'switch' || t.text === 'select')) {
      const b = headerBlock(toks, i, toks.length);
      if (b >= 0) {
        let close = matchBracket(toks, b);
        // An if statement's implicit block includes its else chain.
        while (t.text === 'if' && toks[close + 1]?.text === 'else') {
          const n = close + 2;
          const nb = toks[n]?.text === '{' ? n : headerBlock(toks, n, toks.length);
          if (nb < 0) {
            break;
          }
          close = matchBracket(toks, nb);
        }
        blocks.push([t.start, endOf(close)]);
      }
    } else if (t.text === ':=') {
      for (let j = i - 1; j >= 0 && toks[j].kind === 'ident'; j -= 2) {
        declare(j, -1, -1);
        if (toks[j - 1]?.text !== ',') {
          break;
        }
      }
    } else if (t.kind === 'kw' && t.text === 'var') {
      const specs: number[] = [];
      if (toks[i + 1]?.text === '(') {
        const close = matchBracket(toks, i + 1);
        for (let j = i + 2; j < close; j++) {
          if (j === i + 2 || toks[j].nl || toks[j - 1].text === ';') {
            specs.push(j);
          }
          if (toks[j].text === '(' || toks[j].text === '[' || toks[j].text === '{') {
            j = matchBracket(toks, j);
          }
        }
      } else {
        specs.push(i + 1);
      }
      for (const s of specs) {
        for (let j = s; toks[j]?.kind === 'ident'; j += 2) {
          declare(j, -1, -1);
          if (toks[j + 1]?.text !== ',') {
            break;
          }
        }
      }
    }
  }
  // Variables declared by := / var belong to the innermost scope containing them.
  for (const d of decls) {
    if (d.scopeStart >= 0) {
      continue;
    }
    let best: [number, number] = [fn.start, fn.end];
    for (const b of blocks) {
      if (b[0] <= d.offset && d.offset < b[1] && b[0] >= best[0]) {
        best = b;
      }
    }
    [d.scopeStart, d.scopeEnd] = best;
  }

  const resolve = (name: string, at: number): Decl | undefined => {
    let found: Decl | undefined;
    for (const d of decls) {
      if (d.name !== name || d.offset > at || at < d.scopeStart || at >= d.scopeEnd) {
        continue;
      }
      if (!found || d.scopeStart > found.scopeStart || (d.scopeStart === found.scopeStart && d.offset < found.offset)) {
        found = d;
      }
    }
    return found;
  };

  // Pass 2: occurrences up to the stop line.
  const out: Occurrence[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.start > lineEnd) {
      break;
    }
    if (t.kind !== 'ident' || toks[i - 1]?.text === '.') {
      continue;
    }
    // Keys in composite literals: T{Key: v}
    if (toks[i + 1]?.text === ':' && (toks[i - 1]?.text === '{' || toks[i - 1]?.text === ',')) {
      continue;
    }
    const d = resolve(t.text, t.start);
    if (!d || (!d.param && d.offset >= lineStart) || resolve(t.text, stop) !== d) {
      continue;
    }
    out.push({ name: t.text, start: t.start, end: t.end });
  }
  return out;
}
