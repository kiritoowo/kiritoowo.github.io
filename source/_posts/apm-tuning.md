---
title: APM 调优篇：SkyWalking、ELK Stack、Prometheus 与 Grafana
date: 2025-04-17 10:00:00
categories:
  - 调优
  - 可观测性
tags:
  - SkyWalking
  - ELK
  - Prometheus
  - Grafana
---

<p class="tuning-lead">可观测性系统也会消耗 CPU、网络和存储。采用采样优先、标签受控、冷热分层，保证故障高峰仍能查询关键链路。</p><h2>信号与容量基线</h2><table><tr><th>系统</th><th>生产起点</th><th>关键参数</th></tr><tr><td>SkyWalking</td><td>普通链路 10%，错误 100%</td><td>agent.sample_n_per_3_secs</td></tr><tr><td>Prometheus</td><td>抓取 15–30s，保留 30 天</td><td>--storage.tsdb.retention.time=30d</td></tr><tr><td>ELK</td><td>Hot 7 天、Warm 30 天、冷归档</td><td>ILM、bulk pipeline</td></tr><tr><td>Grafana</td><td>查询超时 30s，变量限值</td><td>缓存与并发查询</td></tr></table><h2>降噪与验证</h2><pre><code># Prometheus 启动参数
--storage.tsdb.retention.time=30d
--storage.tsdb.wal-compression
# Filebeat 队列参数
queue.mem.events: 4096
bulk_max_size: 2048
compression_level: 5</code></pre><p>指标标签禁止 userId、requestId 等高基数字段；日志 pipeline 脱敏。看板按 RED/USE 组织，告警带 runbook。演练 Prometheus 重启、ES 节点故障和采样降级。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://skywalking.apache.org/docs/" target="_blank" rel="noopener">SkyWalking</a></li><li><a href="https://prometheus.io/docs/prometheus/latest/configuration/configuration/" target="_blank" rel="noopener">Prometheus 配置</a></li><li><a href="https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html" target="_blank" rel="noopener">Elastic ILM</a></li><li><a href="https://grafana.com/docs/grafana/latest/administration/" target="_blank" rel="noopener">Grafana 管理</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: monitoring
  become: true
  tasks:
    - name: 部署 Prometheus 保留策略
      ansible.builtin.copy:
        dest: /etc/default/prometheus
        mode: '0644'
        content: 'ARGS=--storage.tsdb.retention.time=30d --storage.tsdb.wal-compression\n'
      notify: 重启 Prometheus
    - name: 配置 Filebeat 队列
      ansible.builtin.blockinfile:
        path: /etc/filebeat/filebeat.yml
        marker: "# {mark} ANSIBLE 调优"
        block: |
          queue.mem.events: 4096
          bulk_max_size: 2048
  handlers:
    - name: 重启 Prometheus
      ansible.builtin.service: {name: prometheus, state: restarted}</code></pre>

