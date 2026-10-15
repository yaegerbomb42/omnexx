var TODOS = [
  { text: 'Buy milk', done: true },
  { text: 'Walk the dog', done: false },
  { text: 'Ship the release', done: false },
];

function render() {
  var list = document.getElementById('todo-list');
  TODOS.forEach(function (todo) {
    var li = document.createElement('li');
    li.textContent = todo.title;
    if (todo.done) li.className = 'done';
    list.appendChild(li);
  });
  var left = TODOS.filter(function (t) {
    return !t.done;
  }).length;
  document.getElementById('summary').textContent = left + ' left';
}

render();
