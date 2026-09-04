import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ChatMessageInput } from '../core/types';

const MAX_STEPS = 8;
const MAX_OUTPUT_CHARS = 12_000;

type ToolName = 'read-file' | 'check-workspace' | 'edit-file' | 'delete-file' | 'run-command';

interface ToolCall {
	type: 'tool';
	name: ToolName;
	arguments: Record<string, unknown>;
}

interface FinalReply {
	type: 'final';
	content: string;
}

const AGENT_INSTRUCTIONS = `You are SkyCode, a coding assistant with workspace tools.
You must respond with JSON only, never Markdown or explanations outside JSON.
To use one tool, respond exactly with {"type":"tool","name":"TOOL_NAME","arguments":{...}}.
Available tools:
- read-file: {"path":"relative/file.ts","startLine":1,"endLine":120}
- check-workspace: {}
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
		private readonly output: vscode.OutputChannel
	) {}

	async run(messages: ChatMessageInput[], autoApprove: boolean, signal: AbortSignal): Promise<string> {
		const turns: ChatMessageInput[] = [{ role: 'system', content: AGENT_INSTRUCTIONS }, ...messages];
		for (let step = 0; step < MAX_STEPS; step++) {
			if (signal.aborted) {
				return '';
			}
			const raw = await this.complete(turns, signal);
			const action = parseAgentResponse(raw);
			if (!action) {
				return raw;
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
		try {
			switch (call.name) {
				case 'read-file':
					return this.readFile(call.arguments);
				case 'check-workspace':
					return this.checkWorkspace();
				case 'edit-file':
					if (!(await this.approve(call, autoApprove))) {
						return 'Denied by user.';
					}
					return this.editFile(call.arguments);
				case 'delete-file':
					if (!(await this.approve(call, autoApprove))) {
						return 'Denied by user.';
					}
					return this.deleteFile(call.arguments);
				case 'run-command':
					if (!(await this.approve(call, autoApprove))) {
						return 'Denied by user.';
					}
					return this.runCommand(call.arguments, signal);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`Tool ${call.name} failed: ${message}`);
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

	private async approve(call: ToolCall, autoApprove: boolean): Promise<boolean> {
		if (autoApprove) {
			return true;
		}
		const detail = call.name === 'run-command'
			? stringArg(call.arguments, 'command')
			: stringArg(call.arguments, 'path');
		const choice = await vscode.window.showWarningMessage(
			`SkyCode wants to ${call.name}: ${detail}`,
			{ modal: true },
			'Allow once'
		);
		return choice === 'Allow once';
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

function parseAgentResponse(raw: string): ToolCall | FinalReply | undefined {
	const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	try {
		const response = JSON.parse(cleaned) as {
			type?: unknown;
			name?: unknown;
			arguments?: unknown;
			content?: unknown;
		};
		if (response.type === 'final' && typeof response.content === 'string') {
			return { type: 'final', content: response.content };
		}
		if (response.type === 'tool' && isToolName(response.name) && response.arguments && typeof response.arguments === 'object' && !Array.isArray(response.arguments)) {
			return { type: 'tool', name: response.name, arguments: response.arguments as Record<string, unknown> };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function isToolName(value: unknown): value is ToolName {
	return value === 'read-file' || value === 'check-workspace' || value === 'edit-file' || value === 'delete-file' || value === 'run-command';
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
