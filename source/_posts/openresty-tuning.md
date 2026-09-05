---
title: OpenResty 调优篇：事件模型、缓存与 LuaJIT
date: 2024-12-12 10:00:00
categories:
  - 调优
  - 网关
tags:
  - OpenResty
  - Nginx
  - LuaJIT
---

<h2>事件循环的边界</h2>
<p>每个 worker 处理大量非阻塞连接，但一段阻塞 Lua、DNS 查询、磁盘 I/O 或过重正则都可能拖慢该 worker。请求路径只做鉴权、路由、缓存和轻量转换；复杂计算交给上游服务或异步队列。Lua 代码使用 cosocket，避免直接调用阻塞系统命令。</p>
<pre><code># 快速检查配置与连接状态
openresty -t
curl -s http://127.0.0.1/nginx_status
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log</code></pre>
<h2>缓存正确性</h2>
<p>缓存键必须包含影响响应的租户、语言、认证状态和必要请求头；缓存响应不要误包含 Set-Cookie。对回源失败设置 stale-while-revalidate 或短暂 stale 响应能提升可用性，但敏感数据和权限变更接口必须主动失效。限流 key 用用户、IP 或 API 维度组合，避免 NAT 场景误伤。</p>
<p class="tuning-lead">OpenResty 基于 Nginx 事件循环和 LuaJIT。调优关键是 worker、连接上限、proxy 缓冲和 Lua 共享字典；请求路径禁止阻塞 I/O。</p>

<!-- more --><h2>nginx.conf 基线</h2><pre><code>worker_processes auto;

worker_rlimit_nofile 200000;
events { use epoll; worker_connections 65535; multi_accept on; }
http {
  sendfile on; tcp_nopush on; tcp_nodelay on;
  keepalive_timeout 30; keepalive_requests 1000;
  proxy_http_version 1.1; proxy_buffering on;
  proxy_buffers 16 16k; proxy_busy_buffers_size 64k;
  lua_shared_dict metrics 20m;
  gzip on; gzip_comp_level 5;
}</code></pre><h2>Lua、缓存与验收</h2><p>使用 lua-resty-redis 连接池并调用 set_keepalive；共享字典用于限流和热点缓存。动态接口使用 proxy_cache_lock 抑制击穿，静态资源使用 immutable 长缓存。关注 active/reading/writing、upstream 响应时间、Lua GC、4xx/5xx。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://openresty.org/en/" target="_blank" rel="noopener">OpenResty 官方文档</a></li><li><a href="https://docs.nginx.com/nginx/admin-guide/optimizing-performance/" target="_blank" rel="noopener">Nginx 性能优化</a></li><li><a href="https://help.aliyun.com/zh/ecs/user-guide/optimize-nginx" target="_blank" rel="noopener">阿里云 Nginx 优化</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: openresty
  become: true
  tasks:
    - name: 部署 OpenResty 配置
      ansible.builtin.template:
        src: nginx.conf.j2
        dest: /usr/local/openresty/nginx/conf/nginx.conf
        mode: '0644'
      notify: 重载 OpenResty
  handlers:
    - name: 重载 OpenResty
      ansible.builtin.service: {name: openresty, state: reloaded}</code></pre>
