---
title: Redis 调优篇：内存淘汰、持久化与高并发连接
date: 2024-05-16 10:00:00
categories:
  - 调优
  - 中间件
tags:
  - Redis
  - 缓存
  - 高并发
---

<h2>内存模型与淘汰策略选择</h2>
<p>先区分 Redis 是缓存、会话、排行榜还是主数据副本。缓存可容忍逐出时使用 <code>allkeys-lfu</code>；仅对带 TTL 的键逐出时才选择 <code>volatile-*</code>。每个业务键必须定义 TTL、最大值和失效后的降级行为，避免没有过期时间的 key 挤占热数据。</p>
<pre><code># 采集内存碎片、大 key 和复制压力
redis-cli info memory
redis-cli memory stats
redis-cli --memkeys
redis-cli info replication
redis-cli latency doctor</code></pre>
<h2>客户端连接与故障切换</h2>
<p>连接池上限要乘以实例数计算，不要让每个应用实例创建数百条空闲长连接。读写分离要接受复制延迟，不能把强一致读路由到副本。哨兵或 Cluster 切换时客户端需刷新拓扑并设定合理的 connect/read timeout，业务侧仍需具备缓存未命中回源保护。</p>
<table><tr><th>异常</th><th>优先检查</th><th>处理方向</th></tr><tr><td>延迟尖刺</td><td>slowlog、fork、AOF rewrite、交换分区</td><td>拆分大 key、安排重写窗口</td></tr><tr><td>频繁逐出</td><td>maxmemory、TTL、内存碎片</td><td>扩容或缩短无效数据生命周期</td></tr><tr><td>主从延迟</td><td>网络、repl backlog、输出缓冲</td><td>减少大命令和复制阻塞</td></tr></table>
<p class="tuning-lead">Redis 7.x 调优重点是避免阻塞命令、控制内存水位、明确 AOF/RDB 安全目标，并让连接池与超时可观测。</p>

<!-- more --><h2>redis.conf 基线</h2><pre><code>maxmemory 12gb

maxmemory-policy allkeys-lfu
appendonly yes
appendfsync everysec
no-appendfsync-on-rewrite yes
save 900 1
save 300 10
tcp-keepalive 60
maxclients 20000
activedefrag yes
lazyfree-lazy-eviction yes</code></pre><p>建议 maxmemory 不超过物理内存 70%，为复制缓冲、AOF 重写和输出缓冲预留空间。缓存场景用 allkeys-lfu，重要数据评估 AOF everysec。</p><h2>热点与大 key</h2><pre><code>redis-cli --bigkeys
redis-cli --hotkeys
redis-cli slowlog get 20
redis-cli info commandstats</code></pre><p>大集合删除用 UNLINK，遍历用 SCAN，禁止线上 KEYS *；集群热点用 hash tag 拆分，关注 evicted_keys、blocked_clients 和复制延迟。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://redis.io/docs/latest/operate/oss_and_stack/management/config/" target="_blank" rel="noopener">Redis 配置</a></li><li><a href="https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/" target="_blank" rel="noopener">Redis 延迟诊断</a></li><li><a href="https://help.aliyun.com/zh/apsaradb-for-redis/user-guide/optimize-the-performance-of-an-apsaradb-for-redis-instance" target="_blank" rel="noopener">阿里云 Redis 调优</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: redis
  become: true
  tasks:
    - name: 安装 Redis
      ansible.builtin.apt: {name: redis-server, state: present, update_cache: true}
    - name: 写入调优配置
      ansible.builtin.blockinfile:
        path: /etc/redis/redis.conf
        marker: "# {mark} ANSIBLE 调优"
        block: |
          maxmemory 12gb
          maxmemory-policy allkeys-lfu
          appendonly yes
          appendfsync everysec
          activedefrag yes
      notify: 重启 Redis
  handlers:
    - name: 重启 Redis
      ansible.builtin.service: {name: redis-server, state: restarted}</code></pre>
