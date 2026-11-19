import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * gopls only searches packages loaded for the window's workspace. For a Go file
 * outside the workspace (module cache, another repository) callers inside the
 * file's own module are therefore invisible. This starts — on demand — a separate
 * gopls rooted at that module, used only for references/implementation queries.
 *
 * Resource policy (measured on a 126-package module, see README):
 * - GOGC=50 and no telemetry sidecar process (GO_TELEMETRY_CHILD=2);
 * - one forced GC (gopls.mem_stats) after each burst of queries;
 * - stopped shortly after the last editor tab of that module closes, or after
 *   `idleMinutes` without queries.
 */

const REQUEST_TIMEOUT_MS = 60_000;
/** Compact memory once the server has been quiet this long. */
const COMPACT_AFTER_MS = 15_000;
/** Stop the server this long after no editor tab shows a file of its module. */
const STOP_AFTER_CLOSE_MS = 60_000;
const REAP_INTERVAL_MS = 15_000;

interface LspPosition {
  line: number;
  character: number;
}
interface LspLocation {
  uri: string;
  range: { start: LspPosition; end: LspPosition };
}

class GoplsProcess {
  private readonly proc: cp.ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  readonly ready: Promise<void>;
  readonly startedAt = Date.now();
  lastUsed = Date.now();
  /** Last time a tab showed a file of this module. */
  lastVisible = Date.now();
  private compactedAt = 0;
  exited = false;

  constructor(gopls: string, readonly root: string) {
    this.proc = cp.spawn(gopls, ['serve'], {
      cwd: root,
      env: { ...process.env, GOGC: process.env.GOGC ?? '50', GO_TELEMETRY_CHILD: '2' },
      stdio: 'pipe',
    });
    this.proc.stdout.on('data', (d: Buffer) => this.onData(d));
    this.proc.stderr.resume(); // discard
    this.proc.on('error', (e) => this.onExit(e));
    this.proc.on('exit', (code) => this.onExit(new Error(`gopls exited (${code})`)));
    const rootUri = vscode.Uri.file(root).toString();
    this.ready = this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'go-code-insight' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
        capabilities: {},
      },
      30_000,
    ).then(() => this.notify('initialized', {}));
  }

  /** Forces GC once per idle period so the runtime can return memory to the OS. */
  compactIfIdle(now: number): void {
    if (this.exited || this.compactedAt >= this.lastUsed || now - this.lastUsed < COMPACT_AFTER_MS) {
      return;
    }
    this.compactedAt = now;
    this.request('workspace/executeCommand', { command: 'gopls.mem_stats', arguments: [] }, 10_000).catch(() => undefined);
  }

  async locations(method: string, uri: vscode.Uri, pos: vscode.Position): Promise<vscode.Location[]> {
    this.lastUsed = Date.now();
    await this.ready;
    const params: Record<string, unknown> = {
      textDocument: { uri: uri.toString() },
      position: { line: pos.line, character: pos.character },
    };
    if (method === 'textDocument/references') {
      params.context = { includeDeclaration: true };
    }
    const res = ((await this.request(method, params, REQUEST_TIMEOUT_MS)) ?? []) as LspLocation[];
    this.lastUsed = Date.now();
    return res.map(
      (l) =>
        new vscode.Location(
          vscode.Uri.parse(l.uri),
          new vscode.Range(l.range.start.line, l.range.start.character, l.range.end.line, l.range.end.character),
        ),
    );
  }

  fileChanged(uri: vscode.Uri): void {
    this.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri.toString(), type: 2 }] });
  }

  stop(): void {
    if (this.exited) {
      return;
    }
    this.request('shutdown', null, 2000)
      .then(() => this.notify('exit', null))
      .catch(() => undefined)
      .finally(() => setTimeout(() => this.proc.kill(), 1000));
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new Error('gopls is not running'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gopls ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.exited) {
      this.send({ jsonrpc: '2.0', method, params });
    }
  }

  private send(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const m = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'));
      const len = m ? Number(m[1]) : 0;
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) {
        return;
      }
      const body = this.buffer.subarray(start, start + len).toString('utf8');
      this.buffer = this.buffer.subarray(start + len);
      try {
        this.dispatch(JSON.parse(body));
      } catch {
        // ignore malformed message
      }
    }
  }

  private dispatch(msg: { id?: number; method?: string; result?: unknown; error?: { message: string } }): void {
    if (msg.method !== undefined) {
      if (msg.id !== undefined) {
        // Server -> client request (registerCapability, configuration, ...): acknowledge.
        this.send({ jsonrpc: '2.0', id: msg.id, result: null });
      }
      return; // notifications (logs, diagnostics, progress) are ignored
    }
    const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
    if (!p) {
      return;
    }
    this.pending.delete(msg.id!);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(new Error(msg.error.message));
    } else {
      p.resolve(msg.result);
    }
  }

  private onExit(err: Error): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

