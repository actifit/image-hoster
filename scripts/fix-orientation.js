//One-off repair for images stored before the upload fix: finds JPEGs that still
//carry an EXIF orientation (including ones whose EXIF libexif rejects) and
//rewrites them upright, with no metadata.
//
//  node scripts/fix-orientation.js <dir> [<dir> ...]            dry run: list only
//  node scripts/fix-orientation.js --apply <dir> [<dir> ...]    rewrite the files
//  --bucket          also replace the object-storage copy (needs config.json in cwd)
//  --since=YYYY-MM-DD  skip files last modified before that date (UTC midnight)
//
//Pass every storage directory: the local image dir and the mounted volume.
//Objects that exist only in the bucket are not scanned.
//
//Each rewritten name is appended to fixed-orientation.txt as soon as it is
//written, so the CDN cache can be purged even if the run stops part way:
//images are served as immutable, so caches keep the old copy otherwise.

const fs = require('fs');
const path = require('path');
const { imageOrientation, uprightBuffer } = require('../orientation');

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
	const config = JSON.parse(fs.readFileSync('config.json'));
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
async function rewrite(dir, name, file, st, upright, stats) {
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

	//leading dot: safeImageName rejects it, so the GET route never serves the temp file
	const tmp = path.join(dir, '.' + name + '.orient-tmp');
	try {
		fs.writeFileSync(tmp, upright, { mode: st.mode });
		try {
			fs.chownSync(tmp, st.uid, st.gid);
		} catch (err) {
			//only root can chown; otherwise the runner already owns the new file
		}
		fs.renameSync(tmp, file);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
		throw err;
	}
	stats.fixed++;
	fs.appendFileSync(PURGE_LIST, name + '\n');
}

async function main() {
	if (s3) {
		await s3.headBucket({ Bucket: bucket }).promise();
	}
	const stats = { scanned: 0, needsFix: 0, fixed: 0, bucketFixed: 0, errors: 0 };
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
				const { metadata, orientation } = await imageOrientation(input);
				//other formats are fixed on upload; only JPEGs showed the broken EXIF
				if (metadata.format !== 'jpeg' || orientation === 1) continue;
				stats.needsFix++;
				console.log((apply ? 'fixing ' : 'would fix ') + file + ' (orientation ' + orientation + (metadata.orientation ? '' : ', unreadable EXIF') + ')');
				if (!apply) continue;
				await rewrite(dir, name, file, st, await uprightBuffer(input, orientation), stats);
			} catch (err) {
				stats.errors++;
				console.error('error on ' + file + ': ' + err.message);
			}
		}
	}
	console.log(JSON.stringify(stats));
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
