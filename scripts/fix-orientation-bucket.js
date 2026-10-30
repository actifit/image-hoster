//One-off repair for images in object storage: finds JPEGs that still carry an
//EXIF orientation (including ones whose EXIF libexif rejects) and rewrites them
//upright, with no metadata. Most images live only in the bucket, so this is the
//main repair; scripts/fix-orientation.js covers files on local disk.
//
//Run from the app directory (it reads config.json). Run one instance at a time.
//  node scripts/fix-orientation-bucket.js               dry run: list candidates
//  node scripts/fix-orientation-bucket.js --apply       rewrite them
//  --keys=FILE        only check these keys (one per line, first tab-separated
//                     column), e.g. orientation-candidates.tsv from a dry run,
//                     or a copy of orientation-errors.txt to retry failures
//  --start-after=KEY  resume a full listing after this key
//  --concurrency=N    parallel header checks (default 32)
//
//Each object is checked from its first 64 KB, or in full when its EXIF lies
//further in. Before an object is replaced, the original is copied to
//orient-backup/<key> in the same bucket, once: an existing backup is never
//overwritten, so it always holds the true original. A local copy in IMG_DIR,
//if any, is rewritten too, since local disk is served before the bucket.
//
//Output files (in the current directory):
//  orientation-candidates.tsv   dry run only: key, orientation (new each dry run)
//  fixed-orientation.txt        appended: keys rewritten, purge these from the CDN
//  orientation-errors.txt       new each run: keys that failed

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { readExifOrientation, exifFromJpegHeader, imageOrientation, uprightBuffer } = require('../orientation');
const { errorText, replaceFile } = require('./replace-file');

const USAGE = 'usage: node scripts/fix-orientation-bucket.js [--apply] [--keys=FILE] [--start-after=KEY] [--concurrency=N]';
const CANDIDATES = 'orientation-candidates.tsv';
const PURGE_LIST = 'fixed-orientation.txt';
const ERRORS = 'orientation-errors.txt';
const BACKUP_PREFIX = 'orient-backup/';
const HEADER_BYTES = 65536;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const FIX_CONCURRENCY = 2; //full-size decodes are memory and CPU heavy; the live app shares the box

//leave CPU and memory for the live app
sharp.cache(false);
sharp.concurrency(1);

function fail(message) {
	console.error(message);
	console.error(USAGE);
	process.exit(1);
}

const flags = process.argv.slice(2);
const known = /^--(apply|keys=.+|start-after=.+|concurrency=\d+)$/;
const unknown = flags.filter(f => !known.test(f));
if (unknown.length) fail('unknown option: ' + unknown.join(' '));
const apply = flags.includes('--apply');
const valueOf = (name) => {
	const f = flags.find(a => a.startsWith('--' + name + '='));
	return f ? f.slice(name.length + 3) : null;
};
const keysFile = valueOf('keys');
const startAfter = valueOf('start-after');
const concurrency = valueOf('concurrency') ? Number(valueOf('concurrency')) : 32;
if (!(concurrency >= 1 && concurrency <= 256)) fail('--concurrency must be 1-256');
if (keysFile && startAfter) fail('--keys and --start-after cannot be combined');
if (keysFile && !fs.existsSync(keysFile)) fail('no such keys file: ' + keysFile);
if (keysFile && path.resolve(keysFile) === path.resolve(ERRORS)) {
	fail(ERRORS + ' is rewritten by each run; retry from a copy of it');
}

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
const localDir = config.IMG_DIR ? path.resolve(process.cwd(), '.' + path.sep + config.IMG_DIR) : null;

//read the whole keys file up front, without duplicates: two workers on the same
//key could otherwise race and back up an already-fixed image
const keyList = keysFile ? Array.from(new Set(
	fs.readFileSync(keysFile, 'utf8').split('\n').map(l => l.split('\t')[0].trim()).filter(Boolean)
)) : null;

//fail now rather than after objects were rewritten and could not be listed
try {
	fs.writeFileSync(ERRORS, '');
	if (!apply) fs.writeFileSync(CANDIDATES, '');
	if (apply) fs.closeSync(fs.openSync(PURGE_LIST, 'a'));
} catch (err) {
	fail('cannot write output files: ' + err.message);
}

const stats = { checked: 0, empty: 0, notJpeg: 0, noExif: 0, fullChecked: 0, upright: 0, needsFix: 0, fixed: 0, skipped: 0, backupKept: 0, localFixed: 0, errors: 0 };

function logError(key, err) {
	stats.errors++;
	console.error('error on ' + key + ': ' + errorText(err));
	fs.appendFileSync(ERRORS, key + '\n');
}

