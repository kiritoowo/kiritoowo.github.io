---
title: MySQL 调优
date: 2024-04-25 10:00:00
updated: 2025-12-25 10:00:00
description: MySQL 8.4 LTS 从工作负载、慢 SQL、索引和锁等待入手，完成 InnoDB 内存、redo、持久化、连接与复制调优。
categories:
  - 调优
  - 数据库
tags:
  - MySQL
  - InnoDB
  - SQL
---

MySQL 调优应从 SQL 和等待事件开始：先缩短扫描、锁持有和事务时间，再调整 Buffer Pool、redo、刷盘和连接数。参数只能放大正确设计的收益，也会放大错误设计的代价。

<!-- more -->

## 1. 明确版本与工作负载

本文以 MySQL 8.4 LTS、InnoDB、32 GiB 专用数据库节点为示例。共享主机、容器和云 RDS 应扣除操作系统、Agent、连接线程和备份任务内存。

| 类型 | 主要矛盾 | 优先指标 |
| --- | --- | --- |
| OLTP | 随机访问、锁和提交延迟 | p95/p99、锁等待、fsync |
| 读多写少 | Buffer Pool 与索引覆盖 | 逻辑读/物理读、扫描行数 |
| 批量导入 | redo、binlog、磁盘吞吐 | MB/s、checkpoint age、复制延迟 |
| 分析查询 | 大扫描和临时表 | examined rows、临时磁盘表 |

不要为一次离线导入永久降低持久化级别。批任务应错峰、限速，或者放在独立副本。

## 2. 建立可复现基线

启用 Performance Schema 和 `sys` schema，慢日志阈值先设为 500 ms，再根据请求 SLO 降低。不要长期打开 `general_log`。

```ini /etc/mysql/mysql.conf.d/20-observability.cnf
[mysqld]
slow_query_log = ON
long_query_time = 0.5
log_queries_not_using_indexes = OFF
performance_schema = ON
```

```sql
-- 按总耗时定位最值得优化的 SQL 模板
SELECT digest_text,
       count_star,
       ROUND(sum_timer_wait / 1000000000000, 2) AS total_seconds,
       ROUND(avg_timer_wait / 1000000, 2) AS avg_microseconds,
       sum_rows_examined,
       sum_rows_sent
FROM performance_schema.events_statements_summary_by_digest
WHERE digest_text IS NOT NULL
ORDER BY sum_timer_wait DESC
LIMIT 20;

-- 当前锁等待和长事务
SELECT * FROM sys.innodb_lock_waits;
SELECT trx_id, trx_started, trx_state, trx_rows_locked, trx_query
FROM information_schema.innodb_trx
ORDER BY trx_started;
```

系统层同步采集 CPU、磁盘 `await`、IOPS、吞吐和 fsync 尾延迟。Buffer Pool 命中率很高也可能被锁或 redo 限制。

## 3. SQL、索引和访问行数

### 3.1 用 EXPLAIN ANALYZE 看真实执行

```sql
EXPLAIN ANALYZE
SELECT id, status, created_at
FROM orders
WHERE tenant_id = 1001
  AND status = 'PAID'
  AND created_at >= '2025-12-01'
ORDER BY created_at DESC
LIMIT 50;
```

关注每个算子的实际行数、循环次数和耗时。估算与实际相差几个数量级时，检查统计信息、数据倾斜和相关列。

### 3.2 索引设计顺序

通常按“高频等值条件 -> 范围条件 -> 排序/分组 -> 必要覆盖列”设计联合索引，但最终以真实计划为准。避免：

- 字符列和数字参数比较导致隐式转换；
- 对索引列套函数且没有函数索引；
- `SELECT *` 让覆盖索引失效；
- 深分页 `LIMIT 100000, 20`；
- 为每个查询创建宽索引，显著增加写放大。

深分页改为基于稳定排序键的游标：

```sql
SELECT id, created_at, total_amount
FROM orders
WHERE tenant_id = ?
  AND (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT 50;
```

