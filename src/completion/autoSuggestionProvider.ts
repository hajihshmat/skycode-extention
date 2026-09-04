import * as vscode from 'vscode';
import { SettingsStore } from '../settings/store';
import { buildCompletionPrompt, cleanCompletion } from './completionPrompt';
import { indexCurrentDocument } from './contextIndexer';

const DEFAULT_DELAY_MS = 180;
const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 80;

interface CachedSuggestion {
	value?: string;
	expiresAt: number;
}

/** Inline completion provider with cancellation-aware debounce and document-version cache. */
export class AutoSuggestionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
	private readonly cache = new Map<string, CachedSuggestion>();

	constructor(
		private readonly store: SettingsStore,
		private readonly output: vscode.OutputChannel
	) {}

	dispose(): void {
		this.cache.clear();
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		const config = vscode.workspace.getConfiguration('skycode.autoSuggestion');
		if (!config.get<boolean>('enabled', true) || token.isCancellationRequested) {
			return undefined;
		}

		const version = document.version;
		const key = `${document.uri.toString()}@${document.version}:${position.line}:${position.character}`;
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.value ? [new vscode.InlineCompletionItem(cached.value)] : undefined;
		}

		const delayMs = clamp(config.get<number>('delayMs', DEFAULT_DELAY_MS), 0, 2_000);
		if (!(await wait(delayMs, token))) {
			return undefined;
		}

		const controller = new AbortController();
		const subscription = token.onCancellationRequested(() => controller.abort());
		try {
			const target = await this.store.getCompletionTarget();
			if (!target || token.isCancellationRequested) {
				if (!target) {
					this.output.appendLine('Auto-suggestion skipped: no enabled provider with a configured model and available credentials.');
				}
				return undefined;
			}
			const indexed = indexCurrentDocument(document, position);
			const response = await this.store.completeChat(
				target.providerId,
				target.modelIdentifier,
				buildCompletionPrompt(indexed),
				controller.signal
			);
			if (token.isCancellationRequested || document.version !== version) {
				return undefined;
			}
			const value = cleanCompletion(response, indexed.linePrefix);
			if (!value) {
				this.output.appendLine('Auto-suggestion skipped: the model returned no insertable code.');
			}
			this.remember(key, value, clamp(config.get<number>('cacheTtlMs', DEFAULT_CACHE_TTL_MS), 1_000, 300_000));
			return value ? [new vscode.InlineCompletionItem(value)] : undefined;
		} catch (error) {
			if (!controller.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				this.output.appendLine(`Auto-suggestion failed: ${message}`);
				void vscode.window.showWarningMessage(`SkyCode auto-suggestion failed: ${message}`);
			}
			return undefined;
		} finally {
			subscription.dispose();
		}
	}

	private remember(key: string, value: string | undefined, ttlMs: number): void {
		if (this.cache.size >= MAX_CACHE_ENTRIES) {
			this.cache.delete(this.cache.keys().next().value!);
		}
		this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
	}
}

function wait(ms: number, token: vscode.CancellationToken): Promise<boolean> {
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			subscription.dispose();
			resolve(true);
		}, ms);
		const subscription = token.onCancellationRequested(() => {
			clearTimeout(timer);
			subscription.dispose();
			resolve(false);
		});
	});
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
