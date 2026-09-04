import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowUp, Bot, ChevronDown, Copy, MessageSquare, Paperclip, RefreshCw } from 'lucide-react';
import type { Components } from 'react-markdown' with { 'resolution-mode': 'import' };
import { detectDirection } from './utils/textDirection';
import { ModelSelectorPopover } from './ModelSelectorPopover';

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
	onChangeMessages: (next: ChatMessage[]) => void;
	onOpenSettings: () => void;
	onSend: (track: { providerId: string; model: string; messages: ChatMessage[]; requestId: string }) => void;
}

/** Small suggestion prompts shown in the empty (welcome) state. */
const SUGGESTIONS = ['Explain this code', 'Find bugs', 'Write tests', 'Refactor this function'];

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
			<div className="group/code relative my-3 overflow-hidden rounded-lg border border-[var(--vscode-textCodeBlock-background)]">
				<div className="flex items-center justify-between bg-[var(--vscode-textCodeBlock-background)] px-3 py-1.5 text-xs text-[var(--vscode-descriptionForeground)]">
					<span className="font-medium">{lang || 'code'}</span>
					<button
						type="button"
						onClick={() => void navigator.clipboard?.writeText(codeText)}
						className="flex items-center gap-1 rounded px-2 py-0.5 transition-colors hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
					>
						<Copy className="h-3 w-3" />
						<span>Copy</span>
					</button>
				</div>
				<pre dir="ltr" className="chat-code m-0 overflow-x-auto bg-[var(--vscode-textCodeBlock-background)] px-4 py-3 leading-relaxed">
					{props.children}
				</pre>
			</div>
		);
	},
	code(props) {
		if (!props.className) {
			return (
				<code className="rounded bg-[var(--vscode-textCodeBlock-background)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--vscode-textPreformat-foreground)]">
					{props.children}
				</code>
			);
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
export function ChatView({ providers, messages, streaming, onChangeMessages, onOpenSettings, onSend }: ChatViewProps) {
	const [input, setInput] = useState('');
	const [lastPrompt, setLastPrompt] = useState<string | null>(null);
	const [selected, setSelected] = useState<{ p: string; m: string } | null>(null);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const modelMenuRef = useRef<HTMLDivElement>(null);
	const toolbarRef = useRef<HTMLDivElement>(null);
	const [toolbarWidth, setToolbarWidth] = useState(0);

	const sorted = [...providers].sort(a => (a.hasApiKey ? -1 : 1));
	const target = selected && sorted.some(s => s.id === selected.p && s.model === selected.m)
		? sorted.find(s => s.id === selected.p && s.model === selected.m)!
		: sorted[0];

	// Keep the composer growing smoothly when streaming.
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages]);

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
			messages: [...history, { role: 'user', content: promptText }],
			requestId
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
									{SUGGESTIONS.map(s => (
										<button
											key={s}
											type="button"
											onClick={() => submitWith(s)}
											className="chat-suggestion"
										>
											{s}
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
											<div className="flex gap-1.5 py-1" aria-label="AI is thinking">
												<span
													className="h-2 w-2 animate-bounce rounded-full bg-[var(--vscode-descriptionForeground)]"
													style={{ animationDelay: '0ms' }}
												/>
												<span
													className="h-2 w-2 animate-bounce rounded-full bg-[var(--vscode-descriptionForeground)]"
													style={{ animationDelay: '150ms' }}
												/>
												<span
													className="h-2 w-2 animate-bounce rounded-full bg-[var(--vscode-descriptionForeground)]"
													style={{ animationDelay: '300ms' }}
												/>
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
												className="rounded-md p-1.5 text-[var(--vscode-descriptionForeground)] transition-colors hover:bg-[var(--vscode-list-hoverBackground)] hover:text-[var(--vscode-foreground)] disabled:pointer-events-none disabled:opacity-50"
											>
												<Copy className="h-4 w-4" />
											</button>
											{i === lastIndex && !streaming && (
												<button
													type="button"
													title="Regenerate"
													aria-label="Regenerate"
													onClick={regenerate}
													className="rounded-md p-1.5 text-[var(--vscode-descriptionForeground)] transition-colors hover:bg-[var(--vscode-list-hoverBackground)] hover:text-[var(--vscode-foreground)]"
												>
													<RefreshCw className="h-4 w-4" />
												</button>
											)}
										</div>
									</div>
								</div>
							)
						)}
						<div ref={messagesEndRef} />
					</div>
				)}
			</div>
{/* Input area */}
			<div className="chat-composer-area">
				<div className="chat-composer-wrap">
					<form
						onSubmit={submit}
						className="chat-composer"
					>
						{/* Composer textarea */}
						<textarea
							ref={inputRef}
							value={input}
							placeholder="Message…"
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
									title="Attach (coming soon)"
									aria-label="Attach file"
									className="composer-tool"
								>
									<Paperclip className="h-3.5 w-3.5" />
								</button>

								<button
									type="button"
									title="Chat"
									className="composer-tool"
								>
									<MessageSquare className="h-3.5 w-3.5" />
									{!iconOnly && <span>Chat</span>}
									<ChevronDown className="h-3 w-3" />
								</button>

								{/* Model selector (popover anchor) */}
								<div className="relative min-w-0" ref={modelMenuRef}>
									<button
										type="button"
										onClick={() => setModelMenuOpen(o => !o)}
										className="composer-tool composer-tool--model"
									>
										<Bot className="h-3.5 w-3.5 shrink-0" />
										{!iconOnly && (
											<span className="truncate" title={fullModel ? undefined : modelLabel}>
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
									type="submit"
									title={streaming ? 'Sending…' : !target ? 'Select a provider first' : 'Send'}
									aria-label="Send message"
									disabled={streaming || !input.trim() || !target}
									className="composer-send"
								>
									{streaming ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
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
	const content = list[idx].content + (r.error ? '' : r.text);
	return [...list.slice(0, idx), { role: 'assistant', content }];
}
