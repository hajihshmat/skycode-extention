import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ChatMessageInput } from '../core/types';
import { ChatToolName } from '../settings/types';

const MAX_STEPS = 8;
const MAX_OUTPUT_CHARS = 12_000;

export type ToolName = ChatToolName;

interface ToolCall {
	type: 'tool';
	name: ToolName;
	arguments: Record<string, unknown>;
}

interface FinalReply {
	type: 'final';
	content: string;
}

export interface ToolAgentEvents {
	activity?: (event: { activityId: string; tool: ToolName; summary: string; status: 'waiting' | 'running' | 'complete' | 'failed'; detail?: string }) => void;
	requestApproval?: (call: ToolCall, summary: string, signal: AbortSignal) => Promise<boolean>;
}

const AGENT_INSTRUCTIONS = `You are SkyCode, a coding assistant with workspace tools.
You must respond with JSON only, never Markdown or explanations outside JSON.
To use one tool, respond exactly with {"type":"tool","name":"TOOL_NAME","arguments":{...}}.
Available tools:
- read-file: {"path":"relative/file.ts","startLine":1,"endLine":120}
- check-workspace: {}
- create-file: {"path":"relative/new-file.ts","content":"complete file contents"}; only for a new file.
- edit-file: {"path":"relative/file.ts","startLine":1,"endLine":1,"content":"replacement text"}; replaces inclusive lines.
- delete-file: {"path":"relative/file.ts"}
- run-command: {"command":"npm test","cwd":"relative/optional"}
Paths must be relative to the workspace. Use read-file before edit-file when you need exact context. Never delete or run a command unless it is necessary.
After tool results, either call another tool or finish with {"type":"final","content":"your concise user-facing answer"}.
If no tool is needed, finish with a final reply.`;

/** Executes a small, approval-gated tool loop around the configured chat model. */
export class ChatToolAgent {
	constructor(
		private readonly complete: (messages: ChatMessageInput[], signal: AbortSignal) => Promise<string>,
		private readonly output: vscode.OutputChannel,
		private readonly events: ToolAgentEvents = {}
	) {}

	async run(messages: ChatMessageInput[], autoApprove: boolean, signal: AbortSignal): Promise<string> {
		const turns: ChatMessageInput[] = [{ role: 'system', content: AGENT_INSTRUCTIONS }, ...messages];
		for (let step = 0; step < MAX_STEPS; step++) {
			if (signal.aborted) {
				return '';
			}
			let raw = await this.complete(turns, signal);
			let action = parseAgentResponse(raw);
			if (!action && !signal.aborted) {
				// Models sometimes wrap the JSON in <think>…</think>, prose, or get
				// cut off by token limits. One repair turn beats showing raw junk.
				const preview = stripThinking(raw).slice(0, 200);
				this.output.appendLine(`[chat-agent] unparseable reply (len=${raw.length}): ${preview || '<empty>'}`);
				raw = await this.complete(
					[
						...turns,
						{ role: 'assistant', content: raw.slice(0, 4_000) },
						{
							role: 'user',
							content:
								'Your previous reply was not valid tool JSON (it may have been cut off or contained extra text). Respond again with exactly one JSON object: {"type":"tool","name":"TOOL_NAME","arguments":{...}} or {"type":"final","content":"…"} — no other text.'
						}
					],
					signal
				);
				action = parseAgentResponse(raw);
			}
			if (!action) {
				const cleaned = stripThinking(raw).trim();
				return cleaned || 'The model returned an empty reply. Please try again.';
			}
			if (action.type === 'final') {
				return action.content;
			}

			const result = await this.execute(action, autoApprove, signal);
			turns.push({ role: 'assistant', content: raw });
			turns.push({ role: 'user', content: `TOOL_RESULT for ${action.name}:\n${result}\nContinue with JSON only.` });
		}
		return 'I stopped after the maximum number of tool steps. Please narrow the task and try again.';
	}

