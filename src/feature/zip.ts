/**
 * Minimal ZIP writer, stored (uncompressed) entries only.
 *
 * XLSX is a zip of a handful of small XML files, and the stored method is a legal zip that
 * every reader accepts. Writing it here keeps the plugin free of Node builtins entirely —
 * `no-nodejs-modules` (§15.2) only tolerates them behind a `Platform.isDesktop` guard, and a
 * bundler shim for `stream`/`zlib` is exactly the kind of thing that breaks on an app update.
 * See docs/DECISIONS.md for why this replaced `exceljs`.
 */

export interface ZipEntry {
	path: string;
	data: Uint8Array;
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
}

export function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair, the only timestamp a classic zip header carries. */
function dosDateTime(date: Date): { time: number; date: number } {
	const year = Math.max(1980, date.getFullYear());
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

class ByteWriter {
	private chunks: Uint8Array[] = [];
	private length = 0;

	get offset(): number {
		return this.length;
	}

	bytes(data: Uint8Array): void {
		this.chunks.push(data);
		this.length += data.length;
	}

	u16(value: number): void {
		const b = new Uint8Array(2);
		b[0] = value & 0xff;
		b[1] = (value >>> 8) & 0xff;
		this.bytes(b);
	}

	u32(value: number): void {
		const b = new Uint8Array(4);
		b[0] = value & 0xff;
		b[1] = (value >>> 8) & 0xff;
		b[2] = (value >>> 16) & 0xff;
		b[3] = (value >>> 24) & 0xff;
		this.bytes(b);
	}

	finish(): Uint8Array {
		const out = new Uint8Array(this.length);
		let at = 0;
		for (const chunk of this.chunks) {
			out.set(chunk, at);
			at += chunk.length;
		}
		return out;
	}
}

/** Builds the archive. `at` fixes the entry timestamps, which keeps output reproducible. */
export function buildZip(entries: ZipEntry[], at: Date): Uint8Array {
	const encoder = new TextEncoder();
	const { time, date } = dosDateTime(at);
	const body = new ByteWriter();
	const meta: Array<{ name: Uint8Array; crc: number; size: number; offset: number }> = [];

	for (const entry of entries) {
		const name = encoder.encode(entry.path);
		const crc = crc32(entry.data);
		const offset = body.offset;

		body.u32(0x04034b50);
		body.u16(20); // version needed
		body.u16(0x0800); // UTF-8 file names
		body.u16(0); // stored
		body.u16(time);
		body.u16(date);
		body.u32(crc);
		body.u32(entry.data.length); // compressed size == uncompressed for stored
		body.u32(entry.data.length);
		body.u16(name.length);
		body.u16(0); // extra field length
		body.bytes(name);
		body.bytes(entry.data);

		meta.push({ name, crc, size: entry.data.length, offset });
	}

	const centralOffset = body.offset;
	for (const item of meta) {
		body.u32(0x02014b50);
		body.u16(20); // version made by
		body.u16(20); // version needed
		body.u16(0x0800);
		body.u16(0);
		body.u16(time);
		body.u16(date);
		body.u32(item.crc);
		body.u32(item.size);
		body.u32(item.size);
		body.u16(item.name.length);
		body.u16(0); // extra
		body.u16(0); // comment
		body.u16(0); // disk number start
		body.u16(0); // internal attributes
		body.u32(0); // external attributes
		body.u32(item.offset);
		body.bytes(item.name);
	}
	const centralSize = body.offset - centralOffset;

	body.u32(0x06054b50);
	body.u16(0);
	body.u16(0);
	body.u16(meta.length);
	body.u16(meta.length);
	body.u32(centralSize);
	body.u32(centralOffset);
	body.u16(0);

	return body.finish();
}