//caps full rewrites; a released slot goes straight to the next waiter
let freeSlots = FIX_CONCURRENCY;
const waiting = [];
async function withFixSlot(fn) {
	if (freeSlots > 0) {
		freeSlots--;
	} else {
		await new Promise(resolve => waiting.push(resolve));
	}
	try {
		return await fn();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else freeSlots++;
	}
}

async function exists(key) {
	try {
		await s3.headObject({ Bucket: bucket, Key: key }).promise();
		return true;
	} catch (err) {
		if (err.code === 'NotFound' || err.statusCode === 404) return false;
		throw err;
	}
}

async function fixObject(key) {
	const obj = await s3.getObject({ Bucket: bucket, Key: key }).promise();
	//full check: sharp's own reading, falling back to the raw EXIF bytes
	const { orientation } = await imageOrientation(obj.Body);
	const upright = await uprightBuffer(obj.Body, orientation);
	if (!upright) {
		stats.skipped++;
		console.log('skipped ' + key + ': already upright on full check');
		return;
	}

	//1. keep the original, once. An existing backup is the true original from an
	//   earlier attempt, and copying again could replace it with a fixed image.
	if (await exists(BACKUP_PREFIX + key)) {
		stats.backupKept++;
	} else {
		await s3.copyObject({
			Bucket: bucket,
			Key: BACKUP_PREFIX + key,
			CopySource: bucket + '/' + encodeURIComponent(key)
		}).promise();
	}

	//2. listed before anything is rewritten, so it can never miss the CDN purge
	fs.appendFileSync(PURGE_LIST, key + '\n');

	//3. local disk is served before the bucket; if the bucket step then fails,
	//   a rerun still finds the bucket copy sideways
	if (localDir) {
		const file = path.join(localDir, key);
		if (path.dirname(file) === localDir && fs.existsSync(file)) {
			replaceFile(file, upright, fs.statSync(file));
			stats.localFixed++;
		}
	}

	//4. the bucket copy
	await s3.putObject({
		Bucket: bucket,
		Key: key,
		Body: upright,
		ContentType: obj.ContentType || 'image/jpeg',
		CacheControl: CACHE_CONTROL,
		Metadata: obj.Metadata
	}).promise();
	stats.fixed++;
}

async function check(key) {
	if (key.startsWith(BACKUP_PREFIX)) return;
	try {
		let head;
		try {
			head = await s3.getObject({ Bucket: bucket, Key: key, Range: 'bytes=0-' + (HEADER_BYTES - 1) }).promise();
		} catch (err) {
			//a ranged read of a 0-byte object fails with InvalidRange
			if (err.code === 'InvalidRange' || err.statusCode === 416) {
				stats.empty++;
				return;
			}
			throw err;
		}
		stats.checked++;
		let body = head.Body;
		if (body.length < 2 || body[0] !== 0xff || body[1] !== 0xd8) {
			stats.notJpeg++;
			return;
		}
		let exif = exifFromJpegHeader(body);
		if (exif === undefined && body.length >= HEADER_BYTES) {
			//EXIF may sit behind large segments: read the whole file
			stats.fullChecked++;
			body = (await s3.getObject({ Bucket: bucket, Key: key }).promise()).Body;
			exif = exifFromJpegHeader(body);
		}
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
		if (!apply) {
			fs.appendFileSync(CANDIDATES, key + '\t' + orientation + '\n');
			return;
		}
		await withFixSlot(() => fixObject(key));
	} catch (err) {
		logError(key, err);
	}
}

let lastListed = null;
let listError = null;

//yields keys from the keys file, or from a full bucket listing page by page.
//A failed listing page stops the listing; work already started still finishes.
async function* keys() {
	if (keyList) {
		yield* keyList;
		return;
	}
	let token;
	let first = true;
	do {
		let page;
		try {
			page = await s3.listObjectsV2({
				Bucket: bucket,
				ContinuationToken: token,
				StartAfter: first && startAfter ? startAfter : undefined
			}).promise();
		} catch (err) {
			listError = err;
			return;
		}
		first = false;
		for (const o of page.Contents || []) {
			lastListed = o.Key;
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
				console.log('progress: ' + seen + ' keys, ' + Math.round((Date.now() - started) / 1000) + 's, last listed ' + lastListed + ' ' + JSON.stringify(stats));
			}
			await check(next.value);
		}
	}
	await Promise.all(Array.from({ length: concurrency }, worker));
	if (listError) {
		console.error('listing stopped early (' + errorText(listError) + '). Resume with --start-after=' + lastListed);
		process.exitCode = 1;
	}
	console.log((apply ? 'done ' : 'dry run done ') + JSON.stringify(stats));
	if (stats.errors > 0) process.exitCode = 1;
}

main().catch(err => {
	console.error('stopped: ' + errorText(err));
	process.exit(1);
});