export interface ModuleIndexOptions {
  enabled: boolean;
  goplsPath: string;
  idleMinutes: number;
  maxServers: number;
}

export class ModuleIndex implements vscode.Disposable {
  /** Number of module gopls processes started (stats). */
  started = 0;
  private readonly servers = new Map<string, GoplsProcess>();
  /** directory -> module root ('' = none / not indexable). */
  private readonly roots = new Map<string, string>();
  /** Roots whose gopls crashed right after start; not retried this session. */
  private readonly broken = new Set<string>();
  private readonly reaper: NodeJS.Timeout;
  private gopls: string | undefined | null = null; // null = not resolved yet

  constructor(private opts: ModuleIndexOptions) {
    this.reaper = setInterval(() => this.reap(), REAP_INTERVAL_MS);
  }

  configure(opts: ModuleIndexOptions): void {
    const pathChanged = opts.goplsPath !== this.opts.goplsPath;
    this.opts = opts;
    if (pathChanged) {
      this.gopls = null;
    }
    if (!opts.enabled || pathChanged) {
      this.stopAll();
    }
  }

  /** Module name of the root used for `uri`, if it is (or can be) indexed. */
  async moduleOf(uri: vscode.Uri): Promise<string | undefined> {
    const root = await this.rootOf(uri);
    return root ? path.basename(root) : undefined;
  }

  /** Locations from the file's own module, or undefined when not applicable. */
  async query(kind: 'references' | 'implementation', uri: vscode.Uri, pos: vscode.Position): Promise<vscode.Location[] | undefined> {
    if (!this.opts.enabled || uri.scheme !== 'file') {
      return undefined;
    }
    const root = await this.rootOf(uri);
    if (!root || this.broken.has(root)) {
      return undefined;
    }
    const server = this.server(root);
    if (!server) {
      return undefined;
    }
    try {
      return await server.locations(`textDocument/${kind}`, uri, pos);
    } catch {
      if (server.exited && Date.now() - server.startedAt < 15_000) {
        this.broken.add(root);
      }
      if (server.exited) {
        this.servers.delete(root);
      }
      return undefined;
    }
  }

  /** Starts (but does not query) the gopls for the module of `uri`. */
  async prewarm(uri: vscode.Uri): Promise<void> {
    if (!this.opts.enabled || uri.scheme !== 'file') {
      return;
    }
    const root = await this.rootOf(uri);
    if (root && !this.broken.has(root)) {
      this.server(root);
    }
  }

  /** Tells the module's gopls (if running) that a file changed on disk. */
  fileChanged(uri: vscode.Uri): void {
    for (const [root, s] of this.servers) {
      if (uri.fsPath.startsWith(root + path.sep)) {
        s.fileChanged(uri);
      }
    }
  }

  dispose(): void {
    clearInterval(this.reaper);
    this.stopAll();
  }

