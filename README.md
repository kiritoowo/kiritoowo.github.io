# kirito Hexo 博客

本仓库采用同库双分支：

- `hexo-source`：Hexo 配置、主题依赖和 Markdown 源文章。
- `master`：Hexo 生成的静态文件，由 GitHub Pages 发布。

## 本地运行

```bash
npm install
npm run server
```

浏览器打开 `http://localhost:4000/` 预览。

## 新增文章

```bash
npx hexo new post "文章标题"
```

文章放在 `source/_posts/`，Front Matter 支持多个分类：

```yaml
categories:
  - 调优
  - 中间件
tags:
  - Redis
  - 性能优化
```

## 生成与发布

```bash
npm run build
npm run deploy
```

`npm run deploy` 会清理旧产物、重新生成 `public/`，然后将产物推送到 `master`。发布前建议先执行 `npm run server` 检查页面和链接。

## 版本说明

- Hexo 8.1.2
- NexT Pisces 8.29.0
- Node.js 20.19.0 或更高版本

主题配置位于 `_config.next.yml`，不要直接修改 `node_modules/hexo-theme-next`。站内导航使用本地托管的 PJAX，主题脚本、图标和搜索均不依赖运行时外部 CDN。
