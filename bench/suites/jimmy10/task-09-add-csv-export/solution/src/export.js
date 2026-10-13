import { toCsv } from './csv.js';
export function exportUsers(users) {
  return toCsv(users, ['id', 'name', 'email']);
}
