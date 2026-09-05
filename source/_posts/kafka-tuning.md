---
title: Kafka 调优
date: 2024-11-07 10:00:00
updated: 2025-12-31 11:00:00
description: Kafka 4 KRaft 从分区、副本、磁盘容量出发，系统讲解 Producer、Broker、Consumer、堆积恢复和故障演练。
categories:
  - 调优
  - 消息队列
tags:
  - Kafka
  - KRaft
  - Consumer Lag
---

Kafka 调优不是追求单项峰值吞吐，而是在吞吐、尾延迟、可靠性和故障恢复之间建立可验证的配置组合。本文以 Kafka 4.x 的 KRaft 架构为基线。

<!-- more -->

## 1. 先计算数据和故障预算

| 输入 | 示例 | 用途 |
| --- | ---: | --- |
| 峰值消息数 | 100,000 条/秒 | 分区和客户端并发 |
| 平均记录大小 | 1 KiB | 网络、磁盘吞吐 |
| 峰值系数 | 2 | 发布或活动余量 |
| 保留时间 | 72 小时 | 磁盘容量 |
| 副本因子 | 3 | 可靠性和磁盘放大 |

```text
每日逻辑数据 ≈ 每秒记录 × 平均字节 × 86400
集群磁盘 ≈ 每日逻辑数据 × 保留天数 × 副本因子 × 1.2
```

压缩发生在批次级，真实压缩比必须用生产样本测量。磁盘还需预留分区重分配和单 Broker 故障后的副本重建空间。

## 2. KRaft 拓扑和节点角色

Kafka 4 已以 KRaft 替代 ZooKeeper。生产环境推荐 3 或 5 个 Controller 形成多数派，较大集群将 Controller 与 Broker 分离，避免数据 I/O、GC 影响元数据仲裁。

```properties controller.properties
process.roles=controller
node.id=1
controller.listener.names=CONTROLLER
listeners=CONTROLLER://0.0.0.0:9093
listener.security.protocol.map=CONTROLLER:SASL_SSL
controller.quorum.voters=1@controller-1:9093,2@controller-2:9093,3@controller-3:9093
metadata.log.dir=/data/kafka-metadata
```

具体版本若使用动态 Controller quorum，应按该版本 KRaft 文档初始化，不能混用静态和动态仲裁流程。

## 3. Topic、分区和副本

分区数决定单 Consumer Group 的最大并行度，也决定文件、索引、选主和恢复成本。

```text
分区下限 = max(
  目标生产吞吐 ÷ 单分区生产吞吐,
  目标消费吞吐 ÷ 单消费线程吞吐
)
```

先对目标硬件测出单分区稳定吞吐，再乘 1.3～1.5 余量。不要因为“以后可能增长”一次创建数千分区；增加分区会改变按 Key 分区的映射，可能破坏历史顺序假设。

核心 Topic 的常用可靠性组合：

```properties
default.replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false
```

同时 Producer 使用 `acks=all`。如果只配置 `min.insync.replicas=2` 而 Producer 使用 `acks=1`，并不能得到预期保护。

## 4. Producer：批次、压缩和幂等

```properties producer.properties
acks=all
enable.idempotence=true
compression.type=zstd
linger.ms=10
batch.size=65536
buffer.memory=134217728
delivery.timeout.ms=120000
request.timeout.ms=30000
max.block.ms=10000
```

调优逻辑：

- `linger.ms` 给同一分区的记录留出组批时间，增加吞吐但也增加少量延迟；
- `batch.size` 是单分区批次上限，不会启动时一次性全分配；
- `zstd` 压缩率好但更耗 CPU，文本/JSON 常收益明显；
- `buffer.memory` 满时 `send()` 会阻塞到 `max.block.ms`，应用必须监控；
- 幂等 Producer 防止单会话重试产生重复，不替代跨进程业务幂等。

不要把 `retries` 和 `delivery.timeout.ms` 同时设成无边界。业务请求已超时后，Producer 在后台继续发送可能制造“调用失败但消息成功”的歧义，应通过 Outbox 或明确状态机解决。

### 4.1 事务和顺序

