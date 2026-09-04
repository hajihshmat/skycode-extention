import * as vscode from 'vscode';

export interface CodeContext {
	languageId: string;
	fileName: string;
	linePrefix: string;
	lineSuffix: string;
	nearbyCode: string;
	imports: string[];
	symbols: string[];
}

const MAX_NEARBY_LINES = 48;
const MAX_IMPORTS = 40;
const MAX_SYMBOLS = 120;
const MAX_NEARBY_CHARS = 8_000;
const MAX_INDEX_LINE_CHARS = 360;

/**
 * Extracts local, privacy-bounded completion context from the active document.
 * It intentionally does not read other workspace files.
 */
export function indexCurrentDocument(document: vscode.TextDocument, position: vscode.Position): CodeContext {
	const lines = document.getText().split(/\r?\n/);
	const line = lines[position.line] ?? '';
	const start = Math.max(0, position.line - Math.floor(MAX_NEARBY_LINES * 0.65));
	const end = Math.min(lines.length, position.line + Math.ceil(MAX_NEARBY_LINES * 0.35) + 1);

	return {
		languageId: document.languageId,
		fileName: vscode.workspace.asRelativePath(document.uri, false),
		linePrefix: line.slice(0, position.character),
		lineSuffix: line.slice(position.character),
		nearbyCode: clip(lines.slice(start, end).join('\n'), MAX_NEARBY_CHARS),
		imports: collect(lines, importPattern, MAX_IMPORTS),
		symbols: collect(lines, symbolPattern, MAX_SYMBOLS)
	};
}

const importPattern = /^\s*(?:import\b.*|export\s+.*\s+from\b.*|(?:const|let|var)\s+\w+\s*=\s*require\b.*|from\s+[\w.]+\s+import\b.*)$/;
const symbolPattern = /^\s*(?:(?:export|default|public|private|protected|static|async|abstract|declare)\s+)*(?:class|interface|type|enum|function|def|fn|struct|trait|impl|namespace|module)\s+([A-Za-z_$][\w$]*)|^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^={]+)?\s*\{/;

function collect(lines: string[], pattern: RegExp, limit: number): string[] {
	const values: string[] = [];
	for (const line of lines) {
		if (!pattern.test(line)) {
			continue;
		}
		const value = clip(line.trim(), MAX_INDEX_LINE_CHARS);
		if (value && !values.includes(value)) {
			values.push(value);
		}
		if (values.length >= limit) {
			break;
		}
	}
	return values;
}

function clip(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
