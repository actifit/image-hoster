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

test.before(async () => {
	fs.mkdirSync(imgDir, { recursive: true });
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'image-hoster-'));
	fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({ IMG_DIR, SEC_UPL_KEE: KEY }));
	server = spawn(process.execPath, [path.join(ROOT, 'index.js')], { cwd, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(base + '/')).ok) return;
		} catch (e) { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error('server did not start');
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

const leftovers = () => fs.readdirSync(imgDir).filter((f) => f.startsWith('.'));

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
	assert.strictEqual(res.status, 500);
	assert.ok(!fs.existsSync(path.join(imgDir, 'NOTANIMAGE')));
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
