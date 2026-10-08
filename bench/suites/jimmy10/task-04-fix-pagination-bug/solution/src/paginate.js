/** Return one 1-based page of `items` plus the total page count. */
export function paginate(items, page, pageSize) {
  const totalPages = Math.ceil(items.length / pageSize);
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, totalPages };
}
