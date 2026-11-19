import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Persistent cross-reference indexes for immutable dependency modules
 * (module-cache directories such as `.../mod/example.com/x@v1.2.3`).
 *
 * An index is built once per module version by the bundled Go indexer
 * (indexer/main.go: one go/types pass over the module, export data for the rest),
 * stored under the OS cache directory, and shared by every VS Code window. Lenses
 * in such files are then answered from small per-file JSON shards: no language
 * server, nothing resident in memory beyond a few recently used shards.
 */

const INDEX_FORMAT = 1;
const MAX_SHARDS = 64;
const LOCK_STALE_MS = 5 * 60_000;

interface Entry {
  r?: number[][];
  i?: number[][];
  t?: number[][];
}
interface Shard {
  f: string[];
  d: Record<string, Entry>;
}

export interface DepIndexOptions {
  enabled: boolean;
  prebuild: 'sameOrg' | 'all' | 'off';
  /** How long a query waits for an index being built before falling back. */
  waitMs: number;
}

function cacheRoot(): string {
  if (process.env.GO_CODE_INSIGHT_CACHE_DIR) {
    return process.env.GO_CODE_INSIGHT_CACHE_DIR; // tests / benchmarks
  }
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches')
      : process.platform === 'win32'
        ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
        : process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'go-code-insight', `v${INDEX_FORMAT}`);
}

/** Module-cache directories are immutable: `<module>@<version>`. */
export function isImmutableModule(root: string): boolean {
  return /@v\d/.test(path.basename(root));
}

/** Organization part of a module path: `github.com/org`, or the first element. */
function orgOf(modulePath: string): string {
  const parts = modulePath.split('/');
  return /^(github\.com|gitlab\.com|bitbucket\.org|gitee\.com|golang\.org)$/.test(parts[0]) ? parts.slice(0, 2).join('/') : parts[0];
}

export class DepIndex implements vscode.Disposable {
  private readonly dir = cacheRoot();
  private readonly ready = new Set<string>();
  private readonly building = new Map<string, Promise<boolean>>();
  private readonly shards = new Map<string, Promise<Shard | undefined>>();
  private queue: Promise<unknown> = Promise.resolve();
  private indexer: Promise<string | undefined> | undefined;
  private disposed = false;
  readonly stats = { builds: 0, buildMs: 0, hits: 0 };

  constructor(
    private opts: DepIndexOptions,
    private readonly extensionPath: string,
    private readonly goTool: () => string | undefined,
    private readonly log: (msg: string) => void,
  ) {}

  configure(opts: DepIndexOptions): void {
    this.opts = opts;
  }

  dispose(): void {
    this.disposed = true;
  }

  private indexDir(root: string): string {
    return path.join(this.dir, 'index', crypto.createHash('sha1').update(root).digest('hex').slice(0, 16));
  }

  /** True if an index for `root` exists (cheap, synchronous). */
  has(root: string): boolean {
    if (this.ready.has(root)) {
      return true;
    }
    if (fs.existsSync(path.join(this.indexDir(root), 'meta.json'))) {
      this.ready.add(root);
      return true;
    }
    return false;
  }

  /**
   * Locations for a references / implementation query on a dependency file, or
   * undefined when the module has no index (yet) — the caller then falls back.
   */
  async lookup(kind: 'references' | 'implementation', root: string, uri: vscode.Uri, pos: vscode.Position): Promise<vscode.Location[] | undefined> {
    if (!this.opts.enabled || !isImmutableModule(root)) {
      return undefined;
    }
    if (!this.has(root)) {
      const built = this.ensure(root);
      const inTime = await Promise.race([built, new Promise<boolean>((r) => setTimeout(() => r(false), this.opts.waitMs))]);
      if (!inTime) {
        return undefined;
      }
    }
    const shard = await this.shard(root, uri.fsPath);
    if (!shard) {
      return undefined;
    }
    this.stats.hits++;
    const e = shard.d[`${pos.line}:${pos.character}`];
    if (!e) {
      return [];
    }
    const list = kind === 'references' ? e.r ?? [] : [...(e.i ?? []), ...(e.t ?? [])];
    return list.map(([f, line, col, end]) => new vscode.Location(vscode.Uri.file(shard.f[f]), new vscode.Range(line, col, line, end)));
  }

  /** Builds the index of `root` in the background (once; shared across windows). */
  ensure(root: string): Promise<boolean> {
    if (this.has(root)) {
      return Promise.resolve(true);
    }
    let p = this.building.get(root);
    if (!p) {
      p = this.enqueue(() => this.build(root));
      this.building.set(root, p);
      void p.finally(() => this.building.delete(root));
    }
    return p;
  }

