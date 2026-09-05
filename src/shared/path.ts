/**
 * Normalize a zip/entry path to forward slashes.
 * Pure and allocation-minimal: fast path when no backslash is present.
 */
export function normalizePath(path: string): string {
	if (path.indexOf("\\") === -1) return path;
	return path.replace(/\\/g, "/");
}

/**
 * Sanitize a zip entry path against Zip-Slip / absolute-path attacks.
 * Returns the normalized safe relative path, or `null` when the entry
 * must be rejected (absolute path, drive letter, NUL byte, `..` escape).
 *
 * Rules (observable-safe):
 * - Backslashes become `/` (same as {@link normalizePath}).
 * - Rejects NUL bytes, drive letters (`C:`), leading `/`, and any `..`
 *   segment after resolving `.`/`..` lexically.
 * - Collapses duplicate `/`, strips leading `./`, drops trailing `/`
 *   handling is left to callers (they skip directory entries).
 */
export function sanitizeZipPath(rawPath: string): string | null {
	if (rawPath.indexOf("\0") !== -1) return null;
	const p = normalizePath(rawPath);
	// Absolute paths (posix or windows) are never safe inside a zip.
	if (p.startsWith("/") || p.startsWith("\\")) return null;
	// Windows drive letter, e.g. "C:/..." or "C:...".
	if (/^[A-Za-z]:/.test(p)) return null;

	const parts = p.split("/");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (stack.length === 0) return null;
			stack.pop();
			continue;
		}
		stack.push(part);
	}
	if (stack.length === 0) return null;
	// Prototype-pollution guard: a top-level "__proto__"/"constructor"/
	// "prototype" entry would mutate the FileMap prototype on `out[p] = ...`.
	// Such names are never valid pack files, so reject them centrally.
	if (
		stack.length === 1 &&
		(stack[0] === "__proto__" || stack[0] === "constructor" || stack[0] === "prototype")
	) {
		return null;
	}
	return stack.join("/");
}