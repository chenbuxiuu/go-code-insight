import * as vscode from 'vscode';
import { FuncRange, functionRanges, inlineValueTargets } from './goScopes';

/**
 * Debugger inline values for Go: `name = value` at the end of every line of the
 * current function (up to the stop line) that mentions a variable in scope.
 *
 * Which identifiers are variables, and which declaration they refer to at the stop,
 * comes from a local scope analysis of the function (src/goScopes.ts). Values come
 * from the debug adapter: one `scopes` + one `variables` request per stack frame,
 * cached until the debugger moves. No extra process.
 */

interface DapVariable {
  name: string;
  value: string;
  variablesReference: number;
}

interface Options {
  enable: boolean;
  maxLength: number;
}

const MAX_VALUES = 200;

/** Shown text for a value, or undefined to skip it (unreadable or overly complex). */
function display(v: DapVariable, max: number): string | undefined {
  const value = v.value.replace(/\s+/g, ' ').trim();
  if (!value || /^(unreadable|<)/.test(value)) {
    return undefined;
  }
  if (v.variablesReference > 0 && value.length > max) {
    return undefined; // struct / slice / map too large to be useful inline
  }
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export class GoInlineValuesProvider implements vscode.InlineValuesProvider, vscode.Disposable {
  private funcs: { uri: string; version: number; ranges: FuncRange[] } | undefined;
  private frame: { key: string; vars: Promise<Map<string, DapVariable>> } | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly options: () => Options) {
    const reset = () => (this.frame = undefined);
    this.subscriptions = [vscode.debug.onDidChangeActiveStackItem(reset), vscode.debug.onDidTerminateDebugSession(reset)];
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
  }

  async provideInlineValues(
    document: vscode.TextDocument,
    viewPort: vscode.Range,
    context: vscode.InlineValueContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineValue[] | undefined> {
    const { enable, maxLength } = this.options();
    const session = enable ? this.sessionFor(context.frameId) : undefined;
    if (!session) {
      return undefined;
    }
    const text = document.getText();
    const stop = document.offsetAt(context.stoppedLocation.start);
    const fn = this.functionsOf(document, text).find((f) => stop >= f.bodyStart && stop <= f.end);
    if (!fn) {
      return [];
    }
    const targets = inlineValueTargets(text, stop, fn);
    if (targets.length === 0) {
      return [];
    }
    const vars = await this.variables(session, context.frameId);
    if (token.isCancellationRequested) {
      return undefined;
    }
    const out: vscode.InlineValue[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      const v = vars.get(t.name);
      if (!v) {
        continue; // e.g. optimized away
      }
      const start = document.positionAt(t.start);
      const key = `${start.line}:${t.name}`;
      if (start.line < viewPort.start.line || start.line > viewPort.end.line || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const shown = display(v, maxLength);
      if (shown !== undefined) {
        out.push(new vscode.InlineValueText(new vscode.Range(start, document.positionAt(t.end)), `${t.name} = ${shown}`));
        if (out.length >= MAX_VALUES) {
          break;
        }
      }
    }
    return out;
  }

  private sessionFor(frameId: number): vscode.DebugSession | undefined {
    const item = vscode.debug.activeStackItem;
    const session = item instanceof vscode.DebugStackFrame && item.frameId === frameId ? item.session : vscode.debug.activeDebugSession;
    return session?.type === 'go' ? session : undefined;
  }

  private functionsOf(document: vscode.TextDocument, text: string): FuncRange[] {
    const uri = document.uri.toString();
    if (this.funcs?.uri !== uri || this.funcs.version !== document.version) {
      this.funcs = { uri, version: document.version, ranges: functionRanges(text) };
    }
    return this.funcs.ranges;
  }

  /** Locals and arguments of the frame, by name (first scope wins). */
  private variables(session: vscode.DebugSession, frameId: number): Promise<Map<string, DapVariable>> {
    const key = `${session.id}:${frameId}`;
    if (this.frame?.key !== key) {
      const vars = (async () => {
        const map = new Map<string, DapVariable>();
        const { scopes } = await session.customRequest('scopes', { frameId });
        for (const s of (scopes ?? []) as Array<{ name: string; variablesReference: number; expensive?: boolean }>) {
          if (s.expensive || /global|register/i.test(s.name)) {
            continue;
          }
          const { variables } = await session.customRequest('variables', { variablesReference: s.variablesReference });
          for (const v of (variables ?? []) as DapVariable[]) {
            if (!map.has(v.name)) {
              map.set(v.name, v);
            }
          }
        }
        return map;
      })().catch(() => new Map<string, DapVariable>());
      this.frame = { key, vars };
    }
    return this.frame.vars;
  }
}
