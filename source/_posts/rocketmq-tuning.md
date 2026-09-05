---
title: RocketMQ 调优
date: 2024-08-01 10:00:00
updated: 2025-12-30 10:00:00
description: RocketMQ 5 从 Topic、队列和存储容量出发，完成生产、刷盘、副本、消费堆积、重试与故障演练调优。
categories:
  - 调优
  - 消息队列
tags:
  - RocketMQ
  - 消息堆积
  - 刷盘
---

RocketMQ 调优的核心不是把 Broker 线程池全部调大，而是让生产速率、队列并行度、存储带宽和消费能力形成可计算的闭环，并在节点故障时仍满足 RPO/RTO。

<!-- more -->

## 1. 从消息链路定义 SLO

一条消息经过 Producer -> NameServer/Proxy -> Broker CommitLog -> 副本/刷盘 -> Consumer -> 业务存储。每一段都要有指标：

| 环节 | 核心指标 | 典型风险 |
| --- | --- | --- |
| 生产 | TPS、发送 p99、失败/重试 | 重试放大、批次过大 |
| Broker | Put/Get p99、PageCache、磁盘水位 | 刷盘慢、PageCache 忙 |
| 复制 | 副本差距、确认时间 | 主从网络或磁盘不足 |
| 消费 | 消费 TPS、最大堆积、最老消息年龄 | 下游慢、反复重试 |

消息系统必须先确定：是否允许丢消息、是否允许重复、是否要求顺序、最大消息大小、峰值 TPS、保留时间和故障恢复时间。

## 2. 容量规划

### 2.1 存储容量

```text
每日 CommitLog ≈ 峰值每秒消息数 × 平均消息字节 × 86400 × 峰值折算系数
实际磁盘 ≈ 每日数据 × 保留天数 × 副本数 × 1.2 安全余量
```

还要计入属性、索引、ConsumeQueue 和重试/死信消息。磁盘使用率达到拒写阈值前就应告警和扩容，不能把清理当作容量策略。

### 2.2 队列数

队列数决定单 Consumer Group 的最大并行度，但不是越多越好。过多队列会增加元数据、文件、锁竞争、重平衡和顺序管理成本。

```text
最低消费并行度 ≈ 峰值生产 TPS ÷ 单消费线程稳定 TPS
队列数 >= 目标并行度，并预留约 30% 峰值余量
```

先用 8、16、32 等可管理规模压测。全局顺序只能使用单队列，吞吐上限必须由业务接受；分区顺序应使用稳定的 sharding key。

## 3. Producer 调优

### 3.1 可靠性组合

```java
DefaultMQProducer producer = new DefaultMQProducer("order-producer");
producer.setNamesrvAddr("mq-namesrv.internal:9876");
producer.setSendMsgTimeout(3000);
producer.setRetryTimesWhenSendFailed(2);
producer.setRetryTimesWhenSendAsyncFailed(1);
producer.setRetryAnotherBrokerWhenNotStoreOK(false);
producer.start();
```

超时和重试必须小于上游请求预算。只有业务幂等时才重试；为消息设置唯一业务 Key，消费者以业务主键或去重表实现幂等，不能依赖“MQ 只投递一次”。

同步发送适合需要确认的核心事件，异步发送适合高吞吐且能处理回调失败的链路，单向发送只用于允许丢失的遥测数据。

### 3.2 批量与压缩

批量发送能摊薄网络和系统调用，但会增加等待时间、重试粒度和内存。以 100～500 条或 256 KiB～1 MiB 为起点，取先达到的限制，并压测 p99。大消息应把内容存到对象存储，MQ 只传引用和校验值。

## 4. Broker 存储路径

RocketMQ 通过 CommitLog 顺序写入，ConsumeQueue 和 IndexFile提供逻辑索引，读取大量依赖操作系统 PageCache。因此：

- Broker 主机不要运行会持续抢占 PageCache 的其他任务；
- CommitLog 优先独立 NVMe 或高性能云盘；
- 日志、监控和系统盘不要与 CommitLog 争用同一低性能磁盘；
- JVM 堆不能占满物理内存，要给 PageCache 留出主要空间；
- 禁止在 Broker 节点持续 swap。

