---
title: Redis 调优
date: 2024-06-13 10:00:00
updated: 2025-12-29 10:00:00
description: 从延迟诊断、内存预算、大 Key 和热 Key 入手，完成 Redis 淘汰、持久化、复制、Cluster 与客户端调优。
categories:
  - 调优
  - 中间件
tags:
  - Redis
  - 缓存
  - 高并发
---

Redis 很快，但它仍受单线程命令执行、内存带宽、fork、持久化磁盘和网络影响。调优主线是先识别阻塞来源，再控制单条命令工作量和总内存，而不是先增加 `maxclients`。

<!-- more -->

## 1. 先区分业务角色

| 角色 | 数据丢失容忍度 | 淘汰策略 | 持久化起点 |
| --- | --- | --- | --- |
| 纯缓存 | 可从源站重建 | `allkeys-lfu` | 可关闭或仅 RDB |
| 会话/令牌 | 少量丢失也影响登录 | `noeviction` 或明确 TTL | AOF everysec + 副本 |
| 排行榜/计数 | 取决于能否重放 | 按键设计 | AOF everysec |
| 主数据 | 通常不适合只放 Redis | `noeviction` | 多副本、AOF、备份 |

每类 Key 都要定义：命名、数据结构、TTL、单 Key 最大元素数、预计 QPS、失效后的回源和降级策略。

## 2. 延迟基线和诊断顺序

```bash
redis-cli --latency
redis-cli --latency-history
redis-cli latency latest
redis-cli latency doctor
redis-cli slowlog get 20
redis-cli info commandstats
```

Redis 内置延迟只覆盖事件循环可见部分；同时测主机固有调度延迟：

```bash
redis-cli --intrinsic-latency 100
```

| 延迟特征 | 优先检查 |
| --- | --- |
| 周期性尖峰 | RDB/AOF rewrite、透明大页、定时任务 |
| 单命令慢 | Slow Log、命令复杂度、大 Key |
| 客户端慢但 Redis 快 | 网络、连接池、客户端队列、DNS |
| 主从切换后抖动 | 拓扑刷新、重连风暴、全量同步 |
| CPU 未满但延迟高 | 单核饱和、fork、内存换页 |

Linux 上关闭 Transparent Huge Pages，并保证 Redis 不发生持续 swap。不要完全关闭系统 OOM 保护；正确做法是给 Redis 留足内存余量并设置 cgroup 限制。

## 3. 内存预算

`maxmemory` 只限制数据和部分开销，不等于进程 RSS 上限。还要预留复制 backlog、客户端输出缓冲、AOF rewrite 写时复制和碎片空间。

```bash
redis-cli info memory
redis-cli memory stats
redis-cli memory doctor
redis-cli info clients
redis-cli info replication
```

24 GiB 专用节点可从 `maxmemory 16gb` 左右开始，给 fork 和复制保留约 30%。写入率高、Key 频繁修改时，AOF rewrite/RDB fork 的 Copy-on-Write 可能接近数据集大小，应以 `used_memory_rss` 峰值校正预算。

关键指标：

- `used_memory`、`used_memory_rss` 和 `mem_fragmentation_ratio`；
- `allocator_frag_ratio`、`allocator_rss_ratio`；
- `evicted_keys`、`expired_keys`；
- `client_recent_max_output_buffer`；
- `latest_fork_usec` 和持久化状态。

碎片率高不一定立即启用 active defrag；RSS 可能来自 allocator 尚未归还的页。先看绝对内存和业务低峰期变化。

## 4. 淘汰与过期策略

缓存默认起点：

```conf
maxmemory 16gb
maxmemory-policy allkeys-lfu
maxmemory-samples 10
lazyfree-lazy-eviction yes
lazyfree-lazy-expire yes
```

`volatile-*` 只会从带 TTL 的 Key 中选择；存在无 TTL Key 时可能没有足够淘汰候选。`noeviction` 会让写命令报错，客户端必须正确处理，不能无限重试。

TTL 增加随机抖动，避免大量 Key 同一秒失效：

```java
// 基础过期 30 分钟，并增加 0～5 分钟随机抖动
Duration ttl = Duration.ofMinutes(30)
    .plusSeconds(ThreadLocalRandom.current().nextLong(301));
```

## 5. 大 Key、热 Key 和危险命令

```bash
# 在副本或低峰执行，避免生产主节点额外压力
redis-cli --bigkeys
redis-cli --memkeys
redis-cli --hotkeys
redis-cli --keystats --top 20
```

`--hotkeys` 依赖 LFU 策略；扫描命令也有成本。生产中优先从采样副本、客户端埋点或阿里云/Tair 的大 Key 分析获取结果。

治理规则：

- 禁止在线使用 `KEYS *`，遍历改用 `SCAN` 并限制 `COUNT`；
- 大 Hash/Set/ZSet 分桶，单次 `HGETALL`、`SMEMBERS` 改分页；
- 删除大对象用 `UNLINK`，过期释放启用 lazyfree；
- 热点计数器按业务键分片后汇总；
- Lua 脚本必须限定遍历量，不能执行不可控循环。

## 6. AOF、RDB 和数据安全

### 6.1 通用重要数据起点

```conf
appendonly yes
appendfsync everysec
no-appendfsync-on-rewrite yes
aof-use-rdb-preamble yes
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 1gb
save 3600 1
save 300 100
```

`appendfsync everysec` 在操作系统故障时可能丢约一秒数据；`always` 更安全但显著增加提交延迟。即使开启 AOF，也要做离线备份并定期恢复演练。

`no-appendfsync-on-rewrite yes` 能减少 rewrite 期间 I/O 竞争，但故障窗口可能扩大。核心数据应保持 `no` 并使用足够的磁盘性能，或由业务明确接受风险。

