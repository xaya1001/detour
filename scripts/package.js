// Write dist/detour-<version>.zip with the contents of extension/ and LICENSE at the zip root.
// Minimal zip writer (deflate) so no external tool or dependency is needed.
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const { version } = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
const output = join(root, 'dist', `detour-${version}.zip`);

function walk(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

// Extension files at the zip root, plus the license.
const files = [...walk(source).map((full) => [relative(source, full), full]), ['LICENSE', join(root, 'LICENSE')]];
const localParts = [];
const centralParts = [];
let offset = 0;
const { time, day } = dosDateTime(new Date());

for (const [path, full] of files) {
  const name = Buffer.from(path.split('\\').join('/'), 'utf8');
  const data = readFileSync(full);
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const common = Buffer.concat([
    u16(20), // version needed
    u16(0x0800), // flags: UTF-8 names
    u16(8), // deflate
    u16(time),
    u16(day),
    u32(crc),
    u32(compressed.length),
    u32(data.length),
    u16(name.length),
    u16(0), // extra length
  ]);
  const local = Buffer.concat([u32(0x04034b50), common, name, compressed]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20), // version made by
    common,
    u16(0), // comment length
    u16(0), // disk number
    u16(0), // internal attrs
    u32(0), // external attrs
    u32(offset),
    name,
  ]);
  localParts.push(local);
  centralParts.push(central);
  offset += local.length;
}

const centralDir = Buffer.concat(centralParts);
const end = Buffer.concat([
  u32(0x06054b50),
  u16(0),
  u16(0),
  u16(files.length),
  u16(files.length),
  u32(centralDir.length),
  u32(offset),
  u16(0),
]);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([...localParts, centralDir, end]));
console.log(`${relative(root, output)}: ${files.length} files`);
for (const [path] of files) console.log(`  ${path}`);
