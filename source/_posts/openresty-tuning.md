---
title: OpenResty 调优
date: 2025-04-17 10:00:00
updated: 2025-12-31 14:00:00
description: OpenResty 从事件循环、连接预算、上游连接池、缓存、TLS、LuaJIT 和限流入手，完成网关性能调优。
categories:
  - 调优
  - 网关
tags:
  - OpenResty
  - Nginx
  - LuaJIT
---

OpenResty 把 Nginx 事件模型与 LuaJIT 组合在一起。调优重点是保证 worker 不执行阻塞操作、复用上下游连接，并用有界缓存、限流和超时把过载挡在入口。

<!-- more -->

## 1. 先画出请求预算

```text
客户端 -> TLS/HTTP -> OpenResty worker -> Lua 阶段
       -> upstream keepalive -> 应用 -> 数据库/缓存
       <- buffer/stream      <- 响应
```

入口总超时应大于上游 connect/send/read 超时之和并留出重试预算。不要让 OpenResty 超时 60 s，而应用 3 s 早已失败；也不要让客户端 3 s 超时、网关仍在后台执行 60 s。

基线指标：RPS、活动/等待连接、握手 p99、upstream connect/header/response time、状态码、worker CPU、RSS、磁盘临时文件、Lua 错误和共享字典水位。

## 2. Worker 与连接容量

```nginx
worker_processes auto;
worker_rlimit_nofile 262144;

events {
    worker_connections 65535;
    multi_accept off;
}
```

`worker_connections` 包含客户端和上游连接。反向代理最坏情况下一个请求占两条连接：

```text
理论连接上限 ≈ worker_processes × worker_connections
实际客户端上限 < 理论值 ÷ 2，并受文件句柄、内存和上游池限制
```

`multi_accept on` 会让单 worker 一次接受尽可能多连接，突发场景可能降低公平性；先保留默认并压测。现代 Linux 的事件模型由 Nginx 自动选择，无需机械配置 `use epoll`。

## 3. 基础 HTTP 配置

```nginx
http {
    include       mime.types;
    default_type  application/octet-stream;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;

    keepalive_timeout 30s;
    keepalive_requests 1000;
    client_header_timeout 10s;
    client_body_timeout 15s;
    send_timeout 15s;

    client_max_body_size 10m;
    client_body_buffer_size 128k;
    large_client_header_buffers 4 16k;

    server_tokens off;
}
```

`sendfile` 适合静态文件；容器、网络文件系统和特定缓存一致性场景要验证。请求体大小按接口分层配置，上传服务不应迫使所有 API 放开大 body。

## 4. 上游连接池和失败边界

```nginx
upstream app_backend {
    zone app_backend 64k;
    least_conn;
    server 10.0.3.11:8080 max_fails=3 fail_timeout=10s;
    server 10.0.3.12:8080 max_fails=3 fail_timeout=10s;
    keepalive 128;
    keepalive_requests 1000;
    keepalive_timeout 30s;
}

server {
    listen 443 ssl;

    location /api/ {
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Request-Id $request_id;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 1s;
        proxy_send_timeout 3s;
        proxy_read_timeout 3s;
        proxy_next_upstream error timeout http_502 http_503;
        proxy_next_upstream_tries 2;
        proxy_pass http://app_backend;
    }
}
```

`keepalive 128` 是每个 worker 的空闲上游连接缓存，不是全局最大连接数。上游真实连接数要乘 worker 数，并与 Tomcat/应用 `maxConnections` 对齐。

非幂等 POST 默认不要跨上游重试；即使配置了重试条件，也要确认请求体是否已发送及业务幂等。重试次数必须进入容量预算。

## 5. 缓冲、流式响应和临时文件

普通小响应开启 proxy buffering，可以让上游更快释放连接并隔离慢客户端：

```nginx
proxy_buffering on;
proxy_buffer_size 16k;
proxy_buffers 16 16k;
proxy_busy_buffers_size 64k;
proxy_max_temp_file_size 256m;
```

SSE、WebSocket 和真正的流式下载要关闭缓冲，并分别设置长连接超时。缓冲过小会写临时文件，过大则按并发占用大量内存；观察 `$upstream_response_length`、临时目录 I/O 和 worker RSS 后调整。

## 6. gzip、Brotli 与 TLS

```nginx
gzip on;
gzip_comp_level 5;
gzip_min_length 1024;
gzip_vary on;
gzip_types text/plain text/css application/json application/javascript application/xml;
```

不要压缩 JPEG、ZIP、视频等格式。等级越高 CPU 成本增长明显，5～6 通常是起点。Brotli 需要对应模块，静态资源可优先离线压缩。

TLS 应启用会话复用并使用现代协议：

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_session_cache shared:SSL:20m;
ssl_session_timeout 10m;
ssl_session_tickets off;
```

密码套件按 OpenSSL 和合规要求配置，不要复制多年未更新的长列表。证书私钥权限最小化，更新后执行 `openresty -t` 再 reload。

## 7. 缓存只解决可缓存请求

```nginx
proxy_cache_path /data/openresty/cache
    levels=1:2
    keys_zone=api_cache:100m
    max_size=20g
    inactive=30m
    use_temp_path=off;

map $request_method $skip_cache {
    default 1;
    GET 0;
    HEAD 0;
}
```

缓存 Key 必须包含真正影响响应的租户、查询参数和版本，不能缓存带个人权限的响应。设置 stale 策略前要确认业务允许返回旧数据，并监控 HIT/MISS/BYPASS/EXPIRED。

缓存击穿用锁、过期抖动和后台更新治理。缓存目录磁盘满不能影响日志和系统盘。

## 8. 限流、连接限制和背压

```nginx
limit_req_zone $binary_remote_addr zone=api_rate:20m rate=20r/s;
limit_conn_zone $binary_remote_addr zone=per_ip_conn:20m;

