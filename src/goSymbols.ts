// Top-level Go declarations from the token stream, shaped like gopls documentSymbol
// output (only what the lens provider uses). No vscode dependency.

import { Tok, tokenize } from './goScopes';

export type SymKind = 'func' | 'method' | 'interface' | 'struct' | 'functype' | 'type' | 'field' | 'imethod';

export interface GoSymbol {
  kind: SymKind;
  /** gopls-style name: `F`, `(*T).M`, `(T).M`, `T`. */
  name: string;
  /** Offset of the declaration start (`func` keyword, or the type name in a spec). */
  start: number;
  /** Name identifier. */
  nameStart: number;
  nameEnd: number;
  children: GoSymbol[];
}

function match(toks: Tok[], i: number): number {
  const open = toks[i].text;
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let d = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].text === open) {
      d++;
    } else if (toks[j].text === close && --d === 0) {
      return j;
    }
  }
  return toks.length - 1;
}

const sym = (kind: SymKind, name: string, start: number, t: Tok): GoSymbol => ({
  kind,
  name,
  start,
  nameStart: t.start,
  nameEnd: t.end,
  children: [],
});

/** Members of a struct or interface body; `open` is the index of `{`. */
function members(toks: Tok[], open: number, close: number, isInterface: boolean): GoSymbol[] {
  const out: GoSymbol[] = [];
  let i = open + 1;
  while (i < close) {
    // One field / method spec per line (or `;`).
    let end = i;
    while (end < close && !(end > i && (toks[end].nl || toks[end - 1].text === ';'))) {
      if (toks[end].text === '(' || toks[end].text === '[' || toks[end].text === '{') {
        end = match(toks, end);
      }
      end++;
    }
    const spec = toks.slice(i, Math.min(end, close)).filter((t) => t.text !== ';');
    if (spec.length > 0) {
      if (isInterface) {
        if (spec[0].kind === 'ident' && spec[1]?.text === '(') {
          out.push(sym('imethod', spec[0].text, spec[0].start, spec[0]));
        } else if (spec[0].kind === 'ident') {
          const last = spec[1]?.text === '.' && spec[2] ? spec[2] : spec[0];
          out.push(sym('field', last.text, spec[0].start, last)); // embedded interface
        }
      } else {
        // `A, B T` → named fields; `T`, `*T`, `pkg.T` (+ optional tag) → embedded.
        const names: Tok[] = [];
        let k = 0;
        while (spec[k]?.kind === 'ident') {
          names.push(spec[k]);
          if (spec[k + 1]?.text !== ',') {
            break;
          }
          k += 2;
        }
        const rest = spec.slice(k + 1).filter((t) => t.kind !== 'lit' || !/^[`"]/.test(t.text) || t !== spec[spec.length - 1]);
        const embedded = names.length === 1 && (rest.length === 0 || rest[0].text === '.');
        if (embedded || names.length === 0) {
          const idents = spec.filter((t) => t.kind === 'ident');
          const last = idents[idents.length - 1];
          if (last) {
            out.push(sym('field', last.text, spec[0].start, last));
          }
        } else {
          names.forEach((n) => out.push(sym('field', n.text, n.start, n)));
        }
      }
    }
    i = end;
  }
  return out;
}

/** Top-level funcs, methods and types (with struct fields / interface methods). */
export function goSymbols(text: string): GoSymbol[] {
  const toks = tokenize(text);
  const out: GoSymbol[] = [];
  const typeSpec = (i: number, start: number): number => {
    const name = toks[i];
    if (name?.kind !== 'ident') {
      return i;
    }
    let j = i + 1;
    if (toks[j]?.text === '[' && toks[j + 1]?.kind === 'ident' && toks[j + 2]?.text !== ']') {
      j = match(toks, j) + 1; // type parameters (not an array length)
    }
    if (toks[j]?.text === '=') {
      j++; // alias
    }
    const head = toks[j];
    let s: GoSymbol;
    if (head?.text === 'struct' && toks[j + 1]?.text === '{') {
      s = sym('struct', name.text, start, name);
      const close = match(toks, j + 1);
      s.children = members(toks, j + 1, close, false);
      j = close;
    } else if (head?.text === 'interface' && toks[j + 1]?.text === '{') {
      s = sym('interface', name.text, start, name);
      const close = match(toks, j + 1);
      s.children = members(toks, j + 1, close, true);
      j = close;
    } else {
      s = sym(head?.text === 'func' ? 'functype' : 'type', name.text, start, name);
      // Skip the type expression: up to the next line / `;` / end of a type group.
      let k = j;
      for (; k < toks.length; k++) {
        const x = toks[k];
        if (k > j && (x.nl || x.text === ';' || x.text === ')')) {
          break;
        }
        if (x.text === '(' || x.text === '[' || x.text === '{') {
          k = match(toks, k);
        }
      }
      j = k - 1;
    }
    out.push(s);
    return j;
  };

  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.text === '(' || t.text === '[' || t.text === '{') {
      depth++;
      continue;
    }
    if (t.text === ')' || t.text === ']' || t.text === '}') {
      depth--;
      continue;
    }
    if (depth !== 0 || t.kind !== 'kw') {
      continue;
    }
    if (t.text === 'func') {
      let j = i + 1;
      let recv = '';
      if (toks[j]?.text === '(') {
        const close = match(toks, j);
        // Receiver type: last identifier before `[` or `)` that is not the receiver name.
        const inner = toks.slice(j + 1, close);
        const br = inner.findIndex((x) => x.text === '[');
        const typeToks = (br >= 0 ? inner.slice(0, br) : inner).filter((x) => x.kind === 'ident');
        const ptr = inner.some((x) => x.text === '*');
        const typeName = typeToks[typeToks.length - 1]?.text;
        recv = typeName ? (ptr ? `(*${typeName})` : `(${typeName})`) : '';
        j = close + 1;
      }
      const name = toks[j];
      if (name?.kind === 'ident') {
        out.push(sym(recv ? 'method' : 'func', recv ? `${recv}.${name.text}` : name.text, t.start, name));
      }
      // Skip to the body (if any) so its braces do not count as top level.
      for (let k = j + 1; k < toks.length; k++) {
        const x = toks[k];
        if (x.text === '(' || x.text === '[') {
          k = match(toks, k);
        } else if (x.text === '{') {
          if (toks[k - 1]?.text === 'interface' || toks[k - 1]?.text === 'struct') {
            k = match(toks, k);
            continue;
          }
          i = match(toks, k);
          break;
        } else if (x.nl && x.kind === 'kw') {
          i = k - 1; // no body
          break;
        }
      }
      continue;
    }
    if (t.text === 'type') {
      if (toks[i + 1]?.text === '(') {
        const close = match(toks, i + 1);
        for (let j = i + 2; j < close; j++) {
          if (toks[j].kind === 'ident' && (j === i + 2 || toks[j].nl || toks[j - 1].text === ';')) {
            j = typeSpec(j, toks[j].start);
          }
        }
        i = close;
      } else {
        i = typeSpec(i + 1, t.start);
      }
    }
  }
  return out;
}
