---
title: RocketMQ 调优篇：刷盘、堆外与消费者并发
date: 2024-06-20 10:00:00
categories:
  - 调优
  - 消息队列
tags:
  - RocketMQ
  - 消息堆积
  - 刷盘
---

<p class="tuning-lead">RocketMQ 5.x 调优围绕 CommitLog 顺序写、PageCache、副本策略和消费并发；Broker 磁盘优先 NVMe/高性能云盘并与系统日志隔离。</p><h2>Broker 参数</h2><pre><code>brokerRole=ASYNC_MASTER
flushDiskType=ASYNC_FLUSH
transientStorePoolEnable=false
mapedFileSizeCommitLog=1073741824
sendMessageThreadPoolNums=16
osPageCacheBusyTimeOutMills=1000</code></pre><p>强一致场景改用 SYNC_MASTER+SYNC_FLUSH；普通事件可异步刷盘并依赖多副本。Producer 超时 3s、重试 2 次，批量消息控制在 1MB 内。</p><h2>消费闭环</h2><div class="mermaid">flowchart LR
P[Producer批量/压缩]-->B[CommitLog顺序写]
B-->R[副本同步/刷盘]
R-->C[Consumer并发]
C-->M[堆积与延迟监控]</div><p>消费者并发从 CPU×2 起步，顺序消息同队列单线程；监控 TPS、落盘延迟、重试主题和磁盘水位。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://rocketmq.apache.org/docs/" target="_blank" rel="noopener">RocketMQ 官方文档</a></li><li><a href="https://rocketmq.apache.org/docs/4.x/parameterConfiguration/01server/" target="_blank" rel="noopener">RocketMQ 服务端参数</a></li><li><a href="https://help.aliyun.com/zh/apsaramq-for-rocketmq/cloud-message-queue-rocketmq-4-0-series/user-guide/adjust-the-performance-of-a-rocketmq-instance" target="_blank" rel="noopener">阿里云 RocketMQ 调优</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: rocketmq_broker
  become: true
  vars: {rocketmq_home: /opt/rocketmq}
  tasks:
    - name: 部署 Broker 参数
      ansible.builtin.copy:
        dest: "{{ rocketmq_home }}/conf/broker.properties"
        mode: '0644'
        content: |
          brokerRole=ASYNC_MASTER
          flushDiskType=ASYNC_FLUSH
          sendMessageThreadPoolNums=16
          osPageCacheBusyTimeOutMills=1000</code></pre>

