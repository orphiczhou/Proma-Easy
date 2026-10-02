const express = require('express');
const router = express.Router();
const notesController = require('../controllers/notes');

router.get('/', notesController.getAll);
router.get('/:id', notesController.getById);
router.post('/', notesController.create);
router.put('/:id', notesController.update);
router.delete('/:id', notesController.remove);

module.exports = router;
