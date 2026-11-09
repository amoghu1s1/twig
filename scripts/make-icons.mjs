// Regenerate the committed icon set from the transparent emblem
// (build/icon-emblem.png is the source of truth).
//
//   build/icon-flat.svg — self-contained SVG wrapper (embedded PNG)
//   build/icon.ico      — Windows (.ico with 16/24/32/48/64/128/256 PNG entries)
//   build/icon.png      — Linux (512×512; AppImage/deb/desktop entry)
//   build/icon.icns     — macOS pre-Tahoe fallback (16→1024, PNG entries)
//   app/icon.png        — Next.js app icon (1024×1024)
//
// macOS 26 uses build/icon.icon (the Icon Composer document), compiled by
// actool at package time into Assets.car. scripts/after-pack.cjs then swaps
// in build/icon.icns as the full-resolution fallback for older macOS.
//
// Renders each size directly from the SVG (resvg), so the transparent
// emblem stays sharp at every size. Committed outputs; rerun only when the
// design changes: `node scripts/make-icons.mjs`.
import { Resvg } from "@resvg/resvg-js";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const emblem = readFileSync(path.join(root, "build", "icon-emblem.png"));
const svg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 1024 1024">
    <image x="0" y="0" width="1024" height="1024" xlink:href="data:image/png;base64,${emblem.toString("base64")}"/>
</svg>
`;
writeFileSync(path.join(root, "build", "icon-flat.svg"), svg);

const render = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

// ---- build/icon.ico: ICONDIR + PNG entries ------------------------------
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const pngs = ICO_SIZES.map(render);
// Header (6) + one 16-byte directory entry per image, then the PNGs.
const header = Buffer.alloc(6 + ICO_SIZES.length * 16);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(ICO_SIZES.length, 4);
let offset = header.length;
ICO_SIZES.forEach((size, i) => {
	const e = 6 + i * 16;
	header.writeUInt8(size === 256 ? 0 : size, e); // 0 encodes 256
	header.writeUInt8(size === 256 ? 0 : size, e + 1);
	header.writeUInt8(0, e + 2); // colors
	header.writeUInt8(0, e + 3); // reserved
	header.writeUInt16LE(1, e + 4); // planes
	header.writeUInt16LE(32, e + 6); // bpp
	header.writeUInt32LE(pngs[i].length, e + 8);
	header.writeUInt32LE(offset, e + 12);
	offset += pngs[i].length;
});
const ico = Buffer.concat([header, ...pngs]);
writeFileSync(path.join(root, "build", "icon.ico"), ico);
console.log(`build/icon.ico  ${ICO_SIZES.join("/")} — ${(ico.length / 1024).toFixed(1)} KB`);

// ---- build/icon.png: the Linux icon -------------------------------------
const png512 = render(512);
writeFileSync(path.join(root, "build", "icon.png"), png512);
console.log(`build/icon.png  512×512 — ${(png512.length / 1024).toFixed(1)} KB`);

// ---- build/icon.icns: the pre-Tahoe macOS fallback ----------------------
const ICNS_ENTRIES = [
	["icp4", 16],
	["icp5", 32],
	["icp6", 64],
	["ic07", 128],
	["ic08", 256],
	["ic09", 512],
	["ic10", 1024],
];
const icnsEntries = ICNS_ENTRIES.map(([type, size]) => {
	const data = render(size);
	const entry = Buffer.alloc(8 + data.length);
	entry.write(type, 0, "ascii");
	entry.writeUInt32BE(entry.length, 4);
	data.copy(entry, 8);
	return entry;
});
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, "ascii");
icnsHeader.writeUInt32BE(8 + icnsEntries.reduce((n, entry) => n + entry.length, 0), 4);
const icns = Buffer.concat([icnsHeader, ...icnsEntries]);
writeFileSync(path.join(root, "build", "icon.icns"), icns);
console.log(`build/icon.icns ${ICNS_ENTRIES.map(([, size]) => size).join("/")} — ${(icns.length / 1024).toFixed(1)} KB`);

// ---- app/icon.png and the macOS Icon Composer asset ----------------------
copyFileSync(path.join(root, "build", "icon-emblem.png"), path.join(root, "app", "icon.png"));
copyFileSync(path.join(root, "build", "icon-emblem.png"), path.join(root, "build", "icon.icon", "Assets", "emblem.png"));
console.log("app/icon.png     1024×1024");
