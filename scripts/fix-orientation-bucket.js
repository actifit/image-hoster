//One-off repair for images in object storage: finds JPEGs that still carry an
//EXIF orientation (including ones whose EXIF libexif rejects) and rewrites them
//upright, with no metadata. Most images live only in the bucket, so this is the
//main repair; scripts/fix-orientation.js covers files on local disk.
//
//Run from the app directory (it reads config.json):
//  node scripts/fix-orientation-bucket.js               dry run: list candidates
//  node scripts/fix-orientation-bucket.js --apply       rewrite them
//  --keys=FILE        only check these keys (one per line, first tab-separated
//                     column), e.g. orientation-candidates.tsv from a dry run,
//                     or orientation-errors.txt to retry failures
//  --concurrency=N    parallel header checks (default 32)
//
//Each object is checked from its first 64 KB only. Before an object is
//replaced, the original is copied to orient-backup/<key> in the same bucket
//(the GET route never serves keys with a slash). A local copy in IMG_DIR, if
//any, is rewritten too, first, since local disk is served before the bucket.
//
//Output files, appended as the run goes so nothing is lost if it stops:
//  orientation-candidates.tsv   key, orientation (every candidate found)
//  fixed-orientation.txt        keys rewritten: purge these URLs from the CDN
//  orientation-errors.txt       keys that failed: retry with --keys

const fs = require('fs');
const path = require('path');
const { readExifOrientation, exifFromJpegHeader, imageOrientation, uprightBuffer } = require('../orientation');
const { errorText, replaceFile } = require('./replace-file');

const USAGE = 'usage: node scripts/fix-orientation-bucket.js [--apply] [--keys=FILE] [--concurrency=N]';
const CANDIDATES = 'orientation-candidates.tsv';
const PURGE_LIST = 'fixed-orientation.txt';
const ERRORS = 'orientation-errors.txt';
const BACKUP_PREFIX = 'orient-backup/';
const HEADER_BYTES = 65536;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const FIX_CONCURRENCY = 4; //full-size decodes are memory heavy

function fail(message) {
	console.error(message);
	console.error(USAGE);
	process.exit(1);
}

const flags = process.argv.slice(2);
const known = /^--(apply|keys=.+|concurrency=\d+)$/;
const unknown = flags.filter(f => !known.test(f));
if (unknown.length) fail('unknown option: ' + unknown.join(' '));
const apply = flags.includes('--apply');
const keysArg = flags.find(f => f.startsWith('--keys='));
const keysFile = keysArg ? keysArg.slice(7) : null;
const concArg = flags.find(f => f.startsWith('--concurrency='));
const concurrency = concArg ? Number(concArg.slice(14)) : 32;
if (!(concurrency >= 1 && concurrency <= 256)) fail('--concurrency must be 1-256');
if (keysFile && !fs.existsSync(keysFile)) fail('no such keys file: ' + keysFile);

let config;
try {
	config = JSON.parse(fs.readFileSync('config.json'));
} catch (err) {
	fail('needs a readable config.json in the current directory: ' + err.message);
}
if (!(config.OBJ_ENDPOINT && config.OBJ_BUCKET && config.OBJ_KEY && config.OBJ_SECRET)) {
	fail('needs OBJ_ENDPOINT, OBJ_BUCKET, OBJ_KEY and OBJ_SECRET in config.json');
}
const S3 = require('aws-sdk').S3;
const s3 = new S3({
	endpoint: config.OBJ_ENDPOINT,
	accessKeyId: config.OBJ_KEY,
	secretAccessKey: config.OBJ_SECRET,
	region: config.OBJ_REGION || 'hel1',
	s3ForcePathStyle: true,
	signatureVersion: 'v4',
	maxRetries: 5
});
const bucket = config.OBJ_BUCKET;
const localDir = config.IMG_DIR ? path.join(process.cwd(), config.IMG_DIR) : null;

//fail now rather than after objects were rewritten and could not be listed
for (const file of [CANDIDATES, ERRORS].concat(apply ? [PURGE_LIST] : [])) {
	try {
		fs.closeSync(fs.openSync(file, 'a'));
	} catch (err) {
		fail('cannot write ' + file + ': ' + err.message);
	}
}

const stats = { checked: 0, empty: 0, notJpeg: 0, noExif: 0, upright: 0, needsFix: 0, fixed: 0, localFixed: 0, errors: 0 };

