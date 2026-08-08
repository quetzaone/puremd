// Packs PNGs into a Windows .ico so the icon stays regenerable from the design
// handoff instead of being an opaque binary nobody can rebuild.
//
//   node tools/make-ico.mjs icons/icon.ico icons/icon-16.png icons/icon-32.png ...
//
// Entries are stored PNG-compressed rather than as BMP. Windows has read that
// since Vista, and it is what keeps a 256px icon at kilobytes instead of the
// quarter megabyte a raw 32-bit bitmap plus mask would cost.

import { readFileSync, writeFileSync } from "node:fs";

const [out, ...sources] = process.argv.slice(2);

if (!out || !sources.length) {
  console.error("usage: node tools/make-ico.mjs <out.ico> <png...>");
  process.exit(1);
}

const images = sources.map((file) => {
  const data = readFileSync(file);
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${file}: not a PNG`);
  }

  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 1 || width > 256 || height < 1 || height > 256) {
    throw new Error(`${file}: ${width}x${height}, but an icon entry holds 1–256px`);
  }

  return { data, width, height };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type 1 = icon
header.writeUInt16LE(images.length, 4);

const directory = Buffer.alloc(images.length * 16);
let offset = header.length + directory.length;

images.forEach((image, index) => {
  const at = index * 16;
  directory[at] = image.width % 256; // 256 is written as 0 — a byte cannot hold it
  directory[at + 1] = image.height % 256;
  directory.writeUInt16LE(1, at + 4); // colour planes
  directory.writeUInt16LE(32, at + 6); // bits per pixel
  directory.writeUInt32LE(image.data.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += image.data.length;
});

writeFileSync(out, Buffer.concat([header, directory, ...images.map((image) => image.data)]));
console.log(`${out}: ${images.length} entries, ${offset} bytes`);