	private async execute(call: ToolCall, autoApprove: boolean, signal: AbortSignal): Promise<string> {
		const activityId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const summary = toolSummary(call);
		this.events.activity?.({ activityId, tool: call.name, summary, status: 'running' });
		try {
			let result: string;
			switch (call.name) {
				case 'read-file':
					result = await this.readFile(call.arguments);
					break;
				case 'check-workspace':
					result = await this.checkWorkspace();
					break;
				case 'create-file':
					if (!(await this.approve(call, autoApprove, activityId, summary, signal))) {
						result = 'Denied by user.';
						break;
					}
					result = await this.createFile(call.arguments);
					break;
				case 'edit-file':
					if (!(await this.approve(call, autoApprove, activityId, summary, signal))) {
						result = 'Denied by user.';
						break;
					}
					result = await this.editFile(call.arguments);
					break;
				case 'delete-file':
					if (!(await this.approve(call, autoApprove, activityId, summary, signal))) {
						result = 'Denied by user.';
						break;
					}
					result = await this.deleteFile(call.arguments);
					break;
				case 'run-command':
					if (!(await this.approve(call, autoApprove, activityId, summary, signal))) {
						result = 'Denied by user.';
						break;
					}
					result = await this.runCommand(call.arguments, signal);
					break;
			}
			this.events.activity?.({ activityId, tool: call.name, summary, status: 'complete', detail: shortDetail(result) });
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`Tool ${call.name} failed: ${message}`);
			this.events.activity?.({ activityId, tool: call.name, summary, status: 'failed', detail: message });
			return `Tool failed: ${message}`;
		}
	}

	private async readFile(args: Record<string, unknown>): Promise<string> {
		const uri = this.workspaceFile(stringArg(args, 'path'));
		const document = await vscode.workspace.openTextDocument(uri);
		const startLine = positiveInt(args.startLine, 1) - 1;
		const endLine = Math.min(positiveInt(args.endLine, startLine + 101), document.lineCount) - 1;
		if (startLine >= document.lineCount || endLine < startLine) {
			throw new Error('Requested line range is outside the file.');
		}
		const lines: string[] = [];
		for (let line = startLine; line <= endLine; line++) {
			lines.push(`${line + 1}: ${document.lineAt(line).text}`);
		}
		return clip(lines.join('\n'));
	}

	private async checkWorkspace(): Promise<string> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			return 'No workspace folder is open.';
		}
		const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out,media}/**', 120);
		return clip(files.map(file => vscode.workspace.asRelativePath(file, false)).join('\n') || 'Workspace has no matching files.');
	}

	private async editFile(args: Record<string, unknown>): Promise<string> {
		const uri = this.workspaceFile(stringArg(args, 'path'));
		const document = await vscode.workspace.openTextDocument(uri);
		const startLine = positiveInt(args.startLine, 1) - 1;
		const endLine = positiveInt(args.endLine, startLine + 1) - 1;
		const content = stringArg(args, 'content');
		if (startLine > endLine || endLine >= document.lineCount) {
			throw new Error('Requested line range is outside the file.');
		}
		const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, range, content);
		if (!(await vscode.workspace.applyEdit(edit))) {
			throw new Error('VS Code rejected the file edit.');
		}
		return `Edited ${vscode.workspace.asRelativePath(uri, false)} lines ${startLine + 1}-${endLine + 1}.`;
	}

	private async createFile(args: Record<string, unknown>): Promise<string> {
		const relativePath = stringArg(args, 'path');
		const uri = this.workspaceFile(relativePath);
		try {
			await vscode.workspace.fs.stat(uri);
			throw new Error('The file already exists. Use edit-file instead.');
		} catch (error) {
			if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
				throw error;
			}
		}
		const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.workspaceFolder().uri, ...segments.slice(0, -1)));
		await vscode.workspace.fs.writeFile(uri, Buffer.from(stringArg(args, 'content'), 'utf8'));
		return `Created ${vscode.workspace.asRelativePath(uri, false)}.`;
	}

	private async deleteFile(args: Record<string, unknown>): Promise<string> {
		const uri = this.workspaceFile(stringArg(args, 'path'));
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.type !== vscode.FileType.File) {
			throw new Error('Only individual files can be deleted.');
		}
		await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
		return `Moved ${vscode.workspace.asRelativePath(uri, false)} to the trash.`;
	}

	private async runCommand(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		const command = stringArg(args, 'command');
		const root = this.workspaceFolder();
		const cwd = args.cwd === undefined ? root.uri.fsPath : this.workspaceFile(stringArg(args, 'cwd')).fsPath;
		return new Promise((resolve, reject) => {
			const child = exec(command, { cwd, timeout: 120_000, maxBuffer: MAX_OUTPUT_CHARS, windowsHide: true }, (error, stdout, stderr) => {
				if (error && !signal.aborted) {
					resolve(clip(`Exit error: ${error.message}\n${stdout}\n${stderr}`));
					return;
				}
				if (signal.aborted) {
					reject(new Error('Command cancelled.'));
					return;
				}
				resolve(clip(`${stdout}\n${stderr}`.trim() || 'Command completed with no output.'));
			});
			const cancel = () => child.kill();
			signal.addEventListener('abort', cancel, { once: true });
		});
	}

	private async approve(call: ToolCall, autoApprove: boolean, activityId: string, summary: string, signal: AbortSignal): Promise<boolean> {
		if (autoApprove) {
			return true;
		}
		this.events.activity?.({ activityId, tool: call.name, summary, status: 'waiting' });
		const approved = await this.events.requestApproval?.(call, summary, signal);
		if (approved) {
			this.events.activity?.({ activityId, tool: call.name, summary, status: 'running' });
		}
		return approved === true;
	}

	private workspaceFolder(): vscode.WorkspaceFolder {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			throw new Error('Open a workspace folder before using file or command tools.');
		}
		return folder;
	}

	private workspaceFile(relativePath: string): vscode.Uri {
		const normalized = relativePath.replace(/\\/g, '/');
		if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
			throw new Error('Tool paths must be non-empty paths relative to the workspace.');
		}
		return vscode.Uri.joinPath(this.workspaceFolder().uri, ...normalized.split('/').filter(Boolean));
	}
}

/** Parse a model reply into a tool call or a final answer. Exported for tests. */
export function parseAgentResponse(raw: string): ToolCall | FinalReply | undefined {
	const cleaned = extractJson(raw);
	if (!cleaned) {
		return undefined;
	}
	try {
		const response = JSON.parse(cleaned) as {
			type?: unknown;
			name?: unknown;
			tool?: unknown;
			arguments?: unknown;
			content?: unknown;
		};
		if (response.type === 'final' && typeof response.content === 'string') {
			return { type: 'final', content: response.content };
		}
		const name = response.name ?? response.tool;
		if (isToolName(name) && response.arguments && typeof response.arguments === 'object' && !Array.isArray(response.arguments)) {
			return { type: 'tool', name, arguments: response.arguments as Record<string, unknown> };
		}
		// Some models drop "type" and emit the tool call as {"tool":"...","arguments":{...}}.
		if (response.type === undefined && typeof response.content === 'string' && !isToolName(name)) {
			return { type: 'final', content: response.content };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Remove reasoning-model `<think>…</think>` blocks before parsing. */
export function stripThinking(raw: string): string {
	return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
}

/**
 * Pull the first balanced JSON object out of a reply. Models routinely wrap
 * tool JSON in prose or code fences, and truncation can leave it unterminated —
 * a plain `JSON.parse(trim)` fails on all of those.
 */
export function extractJson(raw: string): string | undefined {
	const text = stripThinking(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
	const start = text.indexOf('{');
	if (start < 0) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	return undefined;
}


function isToolName(value: unknown): value is ToolName {
	return value === 'read-file' || value === 'check-workspace' || value === 'create-file' || value === 'edit-file' || value === 'delete-file' || value === 'run-command';
}

function toolSummary(call: ToolCall): string {
	if (call.name === 'check-workspace') {
		return 'Inspect workspace files';
	}
	if (call.name === 'run-command') {
		return `Run ${stringArg(call.arguments, 'command').replace(/\s+/g, ' ').slice(0, 140)}`;
	}
	const path = stringArg(call.arguments, 'path');
	if (call.name === 'edit-file') {
		return `Edit ${path} (lines ${positiveInt(call.arguments.startLine, 1)}–${positiveInt(call.arguments.endLine, 1)})`;
	}
	return `${call.name.replace('-', ' ')} ${path}`;
}

function shortDetail(value: string): string {
	return value.replace(/\s+/g, ' ').slice(0, 180);
}

function stringArg(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`Tool argument "${key}" must be a non-empty string.`);
	}
	return value;
}

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function clip(value: string): string {
	return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n… output clipped` : value;
}
