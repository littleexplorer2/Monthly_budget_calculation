'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Load the exact production script list; each script keeps its own scope. */
function loadFrontend(context, webRoot = path.join(__dirname, '..', '..', 'web')) {
  const html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script\s+src="([^"?]+)(?:\?[^\"]*)?"\s*><\/script>/g), (match) => match[1]);
  for (const relativePath of scripts) {
    if (relativePath.startsWith('vendor/')) continue;
    const filename = path.resolve(webRoot, relativePath);
    if (!filename.startsWith(path.resolve(webRoot) + path.sep)) throw new Error('脚本路径超出 web/：' + relativePath);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  return context.window.BudgetApp;
}

module.exports = { loadFrontend };
