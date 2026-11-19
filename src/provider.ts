import * as vscode from 'vscode';
import { isExported, parseReceiver, semanticHash } from './goText';
import { goSymbols, SymKind } from './goSymbols';
import { Limiter } from './limiter';
import { DepIndex, DepIndexOptions, isImmutableModule } from './depIndex';
import { findGoTool, ModuleIndex, ModuleIndexOptions } from './moduleIndex';
import { PackageMethods } from './packageMethods';
import { TextStore } from './textStore';

export const SHOW_LOCATIONS = 'goCodeInsight.showLocations';

/** Lines around the viewport whose concrete types are resolved eagerly. */
const VIEWPORT_MARGIN = 100;
const MAX_IMPLEMENTS_CACHE = 4000;
/** How long provideCodeLenses waits for "implements" queries before rendering without them. */
const EAGER_BUDGET_MS = 150;
const READY_MAX_PROBES = 25;
const SYMBOL_KINDS: Record<SymKind, vscode.SymbolKind> = {
  func: vscode.SymbolKind.Function,
  method: vscode.SymbolKind.Method,
  interface: vscode.SymbolKind.Interface,
  struct: vscode.SymbolKind.Struct,
  functype: vscode.SymbolKind.Function,
  type: vscode.SymbolKind.Class,
  field: vscode.SymbolKind.Field,
  imethod: vscode.SymbolKind.Method,
};
/** Larger documents skip the comment/format-only edit check (~7 ms per MB). */
const MAX_HASH_CHARS = 1 << 20;

interface Config {
  enable: boolean;
  references: boolean;
  implementations: boolean;
  implementsEnable: boolean;
  fieldRefs: boolean;
  dependencies: boolean;
  methods: boolean;
  packageImports: boolean;
  maxNames: number;
  hideUnexportedForeign: boolean;
  exclude: Set<string>;
  maxConcurrent: number;
  refreshDelay: number;
  moduleIndex: ModuleIndexOptions;
  depIndex: DepIndexOptions;
}

function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('goCodeInsight');
  return {
    enable: c.get('enable', true),
    references: c.get('references.enable', true),
    implementations: c.get('implementations.enable', true),
    implementsEnable: c.get('implements.enable', true),
    fieldRefs: c.get('references.fields', true),
    dependencies: c.get('dependencies.enable', true),
    methods: c.get('methods.enable', true),
    packageImports: c.get('packageImports.enable', true),
    maxNames: Math.max(1, c.get('implements.maxNames', 3)),
    hideUnexportedForeign: c.get('implements.hideUnexportedForeign', true),
    exclude: new Set(c.get<string[]>('implements.exclude', [])),
    maxConcurrent: Math.max(1, c.get('maxConcurrentRequests', 8)),
    refreshDelay: Math.max(100, c.get('refreshDelay', 800)),
    depIndex: {
      enabled: c.get('dependencies.index', true),
      prebuild: c.get<'sameOrg' | 'all' | 'off'>('dependencies.prebuild', 'sameOrg'),
      waitMs: 3000,
    },
    moduleIndex: {
      enabled: c.get('outsideWorkspace.moduleIndex', true),
      goplsPath: c.get('goplsPath', ''),
      idleMinutes: Math.max(1, c.get('outsideWorkspace.idleMinutes', 5)),
      maxServers: Math.max(1, c.get('outsideWorkspace.maxServers', 2)),
    },
  };
}

type LazyKind = 'refs' | 'typeImpls' | 'methodImpls' | 'pkgImports';

/** Lens resolved on demand (VS Code only resolves lenses inside the viewport). */
class LazyLens extends vscode.CodeLens {
  constructor(
    range: vscode.Range,
    readonly doc: vscode.TextDocument,
    readonly version: number,
    readonly kind: LazyKind,
    /** Position-independent identity, e.g. `refs|(*Sq).Read`. */
    readonly key: string,
  ) {
    super(range);
  }
}

/** Resolved lazy lens, kept per symbol identity so it survives line shifts. */
interface LensResult {
  title: string;
  tooltip?: string;
  locations: vscode.Location[];
  /** Set while the workspace part of a dependency query is still running. */
  pending?: Promise<void>;
}

/** How long a dependency lens waits for the workspace gopls before showing the module's count. */
const WORKSPACE_BUDGET_MS = 80;

/** Maps a position through a document edit; undefined if it was inside the replaced text. */
function shiftPosition(p: vscode.Position, ch: vscode.TextDocumentContentChangeEvent): vscode.Position | undefined {
  const { start, end } = ch.range;
  if (p.isBefore(start)) {
    return p;
  }
  if (p.isBefore(end)) {
    return undefined;
  }
  const lines = ch.text.split('\n');
  const endLine = start.line + lines.length - 1;
  const endChar = lines.length === 1 ? start.character + ch.text.length : lines[lines.length - 1].length;
  return p.line === end.line
    ? new vscode.Position(endLine, endChar + p.character - end.character)
    : new vscode.Position(p.line + endLine - end.line, p.character);
}

