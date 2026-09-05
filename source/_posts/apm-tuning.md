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

<h2>高基数、采样和存储成本</h2>
<p>APM 系统最容易被高基数标签和无边界日志拖垮。指标标签禁止使用 userId、订单号、完整 URL 和 requestId；这些字段放到日志或链路 span 的受控属性中。SkyWalking 采样率按服务重要性分级，错误、慢请求和关键交易可以提升采样，正常成功链路按比例采样。</p>
<pre><code># Prometheus 查询：识别高基数指标
topk(20, count by (__name__)({__name__=~".+"}))
# 查看目标抓取与样本增长
prometheus_tsdb_head_series
rate(prometheus_tsdb_head_samples_appended_total[5m])</code></pre>
<h2>告警要可行动</h2>
<p>告警使用多窗口、燃尽率或 RED/USE 指标，避免单个瞬时点触发。每条告警包含影响范围、查询链接、runbook、负责人和自动恢复动作。日志、指标和链路使用同一 traceId，但不要把完整请求体写入日志；敏感字段在采集端脱敏。</p>
<div class="tuning-tip">观测系统故障时业务仍应可用：Agent 上报失败要丢弃或限队列，Filebeat/OTel 缓冲达到阈值要降级，Prometheus remote_write 失败不能阻塞本地抓取。</div>
<p class="tuning-lead">可观测性系统也会消耗 CPU、网络和存储。采用采样优先、标签受控、冷热分层，保证故障高峰仍能查询关键链路。</p>

<!-- more --><h2>信号与容量基线</h2><table><tr><th>系统</th><th>生产起点</th><th>关键参数</th></tr><tr><td>SkyWalking</td><td>普通链路 10%，错误 100%</td><td>agent.sample_n_per_3_secs</td></tr><tr><td>Prometheus</td><td>抓取 15–30s，保留 30 天</td><td>--storage.tsdb.retention.time=30d</td></tr><tr><td>ELK</td><td>Hot 7 天、Warm 30 天、冷归档</td><td>ILM、bulk pipeline</td></tr><tr><td>Grafana</td><td>查询超时 30s，变量限值</td><td>缓存与并发查询</td></tr></table><h2>降噪与验证</h2><pre><code># Prometheus 启动参数

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