  private server(root: string): GoplsProcess | undefined {
    let s = this.servers.get(root);
    if (s && !s.exited) {
      this.servers.delete(root);
      this.servers.set(root, s); // LRU
      return s;
    }
    const gopls = this.goplsPath();
    if (!gopls) {
      return undefined;
    }
    while (this.servers.size >= this.opts.maxServers) {
      const [oldest, server] = this.servers.entries().next().value as [string, GoplsProcess];
      server.stop();
      this.servers.delete(oldest);
    }
    s = new GoplsProcess(gopls, root);
    this.started++;
    if (process.env.GO_CODE_INSIGHT_TRACE) {
      const t = Date.now();
      void s.ready.then(() => console.log(`[gil] module gopls ${path.basename(root)} initialized in ${Date.now() - t}ms`));
    }
    this.servers.set(root, s);
    return s;
  }

  private reap(): void {
    if (this.servers.size === 0) {
      return;
    }
    const now = Date.now();
    const idle = this.opts.idleMinutes * 60_000;
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const open = tabs.flatMap((t) => (t.input instanceof vscode.TabInputText ? [t.input.uri.fsPath] : []));
    for (const [root, s] of this.servers) {
      if (open.some((f) => f.startsWith(root + path.sep))) {
        s.lastVisible = now;
      }
      if (s.exited || now - s.lastUsed > idle || now - s.lastVisible > STOP_AFTER_CLOSE_MS) {
        s.stop();
        this.servers.delete(root);
      } else {
        s.compactIfIdle(now);
      }
    }
  }

  private stopAll(): void {
    this.servers.forEach((s) => s.stop());
    this.servers.clear();
  }

  /** Root directory of the module containing `uri` (undefined for GOROOT / no go.mod). */
  async rootOf(uri: vscode.Uri): Promise<string | undefined> {
    const start = path.dirname(uri.fsPath);
    const cached = this.roots.get(start);
    if (cached !== undefined) {
      return cached || undefined;
    }
    let root = '';
    for (let dir = start; ; dir = path.dirname(dir)) {
      const gomod = path.join(dir, 'go.mod');
      try {
        const text = await fs.promises.readFile(gomod, 'utf8');
        // The standard library is too large to index on the side; skip it.
        root = /^\s*module\s+(std|cmd)\s*$/m.test(text) ? '' : dir;
        break;
      } catch {
        if (path.dirname(dir) === dir) {
          break;
        }
      }
    }
    this.roots.set(start, root);
    return root || undefined;
  }

  private goplsPath(): string | undefined {
    if (this.gopls === null) {
      this.gopls = findGoTool('gopls', this.opts.goplsPath);
    }
    return this.gopls;
  }
}

/**
 * Locates a Go tool (`go`, `gopls`): explicit setting, go.alternateTools, GOROOT /
 * go.goroot for `go`, $GOBIN, $GOPATH/bin, ~/go/bin, then PATH.
 */
export function findGoTool(name: 'go' | 'gopls', configured?: string): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const goCfg = vscode.workspace.getConfiguration('go');
  const candidates: string[] = [];
  if (configured) {
    candidates.push(configured);
  }
  const alt = goCfg.get<Record<string, string>>('alternateTools')?.[name];
  if (alt) {
    candidates.push(alt);
  }
  if (name === 'go') {
    for (const root of [goCfg.get<string>('goroot'), process.env.GOROOT]) {
      if (root) {
        candidates.push(path.join(root, 'bin', exe));
      }
    }
  }
  if (process.env.GOBIN) {
    candidates.push(path.join(process.env.GOBIN, exe));
  }
  for (const gp of [goCfg.get<string>('toolsGopath'), process.env.GOPATH, path.join(os.homedir(), 'go')]) {
    for (const p of (gp ?? '').split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(p, 'bin', exe));
    }
  }
  for (const p of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(p, exe));
  }
  if (name === 'go') {
    candidates.push('/usr/local/go/bin/go', '/opt/homebrew/bin/go', 'C:\\Program Files\\Go\\bin\\go.exe');
  }
  return candidates.find((c) => path.isAbsolute(c) && fs.existsSync(c));
}
