/** Fetch all ids with at most `limit` concurrent calls to `fetchOne`. */
export async function loadAll(ids, fetchOne, limit) {
  const results = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      results[i] = await fetchOne(ids[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, worker));
  return results;
}
