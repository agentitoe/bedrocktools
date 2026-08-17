export function stripJsonComments(text: string): string {
	let result = "";
	let inString = false;
	let inBlockComment = false;
	let inLineComment = false;

	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const next = text[i + 1];

		if (inBlockComment) {
			if (c === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inLineComment) {
			if (c === "\n") {
				inLineComment = false;
				result += c;
			}
			continue;
		}
		if (inString) {
			result += c;
			if (c === "\\") {
				result += next ?? "";
				i++;
			} else if (c === '"') {
				inString = false;
			}
			continue;
		}

		if (c === '"') {
			inString = true;
			result += c;
		} else if (c === "/" && next === "*") {
			inBlockComment = true;
			i++;
		} else if (c === "/" && next === "/") {
			inLineComment = true;
			i++;
		} else {
			result += c;
		}
	}

	return result.trim();
}