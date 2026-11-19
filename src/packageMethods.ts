import * as vscode from 'vscode';
import { parseReceiver } from './goText';
import { TextStore } from './textStore';

const MAX_DIRS = 200;
const METHOD_DECL = /^func\s*\(/gm;

/**
 * Methods declared in a package, by receiver type name. Computed locally from the
 * package's files (no gopls request) and cached per directory until a file in it
 * changes.
 */
export class PackageMethods {
  private readonly dirs = new Map<string, Promise<Map<string, vscode.Location[]>>>();

  constructor(private readonly texts: TextStore) {}

  async of(doc: vscode.Uri, pkg: string, type: string): Promise<vscode.Location[]> {
    const dir = vscode.Uri.joinPath(doc, '..');
    const key = `${dir}|${pkg}`;
    let index = this.dirs.get(key);
    if (!index) {
      index = this.build(dir, pkg).catch(() => new Map<string, vscode.Location[]>());
      this.dirs.set(key, index);
      if (this.dirs.size > MAX_DIRS) {
        this.dirs.delete(this.dirs.keys().next().value as string);
      }
    }
    return (await index).get(type) ?? [];
  }

  /** Drops the cached index of the directory containing `file`. */
  invalidate(file: vscode.Uri): void {
    const dir = vscode.Uri.joinPath(file, '..').toString();
    for (const key of this.dirs.keys()) {
      if (key.startsWith(`${dir}|`)) {
        this.dirs.delete(key);
      }
    }
  }

  clear(): void {
    this.dirs.clear();
  }

  private async build(dir: vscode.Uri, pkg: string): Promise<Map<string, vscode.Location[]>> {
    const byType = new Map<string, vscode.Location[]>();
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.File || !name.endsWith('.go')) {
        continue;
      }
      const uri = vscode.Uri.joinPath(dir, name);
      const text = await this.texts.get(uri);
      if (!text || text.packageName() !== pkg) {
        continue;
      }
      const src = text.text;
      for (const m of src.matchAll(METHOD_DECL)) {
        const recv = parseReceiver(src, m.index);
        if (!recv) {
          continue;
        }
        // Method name follows the receiver's closing parenthesis.
        let i = m.index + m[0].length - 1;
        for (let depth = 0; i < src.length; i++) {
          if (src[i] === '(') {
            depth++;
          } else if (src[i] === ')' && --depth === 0) {
            break;
          }
        }
        const nameMatch = /^\s*([\p{L}_][\p{L}\p{N}_]*)/u.exec(src.slice(i + 1, i + 200));
        if (!nameMatch) {
          continue;
        }
        const offset = i + 1 + nameMatch[0].length - nameMatch[1].length;
        const p = text.positionAt(offset);
        const start = new vscode.Position(p.line, p.character);
        const list = byType.get(recv.name) ?? [];
        list.push(new vscode.Location(uri, new vscode.Range(start, start.translate(0, nameMatch[1].length))));
        byType.set(recv.name, list);
      }
    }
    return byType;
  }
}
