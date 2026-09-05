import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
	ArrowUp,
	Bot,
	Check,
	ChevronDown,
	Copy,
	FileCode,
	FilePen,
	FilePlus,
	FolderTree,
	ListChecks,
	Loader,
	MessageSquare,
	Plus,
	RefreshCw,
	Settings,
	ShieldCheck,
	ShieldOff,
	ShieldQuestion,
	Sparkles,
	Square,
	Terminal,
	Trash2,
	TriangleAlert,
	Wrench,
	X,
	Zap
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Components } from 'react-markdown' with { 'resolution-mode': 'import' };
import { detectDirection } from './utils/textDirection';
import { ModelSelectorPopover } from './ModelSelectorPopover';
import { CHAT_MODES, buildRequestMessages, getChatMode } from './chatModes';
import type { ChatModeId, ChatRequestMessage } from './chatModes';
import type { ChatToolName, ToolActivityMessage, ToolApprovalRequestedMessage } from '../settings/types';

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface ChatTarget {
	id: string;
	model: string;
	displayName: string;
	hasApiKey: boolean;
}

interface ChatViewProps {
	providers: ChatTarget[];
	messages: ChatMessage[];
	streaming: boolean;
	toolActivities: ToolActivityMessage[];
	toolApprovals: ToolApprovalRequestedMessage[];
	onChangeMessages: (next: ChatMessage[]) => void;
	onOpenSettings: () => void;
	onSend: (track: { providerId: string; model: string; messages: ChatRequestMessage[]; requestId: string; autoApproveTools: boolean }) => void;
	onCancel: () => void;
	onResolveToolApproval: (approval: ToolApprovalRequestedMessage, approved: boolean) => void;
}

/** Icon per composer mode; the copy itself lives in `chatModes.ts`. */
const MODE_ICONS: Record<ChatModeId, LucideIcon> = {
	chat: MessageSquare,
	agent: Zap,
	plan: ListChecks
};

/** Small suggestion prompts shown in the empty (welcome) state. */
const SUGGESTIONS: { text: string; icon: LucideIcon }[] = [
	{ text: 'Explain this code', icon: FileCode },
	{ text: 'Find bugs', icon: TriangleAlert },
	{ text: 'Write tests', icon: Check },
	{ text: 'Refactor this function', icon: Sparkles }
];

/** Icon per workspace tool, so the timeline reads at a glance. */
const TOOL_ICONS: Record<ChatToolName, LucideIcon> = {
	'read-file': FileCode,
	'check-workspace': FolderTree,
	'create-file': FilePlus,
	'edit-file': FilePen,
	'delete-file': Trash2,
	'run-command': Terminal
};

/** Recursively pull the plain text out of a (possibly nested) React subtree. */
function extractCodeFromChildren(children: unknown): string {
	if (typeof children === 'string' || typeof children === 'number') {
		return String(children);
	}
	if (Array.isArray(children)) {
		return children.map(extractCodeFromChildren).join('');
	}
	if (children && typeof children === 'object') {
		const el = children as { props?: { children?: unknown } };
		if (el.props?.children) {
			return extractCodeFromChildren(el.props.children);
		}
	}
	return '';
}

/** Find the code fence language (e.g. `language-js` → `js`) in a subtree. */
function extractCodeLanguage(children: unknown): string {
	if (Array.isArray(children)) {
		for (const child of children) {
			const lang = extractCodeLanguage(child);
			if (lang) {
				return lang;
			}
		}
		return '';
	}
	if (children && typeof children === 'object') {
		const el = children as {
			props?: {
				className?: string | string[] | undefined;
				node?: { properties?: { className?: string[] } };
			};
		};
		const cls = el.props?.className ?? el.props?.node?.properties?.className;
		const str = Array.isArray(cls) ? cls.join(' ') : String(cls ?? '');
		const m = /language-([\w.+-]+)/i.exec(str);
		return m ? m[1] : '';
	}
	return '';
}

