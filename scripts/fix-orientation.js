//One-off repair for images stored before the upload fix: finds JPEGs that still
//carry an EXIF orientation (including ones whose EXIF libexif rejects) and
//rewrites them upright, with no metadata.
//
//  node scripts/fix-orientation.js <dir> [<dir> ...]            dry run: list only
//  node scripts/fix-orientation.js --apply <dir> [<dir> ...]    rewrite the files
//  --bucket          also replace the object-storage copy (needs config.json in cwd)
//  --since=YYYY-MM-DD  skip files last modified before that date (UTC midnight)
//
//This covers images on local disk. Images that exist only in the bucket are
//handled by scripts/fix-orientation-bucket.js.
//
//Each rewritten name is appended to fixed-orientation.txt as soon as it is
//written, so the CDN cache can be purged even if the run stops part way:
//images are served as immutable, so caches keep the old copy otherwise.

const fs = require('fs');
const path = require('path');
const { imageOrientation, uprightBuffer } = require('../orientation');
const { errorText, replaceFile } = require('./replace-file');

const USAGE = 'usage: node scripts/fix-orientation.js [--apply] [--bucket] [--since=YYYY-MM-DD] <dir> [<dir> ...]';
const PURGE_LIST = 'fixed-orientation.txt';

const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const dirs = args.filter(a => !a.startsWith('--'));
const apply = flags.includes('--apply');
const useBucket = flags.includes('--bucket');
const sinceArg = flags.find(a => a.startsWith('--since='));
const since = sinceArg ? new Date(sinceArg.slice(8)).getTime() : 0;

function fail(message) {
	console.error(message);
	console.error(USAGE);
	process.exit(1);
}

//check everything before touching any file, so a typo cannot stop a run half way
const unknown = flags.filter(f => f !== '--apply' && f !== '--bucket' && !f.startsWith('--since='));
if (unknown.length) fail('unknown option: ' + unknown.join(' '));
if (dirs.length === 0) fail('no directory given');
if (Number.isNaN(since)) fail('bad --since date');
for (const dir of dirs) {
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail('not a directory: ' + dir);
}

let s3 = null;
let bucket = null;
if (useBucket) {
	let config;
	try {
		config = JSON.parse(fs.readFileSync('config.json'));
	} catch (err) {
		fail('--bucket needs a readable config.json in the current directory: ' + err.message);
	}
	if (!(config.OBJ_ENDPOINT && config.OBJ_BUCKET && config.OBJ_KEY && config.OBJ_SECRET)) {
		fail('--bucket needs OBJ_ENDPOINT, OBJ_BUCKET, OBJ_KEY and OBJ_SECRET in config.json');
	}
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

//fail now rather than after files were rewritten and could not be listed
if (apply) {
	try {
		fs.closeSync(fs.openSync(PURGE_LIST, 'a'));
	} catch (err) {
		fail('cannot write ' + PURGE_LIST + ': ' + err.message);
	}
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

//The bucket copy is replaced before the local file: once the local file is
//upright, a rerun skips it, so a bucket failure after that could never be retried.
async function rewrite(name, file, st, upright, stats) {
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

	//listed before the rename: once renamed, a rerun skips the file, so a name
	//missing from the list would never be purged. Listing an unfixed name is harmless.
	fs.appendFileSync(PURGE_LIST, name + '\n');

	replaceFile(file, upright, st);
	stats.fixed++;
}

async function main() {
	if (s3) {
		await s3.headBucket({ Bucket: bucket }).promise();
	}
	const stats = { scanned: 0, notImage: 0, needsFix: 0, fixed: 0, bucketFixed: 0, errors: 0 };
	for (const dir of dirs) {
		for (const name of fs.readdirSync(dir)) {
			if (name.startsWith('.')) continue;
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
				let found;
				try {
					found = await imageOrientation(input);
				} catch (err) {
					stats.notImage++;
					continue;
				}
				const { metadata, orientation } = found;
				//other formats are fixed on upload; only JPEGs showed the broken EXIF
				if (metadata.format !== 'jpeg' || orientation === 1) continue;
				stats.needsFix++;
				console.log((apply ? 'fixing ' : 'would fix ') + file + ' (orientation ' + orientation + (metadata.orientation ? '' : ', unreadable EXIF') + ')');
				if (!apply) continue;
				await rewrite(name, file, st, await uprightBuffer(input, orientation), stats);
			} catch (err) {
				stats.errors++;
				console.error('error on ' + file + ': ' + errorText(err));
			}
		}
	}
	console.log(JSON.stringify(stats));
	if (stats.errors > 0) {
		process.exitCode = 1;
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
