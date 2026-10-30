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
	return img.toBuffer();
}

module.exports = { readExifOrientation, imageOrientation, uprightBuffer };
