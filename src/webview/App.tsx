import { useCallback, useEffect, useRef, useState } from 'react';
import { HostToWebviewMessage, ModelInfoFetchedMessage, SkyCodeSettings, WebviewToHostMessage } from '../settings/types';
import { ChatMessage, ChatTarget, ChatView, applyChatDelta } from './ChatView';
import { SettingsView } from './SettingsView';
import { ModelsFetchState } from './ProviderForm';

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
const vscode = acquireVsCodeApi();

export type ViewName = 'home' | 'settings';

/** Post a message from the webview to the extension host. */
export function postToHost(msg: WebviewToHostMessage): void {
	vscode.postMessage(msg);
}

/** Flatten configured providers into selectable chat targets (one entry per model). */
function withChatTargets(settings: SkyCodeSettings): ChatTarget[] {
	const targets: ChatTarget[] = [];
	for (const p of settings.providers) {
		for (const m of p.models) {
			targets.push({ id: p.id, model: m.id, displayName: p.displayName, hasApiKey: p.hasApiKey });
		}
	}
	return targets;
}

export function App() {
	const [view, setView] = useState<ViewName>('home');
	const [settings, setSettings] = useState<SkyCodeSettings>({ providers: [] });
	const [modelsFetch, setModelsFetch] = useState<ModelsFetchState | null>(null);
	const [infoResults, setInfoResults] = useState<ModelInfoFetchedMessage[]>([]);
	const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
	// Tracks whether the current chat completion is still streaming, so the UI can
	// re-enable the Send button the moment the host reports `done: true`.
	const [streaming, setStreaming] = useState(false);
	const activeRequestId = useRef<string | null>(null);

	useEffect(() => {
		const handler = (event: MessageEvent<HostToWebviewMessage>) => {
			const msg = event.data;
			switch (msg.type) {
				case 'settingsUpdated':
					setSettings(msg.settings);
					break;
				case 'navigate':
					setView(msg.view);
					break;
				case 'modelsFetched':
					setModelsFetch(prev =>
						prev && prev.requestId === msg.requestId
							? { ...prev, pending: false, models: msg.models, error: msg.error }
							: prev
					);
					break;
				case 'modelInfoFetched':
					setInfoResults(prev => [...prev, msg]);
					break;
				case 'chatChunk':
					if (activeRequestId.current !== msg.requestId) {
						break;
					}
					setChatMessages(prev =>
						applyChatDelta(prev, { requestId: msg.requestId, text: msg.text, error: msg.error })
					);
					// The host always emits a `done: true` chunk on completion or error.
					if (msg.done) {
						setStreaming(false);
						activeRequestId.current = null;
					}
					break;
			}
		};
		window.addEventListener('message', handler);
		postToHost({ type: 'ready' });
		return () => window.removeEventListener('message', handler);
	}, []);

	const consumeInfoResults = useCallback((requestIds: string[]) => {
		setInfoResults(prev => prev.filter(r => !requestIds.includes(r.requestId)));
	}, []);

	const keyOps = {
		onSaveKey: (providerId: string, keyId: string, label: string, value?: string) =>
			postToHost({ type: 'saveKey', providerId, keyId, label, value }),
		onDeleteKey: (providerId: string, keyId: string) =>
			postToHost({ type: 'deleteKey', providerId, keyId }),
		onSetActiveKey: (providerId: string, keyId: string) =>
			postToHost({ type: 'setActiveKey', providerId, keyId }),
		onFetchModels: (providerId: string, requestId: string) => {
			setModelsFetch({ requestId, pending: true });
			postToHost({ type: 'fetchModels', providerId, requestId });
		},
		onFetchModelInfo: (providerId: string, requestId: string, modelId: string) =>
			postToHost({ type: 'fetchModelInfo', providerId, requestId, modelId }),
		onConsumeInfoResults: consumeInfoResults
	};

	if (view === 'settings') {
		return (
			<SettingsView
				providers={settings.providers}
				modelsFetch={modelsFetch}
				modelInfoResults={infoResults}
				onClose={() => setView('home')}
				onSave={payload => postToHost({ type: 'saveProvider', entry: payload.entry })}
				onDelete={id => postToHost({ type: 'deleteProvider', id })}
				{...keyOps}
			/>
		);
	}

	return (
		<ChatView
			providers={withChatTargets(settings)}
			messages={chatMessages}
			streaming={streaming}
			onChangeMessages={setChatMessages}
			onOpenSettings={() => setView('settings')}
			onSend={track => {
				setStreaming(true);
				activeRequestId.current = track.requestId;
				postToHost({
					type: 'sendChatMessage',
					providerId: track.providerId,
					modelIdentifier: track.model,
					messages: track.messages,
					requestId: track.requestId,
					autoApproveTools: track.autoApproveTools
				});
			}}
			onCancel={() => {
				const requestId = activeRequestId.current;
				if (!requestId) {
					return;
				}
				activeRequestId.current = null;
				setStreaming(false);
				postToHost({ type: 'cancelChatMessage', requestId });
			}}
		/>
	);
}