## 4. 事务和锁

事务中不要执行 RPC、文件上传或等待用户输入。批量修改使用主键范围分段，每批提交并记录进度。大事务会同时放大 undo、锁持有、历史版本和复制延迟。

```sql
-- 查看 InnoDB 现场和元数据锁
SHOW ENGINE INNODB STATUS\G
SELECT * FROM performance_schema.metadata_locks
WHERE LOCK_STATUS = 'PENDING';
```

隔离级别不是越高越好。MySQL 默认 `REPEATABLE READ` 适合多数事务；明确不需要一致性快照且希望减少部分 gap lock 影响时，可评估 `READ COMMITTED`，但必须测试业务语义和复制格式。

## 5. Buffer Pool 内存预算

专用 32 GiB 节点可以从 20～24 GiB Buffer Pool 开始，而不是机械地使用 80%。剩余内存需要覆盖连接缓冲、Performance Schema、排序/临时表、redo、操作系统和备份。

```ini
[mysqld]
innodb_buffer_pool_size = 22G
```

MySQL 8 支持在线调整 `innodb_buffer_pool_size`，但扩缩容仍会造成 I/O 和延迟波动，应小步执行并观测：

```sql
SET GLOBAL innodb_buffer_pool_size = 23622320128;

SELECT variable_name, variable_value
FROM performance_schema.global_status
WHERE variable_name IN (
  'Innodb_buffer_pool_reads',
  'Innodb_buffer_pool_read_requests',
  'Innodb_buffer_pool_wait_free'
);
```

## 6. Redo、刷盘和持久化

MySQL 8.0.30 起优先使用 `innodb_redo_log_capacity`，旧教程中的 `innodb_log_file_size × innodb_log_files_in_group` 已不是新部署的推荐写法。

```ini
[mysqld]
innodb_redo_log_capacity = 8G
innodb_flush_method = O_DIRECT
innodb_flush_log_at_trx_commit = 1
sync_binlog = 1
```

redo 容量过小会频繁 checkpoint 和刷脏，过大则增加崩溃恢复时间。根据高峰写入速率，让 redo 覆盖约 30～60 分钟写入作为实验起点，再用 checkpoint、脏页和恢复演练验证。

| 组合 | 数据风险 | 场景 |
| --- | --- | --- |
| `flush=1`、`sync_binlog=1` | 最强持久化语义 | 订单、资金、核心状态 |
| `flush=2`、`sync_binlog=N` | OS/主机故障可能丢最近事务 | 可重放事件、临时数据 |

降低持久化级别必须由业务 RPO 决定，不能只因为 TPS 更高。

## 7. 连接数、线程和缓存

`max_connections=2000` 不代表数据库可以有效执行 2000 个并发查询。并发预算来自 CPU、查询耗时和磁盘能力：

```text
所需活跃连接约等于 峰值 TPS × 单事务平均秒数
```

应用连接池以较小值开始，例如每实例 16～32，并保证所有实例、后台任务和管理连接之和不超过数据库预算。连接获取超时应小于接口剩余时间，避免请求在线程池和连接池排两次长队。

谨慎设置每连接缓冲：`sort_buffer_size`、`join_buffer_size`、`read_buffer_size` 可能按活动连接分配，不能按“连接数 × 全部上限”把内存花完。

## 8. 临时表和排序

```sql
SELECT variable_name, variable_value
FROM performance_schema.global_status
WHERE variable_name IN ('Created_tmp_tables', 'Created_tmp_disk_tables', 'Sort_merge_passes');
```

磁盘临时表多时先优化 SQL、字段类型和索引，再调整 `tmp_table_size`。该变量不是全局只分配一次，大并发下调得过大可能导致 OOM。

## 9. 复制与高可用

复制延迟应同时看 relay log、SQL apply、长事务和副本磁盘。并行复制参数要配合真实事务依赖验证。只读请求若要求“写后立刻可见”，不能无条件路由到异步副本。

