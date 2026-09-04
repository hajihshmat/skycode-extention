import * as vscode from 'vscode';
import { SettingsStore } from './settings/store';
import { HostToWebviewMessage, WebviewToHostMessage } from './settings/types';
import { getAdapter } from './core/adapterRegistry';
import { ProviderEntity } from './core/types';

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

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: SettingsStore
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
		const provider = this.store.getSettings().providers.find(p => p.id === providerId);
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
		const provider = this.store.getSettings().providers.find(p => p.id === providerId);
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
		const settings = await this.store.withKeyFlags(this.store.getSettings());
		await webview.postMessage({ type: 'settingsUpdated', settings } satisfies HostToWebviewMessage);
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js')
		);
		const stylesUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css')
		);
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="${stylesUri}" rel="stylesheet" />
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
