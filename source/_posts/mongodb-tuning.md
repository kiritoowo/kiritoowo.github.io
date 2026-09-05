---
title: MongoDB 调优篇：WiredTiger 缓存、索引与连接池
date: 2024-10-03 10:00:00
categories:
  - 调优
  - 数据库
tags:
  - MongoDB
  - WiredTiger
  - 索引
---

<p class="tuning-lead">MongoDB 7.x 的 WiredTiger 已较稳健，调优重点是工作集、索引选择性、写关注级别和连接池。副本集先保证多数派写入，再讨论吞吐。</p><h2>mongod.conf 基线</h2><pre><code>storage:
  wiredTiger:
    engineConfig:
      cacheSizeGB: 12
operationProfiling:
  mode: slowOp
  slowOpThresholdMs: 100
net:
  maxIncomingConnections: 20000
replication:
  oplogSizeMB: 51200</code></pre><p>WiredTiger cache 通常约为物理内存 50%（容器按 limit 计算），其余留给文件系统缓存和连接。驱动 maxPoolSize 从 100–200 起步，结合排队时间调节。</p><h2>查询与索引</h2><pre><code>db.orders.explain('executionStats').find({tenantId:1,status:'PAID'}).sort({createdAt:-1})
db.orders.getIndexes()
db.serverStatus().wiredTiger.cache</code></pre><p>复合索引遵循 ESR（Equality、Sort、Range）；分页采用范围条件避免高 skip。批量写使用 <code>bulkWrite</code>，并评估 <code>w: majority</code> 的延迟成本。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/" target="_blank" rel="noopener">MongoDB 性能分析</a></li><li><a href="https://www.mongodb.com/docs/manual/core/wiredtiger/#memory-use" target="_blank" rel="noopener">WiredTiger 缓存</a></li><li><a href="https://help.aliyun.com/zh/mongodb/user-guide/optimize-the-performance-of-an-apsaradb-for-mongodb-instance" target="_blank" rel="noopener">阿里云 MongoDB 调优</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: mongodb
  become: true
  tasks:
    - name: 写入 WiredTiger 缓存
      ansible.builtin.blockinfile:
        path: /etc/mongod.conf
        marker: "# {mark} ANSIBLE 调优"
        block: |
          storage:
            wiredTiger:
              engineConfig:
                cacheSizeGB: 12
      notify: 重启 MongoDB
  handlers:
    - name: 重启 MongoDB
      ansible.builtin.service: {name: mongod, state: restarted}</code></pre>