  /** Indexes the dependency modules of the workspace modules (per `prebuild`). */
  async prebuild(workspaceModuleDirs: string[]): Promise<void> {
    if (!this.opts.enabled || this.opts.prebuild === 'off') {
      return;
    }
    const go = this.goTool();
    if (!go) {
      return;
    }
    for (const dir of workspaceModuleDirs) {
      const mods = await this.listModules(go, dir);
      const main = mods.find((m) => m.Main);
      const org = main ? orgOf(main.Path) : undefined;
      for (const m of mods) {
        if (this.disposed || m.Main || !m.Dir || !isImmutableModule(m.Dir)) {
          continue;
        }
        if (this.opts.prebuild === 'sameOrg' && (!org || orgOf(m.Path) !== org)) {
          continue;
        }
        await this.ensure(m.Dir);
      }
    }
  }

  private listModules(go: string, dir: string): Promise<Array<{ Path: string; Dir?: string; Main?: boolean }>> {
    return new Promise((resolve) => {
      cp.execFile(go, ['list', '-m', '-json', 'all'], { cwd: dir, maxBuffer: 64 << 20, timeout: 60_000 }, (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        const out: Array<{ Path: string; Dir?: string; Main?: boolean }> = [];
        for (const chunk of stdout.split(/\n}\n?/)) {
          try {
            if (chunk.trim()) {
              out.push(JSON.parse(`${chunk}\n}`));
            }
          } catch {
            // ignore
          }
        }
        resolve(out);
      });
    });
  }

  /** Builds run one at a time, at low priority. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async build(root: string): Promise<boolean> {
    if (this.has(root) || this.disposed) {
      return this.has(root);
    }
    const out = this.indexDir(root);
    const lock = `${out}.lock`;
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    // Another window may be building the same module: wait for it instead.
    try {
      const st = await fs.promises.stat(lock);
      if (Date.now() - st.mtimeMs < LOCK_STALE_MS) {
        for (let i = 0; i < 120 && !this.has(root); i++) {
          await new Promise((r) => setTimeout(r, 500));
        }
        return this.has(root);
      }
    } catch {
      // no lock
    }
    const indexer = await this.indexerBinary();
    if (!indexer) {
      return false;
    }
    await fs.promises.writeFile(lock, String(process.pid));
    const t = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const child = cp.execFile(indexer, [root, out], { cwd: root, env: { ...process.env, GOWORK: 'off', GOFLAGS: '' }, timeout: 300_000, maxBuffer: 16 << 20 }, (err) =>
          err ? reject(err) : resolve(),
        );
        try {
          if (child.pid) {
            os.setPriority(child.pid, 10);
          }
        } catch {
          // best effort
        }
      });
      this.stats.builds++;
      this.stats.buildMs += Date.now() - t;
      this.log(`indexed ${root} in ${Date.now() - t} ms`);
      return this.has(root);
    } catch (e) {
      this.log(`indexing ${root} failed: ${e instanceof Error ? e.message : e}`);
      return false;
    } finally {
      await fs.promises.rm(lock, { force: true });
    }
  }

  /** Compiles the bundled indexer once per source version (needs the Go toolchain). */
  private indexerBinary(): Promise<string | undefined> {
    this.indexer ??= (async () => {
      const go = this.goTool();
      const src = path.join(this.extensionPath, 'indexer');
      if (!go || !fs.existsSync(path.join(src, 'main.go'))) {
        return undefined;
      }
      const hash = crypto
        .createHash('sha1')
        .update(await fs.promises.readFile(path.join(src, 'main.go')))
        .digest('hex')
        .slice(0, 12);
      const bin = path.join(this.dir, 'bin', `indexer-${hash}${process.platform === 'win32' ? '.exe' : ''}`);
      if (fs.existsSync(bin)) {
        return bin;
      }
      await fs.promises.mkdir(path.dirname(bin), { recursive: true });
      return new Promise<string | undefined>((resolve) => {
        cp.execFile(go, ['build', '-trimpath', '-o', bin, '.'], { cwd: src, env: { ...process.env, GOWORK: 'off', GOFLAGS: '' }, timeout: 120_000 }, (err) => {
          if (err) {
            this.log(`building the indexer failed: ${err.message}`);
          }
          resolve(err ? undefined : bin);
        });
      });
    })();
    return this.indexer;
  }

  private shard(root: string, file: string): Promise<Shard | undefined> {
    const rel = path.relative(root, file).split(path.sep).join('__');
    const shardPath = path.join(this.indexDir(root), 'files', `${rel}.json`);
    let s = this.shards.get(shardPath);
    if (!s) {
      s = fs.promises
        .readFile(shardPath, 'utf8')
        .then((t) => JSON.parse(t) as Shard)
        .catch(() => ({ f: [], d: {} }) as Shard);
      this.shards.set(shardPath, s);
      if (this.shards.size > MAX_SHARDS) {
        this.shards.delete(this.shards.keys().next().value as string);
      }
    }
    return s;
  }
}