### 6.2 观察持久化

```bash
redis-cli info persistence
redis-cli config get appendfsync
redis-check-aof --fix appendonly.aof.manifest
```

不要在未备份时对生产 AOF 直接执行修复命令。先复制文件，在隔离环境验证可恢复范围。

## 7. 连接与客户端

```conf
maxclients 20000
timeout 0
tcp-keepalive 60
client-output-buffer-limit normal 0 0 0
client-output-buffer-limit pubsub 32mb 8mb 60
```

`maxclients` 必须小于进程文件句柄上限，并与所有应用实例的连接池总和匹配。连接池重点不是越大越好：Redis 命令很短时，几十条稳定连接往往足够；过多连接增加上下文、缓冲和故障重连压力。

客户端必须设置 connect、command 和 pool acquire timeout。只对幂等命令做有上限、带退避和抖动的重试。

管道可以减少 RTT，但批次过大将独占事件循环并膨胀输出缓冲。以 50～200 条小命令为起点压测，并设置响应字节上限。

## 8. 复制、Sentinel 与 Cluster

```conf
repl-backlog-size 512mb
repl-backlog-ttl 3600
min-replicas-to-write 1
min-replicas-max-lag 10
```

backlog 至少覆盖“峰值复制字节率 × 可接受断线时间”，从而尽量使用部分同步。`min-replicas-*` 会在副本不足时拒绝写入，是一致性和可用性的业务选择。

Cluster 中：

- Key 必须均匀分布到 slot，避免单分片 CPU 或内存提前饱和；
- 多 Key 操作需要同一 hash tag，但滥用 `{tenant}` 会形成超级热点；
- 客户端要支持 `MOVED`、`ASK` 和拓扑刷新；
- 扩缩容期间限制迁移速度并观察 p99。

## 9. 建议配置与系统项

```conf /etc/redis/redis-tuning.conf
maxmemory 16gb
maxmemory-policy allkeys-lfu
maxmemory-samples 10

appendonly yes
appendfsync everysec
aof-use-rdb-preamble yes
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 1gb

tcp-backlog 4096
tcp-keepalive 60
maxclients 20000

lazyfree-lazy-eviction yes
lazyfree-lazy-expire yes
lazyfree-lazy-server-del yes
activedefrag yes

repl-backlog-size 512mb
repl-backlog-ttl 3600
```

同时保证 `vm.overcommit_memory=1`、监听队列和文件句柄满足需求。透明大页关闭方式应使用发行版的 systemd 单元，并在重启后验证。

## 10. 压测和验收

压测请求分布必须接近生产：Key 大小、命令比例、pipeline、命中率、TTL 和热点程度。`redis-benchmark` 的默认小 Key SET/GET 结果不能代表真实业务。

至少验收：吞吐、p95/p99、单核 CPU、网络、RSS 峰值、eviction、fork 时长、AOF fsync、复制延迟、故障切换时间、切换后错误率和缓存回源峰值。

## 11. 参考资料

- [Redis 官方性能与延迟诊断](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/)
- [Redis 内存优化](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)
- [Redis 淘汰策略](https://redis.io/docs/latest/develop/reference/eviction/)
- [Redis 持久化](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis 复制](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
- [阿里云 Tair 性能优化](https://help.aliyun.com/zh/redis/user-guide/performance-optimization/)
- [阿里云 Tair 大 Key 与热 Key 分析](https://help.aliyun.com/zh/redis/user-guide/use-the-offline-key-analysis-feature)
- [Instagram Engineering：Redis 实践](https://instagram-engineering.com/tagged/redis)

## 12. Ansible 配置

以下示例假设 Redis 已安装且主配置支持 `include /etc/redis/redis-tuning.conf`。先在预发布验证实际配置路径和服务名。

```yaml redis-tuning.yml
---
- name: 部署 Redis 调优配置
  hosts: redis_servers
  become: true
  vars:
    redis_maxmemory: 16gb
    redis_maxclients: 20000
  tasks:
    - name: 写入 Redis 内核参数
      ansible.builtin.copy:
        dest: /etc/sysctl.d/60-redis.conf
        mode: "0644"
        content: |
          vm.overcommit_memory = 1
          net.core.somaxconn = 4096
      notify: 应用 Redis 内核参数

    - name: 写入 Redis 调优片段
      ansible.builtin.copy:
        dest: /etc/redis/redis-tuning.conf
        owner: redis
        group: redis
        mode: "0640"
        backup: true
        content: |
          maxmemory {{ redis_maxmemory }}
          maxmemory-policy allkeys-lfu
          maxmemory-samples 10
          appendonly yes
          appendfsync everysec
          aof-use-rdb-preamble yes
          auto-aof-rewrite-percentage 100
          auto-aof-rewrite-min-size 1gb
          tcp-backlog 4096
          tcp-keepalive 60
          maxclients {{ redis_maxclients }}
          lazyfree-lazy-eviction yes
          lazyfree-lazy-expire yes
          lazyfree-lazy-server-del yes
          activedefrag yes
          repl-backlog-size 512mb
          repl-backlog-ttl 3600
      notify: 重启 Redis

    - name: 确保主配置包含调优片段
      ansible.builtin.lineinfile:
        path: /etc/redis/redis.conf
        line: include /etc/redis/redis-tuning.conf
        regexp: '^include /etc/redis/redis-tuning\.conf$'
        insertafter: EOF
        backup: true
      notify: 重启 Redis

  handlers:
    - name: 应用 Redis 内核参数
      ansible.builtin.command: /usr/sbin/sysctl --system
      changed_when: true

    - name: 重启 Redis
      ansible.builtin.service:
        name: redis-server
        state: restarted
```
