'use strict';

const fs = require('fs');
const path = require('path');

// 只发布页面实际使用的本地依赖，避免第三方 CDN 影响首屏和站内跳转。
hexo.extend.generator.register('local-vendors', () => {
  const fontAwesomeRoot = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));
  const pjaxFile = require.resolve('@next-theme/pjax/pjax.min.js');
  const searchFile = require.resolve('hexo-generator-searchdb/dist/search.js');
  const assets = [
    {
      path: 'lib/pjax/pjax.min.js',
      data: () => fs.createReadStream(pjaxFile)
    },
    {
      path: 'lib/fontawesome/css/all.min.css',
      data: () => fs.createReadStream(path.join(fontAwesomeRoot, 'css', 'all.min.css'))
    },
    {
      path: 'lib/search/search.js',
      data: () => fs.createReadStream(searchFile)
    }
  ];

  for (const file of fs.readdirSync(path.join(fontAwesomeRoot, 'webfonts'))) {
    assets.push({
      path: `lib/fontawesome/webfonts/${file}`,
      data: () => fs.createReadStream(path.join(fontAwesomeRoot, 'webfonts', file))
    });
  }

  return assets;
});
