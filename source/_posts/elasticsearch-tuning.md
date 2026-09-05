---
title: Elasticsearch 调优
date: 2024-09-19 10:00:00
updated: 2025-12-31 10:00:00
description: Elasticsearch 从节点角色、堆与文件缓存、分片、映射、写入、查询和 ILM 入手，建立容量与性能调优闭环。
categories:
  - 调优
  - 搜索
tags:
  - Elasticsearch
  - 分片
  - ILM
---

Elasticsearch 调优的主线是让工作集尽量命中文件系统缓存，并控制分片、字段和聚合的数量。多数性能问题来自数据模型和容量，而不是一个隐藏的 JVM 参数。

<!-- more -->

## 1. 定义场景和版本基线

本文适用于 Elasticsearch 8.x/9.x 的生产思路，具体设置以所用版本文档为准。先区分：

| 场景 | 主要目标 | 关键约束 |
| --- | --- | --- |
| 日志/时序 | 持续写入、按时间淘汰 | shard 数、segment merge、磁盘 |
| 商品/内容搜索 | 查询 p99、相关性 | mapping、缓存、聚合 |
| 向量检索 | 召回率与延迟 | 原生内存、页缓存、向量维度 |
| 安全分析 | 高基数聚合与长保留 | 热温冷分层、查询隔离 |

基线必须记录文档数、每日增量、平均文档大小、保留周期、主分片和副本数、峰值索引速率、查询组合及 p95/p99。

## 2. 节点角色和硬件

生产至少使用三个有资格参与选主的节点，避免两个节点无法可靠形成多数派。较大集群把 master、data、ingest、transform 等角色按压力拆分。

优先级通常是：足够内存 -> 本地 SSD/NVMe -> 稳定网络 -> 更多 CPU。Elasticsearch 大量依赖 mmap 和 PageCache，远程网络盘必须确认 IOPS、吞吐和尾延迟。

```bash
# 主机和进程基线
iostat -xz 1
vmstat 1
pidstat -dur 1
curl -s localhost:9200/_nodes/stats/jvm,fs,os,process?pretty
```

不要把数据目录放在 NFS。生产禁用 swap，或者至少将 `vm.swappiness` 降到 1 并使用 `bootstrap.memory_lock` 锁定 JVM 内存。

## 3. 堆与文件系统缓存

现代 Elasticsearch 能按节点角色自动设置 JVM 堆，优先保留自动配置。手工设置时：

- `Xms` 与 `Xmx` 相同；
- 堆不超过节点可用内存 50%；
- 通常保持在压缩对象指针阈值以下；
- 其余内存留给文件系统缓存和 off-heap。

64 GiB 数据节点可从 28～30 GiB 堆起步，而不是给 JVM 60 GiB。堆越大，PageCache 越小，Lucene 读取可能更慢。

```text /etc/elasticsearch/jvm.options.d/heap.options
-Xms30g
-Xmx30g
-Xlog:gc*:file=/var/log/elasticsearch/gc.log:utctime,level,tags:filecount=32,filesize=64m
```

```bash
curl -s localhost:9200/_nodes/_all/jvm?filter_path=nodes.*.jvm.mem,**.using_compressed_ordinary_object_pointers | jq
```

## 4. 分片是最重要的容量单位

每个分片都是一个 Lucene 索引，具有 segment、文件句柄、缓存和集群状态开销。大量小分片会让 master、GC、查询 fan-out 和恢复都变慢。

日志类数据常以单个主分片 10～50 GiB 为起始范围，再按恢复时间和查询并行度压测。不要把“每节点固定多少分片”的旧经验当成硬规则。

```bash
# 查看分片大小、数量和分配
curl -s 'localhost:9200/_cat/shards?v&bytes=gb&s=store:desc'
curl -s 'localhost:9200/_cat/indices?v&bytes=gb&s=store.size:desc'
curl -s 'localhost:9200/_cluster/allocation/explain?pretty'
```

数据流配合 ILM rollover，以 `max_primary_shard_size` 和时间共同控制分片：