location /api/ {
    limit_req zone=api_rate burst=40 nodelay;
    limit_conn per_ip_conn 20;
    limit_req_status 429;
    limit_conn_status 429;
    proxy_pass http://app_backend;
}
```

按 IP 限流在 NAT、企业出口和 IPv6 场景可能误伤，应优先用已认证租户/API Key。`burst` 是队列/突发额度，不是免费吞吐；压测 429 比例和恢复速度。

## 9. LuaJIT 热路径

### 9.1 禁止阻塞事件循环

Lua 阶段不能调用阻塞 DNS、文件 I/O、系统命令或非 cosocket 网络库。使用 `lua-resty-http`、`lua-resty-redis` 等基于 cosocket 的库，并设置超时与 keepalive。

```lua
local http = require "resty.http"
local client = http.new()
client:set_timeouts(500, 1000, 2000)

local response, error_message = client:request_uri("http://config.internal/v1/rules", {
    method = "GET",
    keepalive = true,
})

if not response then
    ngx.log(ngx.ERR, "规则服务调用失败: ", error_message)
    return ngx.exit(ngx.HTTP_SERVICE_UNAVAILABLE)
end
```

### 9.2 模块、共享字典和定时器

- `require` 放模块顶层，利用每 worker 模块缓存；
- `lua_shared_dict` 是固定容量，写入失败必须处理；
- 不在 `access_by_lua*` 中拼接大字符串或解码无界 JSON；
- `ngx.timer.at/every` 回调要限并发、捕获错误并可退出；
- 避免每请求读取配置文件，配置通过共享字典或 worker 本地缓存更新。

共享字典 `get_keys(0)` 会全量扫描，不能用于线上高频路径。

## 10. 日志和观测

```nginx
log_format timing escape=json
  '{"time":"$time_iso8601","request_id":"$request_id",'
  '"status":$status,"request_time":$request_time,'
  '"upstream_connect_time":"$upstream_connect_time",'
  '"upstream_header_time":"$upstream_header_time",'
  '"upstream_response_time":"$upstream_response_time"}';

access_log /var/log/openresty/access.log timing buffer=256k flush=1s;
```

日志不要记录令牌、Cookie 和完整请求体。高峰期同步写日志也会成为瓶颈，使用缓冲并让采集器限队列。监控 `stub_status`/VTS、Lua 共享字典和上游指标。

## 11. 压测和回滚

依次测试短连接、keep-alive、TLS、缓存命中/未命中、慢客户端、上游超时、大响应和限流。观测 p95/p99、worker CPU/RSS、active/waiting connections、upstream time、临时文件、错误码和文件句柄。

所有配置通过 `openresty -t` 后 reload；保留上一版本配置。Reload 会优雅退出旧 worker，但长连接可能让旧 worker 保留较久，需要监控旧进程。

## 12. 参考资料

- [OpenResty 官方文档](https://openresty.org/en/)
- [lua-nginx-module 指令](https://github.com/openresty/lua-nginx-module#readme)
- [OpenResty 最佳实践](https://github.com/moonbingbing/openresty-best-practices)
- [Nginx 性能调优](https://docs.nginx.com/nginx/admin-guide/monitoring/debugging/)
- [Nginx Proxy 模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [Nginx 限流](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)
- [阿里云 OpenResty 性能优化实践](https://help.aliyun.com/zh/api-gateway/traditional-api-gateway/user-guide/performance-white-paper/)

## 13. Ansible 配置

```yaml openresty-tuning.yml
---
- name: 部署 OpenResty 调优配置
  hosts: openresty_gateways
  become: true
  tasks:
    - name: 创建缓存目录
      ansible.builtin.file:
        path: /data/openresty/cache
        state: directory
        owner: www-data
        group: www-data
        mode: "0750"

    - name: 写入主配置
      ansible.builtin.copy:
        dest: /usr/local/openresty/nginx/conf/nginx.conf
        mode: "0644"
        backup: true
        content: |
          worker_processes auto;
          worker_rlimit_nofile 262144;
          error_log /var/log/openresty/error.log warn;
          pid /run/openresty.pid;

          events {
              worker_connections 65535;
              multi_accept off;
          }

          http {
              include mime.types;
              default_type application/octet-stream;
              sendfile on;
              tcp_nopush on;
              tcp_nodelay on;
              keepalive_timeout 30s;
              keepalive_requests 1000;
              client_header_timeout 10s;
              client_body_timeout 15s;
              send_timeout 15s;
              client_max_body_size 10m;
              server_tokens off;
              gzip on;
              gzip_comp_level 5;
              gzip_min_length 1024;
              gzip_types text/plain text/css application/json application/javascript application/xml;
              include conf.d/*.conf;
          }
        validate: /usr/local/openresty/bin/openresty -t -c %s
      notify: 重载 OpenResty

    - name: 配置服务文件句柄
      ansible.builtin.copy:
        dest: /etc/systemd/system/openresty.service.d/limits.conf
        mode: "0644"
        content: |
          [Service]
          LimitNOFILE=262144
      notify:
        - 重载 systemd
        - 重载 OpenResty

  handlers:
    - name: 重载 systemd
      ansible.builtin.systemd_service:
        daemon_reload: true

    - name: 重载 OpenResty
      ansible.builtin.service:
        name: openresty
        state: reloaded
```
