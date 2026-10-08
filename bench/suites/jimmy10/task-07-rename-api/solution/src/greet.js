import { getUser } from './user.js';
export function greet(id) {
  const u = getUser(id);
  return u ? `Hello, ${u.name}` : 'Hello, stranger';
}
