import * as vscode from 'vscode';
import { GoText } from './goText';

interface Entry {
  /** Document version for open documents, -1 for text read from disk. */
  version: number;
  text: GoText;
}

/**
 * Bounded LRU of indexed Go sources. Open documents are read from the live model
 * (never re-opened); other files are read from disk once and kept until changed.
 */
export class TextStore {
  private readonly entries = new Map<string, Entry>();
  private readonly decoder = new TextDecoder('utf-8');

  constructor(private readonly capacity = 256) {}

  async get(uri: vscode.Uri): Promise<GoText | undefined> {
    const key = uri.toString();
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    const version = doc ? doc.version : -1;
    const hit = this.entries.get(key);
    if (hit && hit.version === version) {
      this.entries.delete(key);
      this.entries.set(key, hit); // refresh LRU position
      return hit.text;
    }
    let text: GoText;
    if (doc) {
      text = new GoText(doc.getText());
    } else {
      try {
        text = new GoText(this.decoder.decode(await vscode.workspace.fs.readFile(uri)));
      } catch {
        return undefined;
      }
    }
    this.entries.delete(key);
    this.entries.set(key, { version, text });
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
    return text;
  }

  invalidate(uri: vscode.Uri): void {
    this.entries.delete(uri.toString());
  }

  clear(): void {
    this.entries.clear();
  }
}
