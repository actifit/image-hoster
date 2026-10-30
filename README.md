Actifit's own image hosting server
Handles uploads from different Actifit services

## Image orientation

Uploads are turned upright on arrival (see `orientation.js`). An image that needs rotating is rewritten without its metadata. One that is already upright is stored as sent, EXIF included. The orientation is read from the raw EXIF bytes when sharp cannot parse the EXIF block, which happens with a broken thumbnail pointer.

To repair images stored before that fix, run `scripts/fix-orientation.js` from the app directory. It is a dry run unless given `--apply`. Pass every storage directory: the local image dir and the mounted volume (`EXTRA_STRG` + `IMG_DIR`).

```
node scripts/fix-orientation.js loadedimgs/ /mnt/VOLUME/loadedimgs/                    # list only
node scripts/fix-orientation.js --apply --bucket loadedimgs/ /mnt/VOLUME/loadedimgs/   # rewrite, and the bucket copies
```

- `--bucket` replaces the object-storage copy of each fixed file. Objects that exist only in the bucket are not scanned.
- `--since=YYYY-MM-DD` skips files last modified before that date (UTC).
- Each fixed name is appended to `fixed-orientation.txt` as it is written. Images are served as immutable, so purge those URLs from the CDN afterwards. Browsers and third-party image proxies that already cached a copy keep it until their own cache expires.

Tests: `npm test` (Node 18+).