```json
PUT _ilm/policy/logs-hot-warm
{
  "policy": {
    "phases": {
      "hot": {
        "actions": {
          "rollover": {
            "max_primary_shard_size": "40gb",
            "max_age": "1d"
          }
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "forcemerge": { "max_num_segments": 1 }
        }
      },
      "delete": {
        "min_age": "30d",
        "actions": { "delete": {} }
      }
    }
  }
}
```

Force merge 消耗大量 I/O，只在索引不再写入后于低峰执行。

## 5. Mapping 先于查询调优

### 5.1 明确字段类型

```json
PUT _index_template/orders-template
{
  "index_patterns": ["orders-*"],
  "template": {
    "settings": {
      "number_of_shards": 3,
      "number_of_replicas": 1
    },
    "mappings": {
      "dynamic": "strict",
      "properties": {
        "order_id": { "type": "keyword" },
        "tenant_id": { "type": "keyword" },
        "created_at": { "type": "date" },
        "amount": { "type": "scaled_float", "scaling_factor": 100 },
        "description": { "type": "text" }
      }
    }
  }
}
```

避免 mapping explosion：动态业务属性不要无限生成字段；用户 ID、请求 ID 等精确值用 `keyword`；不参与搜索和聚合的字段可关闭索引或 doc values。不要对 `text` 开启 fielddata 来救急，它可能迅速耗尽堆。

### 5.2 避免超大文档和嵌套爆炸

更新文档会重写 Lucene 文档。高频变化的大数组应拆模；`nested` 每个元素都会成为隐藏文档。建立单文档字节数、数组元素和 nested 数量上限。

## 6. 写入调优

Bulk 按字节数和耗时控制，不只看文档条数。以 5～15 MiB/批开始压测，逐步增加直到吞吐不再改善或 p99/内存恶化。

```bash
# 写入前临时降低刷新频率，不应长期遗漏恢复步骤
curl -X PUT localhost:9200/orders-write/_settings \
  -H 'Content-Type: application/json' \
  -d '{"index":{"refresh_interval":"30s"}}'
```

首次全量导入且允许暂时降低可用性时，可临时设副本为 0，导入后恢复副本并等待集群绿色。在线写入不要这样做。

客户端对 429 使用指数退避和抖动。增加并发直到单节点 CPU、write thread pool、merge 或磁盘首先饱和，不能无限增加 Bulk 线程。

## 7. Segment、刷新和合并

刷新产生可搜索 segment，频率越高，写入和合并成本越大。默认刷新策略通常适合在线检索；日志场景可根据可见性 SLO 增大 `refresh_interval`。

```bash
curl -s localhost:9200/_nodes/stats/indices/refresh,merge,segments,translog?pretty
curl -s localhost:9200/_cat/thread_pool/write,search,merge?v
```

观察 refresh time、merge throttling、segment count、写线程拒绝和 translog。手工调 Lucene merge policy 前，先修复过小分片、过频刷新和磁盘不足。

## 8. 查询与聚合

- 精确过滤放在 `bool.filter`，无需计算 score；
- 用 `_source` filtering 只返回需要字段；
- 避免大 `from + size`，深分页使用 `search_after` + PIT；
- 高基数聚合限制时间范围和 bucket 数；
- 用户输入禁止直接构造无限复杂的正则和脚本查询；
- 只在诊断单条慢查询时使用 Profile API，它自身有开销。

```json
POST orders-*/_search
{
  "size": 50,
  "track_total_hits": false,
  "_source": ["order_id", "amount", "created_at"],
  "query": {
    "bool": {
      "filter": [
        { "term": { "tenant_id": "1001" } },
        { "range": { "created_at": { "gte": "now-7d" } } }
      ]
    }
  },
  "sort": [
    { "created_at": "desc" },
    { "order_id": "desc" }
  ]
}
```

## 9. 缓存和熔断器

Query Cache、Request Cache 和 PageCache 命中条件不同。不要为追求命中率扩大 JVM 堆；过滤条件不稳定时缓存价值很低。检查 breaker 而不是调大到失去保护：

```bash
curl -s localhost:9200/_nodes/stats/breaker,indices/query_cache,indices/request_cache?pretty
```

触发 circuit breaker 表明查询或聚合超出预算。首选缩小时间范围、减少 buckets、拆分请求或隔离分析查询。

## 10. 磁盘水位、恢复与快照