同一 Key 进入同一分区才能维持分区内顺序。事务 Producer 适合 Kafka 内部读写原子性，但会增加协调和延迟；数据库 + Kafka 的一致性通常用本地事务 Outbox + CDC，而不是假设两个系统能共享本地事务。

## 5. Broker：让 PageCache 和磁盘工作

Kafka 依赖顺序日志和操作系统 PageCache。Broker JVM 堆通常不需要占据节点大部分内存，给 PageCache 留出 50% 以上空间通常更重要。

```properties server.properties
process.roles=broker
node.id=101
controller.listener.names=CONTROLLER
controller.quorum.voters=1@controller-1:9093,2@controller-2:9093,3@controller-3:9093

listeners=INTERNAL://0.0.0.0:9092
advertised.listeners=INTERNAL://broker-1.internal:9092
listener.security.protocol.map=INTERNAL:SASL_SSL,CONTROLLER:SASL_SSL
inter.broker.listener.name=INTERNAL

log.dirs=/data1/kafka,/data2/kafka
num.network.threads=8
num.io.threads=16
queued.max.requests=500

default.replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false
auto.create.topics.enable=false

log.retention.hours=72
log.segment.bytes=1073741824
```

线程数只是 16 核 NVMe 节点的实验起点。只有请求队列持续增长且 CPU/磁盘仍有余量时才增大；否则更多线程只会加重竞争。

多块磁盘可配置多个 `log.dirs`，Kafka 按目录分配分区，但这不是 RAID。单盘故障会让其上的副本下线，容量和副本布局仍要按故障域规划。

## 6. 网络与请求大小

Broker、Producer 和 Consumer 的消息/请求上限必须协调：`message.max.bytes`、Topic 的 `max.message.bytes`、Producer `max.request.size`、Consumer `fetch.max.bytes`。不要通过统一改到几百 MiB 来支持大文件；大对象应存对象存储，Kafka 传 URI、摘要和元数据。

通过 `quota` 限制租户或客户端，避免一个回放任务占满 Broker 网络与磁盘。限额比事后扩线程更可控。

## 7. Consumer：批次和 Poll 生命周期

```properties consumer.properties
enable.auto.commit=false
fetch.min.bytes=1048576
fetch.max.wait.ms=500
fetch.max.bytes=52428800
max.partition.fetch.bytes=4194304
max.poll.records=500
max.poll.interval.ms=300000
session.timeout.ms=45000
heartbeat.interval.ms=15000
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor
```

批次处理总时间必须小于 `max.poll.interval.ms`，并留出 GC 和下游抖动余量。不要仅把 interval 调到几十分钟来掩盖慢消费；应减少 `max.poll.records`、拆分处理或增加实例。

手工提交 offset 时遵循“业务处理成功后提交”。失败重试要避免同一坏消息永久卡住分区，可使用重试 Topic + 延时 + 死信，但必须保留原 Topic、partition、offset 和异常信息。

Cooperative Sticky 分配可减少重平衡时的全量撤销。稳定实例还可评估 `group.instance.id` 静态成员，但实例 ID 必须唯一且生命周期明确。

## 8. Lag 和恢复能力

不要只告警 offset 数量；一百万条 100 B 消息和一百万条 1 MiB 消息完全不同。至少看：

- 每分区 lag；
- 最老未消费消息年龄；
- 生产和消费字节率；
- Consumer 处理 p99 和错误率；
- 重平衡次数与时长。

```text
净恢复速率 = 稳定消费速率 - 同期生产速率
预计清空时间 = 当前堆积量 ÷ 净恢复速率
```

净恢复速率小于等于 0 时，必须扩消费者、减少处理成本或给下游扩容。分区数不足时增加实例无效。

## 9. 观测和诊断

Broker 关注：RequestHandlerAvgIdlePercent、NetworkProcessorAvgIdlePercent、UnderReplicatedPartitions、OfflinePartitionsCount、IsrShrinks、Purgatory、BytesIn/Out、请求 p99 和磁盘延迟。