/** Custom `react-markdown` renderers: fenced code blocks get a styled header + copy. */
const markdownComponents: Components = {
	pre(props) {
		const codeText = extractCodeFromChildren(props.children);
		const lang = extractCodeLanguage(props.children);
		return (
			<div className="code-card">
				<div className="code-card__head">
					<span className="code-card__lang">{lang || 'code'}</span>
					<button
						type="button"
						onClick={() => void navigator.clipboard?.writeText(codeText)}
						className="code-card__action"
					>
						<Copy aria-hidden="true" />
						<span>Copy</span>
					</button>
				</div>
				<pre dir="ltr" className="chat-code">
					{props.children}
				</pre>
			</div>
		);
	},
	code(props) {
		if (!props.className) {
			return <code className="code-inline">{props.children}</code>;
		}
		// Block code — styled by the wrapping `pre` renderer above.
		return <code className={String(props.className)}>{props.children}</code>;
	}
};

/** Minimal loose type for the lazily-loaded Markdown component. */
type MdComponent = { remarkPlugins?: unknown[]; children: string; components?: Components | null };

/** Markdown renderer — code blocks stay LTR via CSS; prose direction adapts to content. */
function MarkdownRenderer({ text }: { text: string }) {
	const [md, setMd] = useState<{ Comp: (p: MdComponent) => ReactNode; plugins: unknown[] } | null>(null);

	useEffect(() => {
		let alive = true;
		void (async () => {
			const Mod = await import('react-markdown');
			const gfm = await import('remark-gfm');
			if (alive) {
				setMd({ Comp: Mod.default as never, plugins: [gfm.default] });
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	const dir = detectDirection(text);

	if (!md) {
		// Fallback until the markdown modules are lazily loaded (single frame).
		return (
			<div dir={dir} className="md">
				{text}
			</div>
		);
	}
	return (
		<div dir={dir} className="md">
			<md.Comp remarkPlugins={md.plugins} components={markdownComponents}>
				{text}
			</md.Comp>
		</div>
	);
}
export function ChatView({ providers, messages, streaming, toolActivities, toolApprovals, onChangeMessages, onOpenSettings, onSend, onCancel, onResolveToolApproval }: ChatViewProps) {
	const [input, setInput] = useState('');
	const [lastPrompt, setLastPrompt] = useState<string | null>(null);
	const [selected, setSelected] = useState<{ p: string; m: string } | null>(null);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [autoApproveTools, setAutoApproveTools] = useState(false);
	const [mode, setMode] = useState<ChatModeId>('chat');
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const modelMenuRef = useRef<HTMLDivElement>(null);
	const toolbarRef = useRef<HTMLDivElement>(null);
	const modeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
	const [toolbarWidth, setToolbarWidth] = useState(0);
	// Sliding thumb geometry for the mode switcher (transform-only animation).
	const [thumb, setThumb] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

	const sorted = [...providers].sort(a => (a.hasApiKey ? -1 : 1));
	const target = selected && sorted.some(s => s.id === selected.p && s.model === selected.m)
		? sorted.find(s => s.id === selected.p && s.model === selected.m)!
		: sorted[0];
	const activeMode = getChatMode(mode);

	// Keep the composer growing smoothly when streaming.
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, toolActivities, toolApprovals]);

	// Close the model popover when clicking/tapping outside of it.
	useEffect(() => {
		if (!modelMenuOpen) {
			return;
		}
		const onPointerDown = (e: MouseEvent) => {
			if (!modelMenuRef.current?.contains(e.target as Node)) {
				setModelMenuOpen(false);
			}
		};
		document.addEventListener('mousedown', onPointerDown);
		return () => document.removeEventListener('mousedown', onPointerDown);
	}, [modelMenuOpen]);

	// Measure the active mode button so the thumb can slide to it. Re-measured on
	// resize because the switcher reflows with the sidebar width.
	useEffect(() => {
		const measure = () => {
			const el = modeRefs.current[mode];
			if (el) {
				setThumb({ left: el.offsetLeft, width: el.offsetWidth });
			}
		};
		measure();
		const ro = new ResizeObserver(measure);
		for (const el of Object.values(modeRefs.current)) {
			if (el) {
				ro.observe(el);
			}
		}
		return () => ro.disconnect();
	}, [mode]);

	// Track the toolbar width so labels can collapse to icons on narrow sidebars
	// and always stay inside the box on wide ones.
	useEffect(() => {
		const el = toolbarRef.current;
		if (!el) {
			return;
		}
		const update = () => setToolbarWidth(el.clientWidth);
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	/** Auto-grow the composer up to ~200px, then scroll. */
	const setInputHeight = () => {
		const el = inputRef.current;
		if (!el) {
			return;
		}
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	};

	const run = (history: ChatMessage[], promptText: string) => {
		const requestId = `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		setLastPrompt(promptText);
		onSend({
			providerId: target.id,
			model: target.model,
			messages: buildRequestMessages(mode, history, promptText),
			requestId,
			autoApproveTools
		});
	};

	const submit = (e?: FormEvent) => {
		e?.preventDefault();
		submitWith(input);
	};

	/** Send a prompt; the welcome chips reuse this to bypass the composer guard. */
	const submitWith = (rawText: string) => {
		const text = rawText.trim();
		if (!text || streaming || !target) {
			return;
		}
		const nextHistory = messages.concat({ role: 'user', content: text });
		onChangeMessages([...nextHistory, { role: 'assistant', content: '' }]);
		setInput('');
		setInputHeight();
		run(nextHistory, text);
	};

	const regenerate = () => {
		if (!lastPrompt || streaming) {
			return;
		}
		const base = messages.filter(m => m.role !== 'assistant');
		onChangeMessages([...base, { role: 'assistant', content: '' }]);
		run(base, lastPrompt);
	};

	const copy = (content: string) => {
		void navigator.clipboard?.writeText(content);
	};

	/** Clear the transcript. Cancels an in-flight stream first. */
	const newChat = () => {
		if (streaming) {
			onCancel();
		}
		onChangeMessages([]);
		setLastPrompt(null);
		setInput('');
		setInputHeight();
		inputRef.current?.focus();
	};

	const lastIndex = messages.length - 1;
	const showTyping = streaming && messages[lastIndex]?.role === 'assistant' && messages[lastIndex]?.content === '';

	// Responsive toolbar labels: on narrow sidebars show icons only, and on wider
	// ones progressively reveal the mode and model names while the CSS `truncate`
	// (with `min-w-0` parents) guarantees nothing ever overflows the box.
	const iconOnly = toolbarWidth > 0 && toolbarWidth < 300;
	const fullModel = !iconOnly && toolbarWidth >= 560;
	// Full label: "Provider · Model". Truncated label: just the model id.
	const modelLabel = target ? `${target.displayName} · ${target.model}` : 'Select a model';
	const modelShort = target ? target.model : 'Model';

	return (
		<div className="chat-shell">
			{/* Loom header: mark + wordmark, live status, quiet actions */}
			<header className="chat-topbar">
				<div className="chat-topbar__brand">
					<div className="chat-topbar__mark"><Bot aria-hidden="true" /></div>
					<div className="chat-topbar__text">
						<h1 className="chat-topbar__title">SkyCode</h1>
						<p className="chat-topbar__meta">
							<span
								className={`status-dot ${streaming ? 'status-dot--live' : target ? 'status-dot--ready' : 'status-dot--warn'}`}
								aria-hidden="true"
							/>
							<span className="truncate">
								{streaming ? 'Thinking…' : target ? `${activeMode.label} · ${target.model}` : 'No model'}
							</span>
						</p>
					</div>
				</div>
				<div className="chat-topbar__actions">
					<button
						type="button"
						title="New chat"
						aria-label="New chat"
						disabled={messages.length === 0}
						onClick={newChat}
						className="chat-icon-btn"
					>
						<Plus aria-hidden="true" />
					</button>
					<button
						type="button"
						title="Settings"
						aria-label="Open settings"
						onClick={onOpenSettings}
						className="chat-icon-btn"
					>
						<Settings aria-hidden="true" />
					</button>
				</div>
			</header>

			{/* Messages area */}
			<div className="chat-scroll">
				{messages.length === 0 ? (
					<div className="chat-welcome">
						{providers.length === 0 ? (
							<div className="chat-welcome__content">
								<div className="chat-mark"><Bot aria-hidden="true" /></div>
								<h2 className="chat-welcome__title">No provider configured</h2>
								<p className="chat-welcome__copy">
									Add a provider to start chatting with your models.
								</p>
								<button
									type="button"
									onClick={onOpenSettings}
									className="chat-primary-action"
								>
									Add a provider
								</button>
							</div>
						) : (
							<div className="chat-welcome__content">
								<div className="chat-mark"><Bot aria-hidden="true" /></div>
								<h2 className="chat-welcome__title">What are we working on?</h2>
								<p className="chat-welcome__copy">Ask SkyCode about the open workspace, or start with a quick task.</p>
								<div className="chat-suggestions">
									{SUGGESTIONS.map(({ text, icon: Icon }) => (
										<button
											key={text}
											type="button"
											onClick={() => submitWith(text)}
											className="chat-suggestion"
										>
											<Icon aria-hidden="true" />
											<span>{text}</span>
										</button>
									))}
								</div>
							</div>
						)}
					</div>
				) : (
					<div className="chat-transcript">
						{messages.map((m, i) =>
							m.role === 'user' ? (
								<div key={i} className="chat-message chat-message--user">
									<div
										dir={detectDirection(m.content)}
										className="chat-bubble chat-bubble--user"
									>
										{m.content}
									</div>
								</div>
							) : (
								<div key={i} className="chat-message chat-message--assistant">
									<div className="chat-assistant-mark"><Bot aria-hidden="true" /></div>
									<div className="chat-bubble chat-bubble--assistant">
										{m.content === '' && showTyping ? (
											<div className="chat-typing" role="status" aria-label="SkyCode is thinking">
												<span />
												<span />
												<span />
											</div>
										) : (
											<MarkdownRenderer text={m.content} />
										)}
										<div className="chat-message-actions">
											<button
												type="button"
												title="Copy"
												aria-label="Copy answer"
												disabled={!m.content}
												onClick={() => copy(m.content)}
												className="chat-message-action"
											>
												<Copy aria-hidden="true" />
											</button>
											{i === lastIndex && !streaming && (
												<button
													type="button"
													title="Regenerate"
													aria-label="Regenerate"
													onClick={regenerate}
													className="chat-message-action"
												>
													<RefreshCw aria-hidden="true" />
												</button>
											)}
										</div>
									</div>
								</div>
							)
						)}
						{toolActivities.length > 0 && (
							<div className="tool-timeline" aria-label="Tool activity">
								{toolActivities.map(activity => {
									const ToolIcon = TOOL_ICONS[activity.tool] ?? Wrench;
									const StatusIcon = activity.status === 'running' ? Loader : ToolIcon;
									return (
										<div key={activity.activityId} className={`tool-card tool-card--${activity.status}`}>
											<div className="tool-card__head">
												<span className="tool-card__icon" aria-hidden="true">
													<StatusIcon />
												</span>
												<span className="tool-card__name">{activity.tool}</span>
												<span className="tool-card__status">{activity.status}</span>
											</div>
											<div className="tool-card__body" aria-live="polite">
												<p>{activity.summary}</p>
												{activity.detail && <p className="tool-card__detail">{activity.detail}</p>}
											</div>
										</div>
									);
								})}
							</div>
						)}
						{toolApprovals.map(approval => (
							<div key={approval.approvalId} className="tool-approval" role="group" aria-label="Tool permission request">
								<div className="tool-approval__head">
									<ShieldQuestion aria-hidden="true" />
									<span>Permission needed</span>
								</div>
								<div className="tool-approval__body">
									<p>SkyCode wants to <strong>{approval.summary}</strong></p>
									<div className="tool-approval__actions">
										<button type="button" className="tool-action tool-action--allow" onClick={() => onResolveToolApproval(approval, true)}>
											<Check aria-hidden="true" />
											Allow once
										</button>
										<button type="button" className="tool-action" onClick={() => onResolveToolApproval(approval, false)}>
											<X aria-hidden="true" />
											Reject
										</button>
									</div>
								</div>
							</div>
						))}
						<div ref={messagesEndRef} />
					</div>
				)}
			</div>
{/* Input area */}
			<div className="chat-composer-area">
				<div className="chat-composer-wrap">
					{/* Mode switcher: Chat / Agent / Plan with a sliding thumb */}
					<div className="mode-switch" role="tablist" aria-label="Composer mode">
						<span
							className="mode-switch__thumb"
							aria-hidden="true"
							style={{ width: `${thumb.width}px`, transform: `translateX(${thumb.left}px)` }}
						/>
						{CHAT_MODES.map(({ id, label }) => {
							const Icon = MODE_ICONS[id];
							return (
								<button
									key={id}
									ref={el => {
										modeRefs.current[id] = el;
									}}
									type="button"
									role="tab"
									aria-selected={mode === id}
									onClick={() => setMode(id)}
									className={`mode-btn${mode === id ? ' is-active' : ''}`}
								>
									<Icon aria-hidden="true" />
									{!iconOnly && <span>{label}</span>}
								</button>
							);
						})}
					</div>

					<form
						onSubmit={submit}
						className="chat-composer"
					>
						{/* Composer textarea */}
						<textarea
							ref={inputRef}
							value={input}
							placeholder={activeMode.placeholder}
							rows={1}
							onChange={e => {
								setInput(e.target.value);
								setInputHeight();
							}}
							onKeyDown={e => {
								if (e.key === 'Enter' && !e.shiftKey) {
									e.preventDefault();
									submit();
								}
							}}
							className="chat-composer__input"
						/>

						{/* Toolbar */}
						<div ref={toolbarRef} className="chat-composer__toolbar">
							<div className="flex min-w-0 items-center gap-1">
								<button
									type="button"
									onClick={() => setAutoApproveTools(enabled => !enabled)}
									title={autoApproveTools ? 'Auto-approve tools is on' : 'Auto-approve tools is off'}
									aria-label={autoApproveTools ? 'Disable auto-approve tools' : 'Enable auto-approve tools'}
									aria-pressed={autoApproveTools}
									className={`composer-tool composer-tool--approval${autoApproveTools ? ' is-active' : ''}`}
								>
									{autoApproveTools ? <ShieldCheck className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
									{!iconOnly && <span>Auto approve</span>}
								</button>

								{/* Model selector (popover anchor) */}
								<div className="relative min-w-0" ref={modelMenuRef}>
									<button
										type="button"
										onClick={() => setModelMenuOpen(o => !o)}
										aria-haspopup="menu"
										aria-expanded={modelMenuOpen}
										title={modelLabel}
										className="composer-tool composer-tool--model"
									>
										<span
											className={`status-dot ${target ? 'status-dot--ready' : 'status-dot--warn'}`}
											aria-hidden="true"
										/>
										{!iconOnly && (
											<span className="truncate">
												{fullModel ? modelLabel : modelShort}
											</span>
										)}
										<ChevronDown className="h-3 w-3 shrink-0" />
									</button>
									{modelMenuOpen && (
										<ModelSelectorPopover
											targets={sorted}
											current={target}
											onSelect={t => setSelected({ p: t.id, m: t.model })}
											onClose={() => setModelMenuOpen(false)}
										/>
									)}
								</div>
							</div>

							<div className="flex shrink-0 items-center gap-1">
								<button
									type={streaming ? 'button' : 'submit'}
									title={streaming ? 'Cancel response' : !target ? 'Select a provider first' : 'Send'}
									aria-label={streaming ? 'Cancel response' : 'Send message'}
									disabled={!streaming && (!input.trim() || !target)}
									className={`composer-send${streaming ? ' composer-send--cancel' : ''}`}
									onClick={streaming ? onCancel : undefined}
								>
									{streaming ? <Square className="h-3 w-3" /> : <ArrowUp className="h-3.5 w-3.5" />}
								</button>
							</div>
						</div>
					</form>

					<p className="chat-composer__hint">
						Enter to send · Shift+Enter for new line
					</p>
				</div>
			</div>
		</div>
	);
}

/** Merge a streaming delta into the trailing assistant slot and return the new list. */
export function applyChatDelta(
	prev: ChatMessage[],
	r: { requestId: string; text: string; error?: string }
): ChatMessage[] {
	const list = prev.slice();
	const idx = list.length - 1;
	if (list.length === 0 || list[idx].role !== 'assistant') {
		return [...prev, { role: 'assistant', content: r.error ? `⚠ ${r.error}` : r.text }];
	}
	const content = r.error && !list[idx].content ? `⚠ ${r.error}` : list[idx].content + (r.error ? '' : r.text);
	return [...list.slice(0, idx), { role: 'assistant', content }];
}