上线前至少演练：主库进程退出、节点故障、网络隔离、磁盘接近满、长事务和 DDL。验收不仅是“能切换”，还包括 RTO、丢失事务范围、客户端重连和重复执行处理。

## 10. 32 GiB OLTP 起始配置

```ini /etc/mysql/mysql.conf.d/99-tuning.cnf
[mysqld]
skip_name_resolve = ON
max_connections = 500
table_open_cache = 8192

innodb_buffer_pool_size = 22G
innodb_redo_log_capacity = 8G
innodb_flush_method = O_DIRECT
innodb_flush_log_at_trx_commit = 1
innodb_flush_neighbors = 0

sync_binlog = 1
binlog_format = ROW
binlog_expire_logs_seconds = 604800

slow_query_log = ON
long_query_time = 0.5
performance_schema = ON
```

NVMe 或云盘通常设置 `innodb_flush_neighbors=0`；机械盘环境需要重新评估。`skip_name_resolve` 启用前确认授权表使用 IP 或网段而非主机名。

## 11. 验收和回滚

至少比较：业务 TPS、p95/p99、扫描/返回行数、Buffer Pool 物理读、锁等待、redo 写入与 checkpoint、fsync p99、连接等待和复制延迟。配置文件先通过以下命令校验：

```bash
mysqld --validate-config
```

保留变更前配置和参数快照。p99 劣化、磁盘队列持续饱和、复制延迟扩大或 OOM 水位不足时，按参数组回滚并重跑同一压测。

## 12. 参考资料

- [MySQL 8.4 优化手册](https://dev.mysql.com/doc/refman/8.4/en/optimization.html)
- [InnoDB Buffer Pool 配置](https://dev.mysql.com/doc/refman/8.4/en/innodb-buffer-pool-resize.html)
- [InnoDB Redo Log 配置](https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html)
- [Performance Schema 语句摘要表](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-statement-summary-tables.html)
- [EXPLAIN ANALYZE](https://dev.mysql.com/doc/refman/8.4/en/explain.html)
- [阿里云 RDS MySQL 性能优化](https://help.aliyun.com/zh/rds/apsaradb-rds-for-mysql/performance-optimization/)
- [阿里云数据库自治服务 DAS](https://help.aliyun.com/zh/das/)
- [Percona MySQL Performance Blog](https://www.percona.com/blog/)

## 13. Ansible 配置

```yaml mysql-tuning.yml
---
- name: 部署 MySQL 8.4 调优基线
  hosts: mysql_servers
  become: true
  vars:
    mysql_buffer_pool_size: 22G
    mysql_redo_capacity: 8G
    mysql_max_connections: 500
  tasks:
    - name: 写入 MySQL 调优配置
      ansible.builtin.copy:
        dest: /etc/mysql/mysql.conf.d/99-tuning.cnf
        owner: root
        group: root
        mode: "0644"
        backup: true
        content: |
          [mysqld]
          skip_name_resolve = ON
          max_connections = {{ mysql_max_connections }}
          table_open_cache = 8192
          innodb_buffer_pool_size = {{ mysql_buffer_pool_size }}
          innodb_redo_log_capacity = {{ mysql_redo_capacity }}
          innodb_flush_method = O_DIRECT
          innodb_flush_log_at_trx_commit = 1
          innodb_flush_neighbors = 0
          sync_binlog = 1
          binlog_format = ROW
          binlog_expire_logs_seconds = 604800
          slow_query_log = ON
          long_query_time = 0.5
          performance_schema = ON
        validate: /usr/sbin/mysqld --defaults-file=%s --validate-config
      notify: 重启 MySQL

    - name: 确保 MySQL 已启动
      ansible.builtin.service:
        name: mysql
        state: started
        enabled: true

  handlers:
    - name: 重启 MySQL
      ansible.builtin.service:
        name: mysql
        state: restarted
```
