const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'notes.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

let nextId = 1;

function readNotes() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
    return [];
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function writeNotes(notes) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(notes, null, 2), 'utf-8');
}

function initIdCounter() {
  const notes = readNotes();
  if (notes.length > 0) {
    nextId = Math.max(...notes.map(function(n) { return n.id; })) + 1;
  }
}

initIdCounter();

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req, callback) {
  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', function() {
    try { callback(null, JSON.parse(body)); }
    catch (e) { callback(e); }
  });
  req.on('error', function(e) { callback(e); });
}

var mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  var safePath = req.url === '/' ? 'index.html' : req.url.split('?')[0];
  var filePath = path.join(PUBLIC_DIR, safePath);

  // 防止路径遍历：确保解析后的路径在 PUBLIC_DIR 内
  var resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    resolved = path.join(PUBLIC_DIR, 'index.html');
  }

  var filePath = resolved;

  var ext = path.extname(filePath);
  var contentType = mimeTypes[ext] || 'application/octet-stream';
  fs.readFile(filePath, function(err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
}

var server = http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;

  if (!pathname.startsWith('/api/')) {
    serveStatic(req, res);
    return;
  }

  // Route matching
  var idMatch = pathname.match(/^\/api\/notes\/(\d+)$/);
  var isCollection = pathname === '/api/notes';

  // GET /api/notes or /api/notes?category=xxx
  if (req.method === 'GET' && isCollection) {
    var notes = readNotes();
    var category = parsed.query.category;
    if (category) {
      sendJSON(res, 200, notes.filter(function(n) { return n.category === category; }));
    } else {
      sendJSON(res, 200, notes);
    }
    return;
  }

  // GET /api/notes/:id
  if (req.method === 'GET' && idMatch) {
    var notes = readNotes();
    var note = notes.find(function(n) { return n.id === parseInt(idMatch[1]); });
    if (!note) { sendJSON(res, 404, { error: '笔记未找到' }); return; }
    sendJSON(res, 200, note);
    return;
  }

  // POST /api/notes
  if (req.method === 'POST' && isCollection) {
    readBody(req, function(err, data) {
      if (err) { sendJSON(res, 400, { error: '无效请求' }); return; }
      if (!data.title || data.title.trim() === '') {
        sendJSON(res, 400, { error: '请输入书名' });
        return;
      }
      var notes = readNotes();
      var note = {
        id: nextId++,
        title: data.title.trim(),
        author: (data.author || '').trim(),
        content: (data.content || '').trim(),
        category: (data.category || '未分类').trim(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      notes.push(note);
      writeNotes(notes);
      sendJSON(res, 201, note);
    });
    return;
  }

  // PUT /api/notes/:id
  if (req.method === 'PUT' && idMatch) {
    readBody(req, function(err, data) {
      if (err) { sendJSON(res, 400, { error: '无效请求' }); return; }
      if (data.title !== undefined && data.title.trim() === '') {
        sendJSON(res, 400, { error: '请输入书名' });
        return;
      }
      var notes = readNotes();
      var index = notes.findIndex(function(n) { return n.id === parseInt(idMatch[1]); });
      if (index === -1) { sendJSON(res, 404, { error: '笔记未找到' }); return; }

      if (data.title !== undefined) notes[index].title = data.title.trim();
      if (data.author !== undefined) notes[index].author = data.author.trim();
      if (data.content !== undefined) notes[index].content = data.content.trim();
      if (data.category !== undefined) notes[index].category = data.category.trim();
      notes[index].updatedAt = new Date().toISOString();

      writeNotes(notes);
      sendJSON(res, 200, notes[index]);
    });
    return;
  }

  // DELETE /api/notes/:id
  if (req.method === 'DELETE' && idMatch) {
    var notes = readNotes();
    var index = notes.findIndex(function(n) { return n.id === parseInt(idMatch[1]); });
    if (index === -1) { sendJSON(res, 404, { error: '笔记未找到' }); return; }
    var removed = notes.splice(index, 1)[0];
    writeNotes(notes);
    sendJSON(res, 200, removed);
    return;
  }

  sendJSON(res, 404, { error: 'Not Found' });
});

server.listen(PORT, function() {
  console.log('读书笔记管理应用已启动: http://localhost:' + PORT);
});
