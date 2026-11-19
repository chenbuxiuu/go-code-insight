import * as vscode from 'vscode';
import { GoInlineValuesProvider } from './inlineValues';
import { GoLensProvider, SHOW_LOCATIONS } from './provider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new GoLensProvider(context.extensionPath);

  const goFiles = vscode.workspace.createFileSystemWatcher('**/*.go');
  const modFiles = vscode.workspace.createFileSystemWatcher('**/{go.mod,go.work}');
  const onModChange = (uri: vscode.Uri) => provider.onFileEvent(uri, 'create');

  provider.onVisibleEditors(vscode.window.visibleTextEditors);
  // Index the workspace's dependency modules once, after startup has settled.
  const prebuild = setTimeout(() => process.env.GO_CODE_INSIGHT_NO_PREBUILD || void provider.prebuildDependencyIndexes(), 10_000);
  context.subscriptions.push({ dispose: () => clearTimeout(prebuild) });
  context.subscriptions.push(
    provider,
    goFiles,
    modFiles,
    vscode.languages.registerCodeLensProvider({ language: 'go', scheme: 'file' }, provider),
    vscode.languages.registerInlineValuesProvider(
      { language: 'go', scheme: 'file' },
      new GoInlineValuesProvider(() => {
        const c = vscode.workspace.getConfiguration('goCodeInsight.inlineValues');
        return { enable: c.get('enable', true), maxLength: Math.max(10, c.get('maxLength', 50)) };
      }),
    ),

    vscode.commands.registerCommand(SHOW_LOCATIONS, async (uri: vscode.Uri, pos: vscode.Position, locs: vscode.Location[]) => {
      if (!locs || locs.length === 0) {
        return;
      }
      if (locs.length === 1) {
        await vscode.window.showTextDocument(locs[0].uri, { selection: locs[0].range });
        return;
      }
      await vscode.commands.executeCommand('editor.action.peekLocations', uri, pos, locs, 'peek');
    }),
    vscode.commands.registerCommand('goCodeInsight.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('goCodeInsight');
      await cfg.update('enable', !cfg.get('enable', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('goCodeInsight.refresh', () => provider.refreshNow(true)),
    vscode.commands.registerCommand('goCodeInsight.stats', () => ({ ...provider.stats, ...provider.depStats() })),
    // Internal: build (or wait for) the index of a module-cache directory; used by tests.
    vscode.commands.registerCommand('goCodeInsight.indexModule', (root: string) => provider.deps.ensure(root)),

    vscode.workspace.onDidChangeTextDocument((e) => provider.onDocumentChanged(e)),
    vscode.workspace.onDidOpenTextDocument((d) => provider.onDocumentOpened(d)),
    vscode.workspace.onDidSaveTextDocument((d) => provider.onDocumentSaved(d)),
    vscode.workspace.onDidCloseTextDocument((d) => provider.onDocumentClosed(d)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('goCodeInsight')) {
        provider.onConfigChanged();
      }
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => provider.onVisibleRangesChanged(e.textEditor)),
    vscode.window.onDidChangeVisibleTextEditors((eds) => provider.onVisibleEditors(eds)),

    goFiles.onDidCreate((u) => provider.onFileEvent(u, 'create')),
    goFiles.onDidChange((u) => provider.onFileEvent(u, 'change')),
    goFiles.onDidDelete((u) => provider.onFileEvent(u, 'delete')),
    modFiles.onDidCreate(onModChange),
    modFiles.onDidChange(onModChange),
    modFiles.onDidDelete(onModChange),
  );
}

export function deactivate(): void {}