```bash
# 查看 Topic 与 Consumer Group
kafka-topics.sh --bootstrap-server broker-1:9092 --describe --topic orders
kafka-consumer-groups.sh --bootstrap-server broker-1:9092 --describe --group order-service

# 分区副本重分配前先生成并审查计划
kafka-reassign-partitions.sh --bootstrap-server broker-1:9092 --generate \
  --topics-to-move-json-file topics.json --broker-list '101,102,103'
```

重分配必须限速并监控在线 p99、复制流量和磁盘队列，完成后再取消限速。

## 10. 压测和故障演练

官方性能脚本适合基线，但压测数据必须匹配真实 Key、记录大小、压缩和确认级别。

```bash
kafka-producer-perf-test.sh \
  --topic perf-test \
  --num-records 10000000 \
  --record-size 1024 \
  --throughput -1 \
  --producer.config producer.properties
```

依次演练 Broker 宕机、Controller 宕机、单盘慢、网络抖动、Consumer 下游变慢和滚动升级。验收 RPO/RTO、不可用分区、ISR 恢复时间、Producer 错误率、Consumer lag 清空时间和业务重复处理。

## 11. 参考资料

- [Apache Kafka 官方文档](https://kafka.apache.org/documentation/)
- [Kafka Producer 配置](https://kafka.apache.org/documentation/#producerconfigs)
- [Kafka Consumer 配置](https://kafka.apache.org/documentation/#consumerconfigs)
- [Kafka Broker 配置](https://kafka.apache.org/documentation/#brokerconfigs)
- [Kafka KRaft](https://kafka.apache.org/documentation/#kraft)
- [Confluent Kafka 性能指南](https://docs.confluent.io/platform/current/kafka/deployment.html)
- [LinkedIn：Kafka 万亿消息实践](https://www.linkedin.com/blog/engineering/open-source/apache-kafka-trillion-messages)
- [阿里云消息队列 Kafka 版](https://help.aliyun.com/zh/apsaramq-for-kafka/)

## 12. Ansible 配置

```yaml kafka-tuning.yml
---
- name: 部署 Kafka Broker 基线
  hosts: kafka_brokers
  become: true
  vars:
    kafka_home: /opt/kafka
    kafka_data_dirs: /data1/kafka,/data2/kafka
    kafka_controller_voters: "1@controller-1:9093,2@controller-2:9093,3@controller-3:9093"
  tasks:
    - name: 创建 Kafka 数据目录
      ansible.builtin.file:
        path: "{{ item }}"
        state: directory
        owner: kafka
        group: kafka
        mode: "0750"
      loop:
        - /data1/kafka
        - /data2/kafka

    - name: 写入 Broker 配置
      ansible.builtin.copy:
        dest: "{{ kafka_home }}/config/kraft/server.properties"
        owner: kafka
        group: kafka
        mode: "0640"
        backup: true
        content: |
          process.roles=broker
          node.id={{ kafka_node_id }}
          controller.listener.names=CONTROLLER
          controller.quorum.voters={{ kafka_controller_voters }}
          listeners=INTERNAL://0.0.0.0:9092
          advertised.listeners=INTERNAL://{{ inventory_hostname }}:9092
          listener.security.protocol.map=INTERNAL:SASL_SSL,CONTROLLER:SASL_SSL
          inter.broker.listener.name=INTERNAL
          log.dirs={{ kafka_data_dirs }}
          num.network.threads=8
          num.io.threads=16
          queued.max.requests=500
          default.replication.factor=3
          min.insync.replicas=2
          unclean.leader.election.enable=false
          auto.create.topics.enable=false
          log.retention.hours=72
          log.segment.bytes=1073741824
      notify: 重启 Kafka

    - name: 写入 Kafka JVM 参数
      ansible.builtin.copy:
        dest: /etc/default/kafka
        mode: "0644"
        content: |
          KAFKA_HEAP_OPTS="-Xms6g -Xmx6g"
          KAFKA_JVM_PERFORMANCE_OPTS="-XX:+UseG1GC -XX:MaxGCPauseMillis=200"
      notify: 重启 Kafka

  handlers:
    - name: 重启 Kafka
      ansible.builtin.service:
        name: kafka
        state: restarted
```
