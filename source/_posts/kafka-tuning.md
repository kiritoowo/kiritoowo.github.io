---
title: Kafka 调优篇：吞吐、可靠性与消费者滞后
date: 2024-08-29 10:00:00
categories:
  - 调优
  - 消息队列
tags:
  - Kafka
  - 吞吐
  - Consumer Lag
---

<h2>分区与副本容量计算</h2>
<p>分区数应以目标吞吐、单分区可持续吞吐、消费者并行度和恢复时间共同计算。扩分区会改变 key 到分区的映射，因此依赖同 key 全局顺序的主题需预留分区。三副本、<code>min.insync.replicas=2</code> 与 <code>acks=all</code> 是高可用常用组合，但要为复制流量和故障恢复预留磁盘空间。</p>
<pre><code># 识别滞后与副本异常
kafka-consumer-groups.sh --bootstrap-server broker:9092 --describe --group your-group
kafka-topics.sh --bootstrap-server broker:9092 --describe --topic your-topic</code></pre>
<h2>消费者稳定性</h2>
<p>Consumer 处理时间必须小于 <code>max.poll.interval.ms</code>；耗时任务应拆成小批或转给工作线程并正确提交 offset。不要因为滞后就无上限增加消费者，分区数才是并行度上限。重平衡频繁时检查部署滚动策略、session timeout、GC 停顿和外部依赖耗时。</p>
<div class="tuning-warn">不要把消息保留策略当作备份。Kafka 的 retention 受时间和磁盘阈值影响，合规或审计数据应同步到对象存储或独立归档系统。</div>
<p class="tuning-lead">Kafka 3.x 调优同时满足吞吐与交付语义：Broker 顺序写和页缓存，Producer 批量/压缩，Consumer 拉取与提交。</p>

<!-- more --><h2>Broker 基线</h2><pre><code>num.network.threads=8

num.io.threads=16
socket.send.buffer.bytes=1048576
socket.receive.buffer.bytes=1048576
socket.request.max.bytes=104857600
log.segment.bytes=1073741824
log.retention.hours=168
default.replication.factor=3
min.insync.replicas=2</code></pre><h2>Producer/Consumer</h2><pre><code>acks=all
enable.idempotence=true
compression.type=zstd
linger.ms=10
batch.size=131072
fetch.min.bytes=1048576
fetch.max.wait.ms=500
max.poll.records=500
enable.auto.commit=false</code></pre><p>分区数按吞吐和消费者并行度规划；监控 UnderReplicatedPartitions、RequestHandlerAvgIdlePercent、ConsumerLag、磁盘和网络水位。</p><div class="tuning-tip">演练杀 Broker、断磁盘、重复提交，确认 ISR、幂等和业务去重符合 RTO/RPO。</div><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://kafka.apache.org/documentation/" target="_blank" rel="noopener">Kafka 官方文档</a></li><li><a href="https://kafka.apache.org/documentation/#producerconfigs" target="_blank" rel="noopener">Kafka Producer 配置</a></li><li><a href="https://help.aliyun.com/zh/alikafka/user-guide/optimize-the-performance-of-an-alikafka-instance" target="_blank" rel="noopener">阿里云 Kafka 调优</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: kafka
  become: true
  tasks:
    - name: 部署 Kafka 性能配置
      ansible.builtin.blockinfile:
        path: /opt/kafka/config/server.properties
        marker: "# {mark} ANSIBLE 调优"
        block: |
          num.network.threads=8
          num.io.threads=16
          socket.send.buffer.bytes=1048576
          socket.receive.buffer.bytes=1048576
          min.insync.replicas=2
      notify: 重启 Kafka
  handlers:
    - name: 重启 Kafka
      ansible.builtin.service: {name: kafka, state: restarted}</code></pre>
