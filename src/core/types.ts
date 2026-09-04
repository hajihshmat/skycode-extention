/**
 * Core entity types for the provider/model/credential architecture.
 * Provider-agnostic: adapters implement provider specifics.
 */

/** Extensible capability set — providers may add custom boolean keys. */
export interface Capabilities {
	streaming?: boolean;
	vision?: boolean;
	toolCalling?: boolean;
	reasoning?: boolean;
	attachments?: boolean;
	[key: string]: boolean | undefined;
}

/** Provider instance configuration (non-secret). */
export interface ProviderEntity {
	id: string;
	/** Registered adapter type, e.g. "ollama". */
	adapterType: string;
	name: string;
	baseUrl: string;
	/** Overrides the adapter's default chat endpoint path/URL. */
	chatEndpoint?: string;
	/** Overrides the adapter's default model-discovery URL. */
	modelsUrl?: string;
	enabled: boolean;
	/** Credential used for requests when several exist. */
	activeCredentialId?: string;
}

export type CredentialStatus = 'active' | 'rate-limited' | 'invalid';

/** Credential metadata. The secret itself lives only in SecretStorage. */
export interface CredentialMeta {
	id: string;
	providerId: string;
	name: string;
	enabled: boolean;
	status: CredentialStatus;
	/** Epoch ms until which the credential is skipped after a rate limit. */
	cooldownUntil?: number;
	lastError?: string;
}

/** User-editable subset of a model that overrides API-discovered values. */
export interface ModelOverrides {
	name?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	/** Absolute URL or path; wins over provider chat endpoint. */
	endpoint?: string;
	/** User-selected request/response style; defaults to 'chat-completion'. */
	responseType?: ResponseType;
	/** User-selected output format; defaults to 'text'. */
	responseFormat?: ResponseFormat;
	capabilities?: Partial<Capabilities>;
}

export type ModelSource = 'api' | 'manual';

/** How a chat request is sent to the provider API. */
export type ResponseType = 'chat-completion' | 'response';
export const DEFAULT_RESPONSE_TYPE: ResponseType = 'chat-completion';

/** Output format requested from the model. */
export type ResponseFormat = 'text' | 'json_object';
export const DEFAULT_RESPONSE_FORMAT: ResponseFormat = 'text';

export interface ModelEntity {
	id: string;
	providerId: string;
	/** Identifier sent to the provider API. */
	modelIdentifier: string;
	name: string;
	source: ModelSource;
	enabled: boolean;
	/** Non-API (manual/discovery-less) capability values. */
	capabilities?: Capabilities;
	contextWindow?: number;
	endpointOverride?: string;
	maxOutputTokens?: number;
	parameterSize?: string;
	quantizationLevel?: string;
	/** Values as discovered from the provider API (never user-edited). */
	apiValues?: {
		contextWindow?: number;
		maxOutputTokens?: number;
		capabilities?: Capabilities;
		parameterSize?: string;
		quantizationLevel?: string;
	};
	/** User overrides — survive API refreshes. */
	overrides?: ModelOverrides;
}

/** Final merged model configuration (API values + user overrides). */
export interface ResolvedModel {
	id: string;
	modelIdentifier: string;
	name: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	endpointOverride?: string;
	capabilities: Capabilities;
	/** Effective response type (override or 'chat-completion'). */
	responseType: ResponseType;
	/** Effective output format (override or 'text'). */
	responseFormat: ResponseFormat;
}

export interface ChatMessageInput {
	role: string;
	content: string;
}

/** Fully-resolved request handed to an adapter — no provider logic needed. */
export interface ChatRequestContext {
	endpoint: string;
	apiKey?: string;
	model: string;
	messages: ChatMessageInput[];
	options?: Record<string, unknown>;
	/** Requested output format; adapters map it to their own wire fields. */
	responseFormat?: ResponseFormat;
	/** Cancels the in-flight provider request when the user stops generation. */
	signal?: AbortSignal;
}

export interface ChatResponse {
	text: string;
	usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
	raw?: unknown;
}

/** Streaming progress info accumulated from SSE events. */
export interface ChatStreamUsage {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
}

/** One streaming chunk yielded by adapter.sendChatStream(). */
export interface ChatStreamChunk {
	/** Incremental text delta ('' for control chunks like done/usage-only). */
	content: string;
	/** True on the final chunk of the stream. */
	done?: boolean;
	/** Usage info when the provider reports it. */
	usage?: ChatStreamUsage;
}

export type ChatErrorKind = 'rate-limited' | 'invalid-credential' | 'network' | 'invalid-request' | 'server' | 'unknown';

/** Error carrying its classification so the engine can decide on rotation. */
export class ChatError extends Error {
	constructor(
		public readonly kind: ChatErrorKind,
		message: string,
		public retryAfterSec?: number
	) {
		super(message);
		this.name = 'ChatError';
	}
}

export function classifyHttpError(status: number, message: string): ChatError {
	if (status === 429) {
		return new ChatError('rate-limited', message);
	}
	if (status === 401 || status === 403) {
		return new ChatError('invalid-credential', message);
	}
	if (status === 404 || status === 400 || status === 422) {
		return new ChatError('invalid-request', message);
	}
	if (status >= 500) {
		return new ChatError('server', message);
	}
	return new ChatError('unknown', message);
}