磁盘水位会影响分片分配，并在 flood stage 对索引设置只读保护。水位告警必须早于默认阈值，预留节点故障后重新分配一份最大分片的空间。

Snapshot 是备份，副本不是。定期对快照做隔离恢复演练，记录恢复速度，反推分片大小和 RTO。节点重启或扩容时限制恢复并发，避免恢复流量压垮在线查询。

## 11. 压测和回滚

索引和查询要同时压测，数据规模至少接近生产工作集。比较：indexing rate、search p95/p99、GC、heap、PageCache、segment、merge、thread pool rejected、磁盘延迟和副本恢复时间。

Mapping、主分片数等变更通常需要新索引 + reindex + alias 切换。先保留旧索引，验收后再删除，这就是可靠回滚路径。

## 12. 参考资料

- [Elastic 生产性能指南](https://www.elastic.co/docs/deploy-manage/production-guidance/optimize-performance)
- [Elasticsearch 索引设置](https://www.elastic.co/docs/reference/elasticsearch/index-settings/index-modules)
- [Elasticsearch JVM 设置](https://www.elastic.co/docs/reference/elasticsearch/jvm-settings/)
- [分片大小最佳实践](https://www.elastic.co/docs/deploy-manage/production-guidance/optimize-performance/size-shards)
- [索引生命周期 ILM](https://www.elastic.co/docs/manage-data/lifecycle/index-lifecycle-management)
- [Tune for indexing speed](https://www.elastic.co/docs/deploy-manage/production-guidance/optimize-performance/indexing-speed)
- [Tune for search speed](https://www.elastic.co/docs/deploy-manage/production-guidance/optimize-performance/search-speed)
- [阿里云 Elasticsearch 性能调优](https://help.aliyun.com/zh/es/user-guide/performance-tuning/)

## 13. Ansible 配置

```yaml elasticsearch-tuning.yml
---
- name: 部署 Elasticsearch 数据节点基线
  hosts: elasticsearch_data
  become: true
  vars:
    elasticsearch_cluster_name: search-prod
    elasticsearch_heap_size: 30g
    elasticsearch_seed_hosts:
      - 10.0.2.11
      - 10.0.2.12
      - 10.0.2.13
  tasks:
    - name: 写入 mmap 上限
      ansible.builtin.copy:
        dest: /etc/sysctl.d/60-elasticsearch.conf
        mode: "0644"
        content: |
          vm.max_map_count = 262144
          vm.swappiness = 1
      notify: 应用 Elasticsearch 内核参数

    - name: 写入 JVM 堆配置
      ansible.builtin.copy:
        dest: /etc/elasticsearch/jvm.options.d/heap.options
        owner: root
        group: elasticsearch
        mode: "0640"
        backup: true
        content: |
          -Xms{{ elasticsearch_heap_size }}
          -Xmx{{ elasticsearch_heap_size }}
      notify: 重启 Elasticsearch

    - name: 写入节点配置
      ansible.builtin.copy:
        dest: /etc/elasticsearch/elasticsearch.yml
        owner: root
        group: elasticsearch
        mode: "0660"
        backup: true
        content: |
          cluster.name: {{ elasticsearch_cluster_name }}
          node.name: {{ inventory_hostname }}
          node.roles: [ data, ingest ]
          path.data: /data/elasticsearch
          path.logs: /var/log/elasticsearch
          network.host: {{ ansible_default_ipv4.address }}
          discovery.seed_hosts: {{ elasticsearch_seed_hosts | to_json }}
          bootstrap.memory_lock: true
      notify: 重启 Elasticsearch

    - name: 配置 systemd 内存锁定
      ansible.builtin.copy:
        dest: /etc/systemd/system/elasticsearch.service.d/override.conf
        mode: "0644"
        content: |
          [Service]
          LimitMEMLOCK=infinity
      notify:
        - 重载 systemd
        - 重启 Elasticsearch

  handlers:
    - name: 应用 Elasticsearch 内核参数
      ansible.builtin.command: /usr/sbin/sysctl --system
      changed_when: true

    - name: 重载 systemd
      ansible.builtin.systemd_service:
        daemon_reload: true

    - name: 重启 Elasticsearch
      ansible.builtin.service:
        name: elasticsearch
        state: restarted
```