interface IfaceRef {
  label: string;
  location: vscode.Location;
  /** Methods declared directly in the interface: name -> position of the name. */
  methods: Map<string, vscode.Position>;
  rank: number;
}

interface TypeTarget {
  name: string;
  /** Where to ask gopls (declaration, or the receiver type of a method in this file). */
  pos?: vscode.Position;
  declRange?: vscode.Range;
  methods: { name: string; range: vscode.Range }[];
  lines: number[];
}

type Window = [number, number];

function dirOf(uri: vscode.Uri): string {
  return uri.toString().replace(/\/[^/]*$/, '');
}

function near(lines: number[], windows: Window[]): boolean {
  return lines.some((l) => windows.some(([a, b]) => l >= a && l <= b));
}

const TRACE = !!process.env.GO_CODE_INSIGHT_TRACE;
const T0 = Date.now();
function trace(msg: string): void {
  if (TRACE) {
    console.log(`[gil @${Date.now() % 100000}] ${msg}`);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export class GoLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  private cfg = readConfig();
  private readonly limiter = new Limiter(this.cfg.maxConcurrent);
  private readonly texts = new TextStore();
  private readonly methods = new PackageMethods(this.texts);
  private readonly modules = new ModuleIndex(this.cfg.moduleIndex);
  readonly deps: DepIndex;
  private readonly output = vscode.window.createOutputChannel('Go Code Insight');

  constructor(extensionPath: string) {
    this.deps = new DepIndex(this.cfg.depIndex, extensionPath, () => findGoTool('go'), (m) => this.output.appendLine(m));
  }

  depStats(): Record<string, number> {
    return { indexBuilds: this.deps.stats.builds, indexBuildMs: this.deps.stats.buildMs, indexHits: this.deps.stats.hits, moduleGoplsStarted: this.modules.started };
  }

  /** Background indexing of the workspace's dependency modules (see DepIndex.prebuild). */
  async prebuildDependencyIndexes(): Promise<void> {
    const dirs = new Set<string>();
    for (const f of await vscode.workspace.findFiles('**/go.mod', '**/{vendor,node_modules,testdata}/**', 20)) {
      dirs.add(vscode.Uri.joinPath(f, '..').fsPath);
    }
    await this.deps.prebuild([...dirs]);
  }

  /** Bumped on any Go source change; results computed for older generations are stale. */
  private generation = 0;
  /** Lazy lens results for the current generation, keyed by `uri|lens identity`. */
  private readonly resolved = new Map<string, LensResult>();
  /** Token-stream hash of each open Go document's latest version. */
  private readonly hashes = new Map<string, number>();
  /** Concrete type -> implemented interfaces. Stale entries are served off-viewport. */
  private readonly implementsCache = new Map<string, { gen: number; ifaces: IfaceRef[] }>();
  private readonly inflight = new Map<string, Promise<IfaceRef[]>>();
  private readonly symbols = new Map<string, { version: number; symbols: vscode.DocumentSymbol[] }>();
  private readonly docTypes = new Map<string, { version: number; types: { key: string; lines: number[] }[] }>();
  private ready: Promise<void> | true | undefined;
  private readonly lazyInflight = new Map<string, Promise<LensResult | undefined>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Requests sent to gopls, by kind (internal command goCodeInsight.stats; used by benchmarks). */
  readonly stats: Record<string, number> = {};
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private viewportTimer: ReturnType<typeof setTimeout> | undefined;

  // ---------------------------------------------------------------- events

  refreshNow(invalidate = false): void {
    if (invalidate) {
      this.invalidate();
      this.texts.clear();
      this.symbols.clear();
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.changeEmitter.fire();
  }

  private refreshSoon(delay = this.cfg.refreshDelay): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshNow(), delay);
  }

  private invalidate(): void {
    this.generation++;
    this.resolved.clear();
    this.inflight.clear();
    this.lazyInflight.clear();
  }

  onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.languageId !== 'go' || e.contentChanges.length === 0) {
      return;
    }
    this.methods.invalidate(e.document.uri);
    // Comment / blank-line / formatting-only edits cannot change any gopls answer:
    // keep the caches and only move the cached locations in this document.
    const key = e.document.uri.toString();
    const prev = this.hashes.get(key);
    const next = this.hashOf(e.document);
    if (next === undefined) {
      this.hashes.delete(key);
    } else {
      this.hashes.set(key, next);
    }
    if (prev !== undefined && prev === next && this.shiftLocations(e.document.uri, e.contentChanges)) {
      return;
    }
    this.invalidate();
    // VS Code re-requests lenses for the edited document itself; other visible Go
    // editors may be affected too (new method => new implementation elsewhere).
    if (vscode.window.visibleTextEditors.some((ed) => ed.document.languageId === 'go' && ed.document !== e.document)) {
      this.refreshSoon();
    }
  }

  onFileEvent(uri: vscode.Uri, kind: 'create' | 'change' | 'delete'): void {
    const key = uri.toString();
    if (kind === 'change' && vscode.workspace.textDocuments.some((d) => d.uri.toString() === key)) {
      return; // open documents are tracked through text change events
    }
    this.texts.invalidate(uri);
    this.methods.invalidate(uri);
    this.invalidate();
    this.refreshSoon();
  }

  /**
   * Opening a Go file outside the workspace makes gopls load its package, which can
   * add references/implementations for symbols elsewhere; cached counts are stale.
   */
  onDocumentOpened(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'go' || doc.uri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(doc.uri)) {
      return;
    }
    this.invalidate();
    this.refreshSoon();
  }

  onDocumentSaved(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'go' || vscode.workspace.getWorkspaceFolder(doc.uri)) {
      return;
    }
    this.modules.fileChanged(doc.uri);
    this.invalidate();
    this.refreshSoon();
  }

  private hashOf(doc: vscode.TextDocument): number | undefined {
    const text = doc.getText();
    return text.length <= MAX_HASH_CHARS ? semanticHash(text) : undefined;
  }

  /** Applies an edit to every cached location in `uri`. False if a location was inside the edit. */
  private shiftLocations(uri: vscode.Uri, changes: readonly vscode.TextDocumentContentChangeEvent[]): boolean {
    const key = uri.toString();
    const move = (loc: vscode.Location): vscode.Location | undefined => {
      if (loc.uri.toString() !== key) {
        return loc;
      }
      let start: vscode.Position | undefined = loc.range.start;
      let end: vscode.Position | undefined = loc.range.end;
      for (const ch of changes) {
        start = start && shiftPosition(start, ch);
        end = end && shiftPosition(end, ch);
      }
      return start && end ? new vscode.Location(loc.uri, new vscode.Range(start, end)) : undefined;
    };
    const moveAll = (locs: vscode.Location[]): vscode.Location[] | undefined => {
      const out: vscode.Location[] = [];
      for (const l of locs) {
        const m = move(l);
        if (!m) {
          return undefined;
        }
        out.push(m);
      }
      return out;
    };
    const resolved = new Map<string, LensResult>();
    for (const [k, r] of this.resolved) {
      const locations = moveAll(r.locations);
      if (!locations) {
        return false;
      }
      resolved.set(k, { ...r, locations });
    }
    const implementsCache = new Map<string, { gen: number; ifaces: IfaceRef[] }>();
    for (const [k, entry] of this.implementsCache) {
      const ifaces: IfaceRef[] = [];
      for (const i of entry.ifaces) {
        const location = move(i.location);
        if (!location) {
          return false;
        }
        const methods = new Map<string, vscode.Position>();
        for (const [name, pos] of i.methods) {
          const moved = move(new vscode.Location(i.location.uri, pos));
          if (!moved) {
            return false;
          }
          methods.set(name, moved.range.start);
        }
        ifaces.push({ ...i, location, methods });
      }
      implementsCache.set(k, { gen: entry.gen, ifaces });
    }
    resolved.forEach((v, k) => this.resolved.set(k, v));
    implementsCache.forEach((v, k) => this.implementsCache.set(k, v));
    return true;
  }

  /**
   * As soon as a dependency file is shown: make sure its module has an index (module
   * cache), or start the module gopls (other repositories) before the first query.
   */
  onVisibleEditors(editors: readonly vscode.TextEditor[]): void {
    if (!this.cfg.enable || !this.cfg.dependencies) {
      return;
    }
    for (const ed of editors) {
      const d = ed.document;
      if (d.languageId !== 'go' || d.uri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(d.uri)) {
        continue;
      }
      void this.modules.rootOf(d.uri).then((root) => {
        if (root && this.cfg.depIndex.enabled && isImmutableModule(root)) {
          void this.deps.ensure(root);
        } else if (this.cfg.moduleIndex.enabled) {
          void this.modules.prewarm(d.uri);
        }
      });
    }
  }

  onDocumentClosed(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    this.hashes.delete(key);
    this.symbols.delete(key);
    this.docTypes.delete(key);
  }

  onConfigChanged(): void {
    this.cfg = readConfig();
    this.limiter.max = this.cfg.maxConcurrent;
    this.modules.configure(this.cfg.moduleIndex);
    this.deps.configure(this.cfg.depIndex);
    this.implementsCache.clear();
    this.methods.clear();
    this.refreshNow(true);
  }

  /** Scrolling into types that were not resolved for the current generation triggers a refresh. */
  onVisibleRangesChanged(editor: vscode.TextEditor): void {
    if (editor.document.languageId !== 'go' || !this.cfg.enable || !this.cfg.implementsEnable) {
      return;
    }
    clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => {
      for (const ed of vscode.window.visibleTextEditors) {
        const rec = this.docTypes.get(ed.document.uri.toString());
        if (!rec || rec.version !== ed.document.version) {
          continue;
        }
        const windows = this.viewport(ed.document);
        if (rec.types.some((t) => near(t.lines, windows) && this.implementsCache.get(t.key)?.gen !== this.generation)) {
          this.changeEmitter.fire();
          return;
        }
      }
    }, 250);
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.viewportTimer);
    this.timers.forEach(clearTimeout);
    this.modules.dispose();
    this.deps.dispose();
    this.output.dispose();
    this.changeEmitter.dispose();
  }

  // ---------------------------------------------------------------- provide

  async provideCodeLenses(doc: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[] | undefined> {
    if (!this.cfg.enable) {
      return [];
    }
    trace(`provide ${doc.uri.path.split('/').pop()} v${doc.version}`);
    if (!this.cfg.dependencies && !vscode.workspace.getWorkspaceFolder(doc.uri)) {
      return [];
    }
    const symbols = this.getSymbols(doc);
    const docKey = doc.uri.toString();
    if (!this.hashes.has(docKey)) {
      const h = this.hashOf(doc);
      if (h !== undefined) {
        this.hashes.set(docKey, h);
      }
    }

    const cfg = this.cfg;
    const version = doc.version;
    const lenses: vscode.CodeLens[] = [];
    const types = new Map<string, TypeTarget>();
    const typeOf = (name: string): TypeTarget => {
      let t = types.get(name);
      if (!t) {
        t = { name, methods: [], lines: [] };
        types.set(name, t);
      }
      return t;
    };
    const seen = new Map<string, number>();
    const lazy = (range: vscode.Range, kind: LazyKind, name: string) => {
      const base = `${kind}|${name}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      lenses.push(new LazyLens(range, doc, version, kind, n ? `${base}#${n}` : base));
    };

    if (cfg.packageImports) {
      const m = /^\s*package\s+([\p{L}_][\p{L}\p{N}_]*)/mu.exec(doc.getText());
      if (m && m[1] !== 'main' && !m[1].endsWith('_test')) {
        const start = doc.positionAt(m.index + m[0].length - m[1].length);
        lazy(new vscode.Range(start, start.translate(0, m[1].length)), 'pkgImports', 'package');
      }
    }

    for (const s of symbols) {
      const sel = s.selectionRange;
      if (s.kind === vscode.SymbolKind.Method) {
        if (cfg.references) {
          lazy(sel, 'refs', s.name);
        }
        const start = doc.offsetAt(s.range.start);
        const recv = parseReceiver(doc.getText(new vscode.Range(s.range.start, sel.start)));
        if (recv) {
          const t = typeOf(recv.name);
          t.pos ??= doc.positionAt(start + recv.offset);
          t.methods.push({ name: doc.getText(sel), range: sel });
          t.lines.push(sel.start.line);
        }
        continue;
      }
      if (
        s.kind === vscode.SymbolKind.Variable ||
        s.kind === vscode.SymbolKind.Constant ||
        s.kind === vscode.SymbolKind.Field ||
        s.kind === vscode.SymbolKind.Package ||
        s.kind === vscode.SymbolKind.Module ||
        s.kind === vscode.SymbolKind.Namespace
      ) {
        continue;
      }
      const before = doc.lineAt(sel.start.line).text.slice(0, sel.start.character);
      if (/\bfunc\s*$/.test(before)) {
        if (cfg.references) {
          lazy(sel, 'refs', s.name); // plain function
        }
        continue;
      }
      if (s.kind === vscode.SymbolKind.Interface) {
        if (cfg.references) {
          lazy(sel, 'refs', s.name);
        }
        if (cfg.implementations) {
          lazy(sel, 'typeImpls', s.name);
        }
        for (const c of s.children ?? []) {
          if (c.kind !== vscode.SymbolKind.Method && c.kind !== vscode.SymbolKind.Function) {
            continue; // embedded interfaces / type constraints
          }
          const after = doc.lineAt(c.selectionRange.end.line).text.slice(c.selectionRange.end.character);
          if (!/^\s*\(/.test(after)) {
            continue;
          }
          if (cfg.references) {
            lazy(c.selectionRange, 'refs', `${s.name}.${c.name}`);
          }
          if (cfg.implementations) {
            lazy(c.selectionRange, 'methodImpls', `${s.name}.${c.name}`);
          }
        }
        continue;
      }
      // Any other named type: struct, func type, basic type, ...
      if (cfg.references) {
        lazy(sel, 'refs', s.name);
        if (cfg.fieldRefs && s.kind === vscode.SymbolKind.Struct) {
          for (const c of s.children ?? []) {
            const after = doc.lineAt(c.selectionRange.end.line).text.slice(c.selectionRange.end.character);
            // Embedded fields (`Base`, `*pkg.T`) refer to their type: skip them.
            const ownLine = c.selectionRange.start.line !== sel.start.line; // not `type T struct{ a int }`
            if (c.kind === vscode.SymbolKind.Field && ownLine && !/^\s*($|`|"|\/\/|\/\*)/.test(after)) {
              lazy(c.selectionRange, 'refs', `${s.name}.${c.name}`);
            }
          }
        }
      }
      const t = typeOf(s.name.replace(/\[.*$/, ''));
      t.pos = sel.start;
      t.declRange = sel;
      t.lines.push(sel.start.line);
    }

    const tImpl = Date.now();
    if (cfg.implementsEnable && types.size > 0) {
      await this.addImplementsLenses(doc, types, lenses);
      trace(`  implements phase ${Date.now() - tImpl}ms`);
      if (token.isCancellationRequested) {
        return undefined;
      }
    }
    if (cfg.methods) {
      const tm = Date.now();
      await this.addMethodLenses(doc, types, lenses);
      trace(`  methods phase ${Date.now() - tm}ms`);
    }
    trace(`provided ${lenses.length} lenses`);
    return lenses;
  }

  /** "N methods" on types declared here; counted locally across the package's files. */
  private async addMethodLenses(doc: vscode.TextDocument, types: Map<string, TypeTarget>, lenses: vscode.CodeLens[]): Promise<void> {
    const pkg = (await this.texts.get(doc.uri))?.packageName() ?? '';
    for (const t of types.values()) {
      if (!t.declRange) {
        continue;
      }
      const locs = await this.methods.of(doc.uri, pkg, t.name);
      if (locs.length > 0) {
        lenses.push(
          new vscode.CodeLens(t.declRange, {
            title: plural(locs.length, 'method'),
            command: SHOW_LOCATIONS,
            arguments: [doc.uri, t.declRange.start, locs],
          }),
        );
      }
    }
  }

  /**
   * Concrete side ("implements X"). Resolved eagerly so that lenses only appear on
   * symbols that actually implement something, with one gopls query per receiver
   * type (method-level results are derived from the interfaces' method lists).
   */
  private async addImplementsLenses(doc: vscode.TextDocument, types: Map<string, TypeTarget>, lenses: vscode.CodeLens[]): Promise<void> {
    const gen = this.generation;
    const dir = dirOf(doc.uri);
    const tp = Date.now();
    const pkg = (await this.texts.get(doc.uri))?.packageName() ?? '';
    trace(`    texts.get ${Date.now() - tp}ms`);
    const windows = this.viewport(doc);
    const recorded: { key: string; lines: number[] }[] = [];
    const results = new Map<TypeTarget, IfaceRef[]>();
    const jobs: Promise<void>[] = [];

    for (const t of types.values()) {
      if (!t.pos) {
        continue;
      }
      const key = `${dir}|${pkg}|${t.name}`;
      recorded.push({ key, lines: t.lines });
      const cached = this.implementsCache.get(key);
      if ((cached && cached.gen === gen) || !near(t.lines, windows)) {
        if (cached) {
          results.set(t, cached.ifaces); // possibly stale; refreshed when scrolled into view
        }
        continue;
      }
      jobs.push(this.queryImplements(key, doc.uri, t.pos, gen, dir).then((ifaces) => void results.set(t, ifaces)));
    }
    // Render without slow "implements" answers (cold gopls, dependency files) and
    // refresh once they arrive; the next provide finds them in the cache.
    const all = Promise.all(jobs);
    const done = await Promise.race([all.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), EAGER_BUDGET_MS))]);
    if (!done) {
      void all.then(() => gen === this.generation && this.refreshSoon(0));
    }
    this.docTypes.set(doc.uri.toString(), { version: doc.version, types: recorded });

    for (const [t, ifaces] of results) {
      if (ifaces.length === 0) {
        continue;
      }
      if (t.declRange) {
        lenses.push(this.implementsLens(doc.uri, t.declRange, ifaces.map((i) => ({ label: i.label, location: i.location }))));
      }
      for (const m of t.methods) {
        const targets: { label: string; location: vscode.Location }[] = [];
        for (const i of ifaces) {
          const p = i.methods.get(m.name);
          if (p) {
            targets.push({
              label: `${i.label}.${m.name}`,
              location: new vscode.Location(i.location.uri, new vscode.Range(p, p.translate(0, m.name.length))),
            });
          }
        }
        if (targets.length > 0) {
          lenses.push(this.implementsLens(doc.uri, m.range, targets));
        }
      }
    }
  }

  private implementsLens(uri: vscode.Uri, range: vscode.Range, targets: { label: string; location: vscode.Location }[]): vscode.CodeLens {
    const max = this.cfg.maxNames;
    const names = targets.map((t) => t.label);
    let title = `implements ${names.slice(0, max).join(', ')}`;
    if (names.length > max) {
      title += ` +${names.length - max}`;
    }
    return new vscode.CodeLens(range, {
      title,
      tooltip: names.join('\n'),
      command: SHOW_LOCATIONS,
      arguments: [uri, range.start, targets.map((t) => t.location)],
    });
  }

  private queryImplements(key: string, uri: vscode.Uri, pos: vscode.Position, gen: number, dir: string): Promise<IfaceRef[]> {
    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }
    let partial: Promise<void> | undefined; // module-only answer; workspace part still running
    const p: Promise<IfaceRef[]> = this.limiter
      .run(async () => {
        const out: IfaceRef[] = [];
        const q = await this.query('implementation', uri, pos, true);
        if (q.pending) {
          partial = q.pending;
        }
        for (const loc of q.locations) {
          const text = await this.texts.get(loc.uri);
          if (!text) {
            continue;
          }
          const decl = text.declAt(text.offsetAt(loc.range.start));
          if (!decl.isInterface || !decl.name) {
            continue;
          }
          const same = dirOf(loc.uri) === dir;
          if (!same && this.cfg.hideUnexportedForeign && !isExported(decl.name)) {
            continue;
          }
          const pkg = text.packageName();
          const builtin = pkg === 'builtin' || pkg === '';
          const qualified = builtin ? decl.name : `${pkg}.${decl.name}`;
          if (this.cfg.exclude.has(qualified)) {
            continue;
          }
          const methods = new Map<string, vscode.Position>();
          for (const [name, offset] of decl.methods) {
            const mp = text.positionAt(offset);
            methods.set(name, new vscode.Position(mp.line, mp.character));
          }
          out.push({
            label: same || builtin ? decl.name : qualified,
            location: loc,
            methods,
            rank: same ? 0 : vscode.workspace.getWorkspaceFolder(loc.uri) ? 1 : 2,
          });
        }
        return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
      })
      .catch(() => [] as IfaceRef[])
      .then((ifaces = []) => {
        if (this.inflight.get(key) === p) {
          this.inflight.delete(key);
        }
        const cur = this.implementsCache.get(key);
        if (partial) {
          // Render now, but keep it stale so the next provide asks again; refresh then.
          void partial.then(() => gen === this.generation && this.refreshSoon(0));
        }
        if (!cur || cur.gen <= gen) {
          this.implementsCache.delete(key);
          this.implementsCache.set(key, { gen: partial ? -1 : gen, ifaces });
          if (this.implementsCache.size > MAX_IMPLEMENTS_CACHE) {
            this.implementsCache.delete(this.implementsCache.keys().next().value as string);
          }
        }
        return ifaces;
      });
    this.inflight.set(key, p);
    return p;
  }

  // ---------------------------------------------------------------- resolve

  async resolveCodeLens(lens: vscode.CodeLens, token: vscode.CancellationToken): Promise<vscode.CodeLens> {
    if (!(lens instanceof LazyLens) || lens.doc.version !== lens.version) {
      return lens; // stale positions; VS Code re-provides after the edit
    }
    const key = `${lens.doc.uri}|${lens.key}`;
    const hit = this.resolved.get(key);
    if (hit) {
      lens.command = this.toCommand(lens, hit);
      return lens;
    }
    const gen = this.generation;
    const queued = Date.now();
    try {
      // A re-provided lens may ask again while the first request is still running.
      let pending = this.lazyInflight.get(key);
      if (!pending) {
        pending = this.limiter.run(() => {
          trace(`resolve ${lens.key} @${lens.range.start.line + 1} waited ${Date.now() - queued}ms`);
          return this.computeLazy(lens);
        }, token);
        this.lazyInflight.set(key, pending);
        void pending.finally(() => this.lazyInflight.get(key) === pending && this.lazyInflight.delete(key));
      }
      const r = await pending;
      trace(`resolved ${lens.key} @${lens.range.start.line + 1} total ${Date.now() - queued}ms`);
      if (r) {
        if (r.pending) {
          // Partial (module only): refresh once the workspace part is in.
          void r.pending.then(() => gen === this.generation && this.refreshSoon(0));
        } else if (gen === this.generation) {
          this.resolved.set(key, r);
        }
        lens.command = this.toCommand(lens, r);
      }
    } catch (e) {
      lens.command = {
        title: lens.kind === 'refs' ? '? refs' : '? implementations',
        tooltip: e instanceof Error ? e.message : String(e),
        command: '',
      };
    }
    return lens;
  }

  private toCommand(lens: LazyLens, r: LensResult): vscode.Command {
    return r.locations.length
      ? { title: r.title, tooltip: r.tooltip, command: SHOW_LOCATIONS, arguments: [lens.doc.uri, lens.range.start, r.locations] }
      : { title: r.title, tooltip: r.tooltip, command: '' };
  }

  /**
   * Workspace gopls results, merged — for files outside the workspace — with a gopls
   * rooted at the file's own module (see ModuleIndex). `partial` means only the
   * packages loaded for this workspace were searched.
   */
  private async query(
    kind: 'references' | 'implementation',
    uri: vscode.Uri,
    pos: vscode.Position,
    allowPending = false,
  ): Promise<{ locations: vscode.Location[]; partial: boolean; module?: string; pending?: Promise<void> }> {
    const command = kind === 'references' ? 'vscode.executeReferenceProvider' : 'vscode.executeImplementationProvider';
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      return { locations: await this.locations(command, uri, pos), partial: false };
    }
    const t = Date.now();
    // The file's own module: persistent index (module cache), else a module gopls.
    const ownModule = async () => {
      const root = this.cfg.depIndex.enabled ? await this.modules.rootOf(uri) : undefined;
      const fromIndex = root ? await this.deps.lookup(kind, root, uri, pos) : undefined;
      trace(`  index ${kind} @${pos.line + 1} ${fromIndex ? 'hit' : 'miss'} ${Date.now() - t}ms`);
      return fromIndex ?? (await this.modules.query(kind, uri, pos));
    };
    const mainP = this.locations(command, uri, pos).finally(() => trace(`  workspace ${kind} @${pos.line + 1} ${Date.now() - t}ms`));
    const ownP = ownModule().finally(() => trace(`  module ${kind} @${pos.line + 1} ${Date.now() - t}ms`));
    if (allowPending) {
      // Show the module's own answer right away if the workspace gopls is slow
      // (e.g. still starting); the lens is refreshed when the rest arrives.
      const own = await ownP;
      // While the workspace gopls is still starting, do not wait at all.
      const quick =
        own && this.ready === true
          ? await Promise.race([mainP.catch(() => []), new Promise<undefined>((r) => setTimeout(() => r(undefined), WORKSPACE_BUDGET_MS))])
          : undefined;
      if (own && quick === undefined) {
        return { locations: own, partial: false, module: await this.modules.moduleOf(uri), pending: mainP.then(() => undefined, () => undefined) };
      }
    }
    const [main, own] = await Promise.all([mainP, ownP]);
    if (!own) {
      return { locations: main, partial: true };
    }
    const seen = new Set<string>();
    const locations = [...own, ...main].filter((l) => {
      const k = `${l.uri}#${l.range.start.line}:${l.range.start.character}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    return { locations, partial: false, module: await this.modules.moduleOf(uri) };
  }

  private scope(r: { partial: boolean; module?: string }): { suffix: string; note: string } {
    const ws = vscode.workspace.name ?? 'workspace';
    if (r.module) {
      return { suffix: '', note: `\n\nSearched module ${r.module} and workspace ${ws}.` };
    }
    if (!r.partial) {
      return { suffix: '', note: '' };
    }
    return {
      suffix: ` (in ${ws})`,
      note:
        `\n\nThis file is outside the workspace "${ws}": only packages gopls has loaded for this ` +
        `workspace were searched (enable goCodeInsight.outsideWorkspace.moduleIndex for the full count).`,
    };
  }

  private async computeLazy(lens: LazyLens): Promise<LensResult> {
    const uri = lens.doc.uri;
    const pos = lens.range.start;

    if (lens.kind === 'pkgImports') {
      const r = await this.query('references', uri, pos, true);
      const scope = this.scope(r);
      // gopls also reports the package clauses of the package's other files.
      const imports: vscode.Location[] = [];
      for (const l of r.locations) {
        const text = await this.texts.get(l.uri);
        if (text && !/^\s*package\b/.test(text.lineText(l.range.start.line))) {
          imports.push(l);
        }
      }
      return {
        title: (imports.length ? plural(imports.length, 'import') : 'no imports') + scope.suffix + (r.pending ? ' …' : ''),
        tooltip: `Files importing this package${scope.note}`,
        locations: imports,
        pending: r.pending,
      };
    }

    if (lens.kind === 'refs') {
      const self = uri.toString();
      const r = await this.query('references', uri, pos, true);
      const scope = this.scope(r);
      const refs = r.locations.filter((l) => !(l.uri.toString() === self && l.range.contains(pos)));
      const title = plural(refs.length, 'ref') + scope.suffix + (r.pending ? ' …' : '');
      const tooltip = r.pending
        ? `${plural(refs.length, 'reference')} in module ${r.module}; still counting references in the workspace…`
        : `${plural(refs.length, 'reference')} found${scope.note}`;
      return { title, tooltip, locations: refs, pending: r.pending };
    }

    const r = await this.query('implementation', uri, pos, true);
    const scope = this.scope(r);
    const dir = dirOf(uri);
    const impls: vscode.Location[] = [];
    const labels: string[] = [];
    for (const loc of r.locations) {
      const text = await this.texts.get(loc.uri);
      if (!text) {
        continue;
      }
      const p = loc.range.start;
      let name: string;
      if (lens.kind === 'typeImpls') {
        const decl = text.declAt(text.offsetAt(p));
        if (decl.isInterface) {
          continue; // gopls also reports interfaces embedding this one
        }
        name = decl.name;
      } else {
        if (!text.isFuncDeclName(p)) {
          continue; // abstract method of another interface
        }
        const recv = text.receiverOf(p);
        const method = text.identAt(text.offsetAt(p));
        name = recv ? `${recv}.${method}` : method;
      }
      const pkg = text.packageName();
      impls.push(loc);
      labels.push(dirOf(loc.uri) === dir || !pkg ? name : `${pkg}.${name}`);
    }
    if (impls.length === 0) {
      if (r.pending) {
        return { title: 'no implementations …', locations: [], pending: r.pending };
      }
      return { title: `no implementations${scope.suffix}`, tooltip: scope.note.trim() || undefined, locations: [] };
    }
    const shown = labels.slice(0, 20);
    if (labels.length > shown.length) {
      shown.push(`… +${labels.length - shown.length}`);
    }
    return {
      title: plural(impls.length, 'implementation') + scope.suffix + (r.pending ? ' …' : ''),
      tooltip: shown.join('\n') + scope.note,
      locations: impls,
      pending: r.pending,
    };
  }

  // ---------------------------------------------------------------- helpers

  /** Declarations from the local scanner (no gopls round trip), cached per document version. */
  private getSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const key = doc.uri.toString();
    const cached = this.symbols.get(key);
    if (cached && cached.version === doc.version) {
      return cached.symbols;
    }
    const range = (a: number, b: number) => new vscode.Range(doc.positionAt(a), doc.positionAt(b));
    const symbols = goSymbols(doc.getText()).map((g) => {
      const d = new vscode.DocumentSymbol(g.name, '', SYMBOL_KINDS[g.kind], range(g.start, g.nameEnd), range(g.nameStart, g.nameEnd));
      d.children = g.children.map(
        (c) => new vscode.DocumentSymbol(c.name, '', SYMBOL_KINDS[c.kind], range(c.start, c.nameEnd), range(c.nameStart, c.nameEnd)),
      );
      return d;
    });
    this.symbols.set(key, { version: doc.version, symbols });
    return symbols;
  }

  /**
   * Resolves once the Go extension's gopls answers requests. Before that, reference
   * queries return nothing, which must not be cached as "0 refs". Probes with
   * documentSymbol, preferring an open workspace file (cheap); gives up after ~30 s
   * (e.g. Go extension not installed) so lenses still resolve.
   */
  private goplsReady(probe: vscode.Uri): Promise<void> {
    if (this.ready === true) {
      return Promise.resolve();
    }
    this.ready ??= (async () => {
      // Probe a workspace file: a dependency file may simply not be loaded yet.
      const open = vscode.workspace.textDocuments.find((d) => d.languageId === 'go' && vscode.workspace.getWorkspaceFolder(d.uri));
      const found = open ? undefined : (await vscode.workspace.findFiles('**/*.go', '**/{vendor,testdata,node_modules}/**', 1))[0];
      const target = open?.uri ?? found ?? probe;
      for (let n = 0, delay = 100; n < READY_MAX_PROBES; n++, delay = Math.min(delay * 2, 2000)) {
        const ws = { uri: target };
        const t = Date.now();
        this.stats.documentSymbol = (this.stats.documentSymbol ?? 0) + 1;
        const res = await Promise.resolve(
          vscode.commands.executeCommand<unknown[]>('vscode.executeDocumentSymbolProvider', ws?.uri ?? probe),
        ).catch(() => undefined);
        trace(`gopls readiness probe ${(ws?.uri ?? probe).path.split('/').pop()} ${Date.now() - t}ms -> ${res?.length ?? 0}`);
        if (res && res.length > 0) {
          break;
        }
        await new Promise((r) => setTimeout(r, delay));
      }
      this.ready = true;
    })();
    return this.ready;
  }

  private viewport(doc: vscode.TextDocument): Window[] {
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document === doc);
    if (editors.length === 0) {
      return [[0, 2 * VIEWPORT_MARGIN]];
    }
    return editors.flatMap((e) =>
      e.visibleRanges.map((r): Window => [r.start.line - VIEWPORT_MARGIN, r.end.line + VIEWPORT_MARGIN]),
    );
  }

  private async locations(command: string, uri: vscode.Uri, pos: vscode.Position): Promise<vscode.Location[]> {
    await this.goplsReady(uri);
    const kind = command === 'vscode.executeReferenceProvider' ? 'references' : 'implementation';
    this.stats[kind] = (this.stats[kind] ?? 0) + 1;
    const res = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(command, uri, pos);
    const seen = new Set<string>();
    const out: vscode.Location[] = [];
    for (const r of res ?? []) {
      const loc = 'targetUri' in r ? new vscode.Location(r.targetUri, r.targetSelectionRange ?? r.targetRange) : r;
      const k = `${loc.uri}#${loc.range.start.line}:${loc.range.start.character}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(loc);
      }
    }
    return out;
  }
}
