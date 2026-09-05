---
title: Elasticsearch 调优篇：堆内存、分片与刷新策略
date: 2024-07-25 10:00:00
categories:
  - 调优
  - 搜索
tags:
  - Elasticsearch
  - 分片
  - ILM
---

<h2>分片不是越多越好</h2>
<p>主分片一旦创建不能直接缩小，因此应按生命周期内的数据量规划，而不是按当天数据量规划。时间序列优先 Data Stream + ILM，按 rollover 的文档数、大小或时间切分；查询跨越过多小分片会放大协调节点 CPU、堆和网络开销。</p>
<pre><code># 查看分片大小、段数量与拒绝请求
GET _cat/shards?v=true&bytes=gb
GET _cat/segments?v=true
GET _nodes/stats/thread_pool?filter_path=nodes.*.thread_pool.write</code></pre>
<h2>查询保护与映射治理</h2>
<p>动态映射只适合受控字段，日志中的任意 JSON 字段可能导致 mapping explosion。为关键词字段选择 keyword，为全文选择 text；不要对不聚合、不排序的字段启用不必要的 doc_values。查询层限制时间范围、聚合桶数和深分页，异常请求通过网关或应用侧提前拒绝。</p>
<table><tr><th>症状</th><th>常见根因</th><th>优先动作</th></tr><tr><td>写入 rejected</td><td>Bulk 并发过高、磁盘慢</td><td>客户端退避并减小批次</td></tr><tr><td>查询慢</td><td>分片过多、深聚合</td><td>缩小范围、预聚合</td></tr><tr><td>堆高</td><td>fielddata、映射膨胀</td><td>修正映射并限制字段</td></tr></table>
<p class="tuning-lead">Elasticsearch 8.x 受 JVM 堆、磁盘 I/O、分片数量和查询模式共同影响；经典基线是堆不超过 31GB、约占物理内存一半。</p>

<!-- more --><h2>节点与 JVM</h2><pre><code># JVM 堆配置文件

-Xms16g
-Xmx16g
# Elasticsearch 配置文件
bootstrap.memory_lock: true
indices.memory.index_buffer_size: 15%
indices.queries.cache.size: 10%</code></pre><p>分片大小建议 20–50GB，采用 ILM 做 Hot/Warm/冷分层；Bulk 从 5–15MB 起步，观察 rejected。</p><h2>写入与查询</h2><pre><code>PUT logs-*/_settings
{"index":{"refresh_interval":"30s","number_of_replicas":1}}
GET _nodes/stats/jvm,fs,thread_pool
GET _cluster/health?level=shards</code></pre><p>导入期间 refresh_interval 可调至 30s，完成后恢复 1s；深分页改用 search_after，映射严格控制高基数字段。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://www.elastic.co/guide/en/elasticsearch/reference/current/tune-for-search-speed.html" target="_blank" rel="noopener">Elastic 性能调优</a></li><li><a href="https://www.elastic.co/guide/en/elasticsearch/reference/current/advanced-configuration.html" target="_blank" rel="noopener">Elastic JVM 设置</a></li><li><a href="https://help.aliyun.com/zh/es/user-guide/optimize-the-performance-of-an-elasticsearch-cluster" target="_blank" rel="noopener">阿里云 Elasticsearch</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: elasticsearch
  become: true
  tasks:
    - name: 设置 vm.max_map_count
      ansible.posix.sysctl: {name: vm.max_map_count, value: '262144', reload: true}
    - name: 设置 16G 堆
      ansible.builtin.copy:
        dest: /etc/elasticsearch/jvm.options.d/heap.options
        mode: '0644'
        content: "-Xms16g\n-Xmx16g\n"
      notify: 重启 Elasticsearch
  handlers:
    - name: 重启 Elasticsearch
      ansible.builtin.service: {name: elasticsearch, state: restarted}</code></pre>
