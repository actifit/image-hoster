//End-to-end tests for /upload: the real index.js runs in a child process, with a
//throwaway config (no object storage) and images directory.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const KEY = 'test-upload-key';
const IMG_DIR = '/test-uploads-' + process.pid + '/';
const imgDir = path.join(ROOT, IMG_DIR);
const PORT = 20000 + (process.pid % 20000);
const base = 'http://127.0.0.1:' + PORT;

let server;
let cwd;

const STALE = '.upload-stale';
const FRESH = '.upload-fresh';

test.before(async () => {
	fs.mkdirSync(imgDir, { recursive: true });
	//temporary files left by aborted uploads: the old one is swept at startup
	fs.writeFileSync(path.join(imgDir, STALE), 'x');
	const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
	fs.utimesSync(path.join(imgDir, STALE), twoHoursAgo, twoHoursAgo);
	fs.writeFileSync(path.join(imgDir, FRESH), 'x');
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'image-hoster-'));
	fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({ IMG_DIR, SEC_UPL_KEE: KEY, MAX_UPLOAD_MB: 1 }));
	server = spawn(process.execPath, [path.join(ROOT, 'index.js')], { cwd, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
	//wait for this server's own start line, so a port clash fails loudly
	await new Promise((resolve, reject) => {
		let out = '';
		server.stdout.on('data', (d) => {
			out += d;
			if (out.includes('Server started')) resolve();
		});
		server.once('exit', (code) => reject(new Error('server exited with ' + code)));
	});
	server.stdout.resume();
});

test.after(async () => {
	const exited = new Promise((r) => server.once('exit', r));
	server.kill();
	await exited;
	fs.rmSync(imgDir, { recursive: true, force: true });
	fs.rmSync(cwd, { recursive: true, force: true });
});

const jpeg = (r, g, b) => sharp({ create: { width: 8, height: 4, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();

function upload(name, body, key = KEY) {
	const form = new FormData();
	form.append('image', new Blob([body], { type: 'image/jpeg' }), name);
	return fetch(base + '/upload', { method: 'POST', body: form, headers: { authorization: key } });
}

const leftovers = () => fs.readdirSync(imgDir).filter((f) => f.startsWith('.') && f !== FRESH);

test('stale temporary files are swept at startup, recent ones kept', () => {
	assert.ok(!fs.existsSync(path.join(imgDir, STALE)));
	assert.ok(fs.existsSync(path.join(imgDir, FRESH)));
});

test('an upload is published under its name and served', async () => {
	const body = await jpeg(255, 0, 0);
	const res = await upload('NEWIMAGE1', body);
	assert.strictEqual(res.status, 200);
	const served = await fetch(base + '/NEWIMAGE1');
	assert.strictEqual(served.status, 200);
	assert.strictEqual(served.headers.get('x-content-type-options'), 'nosniff');
	assert.deepStrictEqual(Buffer.from(await served.arrayBuffer()), body);
	assert.deepStrictEqual(leftovers(), []);
});

test('an existing image is never replaced', async () => {
	const first = await jpeg(0, 255, 0);
	assert.strictEqual((await upload('KEEPME', first)).status, 200);
	const res = await upload('KEEPME', await jpeg(0, 0, 255));
	assert.strictEqual(res.status, 409);
	assert.deepStrictEqual(fs.readFileSync(path.join(imgDir, 'KEEPME')), first);
	//the same image again is a retry of an upload that went through
	assert.strictEqual((await upload('KEEPME', first)).status, 200);
	assert.deepStrictEqual(fs.readFileSync(path.join(imgDir, 'KEEPME')), first);
	assert.deepStrictEqual(leftovers(), []);
});

test('concurrent uploads of one name: exactly one wins', async () => {
	const results = await Promise.all([1, 2, 3, 4].map(async (i) => (await upload('RACE', await jpeg(i * 50, 0, 0))).status));
	assert.strictEqual(results.filter((s) => s === 200).length, 1);
	assert.ok(results.every((s) => s === 200 || s === 409));
	assert.deepStrictEqual(leftovers(), []);
});

test('names that would hide a file or are not plain names are refused', async () => {
	for (const name of ['.hidden', 'bad name.jpg', 'a%2Fb.jpg']) {
		const res = await upload(name, await jpeg(1, 2, 3));
		assert.strictEqual(res.status, 400, name);
	}
	assert.deepStrictEqual(leftovers(), []);
});

test('a path in the uploaded name never leaves the images directory', async () => {
	//multer keeps only the last path part of the name
	const res = await upload('../../escape.jpg', await jpeg(1, 2, 3));
	assert.strictEqual(res.status, 200);
	assert.ok(fs.existsSync(path.join(imgDir, 'escape.jpg')));
	assert.ok(!fs.existsSync(path.join(ROOT, 'escape.jpg')));
	assert.ok(!fs.existsSync(path.join(ROOT, '..', 'escape.jpg')));
});

test('a file that is not an image is not published', async () => {
	const res = await upload('NOTANIMAGE', Buffer.from('<html>hello</html>'));
	assert.strictEqual(res.status, 415);
	assert.ok(!fs.existsSync(path.join(imgDir, 'NOTANIMAGE')));
	assert.deepStrictEqual(leftovers(), []);
});

test('an image over the size limit is refused', async () => {
	const res = await upload('TOOBIG', Buffer.alloc(1024 * 1024 + 1));
	assert.strictEqual(res.status, 413);
	assert.ok(!fs.existsSync(path.join(imgDir, 'TOOBIG')));
	assert.deepStrictEqual(leftovers(), []);
});

test('a wrong key uploads nothing', async () => {
	const res = await upload('NOKEY', await jpeg(9, 9, 9), 'wrong');
	assert.strictEqual(res.status, 403);
	assert.ok(!fs.existsSync(path.join(imgDir, 'NOKEY')));
});

test('/fetchMeta is gone', async () => {
	const res = await fetch(base + '/fetchMeta/x');
	assert.strictEqual(res.status, 410);
});
