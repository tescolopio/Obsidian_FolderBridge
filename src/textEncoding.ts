/**
 * Decoding of text files on local mounts.
 *
 * Obsidian edits notes as UTF-8. Notes on shared drives are sometimes stored
 * in an older encoding instead: Windows-1252 ("ANSI") from older Windows
 * tools, or UTF-16 with a byte-order mark. Reading those as UTF-8 turns
 * characters such as £ € é into U+FFFD, and saving that text back would
 * replace the original bytes for good. So such files are decoded with their
 * real encoding (readable in Obsidian) and flagged, and saving them is refused.
 */

export interface DecodedText {
	text: string;
	/** Not valid UTF-8: decoded for reading, but a UTF-8 save would change its characters. */
	nonUtf8: boolean;
}

// ignoreBOM keeps a UTF-8 byte-order mark in the text, exactly like
// readFile(…, 'utf8') did, so writing the text back preserves it.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeText(buf: Uint8Array): DecodedText {
	if (buf[0] === 0xff && buf[1] === 0xfe) {
		return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), nonUtf8: true };
	}
	if (buf[0] === 0xfe && buf[1] === 0xff) {
		return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), nonUtf8: true };
	}
	try {
		return { text: utf8.decode(buf), nonUtf8: false };
	} catch {
		// Not UTF-8: on a Windows share almost always Windows-1252.
		return { text: new TextDecoder('windows-1252').decode(buf), nonUtf8: true };
	}
}
