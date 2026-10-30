const fs = require('fs');
const path = require('path');

//errors from AWS HEAD requests have no message, only a code or status
function errorText(err) {
	return err.message || err.code || ('HTTP ' + err.statusCode);
}

//Replace `file` with `data` in one step (temp file + rename), keeping its mode
//and, when allowed, its owner. A reader sees either the old or the new image.
function replaceFile(file, data, st) {
	//leading dot: safeImageName rejects it, so the GET route never serves the temp file
	const tmp = path.join(path.dirname(file), '.orient-tmp-' + process.pid);
	try {
		fs.writeFileSync(tmp, data);
		fs.chmodSync(tmp, st.mode & 0o7777); //writeFileSync's mode would be masked by umask
		try {
			fs.chownSync(tmp, st.uid, st.gid);
		} catch (err) {
			if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
				console.warn('warning: could not keep the owner of ' + file + ' (' + errorText(err) + ')');
			}
		}
		fs.renameSync(tmp, file);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
		throw err;
	}
}

module.exports = { errorText, replaceFile };
