Actifit's own image hosting server
Handles uploads from different Actifit services

## Uploads

`POST /upload` (with the upload key) stores a new image. It is written to a hidden temporary file, turned upright, and only then published under its name, so a half-written or unrotated image is never served. Names must be plain (letters, digits, `.`, `_`, `-`), and an upload may only add a new name: if the name already exists locally or in object storage, the answer is `409` (re-sending the identical image gets `200`, so a retry is safe). If object storage cannot be checked, the answer is `503`. Images over 30 MB (`MAX_UPLOAD_MB`) get `413`, and files that are not images `415`. Temporary files from interrupted uploads are removed after an hour.

## Image orientation

Uploads are turned upright on arrival (see `orientation.js`). An image that needs rotating is rewritten without its metadata. One that is already upright is stored as sent, EXIF included. The orientation is read from the raw EXIF bytes when sharp cannot parse the EXIF block, which happens with a broken thumbnail pointer.

To repair images stored before that fix, run the repair scripts from the app directory. Both are dry runs unless given `--apply`.

Most images live only in object storage, so start with the bucket. Run one instance at a time.

```
node scripts/fix-orientation-bucket.js                                             # list candidates
node scripts/fix-orientation-bucket.js --apply --keys=orientation-candidates.tsv   # fix them
cp orientation-errors.txt retry.txt
node scripts/fix-orientation-bucket.js --apply --keys=retry.txt                    # retry failures
```

- Each object is checked from its first 64 KB, or in full when its EXIF lies further in. Empty objects are counted and skipped.
- Before an object is replaced, the original is copied to `orient-backup/<key>` in the same bucket. An existing backup is never overwritten. Delete that prefix once the result looks right.
- A local copy in `IMG_DIR` is rewritten too.
- `orientation-candidates.tsv` is rewritten by each dry run. `orientation-errors.txt` is rewritten by each run, dry runs included, so retry from a copy.
- If the bucket listing fails part way, the script finishes the work in progress and prints the `--start-after=KEY` to resume from.
- `--concurrency=N` sets the number of parallel checks (default 32). Full rewrites are capped at 2 at a time.

`scripts/fix-orientation.js` does the same for files on local disk (`node scripts/fix-orientation.js [--apply] loadedimgs/`). The bucket script already covers local copies of bucket objects. Its `--bucket` option overwrites the bucket copy **without** a backup, so prefer the bucket script.

Both scripts append each fixed name to `fixed-orientation.txt` as it is written. Images are served as immutable, so purge those URLs from the CDN afterwards. Browsers and third-party image proxies that already cached a copy keep it until their own cache expires.

Tests: `npm test` (Node 18+).
