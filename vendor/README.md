# Public storage validation

`storage-v1.js` is a local browser bundle of the pure, signature-verifying
`402-announce/storage` parser from registry version 2.3.0. It adds no network,
signer or wallet access. The static site needs no install or build step and
loads no third-party validator script. Source and dependency licences are MIT;
the bundle retains licence comments. The locked source inputs live under
`scripts/storage-vendor/`.

To reproduce after reviewing the locked dependencies:

```sh
cd scripts/storage-vendor
npm ci --ignore-scripts
npm run build
cd ../..
node --test test/*.test.mjs
```

Remove `scripts/storage-vendor/node_modules` after validation. Keep deployment
static; do not turn service inspection, signing or payments into background work.
