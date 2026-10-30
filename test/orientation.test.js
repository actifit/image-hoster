const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { readExifOrientation, exifFromJpegHeader, imageOrientation, uprightBuffer } = require('../orientation');

//A 40x20 image with four differently coloured quadrants, so any rotation or
//mirror shows up as colours in the wrong corners.
const QUADS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
async function baseJpeg() {
	const w = 40, h = 20;
	const raw = Buffer.alloc(w * h * 3);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const c = QUADS[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)];
			raw.set(c, (y * w + x) * 3);
		}
	}
	return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
}

//Big-endian EXIF APP1 with Orientation in IFD0. `brokenThumb` adds the
//thumbnail offset/length tags pointing far past the end of the block, in the
//order the Actifit Android app wrote them: thumbnail tags first, then image
//width/length, then Orientation (copied from a real affected upload).
function exifApp1(orientation, brokenThumb) {
	const entries = [];
	if (brokenThumb) {
		entries.push([0x0201, 4, 401], [0x0202, 4, 48807], [0x0100, 4, 40], [0x0101, 4, 20]);
	}
	entries.push([0x0112, 3, orientation]);
	const tiff = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
	tiff.write('MM', 0, 'latin1');
	tiff.writeUInt16BE(42, 2);
	tiff.writeUInt32BE(8, 4);
	tiff.writeUInt16BE(entries.length, 8);
	entries.forEach(([tag, type, value], i) => {
		const at = 10 + i * 12;
		tiff.writeUInt16BE(tag, at);
		tiff.writeUInt16BE(type, at + 2);
		tiff.writeUInt32BE(1, at + 4);
		if (type === 3) tiff.writeUInt16BE(value, at + 8);
		else tiff.writeUInt32BE(value, at + 8);
	});
	const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
	const header = Buffer.from([0xff, 0xe1, 0, 0]);
	header.writeUInt16BE(payload.length + 2, 2);
	return Buffer.concat([header, payload]);
}

function withExif(jpeg, orientation, brokenThumb) {
	return Buffer.concat([jpeg.slice(0, 2), exifApp1(orientation, brokenThumb), jpeg.slice(2)]);
}

//Colour of each quadrant's centre pixel, rounded to cope with JPEG noise.
async function quadrants(input) {
	const { data, info } = await sharp(input).raw().toBuffer({ resolveWithObject: true });
	const px = (x, y) => Array.from(data.slice((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)).map(v => Math.round(v / 64));
	const qx = [Math.floor(info.width / 4), Math.floor(info.width * 3 / 4)];
	const qy = [Math.floor(info.height / 4), Math.floor(info.height * 3 / 4)];
	return { size: [info.width, info.height], colours: [px(qx[0], qy[0]), px(qx[1], qy[0]), px(qx[0], qy[1]), px(qx[1], qy[1])] };
}

test('sharp itself cannot read orientation when the thumbnail pointer is broken', async () => {
	const broken = withExif(await baseJpeg(), 6, true);
	const meta = await sharp(broken).metadata();
	assert.strictEqual(meta.orientation, undefined);
	assert.strictEqual(readExifOrientation(meta.exif), 6);
});

for (let o = 1; o <= 8; o++) {
	for (const broken of [false, true]) {
		test(`orientation ${o}${broken ? ' with a broken thumbnail pointer' : ''} comes out upright`, async () => {
			const base = await baseJpeg();
			const input = withExif(base, o, broken);
			const { orientation } = await imageOrientation(input);
			assert.strictEqual(orientation, o);

			const out = await uprightBuffer(input, orientation);
			if (o === 1) {
				assert.strictEqual(out, null);
				return;
			}
			//reference: what sharp's own auto-orientation does with clean EXIF
			const expected = await sharp(withExif(base, o, false)).rotate().toBuffer();
			assert.deepStrictEqual(await quadrants(out), await quadrants(expected));
			const outMeta = await sharp(out).metadata();
			assert.strictEqual(outMeta.orientation, undefined);
			assert.strictEqual(outMeta.exif, undefined);
		});
	}
}

test('readExifOrientation ignores missing, short and malformed input', () => {
	assert.strictEqual(readExifOrientation(undefined), undefined);
	assert.strictEqual(readExifOrientation(Buffer.from('Exif\0\0MM')), undefined);
	assert.strictEqual(readExifOrientation(Buffer.from('Exif\0\0XX\0*\0\0\0\b')), undefined);
	const app1 = exifApp1(6, false).slice(4);
	assert.strictEqual(readExifOrientation(app1.slice(0, app1.length - 8)), undefined);
	assert.strictEqual(readExifOrientation(app1), 6);
});

test('exifFromJpegHeader finds EXIF after other segments and in a truncated header', async () => {
	const jpeg = withExif(await baseJpeg(), 6, true); //EXIF right after SOI
	const exif = exifFromJpegHeader(jpeg);
	assert.ok(exif && exif.slice(0, 6).toString('latin1') === 'Exif\0\0');
	assert.strictEqual(readExifOrientation(exif), 6);

	//EXIF after an APP0 segment
	const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
	const later = Buffer.concat([jpeg.slice(0, 2), app0, jpeg.slice(2)]);
	assert.strictEqual(readExifOrientation(exifFromJpegHeader(later)), 6);

	//only the first bytes, as from a ranged download
	assert.strictEqual(readExifOrientation(exifFromJpegHeader(later.slice(0, 120))), 6);
});

test('exifFromJpegHeader returns null without EXIF or for non-JPEG input', async () => {
	assert.strictEqual(exifFromJpegHeader(await baseJpeg()), null);
	assert.strictEqual(exifFromJpegHeader(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')), null);
	assert.strictEqual(exifFromJpegHeader(Buffer.from([0xff, 0xd8])), null);
	assert.strictEqual(exifFromJpegHeader(undefined), null);
	assert.strictEqual(exifFromJpegHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])), null);
});
