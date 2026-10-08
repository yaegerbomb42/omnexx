const USERS = { 1: { id: 1, name: 'Ada' }, 2: { id: 2, name: 'Linus' } };
export function getUser(id) {
  return USERS[id] ?? null;
}
