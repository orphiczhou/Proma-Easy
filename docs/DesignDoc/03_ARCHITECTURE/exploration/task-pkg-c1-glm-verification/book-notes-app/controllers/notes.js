const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'notes.json');

function readNotes() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
    return [];
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  return JSON.parse(raw);
}

function writeNotes(notes) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(notes, null, 2), 'utf-8');
}

let nextId = 1;

function initIdCounter(notes) {
  if (notes.length > 0) {
    nextId = Math.max(...notes.map(n => n.id)) + 1;
  }
}

const _notes = readNotes();
initIdCounter(_notes);

exports.getAll = (req, res) => {
  const notes = readNotes();
  const { category } = req.query;
  if (category) {
    return res.json(notes.filter(n => n.category === category));
  }
  res.json(notes);
};

exports.getById = (req, res) => {
  const notes = readNotes();
  const note = notes.find(n => n.id === parseInt(req.params.id));
  if (!note) {
    return res.status(404).json({ error: '笔记未找到' });
  }
  res.json(note);
};

exports.create = (req, res) => {
  const { title, author, content, category } = req.body;

  if (!title || title.trim() === '') {
    return res.status(400).json({ error: '请输入书名' });
  }

  const notes = readNotes();
  const note = {
    id: nextId++,
    title: title.trim(),
    author: (author || '').trim(),
    content: (content || '').trim(),
    category: (category || '未分类').trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  notes.push(note);
  writeNotes(notes);
  res.status(201).json(note);
};

exports.update = (req, res) => {
  const { title, author, content, category } = req.body;
  const notes = readNotes();
  const index = notes.findIndex(n => n.id === parseInt(req.params.id));

  if (index === -1) {
    return res.status(404).json({ error: '笔记未找到' });
  }

  if (title !== undefined && title.trim() === '') {
    return res.status(400).json({ error: '请输入书名' });
  }

  notes[index] = {
    ...notes[index],
    ...(title !== undefined && { title: title.trim() }),
    ...(author !== undefined && { author: author.trim() }),
    ...(content !== undefined && { content: content.trim() }),
    ...(category !== undefined && { category: category.trim() }),
    updatedAt: new Date().toISOString()
  };

  writeNotes(notes);
  res.json(notes[index]);
};

exports.remove = (req, res) => {
  const notes = readNotes();
  const index = notes.findIndex(n => n.id === parseInt(req.params.id));

  if (index === -1) {
    return res.status(404).json({ error: '笔记未找到' });
  }

  const removed = notes.splice(index, 1)[0];
  writeNotes(notes);
  res.json(removed);
};
