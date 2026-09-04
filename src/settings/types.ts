/**
 * Settings model shared between the extension host and the webview UI.
 * API keys never travel to the webview — only labels and a `hasApiKey` flag.
 */

import type { ResponseFormat, ResponseType } from '../core/types';

export const PROVIDER_CATALOG = [
	{
		providerId: 'ollamaCloud',
		displayName: 'Ollama Cloud',
		defaultBaseUrl: 'https://ollama.com/v1',
		requiresApiKey: true
	},
	{
		providerId: 'openai',
		displayName: 'OpenAI',
		defaultBaseUrl: 'https://api.openai.com/v1',
		requiresApiKey: true
	},
	{
		providerId: 'anthropic',
		displayName: 'Anthropic',
		defaultBaseUrl: 'https://api.anthropic.com/v1',
		requiresApiKey: true
	}
] as const;

export type ProviderTypeId = (typeof PROVIDER_CATALOG)[number]['providerId'];

/** Capabilities/attributes of a single model. */
export interface ModelEntry {
	id: string;
	/** Maximum context window in tokens. */
	contextLength?: number;
	/** Request/response style chosen by the user (default: chat-completion). */
	responseType?: ResponseType;
	/** Output format chosen by the user (default: text). */
	responseFormat?: ResponseFormat;
	/** Provider supports streaming for this model. */
	supportsStreaming?: boolean;
	/** Provider accepts image input for this model. */
	supportsVision?: boolean;
	/** Model accepts tool/function calls. */
	supportsTools?: boolean;
	/** e.g. "8.0B" (from Ollama /api/show). */
	parameterSize?: string;
	/** e.g. "Q4_K_M" (from Ollama /api/show). */
	quantizationLevel?: string;
}

/** A stored API key (label only; the secret itself lives in SecretStorage). */
export interface KeyEntry {
	id: string;
	label: string;
}

/** One configured provider instance. */
export interface ProviderSettingsEntry {
	/** Unique instance id (differs from providerId when multiple instances exist). */
	id: string;
	/** Registered provider type, e.g. "ollamaCloud". */
	providerId: string;
	displayName: string;
	baseUrl: string;
	/** URL to fetch the model list from. Defaults to `${baseUrl}/models`. */
	modelsUrl?: string;
	/** Available models with their capabilities. */
	models: ModelEntry[];
	/** Model used by default when none is chosen. */
	defaultModel?: string;
	/** Stored API keys. Empty for providers that need none. */
	keys: KeyEntry[];
	/** Which key is used for requests. Defaults to keys[0]. */
	activeKeyId?: string;
	/** Host-computed flag: true when the active key has a stored secret. */
	hasApiKey: boolean;
	/** Response types the provider's adapter supports (filters the Model Editor dropdown). */
	supportedResponseTypes: ResponseType[];
	/** Output formats the provider's adapter supports (filters the Model Editor dropdown). */
	supportedResponseFormats: ResponseFormat[];
}

export interface SkyCodeSettings {
	providers: ProviderSettingsEntry[];
}

/* --- Messages: host -> webview --- */
export interface SettingsUpdatedMessage {
	type: 'settingsUpdated';
	settings: SkyCodeSettings;
}

export interface NavigateMessage {
	type: 'navigate';
	view: 'home' | 'settings';
}

export interface ModelsFetchedMessage {
	type: 'modelsFetched';
	/** Echoed from fetchModels so the UI can match the request. */
	requestId: string;
	/** Model ids from the API, or undefined when the request failed. */
	models?: string[];
	error?: string;
}

export type HostToWebviewMessage =
	| SettingsUpdatedMessage
	| NavigateMessage
	| ModelsFetchedMessage
	| ModelInfoFetchedMessage;

/* --- Messages: webview -> host --- */
export interface SaveProviderMessage {
	type: 'saveProvider';
	entry: ProviderSettingsEntry;
}

export interface DeleteProviderMessage {
	type: 'deleteProvider';
	id: string;
}

/** Create a key (empty keyId) or update an existing one's label/secret. */
export interface SaveKeyMessage {
	type: 'saveKey';
	providerId: string;
	/** Empty string = create a new key. */
	keyId: string;
	label: string;
	/** Omitted/empty = keep the stored secret (label-only edit). */
	value?: string;
}

export interface DeleteKeyMessage {
	type: 'deleteKey';
	providerId: string;
	keyId: string;
}

export interface SetActiveKeyMessage {
	type: 'setActiveKey';
	providerId: string;
	keyId: string;
}

export interface FetchModelsMessage {
	type: 'fetchModels';
	providerId: string;
	requestId: string;
}

export interface ReadyMessage {
	type: 'ready';
}

/** Ask the host to query Ollama /api/show for one model's capabilities. */
export interface FetchModelInfoMessage {
	type: 'fetchModelInfo';
	providerId: string;
	requestId: string;
	modelId: string;
}

export interface ModelInfoFetchedMessage {
	type: 'modelInfoFetched';
	requestId: string;
	modelId: string;
	contextLength?: number;
	supportsVision?: boolean;
	supportsTools?: boolean;
	parameterSize?: string;
	quantizationLevel?: string;
	error?: string;
}

export type WebviewToHostMessage =
	| SaveProviderMessage
	| DeleteProviderMessage
	| SaveKeyMessage
	| DeleteKeyMessage
	| SetActiveKeyMessage
	| FetchModelsMessage
	| FetchModelInfoMessage
	| ReadyMessage;