function logError(key, err) {
	stats.errors++;
	console.error('error on ' + key + ': ' + errorText(err));
	fs.appendFileSync(ERRORS, key + '\n');
}

//a tiny semaphore so header checks stay fast while full rewrites are capped
let fixSlots = FIX_CONCURRENCY;
const fixQueue = [];
async function withFixSlot(fn) {
	if (fixSlots === 0) await new Promise(resolve => fixQueue.push(resolve));
	fixSlots--;
	try {
		return await fn();
	} finally {
		fixSlots++;
		const next = fixQueue.shift();
		if (next) next();
	}
}

async function fixObject(key) {
	const obj = await s3.getObject({ Bucket: bucket, Key: key }).promise();
	//full check: sharp's own reading, falling back to the raw EXIF bytes
	const { orientation } = await imageOrientation(obj.Body);
	const upright = await uprightBuffer(obj.Body, orientation);
	if (!upright) return;

	//listed first: once rewritten, a rerun skips it, so it must never be missing
	fs.appendFileSync(PURGE_LIST, key + '\n');

	//local disk is served before the bucket, so fix the local copy first; if the
	//bucket step then fails, a rerun still finds the bucket copy sideways
	if (localDir) {
		const file = path.join(localDir, key);
		if (path.dirname(file) === path.resolve(localDir) && fs.existsSync(file)) {
			replaceFile(file, upright, fs.statSync(file));
			stats.localFixed++;
		}
	}

	await s3.copyObject({
		Bucket: bucket,
		Key: BACKUP_PREFIX + key,
		CopySource: bucket + '/' + encodeURIComponent(key)
	}).promise();
	await s3.putObject({
		Bucket: bucket,
		Key: key,
		Body: upright,
		ContentType: obj.ContentType || 'image/jpeg',
		CacheControl: CACHE_CONTROL
	}).promise();
	stats.fixed++;
}

async function check(key) {
	if (key.startsWith(BACKUP_PREFIX)) return;
	try {
		const head = await s3.getObject({ Bucket: bucket, Key: key, Range: 'bytes=0-' + (HEADER_BYTES - 1) }).promise();
		stats.checked++;
		const body = head.Body;
		if (body.length < 2 || body[0] !== 0xff || body[1] !== 0xd8) {
			stats.notJpeg++;
			return;
		}
		const exif = exifFromJpegHeader(body);
		if (!exif) {
			stats.noExif++;
			return;
		}
		const orientation = readExifOrientation(exif) || 1;
		if (orientation === 1) {
			stats.upright++;
			return;
		}
		stats.needsFix++;
		fs.appendFileSync(CANDIDATES, key + '\t' + orientation + '\n');
		if (apply) {
			await withFixSlot(() => fixObject(key));
		}
	} catch (err) {
		//a ranged read of a 0-byte object fails with InvalidRange
		if (err.code === 'InvalidRange') {
			stats.empty++;
			return;
		}
		logError(key, err);
	}
}

//yields keys from the keys file, or from a full bucket listing page by page
async function* keys() {
	if (keysFile) {
		for (const line of fs.readFileSync(keysFile, 'utf8').split('\n')) {
			const key = line.split('\t')[0].trim();
			if (key) yield key;
		}
		return;
	}
	let token;
	do {
		const page = await s3.listObjectsV2({ Bucket: bucket, ContinuationToken: token }).promise();
		for (const o of page.Contents || []) {
			if (o.Size === 0) {
				stats.empty++; //nothing to read or fix
				continue;
			}
			yield o.Key;
		}
		token = page.NextContinuationToken;
	} while (token);
}

async function main() {
	await s3.headBucket({ Bucket: bucket }).promise();
	const started = Date.now();
	const iterator = keys();
	let seen = 0;
	async function worker() {
		for (;;) {
			const next = await iterator.next();
			if (next.done) return;
			seen++;
			if (seen % 10000 === 0) {
				console.log('progress: ' + seen + ' keys, ' + Math.round((Date.now() - started) / 1000) + 's ' + JSON.stringify(stats));
			}
			await check(next.value);
		}
	}
	await Promise.all(Array.from({ length: concurrency }, worker));
	console.log((apply ? 'done ' : 'dry run done ') + JSON.stringify(stats));
	if (stats.errors > 0) process.exitCode = 1;
}

main().catch(err => {
	console.error('stopped: ' + errorText(err));
	process.exit(1);
});
