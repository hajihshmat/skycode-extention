import { ModelInfoFetchedMessage } from '../settings/types';

/** Shared key/model-fetch operations a form needs from the host. */
export interface KeyOps {
	onSaveKey: (providerId: string, keyId: string, label: string, value?: string) => void;
	onDeleteKey: (providerId: string, keyId: string) => void;
	onSetActiveKey: (providerId: string, keyId: string) => void;
	onFetchModels: (providerId: string, requestId: string) => void;
	/** Query Ollama /api/show for one model's capabilities. */
	onFetchModelInfo: (providerId: string, requestId: string, modelId: string) => void;
	/** Let the webview acknowledge processed info results so the host can drop them. */
	onConsumeInfoResults: (requestIds: string[]) => void;
}

export type { ModelInfoFetchedMessage };
