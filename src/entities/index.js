const fs = require('fs');
const path = require('path');

const distEntry = path.join(__dirname, '../../dist/entities');
const distIndexFile = path.join(distEntry, 'index.js');
const isTsNodeRuntime = Boolean(process[Symbol.for('ts-node.register.instance')]);

if (!isTsNodeRuntime && fs.existsSync(distIndexFile)) {
    module.exports = require(distEntry);
} else {
    module.exports = require('./index.ts');
}
