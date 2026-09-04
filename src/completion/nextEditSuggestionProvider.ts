import * as vscode from 'vscode';
import { SettingsStore } from '../settings/store';
import { applyNextEdits, buildNextEditPrompt, parseNextEdits } from './nextEditPrompt';

type SuggestionIntent = 'fix-errors' | 'next-edit';

/** Provides error-aware code actions and previews any AI-proposed file edits before applying them. */
export class NextEditSuggestionProvider implements vscode.CodeActionProvider, vscode.Disposable {
	static readonly metadata: vscode.CodeActionProviderMetadata = {
		providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Source]
	};

	private readonly previews = new Map<string, string>();
	private readonly previewProvider: vscode.Disposable;

	constructor(
		private readonly store: SettingsStore,
		private readonly output: vscode.OutputChannel
	) {
		this.previewProvider = vscode.workspace.registerTextDocumentContentProvider('skycode-next-edit', {
			provideTextDocumentContent: uri => this.previews.get(uri.toString()) ?? ''
		});
	}

	dispose(): void {
		this.previews.clear();
		this.previewProvider.dispose();
	}

	provideCodeActions(
		document: vscode.TextDocument,
		_range: vscode.Range,
		context: vscode.CodeActionContext
	): vscode.CodeAction[] {
		if (!vscode.workspace.getConfiguration('skycode.nextEditSuggestion').get<boolean>('enabled', true)) {
			return [];
		}
		const actions: vscode.CodeAction[] = [];
		const errors = context.diagnostics.filter(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error);
		if (errors.length > 0) {
			const action = new vscode.CodeAction(`SkyCode: Suggest fixes for ${errors.length} error${errors.length === 1 ? '' : 's'}`, vscode.CodeActionKind.QuickFix);
			action.diagnostics = errors;
			action.command = { title: action.title, command: 'skycode.suggestNextEdit', arguments: [document.uri, 'fix-errors'] };
			actions.push(action);
		}
		const nextEdit = new vscode.CodeAction('SkyCode: Suggest next edit for this file', vscode.CodeActionKind.Source);
		nextEdit.command = { title: nextEdit.title, command: 'skycode.suggestNextEdit', arguments: [document.uri, 'next-edit'] };
		actions.push(nextEdit);
		return actions;
	}

	async suggest(uri?: vscode.Uri, intent: SuggestionIntent = 'next-edit'): Promise<void> {
		if (!vscode.workspace.getConfiguration('skycode.nextEditSuggestion').get<boolean>('enabled', true)) {
			return;
		}
		const document = await this.resolveDocument(uri);
		if (!document) {
			void vscode.window.showInformationMessage('Open a file before requesting a SkyCode next edit suggestion.');
			return;
		}
		const target = await this.store.getCompletionTarget();
		if (!target) {
			void vscode.window.showWarningMessage('SkyCode needs an enabled provider, model, and API key before it can suggest an edit.');
			return;
		}

		const version = document.version;
		const controller = new AbortController();
		const response = await Promise.resolve(vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'SkyCode is preparing a next edit suggestion', cancellable: true },
			async (_progress, token) => {
				const subscription = token.onCancellationRequested(() => controller.abort());
				try {
					return await this.store.completeChat(
						target.providerId,
						target.modelIdentifier,
						buildNextEditPrompt({
							fileName: vscode.workspace.asRelativePath(document.uri, false),
							languageId: document.languageId,
							content: document.getText(),
							diagnostics: vscode.languages.getDiagnostics(document.uri),
							intent
						}),
						controller.signal
					);
				} finally {
					subscription.dispose();
				}
			}
		)).catch(error => {
			if (!controller.signal.aborted) {
				this.output.appendLine(`Next edit suggestion failed: ${error instanceof Error ? error.message : String(error)}`);
				void vscode.window.showWarningMessage('SkyCode could not generate a next edit suggestion. See “SkyCode Auto Suggestion” output for details.');
			}
			return undefined;
		});
		if (!response || controller.signal.aborted || document.version !== version) {
			return;
		}

		const edits = parseNextEdits(response, document.getText());
		const proposed = edits && applyNextEdits(document.getText(), edits);
		if (!proposed || proposed === document.getText()) {
			void vscode.window.showInformationMessage('SkyCode found no safe next edit for this file.');
			return;
		}
		const preview = vscode.Uri.parse(`skycode-next-edit:${encodeURIComponent(document.uri.toString())}-${Date.now()}`);
		this.previews.set(preview.toString(), proposed);
		await vscode.commands.executeCommand('vscode.diff', document.uri, preview, 'SkyCode Next Edit Preview');
		const choice = await vscode.window.showInformationMessage('Review the SkyCode next edit preview.', { modal: true }, 'Apply edits');
		if (choice !== 'Apply edits' || document.version !== version) {
			return;
		}
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), proposed);
		await vscode.workspace.applyEdit(edit);
	}

	private async resolveDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
		if (uri) {
			return vscode.workspace.openTextDocument(uri);
		}
		return vscode.window.activeTextEditor?.document;
	}
}
