import * as vscode from 'vscode';

const MAX_FILE_CHARS = 24_000;
const MAX_DIAGNOSTICS = 12;
const MAX_EDITS = 8;

export interface NextEditRequest {
	fileName: string;
	languageId: string;
	content: string;
	diagnostics: readonly vscode.Diagnostic[];
	intent: 'fix-errors' | 'next-edit';
}

export interface TextReplacement {
	oldText: string;
	newText: string;
}

/** Prompt contract for safe file-level edit suggestions. */
export function buildNextEditPrompt(request: NextEditRequest): string {
	const diagnostics = request.diagnostics
		.filter(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error)
		.slice(0, MAX_DIAGNOSTICS)
		.map(diagnostic => `- L${diagnostic.range.start.line + 1}: ${diagnostic.message}`)
		.join('\n') || '(no compiler errors reported)';
	const intent = request.intent === 'fix-errors'
		? 'Fix the reported errors with the smallest correct changes.'
		: 'Suggest the single most valuable next edit: complete an obvious TODO/comment/stub, or improve an incomplete implementation implied by the file name and code.';

	return [
		'You are a precise code-edit suggestion engine.',
		intent,
		'Use only facts present in this file and its diagnostics. Do not invent APIs, files, dependencies, exports, or behavior.',
		'Output JSON only. No Markdown, prose, or code fences.',
		`The JSON schema is {"edits":[{"oldText":"exact existing text","newText":"replacement"}]}.`,
		'Each oldText must be a unique, non-empty exact substring of FILE_CONTENT. Keep indentation and line endings appropriate.',
		`Return at most ${MAX_EDITS} edits. Return {"edits":[]} if no safe edit exists.`,
		'',
		`FILE: ${request.fileName}`,
		`LANGUAGE: ${request.languageId}`,
		`DIAGNOSTICS:\n${diagnostics}`,
		'FILE_CONTENT:',
		clipFile(request.content)
	].join('\n');
}

export function parseNextEdits(raw: string, original: string): TextReplacement[] | undefined {
	const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		return undefined;
	}
	const candidate = parsed as { edits?: unknown };
	if (!Array.isArray(candidate.edits) || candidate.edits.length > MAX_EDITS) {
		return undefined;
	}
	const edits: TextReplacement[] = [];
	for (const value of candidate.edits) {
		const edit = value as Partial<TextReplacement>;
		if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string' || !edit.oldText) {
			return undefined;
		}
		if (countOccurrences(original, edit.oldText) !== 1) {
			return undefined;
		}
		edits.push({ oldText: edit.oldText, newText: edit.newText });
	}
	return edits;
}

export function applyNextEdits(original: string, edits: TextReplacement[]): string | undefined {
	const located = edits.map(edit => ({ ...edit, index: original.indexOf(edit.oldText) }));
	if (located.some(edit => edit.index < 0)) {
		return undefined;
	}
	located.sort((left, right) => right.index - left.index);
	for (let i = 0; i < located.length - 1; i++) {
		const current = located[i];
		const following = located[i + 1];
		if (following.index + following.oldText.length > current.index) {
			return undefined;
		}
	}
	return located.reduce((content, edit) =>
		`${content.slice(0, edit.index)}${edit.newText}${content.slice(edit.index + edit.oldText.length)}`, original);
}

function clipFile(content: string): string {
	if (content.length <= MAX_FILE_CHARS) {
		return content;
	}
	const head = Math.floor(MAX_FILE_CHARS * 0.7);
	const tail = MAX_FILE_CHARS - head;
	return `${content.slice(0, head)}\n\n/* SkyCode: middle of file omitted for context budget */\n\n${content.slice(-tail)}`;
}

function countOccurrences(content: string, search: string): number {
	let count = 0;
	let index = 0;
	while ((index = content.indexOf(search, index)) !== -1) {
		count++;
		index += search.length;
	}
	return count;
}
