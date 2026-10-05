#!/usr/bin/env bash
set -euo pipefail

cat > package.json << 'EOF'
{
  "name": "refactor-legacy-code",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
EOF

mkdir -p src test

cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowJs": true,
    "checkJs": false
  },
  "include": ["src"]
}
EOF

cat > src/legacy.js << 'EOF'
// Legacy JavaScript - needs refactoring to TypeScript

var fetchUserData = function(userId, callback) {
  var url = 'https://api.example.com/users/' + userId;
  fetch(url)
    .then(function(response) { return response.json(); })
    .then(function(data) { callback(null, data); })
    .catch(function(err) { callback(err, null); });
};

var processUsers = function(userIds, callback) {
  var results = [];
  var completed = 0;
  
  userIds.forEach(function(id) {
    fetchUserData(id, function(err, data) {
      if (err) {
        callback(err, null);
        return;
      }
      results.push(data);
      completed++;
      if (completed === userIds.length) {
        callback(null, results);
      }
    });
  });
};

var formatUserName = function(user) {
  return user.firstName + ' ' + user.lastName;
};

var getUserEmails = function(users) {
  var emails = [];
  for (var i = 0; i < users.length; i++) {
    emails.push(users[i].email);
  }
  return emails;
};

module.exports = {
  fetchUserData: fetchUserData,
  processUsers: processUsers,
  formatUserName: formatUserName,
  getUserEmails: getUserEmails
};
EOF

cat > test/legacy.test.js << 'EOF'
import { describe, it, expect, vi } from 'vitest';
import * as legacy from '../src/legacy.js';

describe('legacy', () => {
  it('formats user name', () => {
    const user = { firstName: 'John', lastName: 'Doe', email: 'john@example.com' };
    expect(legacy.formatUserName(user)).toBe('John Doe');
  });

  it('gets user emails', () => {
    const users = [
      { firstName: 'John', lastName: 'Doe', email: 'john@example.com' },
      { firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com' }
    ];
    expect(legacy.getUserEmails(users)).toEqual(['john@example.com', 'jane@example.com']);
  });
});
EOF

npm install