```bash
iostat -xz 1
pidstat -dru 1
vmstat 1
sar -n DEV,TCP,ETCP 1
```

磁盘判断看 `await`、队列、吞吐和 `%util`，云盘还要对照实例 IOPS/吞吐额度以及突发积分。

## 5. 刷盘和副本不是单个开关

| 模式 | 确认语义 | 适用场景 |
| --- | --- | --- |
| `ASYNC_FLUSH` | 写入 PageCache 后返回 | 可依赖副本、允许极小故障窗口 |
| `SYNC_FLUSH` | 等待本机刷盘 | 单机持久化要求高，吞吐更低 |
| 异步复制 | 主节点确认更快 | 可接受主故障时的复制窗口 |
| 同步复制/多数派 | 等待副本确认 | RPO 更严格，延迟更高 |

“同步刷盘 + 异步复制”并不等于跨节点不丢；“异步刷盘 + 同步复制”也需要明确副本同时掉电的风险。选择必须来自业务 RPO，并通过拔主节点、断网和磁盘故障演练验证。

RocketMQ 5 可采用 Controller 模式完成主从切换。旧集群升级前应按官方版本矩阵规划，不能把 4.x DLedger 或手工主从配置原样搬入所有 5.x 集群。

## 6. Broker 参数起点

以下示例适用于独立存储节点，线程数和文件保留时间必须按 CPU、磁盘和业务恢复需求调整：

```properties broker.conf
brokerClusterName=DefaultCluster
brokerName=broker-a
brokerId=0
listenPort=10911

storePathRootDir=/data/rocketmq/store
storePathCommitLog=/data/rocketmq/store/commitlog
mappedFileSizeCommitLog=1073741824

flushDiskType=ASYNC_FLUSH
fileReservedTime=72
deleteWhen=04
diskMaxUsedSpaceRatio=75

autoCreateTopicEnable=false
autoCreateSubscriptionGroup=false
```

`mappedFileSizeCommitLog` 一般保持 1 GiB 默认思路，随意改小会增加文件管理开销，改大则增加预分配和恢复粒度。生产必须关闭自动创建 Topic/Group，避免拼写错误悄悄产生新资源。

线程池先保持版本默认。只有监控明确显示发送/拉取线程池队列持续积压，同时磁盘和 CPU 仍有余量时，再小步调整 `sendMessageThreadPoolNums` 等参数。

## 7. Consumer 并发与堆积

```java
DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("order-consumer");
consumer.setConsumeThreadMin(16);
consumer.setConsumeThreadMax(32);
consumer.setPullBatchSize(32);
consumer.setConsumeMessageBatchMaxSize(1);
consumer.setConsumeTimeout(5);
```

并发上限受 Topic 队列数、客户端实例数和下游能力共同限制。增加线程前确认数据库连接池、HTTP 下游和 CPU 可承受，否则只是把堆积转移到下游。

```text
堆积清空时间 ≈ 当前堆积量 ÷ (稳定消费 TPS - 同期生产 TPS)
```

如果稳定消费 TPS 小于生产 TPS，无论等待多久都不会恢复。治理顺序：定位慢处理 -> 下游扩容/降级 -> 增加 Consumer 实例 -> 必要时增加队列并调整生产路由。

顺序消息同队列必须串行，失败消息会阻塞后续消息。处理函数要短小，把不可控的远程等待移出关键链路或设置严格超时。

## 8. 重试、死信和幂等

消费失败返回重试前记录消息 Key、失败类型、已重试次数和下次行动。不可恢复错误应尽快进入人工处理，不要重复冲击永久失败的下游。

幂等常用做法：

1. 数据库业务唯一键，重复 INSERT 转换为已处理；
2. 同一事务内写业务状态和消费记录；
3. 状态机只允许合法跃迁，例如 `PAID -> SHIPPED`；
4. Redis 去重只适合 TTL 内允许概率和数据丢失风险的场景。

死信队列必须有告警、查询、修复、重放和审计流程。重放前先修复幂等问题，且限速执行。

## 9. 运维诊断

