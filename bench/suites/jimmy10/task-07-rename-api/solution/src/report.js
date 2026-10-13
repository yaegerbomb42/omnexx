import { getUser } from './user.js';
export function names(ids) {
  return ids.map((id) => getUser(id)?.name ?? '?').join(', ');
}
