# Rename and deletion contract

The sample moves `src/extent.js` to `src/span.js`, reverses a subtraction on line 10 and removes `src/retired-unit.js`. `span([2, 9])` then returns `-7`. The expected span is `7`. The source helper creates the same two Git commits on each run using a fixed author, date and file contents.

A native `ocr review --from BASE --to HEAD` on this range reported the arithmetic finding at the new path and classified the removed file as `deleted`. `inputs/native-projection.json` contains the range, coverage, comment and two aggregate counts from that run. The producer's `createManifest`, `normalizeResult` and `publishReview` functions issued the three consumer inputs. The capture injects a sample installation, implementation and provider identity, and uses an in-memory GitLab transport with sample note and discussion IDs. The exported audit timestamps use a fixed fixture date.

From the repository root, run the offline regression with Node.js and Git:

```sh
node --test packages/ocr-team/tests/producer-rename-delete.test.mjs
```

To inspect the Git range, pass a new directory under an existing parent:

```sh
node scripts/ocr-fixture-range.mjs /path/to/new-sample
```

To replay the checked-in native projection, supply a compatible OCR integration source directory providing the three functions above. The replay creates a new output directory containing `manifest.json`, `result.json` and `publication-receipt.json`. Compare the files byte-for-byte with this directory.

```sh
node scripts/capture-ocr-fixture.mjs /path/to/ocr/integration /path/to/new-receipts
```
