const sharp = require('sharp');

//Some uploads carry EXIF that libexif rejects as corrupt, for example a
//thumbnail pointer (tags 0x0201/0x0202) aimed past the end of the EXIF block,
//which the Actifit Android app wrote from May 2025. libexif stops reading the
//directory at the bad entry, and those files list the thumbnail tags before
//Orientation, so sharp reports no orientation, the upload is stored unrotated,
//and every resizer that uses libexif shows it sideways. Reading the Orientation
//tag straight from the raw EXIF bytes avoids depending on that parser.
function readExifOrientation(exif) {
	if (!Buffer.isBuffer(exif)) {
		return undefined;
	}
	//sharp hands back the APP1 payload, which starts with "Exif\0\0"
	const tiff = exif.slice(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0;
	if (exif.length < tiff + 8) {
		return undefined;
	}
	const order = exif.toString('latin1', tiff, tiff + 2);
	if (order !== 'II' && order !== 'MM') {
		return undefined;
	}
	const le = order === 'II';
	const u16 = (at) => (le ? exif.readUInt16LE(at) : exif.readUInt16BE(at));
	const u32 = (at) => (le ? exif.readUInt32LE(at) : exif.readUInt32BE(at));
	if (u16(tiff + 2) !== 42) {
		return undefined;
	}
	const ifd0 = tiff + u32(tiff + 4);
	if (ifd0 + 2 > exif.length) {
		return undefined;
	}
	const count = u16(ifd0);
	for (let i = 0; i < count; i++) {
		const entry = ifd0 + 2 + i * 12;
		if (entry + 12 > exif.length) {
			return undefined;
		}
		//0x0112 Orientation: one SHORT, stored in the first two value bytes
		if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {
			const value = u16(entry + 8);
			return value >= 1 && value <= 8 ? value : undefined;
		}
	}
	return undefined;
}

//The EXIF APP1 payload ("Exif\0\0..."), found by walking the JPEG's marker
//segments. Works on just the first bytes of a file, so a bucket object can be
//checked from a ranged download. Returns null for non-JPEGs or when there is
//no EXIF segment before the image data, and undefined when `buf` ends before
//that could be decided (large segments such as an ICC profile come first).
function exifFromJpegHeader(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
		return null;
	}
	let at = 2;
	for (;;) {
		while (at + 1 < buf.length && buf[at] === 0xff && buf[at + 1] === 0xff) {
			at++; //fill bytes may pad a marker
		}
		if (at + 2 > buf.length) {
			return undefined;
		}
		if (buf[at] !== 0xff) {
			return null; //not a marker: corrupt header
		}
		const marker = buf[at + 1];
		if (marker === 0xda || marker === 0xd9) {
			return null; //image data or end of image: no EXIF before it
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			at += 2; //standalone markers carry no length
			continue;
		}
		if (at + 4 > buf.length) {
			return undefined;
		}
		const length = buf.readUInt16BE(at + 2);
		if (length < 2) {
			return null; //corrupt length
		}
		if (marker === 0xe1 && at + 10 <= buf.length && buf.toString('latin1', at + 4, at + 10) === 'Exif\0\0') {
			//a partial EXIF block could hide the Orientation tag: report "unknown"
			return at + 2 + length <= buf.length ? buf.slice(at + 4, at + 2 + length) : undefined;
		}
		if (marker === 0xe1 && at + 10 > buf.length) {
			return undefined; //an APP1 segment whose type is cut off
		}
		at += 2 + length;
	}
}

//The same mapping sharp uses for auto-orientation: rotate clockwise first, then
//mirror. flip mirrors top to bottom, flop mirrors left to right.
const TRANSFORMS = {
	2: { angle: 0, flop: true },
	3: { angle: 180 },
	4: { angle: 180, flop: true },
	5: { angle: 270, flip: true },
	6: { angle: 90 },
	7: { angle: 90, flip: true },
	8: { angle: 270 }
};

async function imageOrientation(input) {
	const metadata = await sharp(input).metadata();
	const orientation = metadata.orientation || readExifOrientation(metadata.exif) || 1;
	return { metadata, orientation };
}

//Returns the upright image, or null when it is already upright. sharp drops all
//metadata on output by default, so a rotated image also loses its EXIF; an
//image that needs no rotation is left as it was, EXIF included.
async function uprightBuffer(input, orientation) {
	const t = TRANSFORMS[orientation];
	if (!t) {
		return null;
	}
	let img = sharp(input).rotate(t.angle);
	if (t.flip) img = img.flip();
	if (t.flop) img = img.flop();
	//quality 90 instead of sharp's default 80, to limit generation loss on
	//originals; force:false keeps non-JPEG input in its own format
	return img.jpeg({ quality: 90, force: false }).toBuffer();
}

module.exports = { readExifOrientation, exifFromJpegHeader, imageOrientation, uprightBuffer };
