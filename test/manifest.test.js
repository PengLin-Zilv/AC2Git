// Every icon the manifest names exists and is an RGBA PNG of the declared size. IHDR read by hand: no dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// IHDR is always the first chunk: length (4) + "IHDR" (4), then width, height, bit depth, colour type.
function ihdr(file) {
  const b = fs.readFileSync(file);
  assert.ok(b.subarray(0, 8).equals(PNG_SIGNATURE), `${file}: not a PNG`);
  assert.equal(b.toString('ascii', 12, 16), 'IHDR', `${file}: first chunk isn't IHDR`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bitDepth: b[24], colorType: b[25] };
}

const icons = [
  ...Object.entries(manifest.icons ?? {}).map(([size, file]) => ['icons', size, file]),
  ...Object.entries(manifest.action?.default_icon ?? {}).map(([size, file]) => ['action.default_icon', size, file]),
];

test('the manifest declares 16/32/48/128 icons and a 16/32 toolbar icon', () => {
  assert.deepEqual(Object.keys(manifest.icons), ['16', '32', '48', '128']);
  assert.deepEqual(Object.keys(manifest.action.default_icon), ['16', '32']);
});

for (const [where, size, file] of icons) {
  test(`${where} ${size}: ${file} exists and is a ${size}×${size} RGBA PNG`, () => {
    const full = path.join(ROOT, file);
    assert.ok(fs.existsSync(full), `${file} is missing`);
    const h = ihdr(full);
    assert.deepEqual([h.width, h.height], [Number(size), Number(size)]);
    assert.equal(h.colorType, 6, 'colour type 6 = RGBA');
    assert.equal(h.bitDepth, 8);
  });
}
