const fs = require('fs');
const path = require('path');

const RESPONDER_FILE = path.join(__dirname, 'autoresponder.json');

function loadPairs() {
  if (!fs.existsSync(RESPONDER_FILE)) return [];
  return JSON.parse(fs.readFileSync(RESPONDER_FILE, 'utf-8'));
}

function savePairs(pairs) {
  fs.writeFileSync(RESPONDER_FILE, JSON.stringify(pairs, null, 2));
}

function addPair(question, answer) {
  const pairs = loadPairs();
  pairs.push({ question, answer });
  savePairs(pairs);
}

function removePair(index) {
  const pairs = loadPairs();
  pairs.splice(index, 1);
  savePairs(pairs);
}

function updatePair(index, question, answer) {
  const pairs = loadPairs();
  if (pairs[index]) {
    pairs[index] = { question, answer };
    savePairs(pairs);
  }
}

function findPairInsensitive(txt) {
  const pairs = loadPairs();
  return pairs.find(p => p.question.trim().toLowerCase() === txt.trim().toLowerCase());
}

module.exports = { loadPairs, savePairs, addPair, removePair, updatePair, findPairInsensitive };