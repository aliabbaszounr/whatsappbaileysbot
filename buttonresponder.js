const fs = require('fs');
const path = require('path');

const BUTTON_FILE = path.join(__dirname, 'buttonresponder.json');

function loadButtons() {
  if (!fs.existsSync(BUTTON_FILE)) return [];
  return JSON.parse(fs.readFileSync(BUTTON_FILE, 'utf-8'));
}

function saveButtons(buttons) {
  fs.writeFileSync(BUTTON_FILE, JSON.stringify(buttons, null, 2));
}

function addButton(question, buttons) {
  const buttonPairs = loadButtons();
  buttonPairs.push({ question, buttons });
  saveButtons(buttonPairs);
}

function removeButton(index) {
  const buttonPairs = loadButtons();
  buttonPairs.splice(index, 1);
  saveButtons(buttonPairs);
}

function updateButton(index, question, buttons) {
  const buttonPairs = loadButtons();
  if (buttonPairs[index]) {
    buttonPairs[index] = { question, buttons };
    saveButtons(buttonPairs);
  }
}

function findButtonInsensitive(txt) {
  const buttonPairs = loadButtons();
  const idx = buttonPairs.findIndex(
    p => p.question.trim().toLowerCase() === txt.trim().toLowerCase()
  );
  return { idx, entry: idx !== -1 ? buttonPairs[idx] : null };
}

module.exports = { loadButtons, saveButtons, addButton, removeButton, updateButton, findButtonInsensitive };