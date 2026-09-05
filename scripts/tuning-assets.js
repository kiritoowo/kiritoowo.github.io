// 为静态页面注入调优专栏样式和 Mermaid 流程图运行时。
hexo.extend.filter.register('after_render:html', function (html) {
  if (html.indexOf('/css/tuning.css') === -1) {
    html = html.replace('</head>', '<link rel="stylesheet" href="/css/tuning.css">\n</head>');
  }
  if (html.indexOf('class="mermaid"') !== -1 && html.indexOf('cdn.jsdelivr.net/npm/mermaid') === -1) {
    html = html.replace('</body>', '<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script><script>mermaid.initialize({startOnLoad:true,theme:"neutral"});</script>\n</body>');
  }
  return html;
});
