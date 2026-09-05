/**
 * Composer modes for the chat panel.
 *
 * Kept free of React/icon imports so the host-side test suite can exercise the
 * request-building logic without loading the webview bundle.
 */

export type ChatModeId = 'chat' | 'agent' | 'plan';

export interface ChatModeSpec {
	id: ChatModeId;
	label: string;
	placeholder: string;
	/**
	 * Prepended as a system message so picking a mode actually changes model
	 * behaviour rather than only relabelling the composer. `undefined` for the
	 * default Chat mode, which uses the agent's own instructions unchanged.
	 */
	directive?: string;
}

/** One entry per segment of the mode switcher, in display order. */
export const CHAT_MODES: readonly ChatModeSpec[] = [
	{
		id: 'chat',
		label: 'Chat',
		placeholder: 'Ask SkyCode about the open workspace…'
	},
	{
		id: 'agent',
		label: 'Agent',
		placeholder: 'Tell SkyCode what to build — it can edit files and run commands',
		directive:
			'Work autonomously: use the workspace tools to inspect and change files until the task is finished, then summarise what changed.'
	},
	{
		id: 'plan',
		label: 'Plan',
		placeholder: 'Describe the goal — SkyCode drafts a plan before touching code',
		directive:
			'Plan only. You may read files, but never create, edit, delete, or run anything. Reply with a numbered plan naming the files each step touches.'
	}
];

/** Look up a mode, falling back to Chat for unknown ids. */
export function getChatMode(id: ChatModeId): ChatModeSpec {
	return CHAT_MODES.find(m => m.id === id) ?? CHAT_MODES[0];
}

/** A turn as the host expects it (the transcript plus an optional directive). */
export interface ChatRequestMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

/** Transcript turns rendered in the panel. Never carries a system role. */
export interface ChatTranscriptMessage {
	role: 'user' | 'assistant';
	content: string;
}

/**
 * Build the message list for one completion: the mode directive (when the mode
 * has one), the existing transcript, then the new user turn.
 */
export function buildRequestMessages(
	mode: ChatModeId,
	history: readonly ChatTranscriptMessage[],
	prompt: string
): ChatRequestMessage[] {
	const { directive } = getChatMode(mode);
	return [
		...(directive ? [{ role: 'system' as const, content: directive }] : []),
		...history,
		{ role: 'user' as const, content: prompt }
	];
}
