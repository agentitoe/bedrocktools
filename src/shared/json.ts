/**
 * Strip `//` line comments and `/*` block comments from JSON text,
 * preserving comment markers inside strings. Single-pass O(n) using a
 * chunk buffer + push/join (avoids O(n²) `+=` on large manifests).
 * A line comment ends at `\n` or `\r` (the terminator is preserved).
 */
export function stripJsonComments(text: string): string {
	const out: string[] = [];
	const len = text.length;
	let chunkStart = 0;
	let inString = false;
	let inBlockComment = false;
	let inLineComment = false;

	/** Flush text[chunkStart..end) into the buffer. */
	const flush = (end: number): void => {
		if (end > chunkStart) out.push(text.slice(chunkStart, end));
	};

	let i = 0;
	while (i < len) {
		const c = text[i];
		const next = i + 1 < len ? text[i + 1] : "";

		if (inBlockComment) {
			if (c === "*" && next === "/") {
				inBlockComment = false;
				i += 2;
				chunkStart = i;
			} else {
				i++;
			}
			continue;
		}
		if (inLineComment) {
			if (c === "\n" || c === "\r") {
				inLineComment = false;
				// Preserve the terminator; resume normal scanning from here.
				chunkStart = i;
				continue;
			}
			i++;
			continue;
		}
		if (inString) {
			if (c === "\\") {
				// Keep the escape pair verbatim.
				i += 2;
				continue;
			}
			if (c === '"') {
				inString = false;
			}
			i++;
			continue;
		}

		if (c === '"') {
			inString = true;
			i++;
		} else if (c === "/" && next === "*") {
			flush(i);
			inBlockComment = true;
			i += 2;
			chunkStart = i;
		} else if (c === "/" && next === "/") {
			flush(i);
			inLineComment = true;
			i += 2;
			chunkStart = i;
		} else {
			i++;
		}
	}

	if (!inBlockComment && !inLineComment) {
		flush(len);
	}
	// If the input ends inside an unterminated block/line comment there is
	// nothing more to flush; the comment tail is already excluded.

	return out.join("").trim();
}