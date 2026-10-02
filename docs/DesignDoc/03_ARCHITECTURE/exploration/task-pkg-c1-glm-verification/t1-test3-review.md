# T1.3 测试3：代码审查

## 待审查代码

```javascript
function addTask(title, date, callback) {
  var tasks = localStorage.getItem('tasks')
  if (tasks == null) {
    tasks = []
  } else {
    tasks = JSON.parse(tasks)
  }
  if (title.length > 0) {
    tasks.push({title: title, date: date, done: false})
  }
  localStorage.setItem('tasks', JSON.stringify(tasks))
  callback(tasks)
  return tasks
}
```

---

## 审查结果

### 问题1（严重）：`title` 未做空值保护，导致运行时崩溃

`title.length` 在 `title` 为 `null` 或 `undefined` 时抛出 `TypeError: Cannot read property 'length' of null`。

**修复**：

```javascript
if (title && title.length > 0) {
```

---

### 问题2（中等）：`JSON.parse` 无异常捕获

`localStorage.getItem` 返回的字符串如果被手动篡改为非法 JSON，`JSON.parse(tasks)` 会抛出 `SyntaxError`。

**修复**：

```javascript
try {
  tasks = JSON.parse(tasks);
} catch (e) {
  tasks = [];
}
```

---

### 问题3（中等）：`callback` 未做空值保护

调用方如果未传 `callback` 参数，`callback(tasks)` 会抛出 `TypeError: callback is not a function`。

**修复**：

```javascript
if (typeof callback === 'function') {
  callback(tasks);
}
```

---

### 问题4（建议）：使用 `==` 而非 `===`

`tasks == null` 虽然能同时匹配 `null` 和 `undefined`（在这是有意为之），但不符合 ESLint `eqeqeq` 规则的推荐写法。建议显式写明：

```javascript
if (tasks === null || tasks === undefined) {
```

---

### 问题5（建议）：缺少日期参数验证

`date` 参数无任何校验，可能传入无效日期字符串。

**建议**：对 `date` 做基本校验（如非空且能被 `Date.parse` 解析），或在文档中说明调用方负责校验。

---

### 问题6（建议）：`var` 应替换为 `const` / `let`

在现代 JavaScript 中，`var` 存在变量提升和函数作用域问题，建议使用 `const`（不会被重新赋值的变量）和 `let`（需要重新赋值的变量）。

---

## 修正后的完整代码

```javascript
function addTask(title, date, callback) {
  const raw = localStorage.getItem('tasks');
  let tasks;

  if (raw === null || raw === undefined) {
    tasks = [];
  } else {
    try {
      tasks = JSON.parse(raw);
    } catch (e) {
      tasks = [];
    }
  }

  if (title && title.length > 0) {
    tasks.push({ title, date, done: false });
  }

  localStorage.setItem('tasks', JSON.stringify(tasks));

  if (typeof callback === 'function') {
    callback(tasks);
  }

  return tasks;
}
```

---

## 审查总结

| 严重度 | 数量 | 说明 |
|--------|------|------|
| 严重 | 1 | `title` 空值导致崩溃 |
| 中等 | 2 | `JSON.parse` 无异常捕获、`callback` 无保护 |
| 建议 | 3 | `==` vs `===`、日期校验、`var` → `const/let` |
