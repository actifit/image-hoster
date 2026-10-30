//One-off repair for images stored before the upload fix: finds JPEGs that still
//carry an EXIF orientation (including ones whose EXIF libexif rejects) and
//rewrites them upright, with no metadata.
//
//  node scripts/fix-orientation.js <dir> [<dir> ...]            dry run: list only
//  node scripts/fix-orientation.js --apply <dir> [<dir> ...]    rewrite the files
//  add --bucket to also replace the object-storage copy (needs config.json in cwd)
//  add --since=YYYY-MM-DD to skip files last modified before that date
//
//Rewritten names are written to fixed-orientation.txt so their CDN cache can be
//purged: images are served as immutable, so caches keep the old copy otherwise.

const fs = require('fs');
const path = require('path');
const { imageOrientation, uprightBuffer } = require('../orientation');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const useBucket = args.includes('--bucket');
const sinceArg = args.find(a => a.startsWith('--since='));
const since = sinceArg ? new Date(sinceArg.slice(8)).getTime() : 0;
const dirs = args.filter(a => !a.startsWith('--'));

if (dirs.length === 0 || Number.isNaN(since)) {
	console.error('usage: node scripts/fix-orientation.js [--apply] [--bucket] [--since=YYYY-MM-DD] <dir> [<dir> ...]');
	process.exit(1);
}

let s3 = null;
let bucket = null;
if (useBucket) {
	const config = JSON.parse(fs.readFileSync('config.json'));
	const S3 = require('aws-sdk').S3;
	s3 = new S3({
		endpoint: config.OBJ_ENDPOINT,
		accessKeyId: config.OBJ_KEY,
		secretAccessKey: config.OBJ_SECRET,
		region: config.OBJ_REGION || 'hel1',
		s3ForcePathStyle: true,
		signatureVersion: 'v4'
	});
	bucket = config.OBJ_BUCKET;
}

async function bucketHas(key) {
	try {
		await s3.headObject({ Bucket: bucket, Key: key }).promise();
		return true;
	} catch (err) {
		if (err.code === 'NotFound' || err.statusCode === 404) return false;
		throw err;
	}
}

async function main() {
	const stats = { scanned: 0, needsFix: 0, fixed: 0, bucketFixed: 0, errors: 0 };
	const fixedNames = [];
	for (const dir of dirs) {
		for (const name of fs.readdirSync(dir)) {
			const file = path.join(dir, name);
			let st;
			try {
				st = fs.statSync(file);
			} catch (err) {
				continue;
			}
			if (!st.isFile() || st.mtimeMs < since) continue;
			stats.scanned++;
			try {
				const input = fs.readFileSync(file);
				const { metadata, orientation } = await imageOrientation(input);
				if (metadata.format !== 'jpeg' || orientation === 1) continue;
				stats.needsFix++;
				console.log((apply ? 'fixing ' : 'would fix ') + file + ' (orientation ' + orientation + (metadata.orientation ? '' : ', unreadable EXIF') + ')');
				if (!apply) continue;

				const upright = await uprightBuffer(input, orientation);
				const tmp = file + '.orient-tmp';
				fs.writeFileSync(tmp, upright);
				fs.utimesSync(tmp, st.atime, st.mtime);
				fs.renameSync(tmp, file);
				stats.fixed++;
				fixedNames.push(name);

				if (s3 && await bucketHas(name)) {
					await s3.putObject({
						Bucket: bucket,
						Key: name,
						Body: upright,
						ContentType: 'image/jpeg',
						CacheControl: 'public, max-age=31536000, immutable'
					}).promise();
					stats.bucketFixed++;
				}
			} catch (err) {
				stats.errors++;
				console.error('error on ' + file + ': ' + err.message);
			}
		}
	}
	if (fixedNames.length) {
		fs.appendFileSync('fixed-orientation.txt', fixedNames.join('\n') + '\n');
	}
	console.log(JSON.stringify(stats));
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
