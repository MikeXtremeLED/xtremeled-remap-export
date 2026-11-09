'use strict';
// Runs after npm install and before npm start: says clearly when this setup can't run the
// app, because Electron's own installer can finish "successfully" without an Electron.
const fs = require('fs');
const path = require('path');

const WANTED_NODE = 22;

function nodeProblem(version) {
  const major = parseInt(String(version).replace(/^v/, ''), 10);
  if (major === WANTED_NODE) return null;
  return `Node ${version} is in use; this project is built and tested on Node ${WANTED_NODE} (see .nvmrc). On other versions the Electron install can end without the program.`;
}

function electronProblem(root) {
  const dir = path.join(root, 'node_modules', 'electron');
  if (!fs.existsSync(path.join(dir, 'package.json'))) return 'Electron is not installed. Run "npm install".';
  let rel = '';
  try {
    rel = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim();
  } catch (e) {
    /* reported below */
  }
  if (rel && fs.existsSync(path.join(dir, 'dist', rel))) return null;
  return `Electron was installed without its program (${path.join('node_modules', 'electron', 'dist')} is incomplete). This happens on Node versions other than ${WANTED_NODE}. Install Node ${WANTED_NODE}, remove node_modules and run "npm ci".`;
}

function main() {
  const root = path.join(__dirname, '..');
  const nodeNote = nodeProblem(process.version);
  if (nodeNote) console.warn(`WARNING: ${nodeNote}`);
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) return;
  const problem = electronProblem(root);
  if (problem) {
    console.error(`\nERROR: ${problem}\n`);
    process.exit(1);
  }
}

module.exports = { nodeProblem, electronProblem, WANTED_NODE };

if (require.main === module) main();
