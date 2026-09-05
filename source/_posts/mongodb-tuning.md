---
title: MongoDB 调优
date: 2025-01-09 10:00:00
updated: 2025-12-31 12:00:00
description: MongoDB 8 从工作集、WiredTiger 缓存、文档模型、索引、连接池、复制与分片入手，建立性能调优闭环。
categories:
  - 调优
  - 数据库
tags:
  - MongoDB
  - WiredTiger
  - 索引
---

MongoDB 调优首先是让文档模型和索引匹配访问模式，并让热点工作集命中 WiredTiger Cache 与文件系统缓存。连接数和缓存参数不能弥补全表扫描或无界数组。

<!-- more -->

## 1. 工作负载画像

上线前记录：集合文档数、平均/p95 文档大小、每日增长、读写比例、查询模板、排序/聚合、索引总大小、工作集、峰值连接、复制延迟和备份窗口。

| 场景 | 优先目标 | 常见瓶颈 |
| --- | --- | --- |
| OLTP 文档 | 单文档低延迟 | 索引、热点、写关注 |
| 事件/时序 | 连续写与保留 | 压缩、分桶、磁盘 |
| 聚合分析 | 扫描和内存 | pipeline 顺序、临时落盘 |
| 多租户 | 隔离和均衡 | shard key、热点租户 |

本文以 MongoDB 8.0 和 WiredTiger 为基线，具体参数先通过 `getParameter` 和对应版本手册核对。

## 2. 从 profiler 和 explain 找证据

Profiler 有性能和存储成本，生产先用慢操作阈值和采样，而不是长期记录全部请求。

```javascript
// 只采样超过 200 毫秒的慢操作
db.setProfilingLevel(1, { slowms: 200, sampleRate: 0.2 })

db.system.profile.find({ millis: { $gte: 200 } })
  .sort({ ts: -1 })
  .limit(20)
```

```javascript
db.orders.find({
  tenantId: 1001,
  status: "PAID",
  createdAt: { $gte: ISODate("2025-12-01") }
}).sort({ createdAt: -1 }).limit(50).explain("executionStats")
```

关注 `totalKeysExamined`、`totalDocsExamined`、`nReturned`、排序阶段、执行时间和是否出现 `COLLSCAN`。扫描/返回比持续很高通常意味着索引或查询边界有问题。

同时检查：

```javascript
db.currentOp({ active: true, secs_running: { $gte: 2 } })
db.serverStatus().wiredTiger.cache
db.serverStatus().connections
db.serverStatus().opcounters
db.serverStatus().metrics.queryExecutor
```

## 3. 文档模型决定上限

### 3.1 内嵌还是引用

一起读取、生命周期一致且大小有上限的数据适合内嵌；独立增长、多对多或会形成大数组的数据适合引用。不要为了“少一次查询”把无限订单历史嵌进用户文档。

MongoDB 文档上限是 16 MiB，但接近上限之前，更新放大、网络和缓存效率已经会恶化。为数组元素数和文档 p95 大小设置监控。

### 3.2 避免热点更新

全局计数器、单个热门文档和单调 shard key 会把写入集中到一个分片或存储页。计数可分桶，时间序列使用原生 time series collection，并按查询和保留需求设计粒度。

## 4. 索引按 ESR 和真实计划设计

ESR 通常指 Equality -> Sort -> Range：等值字段在前，随后排序字段，再放范围字段，但应根据选择性和查询计划验证。

```javascript
db.orders.createIndex(
  { tenantId: 1, status: 1, createdAt: -1, _id: -1 },
  { name: "tenant_status_created" }
)
```

常见错误：

- 每个字段都建单列索引，期待自动组合；
- 索引包含大量低选择性或大字符串；
- 正则以通配符开头；
- 深分页使用大 `skip`；
- 删除“看起来没用”的索引，却忽略月度任务。

深分页改为范围游标：

```javascript
db.orders.find({
  tenantId: 1001,
  $or: [
    { createdAt: { $lt: lastCreatedAt } },
    { createdAt: lastCreatedAt, _id: { $lt: lastId } }
  ]
}).sort({ createdAt: -1, _id: -1 }).limit(50)
```

删除索引前可先隐藏并观察：

```javascript
db.runCommand({ collMod: "orders", index: { name: "old_index", hidden: true } })
```

## 5. WiredTiger Cache 与文件缓存

WiredTiger 默认缓存大致按“物理内存 50% 减 1 GiB”计算，并依赖剩余内存作为操作系统文件缓存。容器中要确认运行时能正确识别 cgroup 限制。

多数场景保留默认。只有同机还有其他重负载进程、容器识别异常或已用指标证明需要隔离时，才设置：

```yaml
storage:
  wiredTiger:
    engineConfig:
      cacheSizeGB: 14
```

重点指标：cache bytes、dirty bytes、pages read into cache、pages written、eviction active、application threads page read/write。持续 eviction pressure 往往意味着工作集过大、扫描太多或存储太慢。

不要把 WiredTiger cache 调到物理内存 80%，否则会挤压文件缓存并触发 swap/OOM。

## 6. 存储与压缩

数据、journal 和日志的 I/O 模式不同。生产优先本地 SSD/NVMe 或满足持续 IOPS 与吞吐的云盘，文件系统按官方支持矩阵选择。挂载选项和预读大小要在实际范围查询下验证。

集合压缩默认通常合理。文本/文档压缩节省磁盘和缓存，但消耗 CPU；不要在 CPU 已饱和时只追求更高压缩率。

