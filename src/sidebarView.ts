import * as vscode from 'vscode';
import { SettingsStore } from './settings/store';
import { HostToWebviewMessage, WebviewToHostMessage } from './settings/types';
import { getAdapter } from './core/adapterRegistry';
import { ChatMessageInput, ProviderEntity } from './core/types';
import { ChatToolAgent, ToolName } from './tools/chatToolAgent';

/** UI catalog id → core adapter type ('ollamaCloud' → 'ollama'; others identity). */
function uiToAdapterType(uiId: string): string {
	return uiId === 'ollamaCloud' ? 'ollama' : uiId;
}

function toCoreProvider(p: {
	id: string;
	providerId: string;
	displayName: string;
	baseUrl: string;
	modelsUrl?: string;
}): ProviderEntity {
	return {
		id: p.id,
		adapterType: uiToAdapterType(p.providerId),
		name: p.displayName,
		baseUrl: p.baseUrl,
		modelsUrl: p.modelsUrl,
		enabled: true
	};
}

/**
 * Sidebar webview for SkyCode (shown under the extension's activity bar icon).
 * Hosts the React UI and relays settings messages between the webview and the
 * SettingsStore.
 */
export class SkyCodeSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'skycode.sidebar';

	private webviewView?: vscode.WebviewView;
	private readonly activeChatRequests = new Map<string, AbortController>();
	private readonly pendingToolApprovals = new Map<string, (approved: boolean) => void>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: SettingsStore,
		private readonly output: vscode.OutputChannel
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.webviewView = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri]
		};

		webviewView.webview.onDidReceiveMessage(
			(msg: WebviewToHostMessage) => this.handleMessage(msg, webviewView.webview),
			undefined,
			this.context.subscriptions
		);

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				void this.pushSettings(webviewView.webview);
			}
		});

		webviewView.webview.html = this.getHtml(webviewView.webview);
	}

	/** Called by the skycode.settings view-title command. */
	async showSettings(): Promise<void> {
		if (!this.webviewView) {
			return;
		}
		await this.webviewView.show?.(true);
		await this.webviewView.webview.postMessage({
			type: 'navigate',
			view: 'settings'
		} satisfies HostToWebviewMessage);
	}

	private async handleMessage(msg: WebviewToHostMessage, webview: vscode.Webview): Promise<void> {
		switch (msg.type) {
			case 'ready':
				await this.pushSettings(webview);
				break;
			case 'saveProvider':
				await this.store.saveProvider(msg.entry);
				await this.pushSettings(webview);
				break;
			case 'deleteProvider':
				await this.store.deleteProvider(msg.id);
				await this.pushSettings(webview);
				break;
			case 'saveKey':
				await this.store.saveKey(msg.providerId, msg.keyId, msg.label, msg.value?.trim() || undefined);
				await this.pushSettings(webview);
				break;
			case 'deleteKey':
				await this.store.deleteKey(msg.providerId, msg.keyId);
				await this.pushSettings(webview);
				break;
			case 'setActiveKey':
				await this.store.setActiveKey(msg.providerId, msg.keyId);
				await this.pushSettings(webview);
				break;
			case 'fetchModels':
				await this.fetchModels(msg.providerId, msg.requestId, webview);
				break;
			case 'fetchModelInfo':
				await this.fetchModelInfo(msg.providerId, msg.requestId, msg.modelId, webview);
				break;
			case 'sendChatMessage':
					if (this.activeChatRequests.has(msg.requestId)) {
						break;
					}
					const controller = new AbortController();
					this.activeChatRequests.set(msg.requestId, controller);
					void this.streamChatMessage(
						{ providerId: msg.providerId, modelIdentifier: msg.modelIdentifier, messages: msg.messages, requestId: msg.requestId, autoApproveTools: msg.autoApproveTools === true },
						webview,
						controller
					);
					break;
			case 'cancelChatMessage':
				this.activeChatRequests.get(msg.requestId)?.abort();
				this.resolvePendingApprovals(msg.requestId, false);
				break;
			case 'resolveToolApproval':
				this.resolveToolApproval(msg.requestId, msg.approvalId, msg.approved);
				break;
		}
	}

	/**
	 * Query the model-details endpoint through the provider adapter
	 * (Ollama: /api/show; future providers: their own mechanism).
	 */
	private async fetchModelInfo(
		providerId: string,
		requestId: string,
		modelId: string,
		webview: vscode.Webview
	): Promise<void> {
		const provider = (await this.store.getSettings()).providers.find(p => p.id === providerId);
		if (!provider) {
			await webview.postMessage({ type: 'modelInfoFetched', requestId, modelId, error: 'Provider not found' } satisfies HostToWebviewMessage);
			return;
		}
		try {
			const adapter = getAdapter(uiToAdapterType(provider.providerId));
			const apiKey = await this.store.getActiveKeySecret(providerId);
			const info = await adapter.showModelInfo!(
				toCoreProvider(provider),
				modelId,
				apiKey ?? undefined
			);
			await webview.postMessage({
				type: 'modelInfoFetched',
				requestId,
				modelId,
				contextLength: info.apiValues?.contextWindow,
				supportsVision: info.apiValues?.capabilities?.vision,
				supportsTools: info.apiValues?.capabilities?.toolCalling,
				parameterSize: info.parameterSize,
				quantizationLevel: info.quantizationLevel
			} satisfies HostToWebviewMessage);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await webview.postMessage({ type: 'modelInfoFetched', requestId, modelId, error: message } satisfies HostToWebviewMessage);
		}
	}

	/** Model discovery through the provider adapter. */
	private async fetchModels(providerId: string, requestId: string, webview: vscode.Webview): Promise<void> {
		const provider = (await this.store.getSettings()).providers.find(p => p.id === providerId);
		if (!provider) {
			await webview.postMessage({ type: 'modelsFetched', requestId, error: 'Provider not found' } satisfies HostToWebviewMessage);
			return;
		}
		try {
			const adapter = getAdapter(uiToAdapterType(provider.providerId));
			const apiKey = await this.store.getActiveKeySecret(providerId);
			const drafts = await adapter.discoverModels(
				toCoreProvider(provider),
				apiKey ?? undefined
			);
			this.store.stageDiscovered(providerId, drafts);
			await webview.postMessage({
				type: 'modelsFetched',
				requestId,
				models: drafts.map(d => d.modelIdentifier)
			} satisfies HostToWebviewMessage);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await webview.postMessage({ type: 'modelsFetched', requestId, error: message } satisfies HostToWebviewMessage);
		}
	}

	private async pushSettings(webview: vscode.Webview): Promise<void> {
		const settings = await this.store.withKeyFlags(await this.store.getSettings());
		await webview.postMessage({ type: 'settingsUpdated', settings } satisfies HostToWebviewMessage);
	}

	/** Stream a chat completion through the core ChatEngine and relay deltas. */
	private async streamChatMessage(
		msg: { providerId: string; modelIdentifier: string; messages: ChatMessageInput[]; requestId: string; autoApproveTools: boolean },
		webview: vscode.Webview,
		controller: AbortController
	): Promise<void> {
		try {
			const tools = new ChatToolAgent(
				(messages, signal) => this.store.completeMessages(msg.providerId, msg.modelIdentifier, messages, signal, { temperature: 0.2, max_tokens: 4_096 }),

				this.output,
				{
					activity: event => {
						void webview.postMessage({ type: 'toolActivity', requestId: msg.requestId, ...event } satisfies HostToWebviewMessage);
					},
					requestApproval: (call, summary, signal) => this.requestToolApproval(msg.requestId, call.name, summary, webview, signal)
				}
			);
			const response = await tools.run(msg.messages, msg.autoApproveTools, controller.signal);
			if (controller.signal.aborted) {
				return;
			}
			await webview.postMessage({
				type: 'chatChunk',
				requestId: msg.requestId,
				text: response,
				done: true
			} satisfies HostToWebviewMessage);
		} catch (err) {
			if (controller.signal.aborted) {
				await webview.postMessage({ type: 'chatChunk', requestId: msg.requestId, text: '', done: true } satisfies HostToWebviewMessage);
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			await webview.postMessage({
				type: 'chatChunk',
				requestId: msg.requestId,
				text: '',
				done: true,
				error: message
			} satisfies HostToWebviewMessage);
		} finally {
			this.resolvePendingApprovals(msg.requestId, false);
			this.activeChatRequests.delete(msg.requestId);
		}
	}

	private requestToolApproval(requestId: string, tool: ToolName, summary: string, webview: vscode.Webview, signal: AbortSignal): Promise<boolean> {
		const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		return new Promise(resolve => {
			const key = `${requestId}:${approvalId}`;
			const finish = (approved: boolean) => {
				this.pendingToolApprovals.delete(key);
				signal.removeEventListener('abort', cancel);
				resolve(approved);
			};
			const cancel = () => finish(false);
			this.pendingToolApprovals.set(key, finish);
			signal.addEventListener('abort', cancel, { once: true });
			void webview.postMessage({ type: 'toolApprovalRequested', requestId, approvalId, tool, summary } satisfies HostToWebviewMessage);
		});
	}

	private resolveToolApproval(requestId: string, approvalId: string, approved: boolean): void {
		this.pendingToolApprovals.get(`${requestId}:${approvalId}`)?.(approved);
	}

	private resolvePendingApprovals(requestId: string, approved: boolean): void {
		for (const [key, resolve] of this.pendingToolApprovals) {
			if (key.startsWith(`${requestId}:`)) {
				resolve(approved);
			}
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js')
		);
		const stylesUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css')
		);
		// Local font resource (no CDN): served from the extension via webview.cspSource.
		const fontRegular = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'fonts', 'AmirRooxFont-Regular.woff2')
		).toString();
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="${stylesUri}" rel="stylesheet" />
	<style nonce="${nonce}">
		@font-face {
			font-family: 'AmirRoox';
			src: url('${fontRegular}') format('woff2');
			font-weight: 400;
			font-style: normal;
			font-display: swap;
		}
		:root {
			--sc-font-farsi: 'AmirRoox', 'Segoe UI', Tahoma, sans-serif;
		}
	</style>
	<title>SkyCode</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