```bash
# 集群和 Broker 状态
mqadmin clusterList -n namesrv-1:9876
mqadmin brokerStatus -n namesrv-1:9876 -b broker-a:10911

# Topic 路由、状态和消费进度
mqadmin topicRoute -n namesrv-1:9876 -t OrderCreated
mqadmin topicStatus -n namesrv-1:9876 -t OrderCreated
mqadmin consumerProgress -n namesrv-1:9876 -g order-consumer
```

统一监控生产/消费 TPS、Put/Get p99、PageCache busy、磁盘水位、刷盘耗时、主从差距、消费 lag、最老消息年龄、重试和死信数量。

## 10. 压测与故障演练

压测必须覆盖真实消息大小、属性数量、Tag 过滤、顺序消息比例、重试和批次。稳定运行后依次演练：

- Broker 进程退出和主节点宕机；
- NameServer 部分不可达；
- 磁盘延迟升高、空间达到告警阈值；
- Consumer 下游变慢和完全不可用；
- 生产突增 2 倍后的堆积恢复。

验收包含 RPO/RTO、重复消息比例、堆积清空时间、发送和消费 p99，而不是只看峰值 TPS。

## 11. 参考资料

- [Apache RocketMQ 5 官方文档](https://rocketmq.apache.org/docs/)
- [RocketMQ 消息存储与清理](https://rocketmq.apache.org/docs/featureBehavior/11messagestorepolicy)
- [RocketMQ 发送重试](https://rocketmq.apache.org/docs/featureBehavior/05sendretrypolicy)
- [RocketMQ 消费重试](https://rocketmq.apache.org/docs/featureBehavior/10consumerretrypolicy)
- [RocketMQ 指标](https://rocketmq.apache.org/docs/observability/01metrics)
- [RocketMQ JVM 与操作系统最佳实践](https://rocketmq.apache.org/docs/bestPractice/07JVMOS)
- [阿里云消息队列 RocketMQ 版](https://help.aliyun.com/zh/apsaramq-for-rocketmq/)
- [阿里云 RocketMQ 消费堆积排查](https://help.aliyun.com/zh/apsaramq-for-rocketmq/cloud-message-queue-rocketmq-5-x-series/support/consumer-lag)

## 12. Ansible 配置

```yaml rocketmq-tuning.yml
---
- name: 部署 RocketMQ Broker 配置
  hosts: rocketmq_brokers
  become: true
  vars:
    rocketmq_home: /opt/rocketmq
    rocketmq_store: /data/rocketmq/store
    rocketmq_nameservers: "10.0.1.11:9876;10.0.1.12:9876;10.0.1.13:9876"
  tasks:
    - name: 创建存储目录
      ansible.builtin.file:
        path: "{{ rocketmq_store }}"
        state: directory
        owner: rocketmq
        group: rocketmq
        mode: "0750"

    - name: 写入 Broker 配置
      ansible.builtin.copy:
        dest: "{{ rocketmq_home }}/conf/broker.conf"
        owner: rocketmq
        group: rocketmq
        mode: "0640"
        backup: true
        content: |
          brokerClusterName=DefaultCluster
          brokerName={{ inventory_hostname }}
          brokerId=0
          namesrvAddr={{ rocketmq_nameservers }}
          listenPort=10911
          storePathRootDir={{ rocketmq_store }}
          storePathCommitLog={{ rocketmq_store }}/commitlog
          mappedFileSizeCommitLog=1073741824
          flushDiskType=ASYNC_FLUSH
          fileReservedTime=72
          deleteWhen=04
          diskMaxUsedSpaceRatio=75
          autoCreateTopicEnable=false
          autoCreateSubscriptionGroup=false
      notify: 重启 RocketMQ Broker

    - name: 配置 Broker 文件句柄
      ansible.builtin.copy:
        dest: /etc/systemd/system/rocketmq-broker.service.d/limits.conf
        mode: "0644"
        content: |
          [Service]
          LimitNOFILE=1000000
      notify:
        - 重载 systemd
        - 重启 RocketMQ Broker

  handlers:
    - name: 重载 systemd
      ansible.builtin.systemd_service:
        daemon_reload: true

    - name: 重启 RocketMQ Broker
      ansible.builtin.service:
        name: rocketmq-broker
        state: restarted
```