```bash
iostat -xz 1
pidstat -dru 1
mongostat --host mongodb-1:27017 1
mongotop --host mongodb-1:27017 1
```

## 7. 连接池和并发

MongoDB 驱动的 `MongoClient` 是重量级、线程安全对象，应按进程复用，而不是每个请求创建。

```yaml
spring:
  data:
    mongodb:
      uri: mongodb://app:secret@mongo-1,mongo-2,mongo-3/orders?replicaSet=rs0&retryWrites=true&w=majority&maxPoolSize=50&minPoolSize=5&waitQueueTimeoutMS=2000
```

连接池总量 = 应用实例数 × 每实例上限 + 运维/任务连接。池等待超时必须小于接口剩余时间。增加连接前确认服务端 ticket、CPU 和存储仍有余量。

## 8. Read/Write Concern 与复制

`writeConcern: { w: "majority" }` 配合 journal 可获得更明确的持久化语义，但延迟取决于副本网络和磁盘。`w: 1` 更快但主节点故障时回滚窗口更大。

读取副本可以分担部分工作，但会接受复制延迟。关键“写后读”默认从 Primary 读取，或用合适的 readConcern/session 保证语义。

副本集至少三投票成员，分布在独立故障域。隐藏副本可承载备份或离线任务，但它仍占用网络、磁盘和 oplog。

```javascript
rs.status()
rs.printReplicationInfo()
rs.printSecondaryReplicationInfo()
```

Oplog 容量应覆盖维护、断线和备份窗口：

```text
oplog 窗口 ≈ oplog 大小 ÷ 峰值 oplog 产生速率
```

## 9. 聚合管道

尽早 `$match`，随后 `$project` 限制字段；在 `$lookup`、`$group` 和 `$sort` 前减少数据量。允许落盘能避免单次聚合内存失败，但可能拖慢整个磁盘，仍需并发和超时限制。

```javascript
db.orders.aggregate([
  { $match: { tenantId: 1001, createdAt: { $gte: start } } },
  { $project: { status: 1, amount: 1 } },
  { $group: { _id: "$status", total: { $sum: "$amount" } } }
], { maxTimeMS: 3000, allowDiskUse: true })
```

## 10. 分片键和均衡

只有单副本集容量、写吞吐或数据地域确实到达边界时才分片。一个好 shard key 同时考虑：基数、写入分布、查询定向和可扩展性。

- 单调时间或自增 ID 可能形成最新 chunk 热点；
- 纯 hashed key 写入均匀，但范围查询会 fan-out；
- 常见方案是租户/地域前缀 + hashed/时间字段的复合设计；
- 缺少 shard key 的查询会 scatter-gather。

分片前用 `analyzeShardKey` 和真实 query sampling 验证，不要凭字段名决定。

## 11. 验收、备份与回滚

压测覆盖真实文档大小、索引、读写比例、聚合和热点。比较 p95/p99、扫描/返回比、Cache eviction、磁盘 await、连接池等待、复制 lag 和 oplog 窗口。

参数回滚相对简单；索引和 schema 变更应先构建新索引、隐藏旧索引或双写新集合。副本不是备份，必须用快照或 `mongodump` 策略做隔离恢复演练。

## 12. 参考资料

- [MongoDB 8.0 性能最佳实践](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/)
- [WiredTiger 存储引擎](https://www.mongodb.com/docs/manual/core/wiredtiger/)
- [索引策略](https://www.mongodb.com/docs/manual/applications/indexes/)
- [Explain 结果](https://www.mongodb.com/docs/manual/reference/explain-results/)
- [副本集部署架构](https://www.mongodb.com/docs/manual/core/replica-set-architectures/)
- [选择分片键](https://www.mongodb.com/docs/manual/core/sharding-choose-a-shard-key/)
- [MongoDB Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)
- [阿里云 MongoDB 性能测试与优化](https://help.aliyun.com/zh/mongodb/use-cases/performance-testing-and-optimization/)

## 13. Ansible 配置

```yaml mongodb-tuning.yml
---
- name: 部署 MongoDB 数据节点基线
  hosts: mongodb_servers
  become: true
  vars:
    mongodb_replica_set: rs0
    mongodb_cache_size_gb: 14
  tasks:
    - name: 创建 MongoDB 数据目录
      ansible.builtin.file:
        path: /data/mongodb
        state: directory
        owner: mongodb
        group: mongodb
        mode: "0750"

    - name: 写入 MongoDB 配置
      ansible.builtin.copy:
        dest: /etc/mongod.conf
        owner: root
        group: root
        mode: "0644"
        backup: true
        content: |
          storage:
            dbPath: /data/mongodb
            wiredTiger:
              engineConfig:
                cacheSizeGB: {{ mongodb_cache_size_gb }}
          systemLog:
            destination: file
            path: /var/log/mongodb/mongod.log
            logAppend: true
          net:
            bindIp: 127.0.0.1,{{ ansible_default_ipv4.address }}
            port: 27017
          replication:
            replSetName: {{ mongodb_replica_set }}
          security:
            authorization: enabled
      notify: 重启 MongoDB

    - name: 配置 MongoDB 文件句柄
      ansible.builtin.copy:
        dest: /etc/systemd/system/mongod.service.d/limits.conf
        mode: "0644"
        content: |
          [Service]
          LimitNOFILE=64000
      notify:
        - 重载 systemd
        - 重启 MongoDB

  handlers:
    - name: 重载 systemd
      ansible.builtin.systemd_service:
        daemon_reload: true

    - name: 重启 MongoDB
      ansible.builtin.service:
        name: mongod
        state: restarted
```
