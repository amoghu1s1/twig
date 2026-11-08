/**
 * Resource limits on model-driven tools (security hardening, ported from the
 * jacobderechin fork, 2026-11-08): catastrophic regexes run in a
 * time-budgeted worker (safe-regex.ts), and oversized files are refused
 * before they are loaded (read, PDFs).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { MAX_PATTERN_LENGTH, RegexScanner, RegexTooSlowError } from "../src/agent/tools/safe-regex.ts";
import { grepTool } from "../src/agent/tools/grep.ts";
import { readTool } from "../src/agent/tools/read.ts";
import { assertPdfSize, MAX_PDF_FILE_BYTES, pdfSearch } from "../src/agent/subagents/pdf-ops.ts";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "lh-limits-"));
/** A sparse file of `size` bytes — no real allocation. */
async function sparse(file: string, size: number) {
	const handle = await fs.open(file, "w");
	try {
		await handle.truncate(size);
	} finally {
		await handle.close();
	}
}

describe("RegexScanner", () => {
	it("matches normally and reports line indices", async () => {
		const scanner = new RegexScanner("b+", "i");
		try {
			assert.deepEqual(await scanner.matchLines(["abc", "xyz", "BBB"]), [0, 2]);
		} finally {
			scanner.close();
		}
	});

	it("a catastrophic-backtracking pattern is cut off at the budget — the event loop stays free", async () => {
		const scanner = new RegexScanner("^(a+)+$", undefined, 300);
		let ticks = 0;
		const ticker = setInterval(() => ticks++, 20);
		const started = Date.now();
		try {
			await assert.rejects(scanner.matchLines(["a".repeat(40) + "!"]), RegexTooSlowError);
		} finally {
			clearInterval(ticker);
			scanner.close();
		}
		assert.ok(Date.now() - started < 2000, "returned near the budget");
		assert.ok(ticks >= 5, "the main thread kept running while the worker spun");
	});

	it("rejects oversized and invalid patterns up front", () => {
		assert.throws(() => new RegexScanner("a".repeat(MAX_PATTERN_LENGTH + 1), undefined), /too long/);
		assert.throws(() => new RegexScanner("(", undefined), /Invalid regex/);
	});
});

describe("grep with the safe scanner", () => {
	it("regex and literal searches still work; invalid patterns are tool errors", async () => {
		const dir = await tmp();
		await fs.writeFile(path.join(dir, "a.txt"), "alpha\nbeta 1.5\ngamma\n");
		const regex = await grepTool.execute!("c", { pattern: "^b.*\\d$", path: dir });
		assert.match(String(regex.details), /a\.txt:2: beta 1\.5/);
		const literal = await grepTool.execute!("c", { pattern: "1.5", literal: true, path: dir });
		assert.match(String(literal.details), /a\.txt:2:/);
		await assert.rejects(() => grepTool.execute!("c", { pattern: "(", path: dir }), /Invalid regex/);
	});
});

describe("size caps before loading", () => {
	it("read refuses text over 10 MB and images over 5 MB, without reading them", async () => {
		const dir = await tmp();
		const big = path.join(dir, "big.txt");
		const img = path.join(dir, "big.png");
		await sparse(big, 11 * 1024 * 1024);
		// A real PNG header makes content sniffing identify it as an image,
		// then the sparse tail makes it oversized.
		const png = createCanvas(1, 1).toBuffer("image/png");
		await sparse(img, 6 * 1024 * 1024);
		// sparse() truncates; put the real PNG header back for content sniffing.
		const handle = await fs.open(img, "r+");
		try {
			await handle.write(png, 0, png.length, 0);
		} finally {
			await handle.close();
		}
		await assert.rejects(() => readTool.execute!("c", { path: big }), /File too large to read/);
		await assert.rejects(() => readTool.execute!("c", { path: img }), /File too large to read/);
		await assert.rejects(() => readTool.execute!("c", { path: dir }), /Not a regular file/);
	});

	it("PDFs over the cap are refused before pdfjs sees them", async () => {
		const dir = await tmp();
		const pdf = path.join(dir, "huge.pdf");
		await sparse(pdf, MAX_PDF_FILE_BYTES + 1);
		await assert.rejects(assertPdfSize(pdf), /PDF too large/);
		await assert.rejects(pdfSearch(pdf, "x", { literal: true }), /PDF too large/);
	});
});
