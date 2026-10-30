Actifit's own image hosting server
Handles uploads from different Actifit services

## Image orientation

Uploads are turned upright on arrival (see `orientation.js`). An image that needs rotating is rewritten without its metadata. One that is already upright is stored as sent, EXIF included. The orientation is read from the raw EXIF bytes when sharp cannot parse the EXIF block, which happens with a broken thumbnail pointer.

To repair images stored before that fix, run the repair scripts from the app directory. Both are dry runs unless given `--apply`.

Most images live only in object storage, so start with the bucket:

```
node scripts/fix-orientation-bucket.js                                          # list candidates
node scripts/fix-orientation-bucket.js --apply --keys=orientation-candidates.tsv   # fix them
node scripts/fix-orientation-bucket.js --apply --keys=orientation-errors.txt       # retry failures
```

- Each object is checked from its first 64 KB. Candidates go to `orientation-candidates.tsv` as they are found.
- Before an object is replaced, the original is copied to `orient-backup/<key>` in the same bucket. Delete that prefix once the result looks right.
- A local copy in `IMG_DIR` is rewritten too.
- `--concurrency=N` sets parallel checks (default 32).

`scripts/fix-orientation.js` does the same for files on local disk (`node scripts/fix-orientation.js [--apply] [--bucket] loadedimgs/`). The bucket script already covers local copies of bucket objects.

Both scripts append each fixed name to `fixed-orientation.txt` as it is written. Images are served as immutable, so purge those URLs from the CDN afterwards. Browsers and third-party image proxies that already cached a copy keep it until their own cache expires.

Tests: `npm test` (Node 18+).
