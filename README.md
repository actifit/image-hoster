Actifit's own image hosting server
Handles uploads from different Actifit services

## Image orientation

Uploads are turned upright on arrival and their metadata is removed (see `orientation.js`). The orientation is read from the raw EXIF bytes when sharp cannot parse the EXIF block, which happens with a broken thumbnail pointer.

To repair images stored before that fix, run `scripts/fix-orientation.js`. It is a dry run unless given `--apply`:

```
node scripts/fix-orientation.js loadedimgs/                       # list only
node scripts/fix-orientation.js --apply --bucket loadedimgs/      # rewrite, and the bucket copy
```

Rewritten names are appended to `fixed-orientation.txt`. Images are served as immutable, so purge those URLs from the CDN cache afterwards.

Tests: `npm test` (Node 18+).
