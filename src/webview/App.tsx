import { useCallback, useEffect, useState } from 'react';
import { HostToWebviewMessage, ModelInfoFetchedMessage, SkyCodeSettings, WebviewToHostMessage } from '../settings/types';
import { HomeView } from './HomeView';
import { SettingsView } from './SettingsView';
import { ModelsFetchState } from './ProviderForm';

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
const vscode = acquireVsCodeApi();

export type ViewName = 'home' | 'settings';

/** Post a message from the webview to the extension host. */
export function postToHost(msg: WebviewToHostMessage): void {
	vscode.postMessage(msg);
}

export function App() {
	const [view, setView] = useState<ViewName>('home');
	const [settings, setSettings] = useState<SkyCodeSettings>({ providers: [] });
	const [modelsFetch, setModelsFetch] = useState<ModelsFetchState | null>(null);
	const [infoResults, setInfoResults] = useState<ModelInfoFetchedMessage[]>([]);

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
	return <HomeView providers={settings.providers} onOpenSettings={() => setView('settings')} />;
}
