/** One-off: embed the whole eval catalog into the dense cache (for the hybrid-full ranker). */
import { buildCatalog } from './eval.js';
import { DenseIndex, denseDocText } from '../../src/runtime/kernel/dense.js';

const cachePath = process.env.DENSE_CACHE ?? '/home/box/models/dense-cache.json.gz';
const { catalog } = buildCatalog();
const dense = new DenseIndex({ cachePath });
console.log('loaded', await dense.load());
const docs = catalog.allEntries().map((e) => ({ id: e.id, text: denseDocText(e) }));
const t0 = Date.now();
for (let i = 0; i < docs.length; i += 2048) {
  await dense.ensure(docs.slice(i, i + 2048));
  console.log(dense.size, `${Math.round((Date.now() - t0) / 1000)}s`);
  if (i % 8192 === 0) await dense.save();
}
await dense.save();
console.log('done', dense.size);
