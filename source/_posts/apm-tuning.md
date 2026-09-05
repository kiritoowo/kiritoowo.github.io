---
title: APM 调优
date: 2025-09-11 10:00:00
updated: 2025-12-31 17:00:00
description: SkyWalking、Elastic Stack、Prometheus 与 Grafana 从采样、基数、存储、查询和告警入手的可观测性调优方法。
categories:
  - 调优
  - 可观测性
tags:
  - SkyWalking
  - Elastic Stack
  - Prometheus
  - Grafana
---

可观测系统也有容量上限。APM 调优的目标是在故障高峰仍保留关键证据，而不是无差别采集所有日志、指标和链路，最终让观测平台先于业务崩溃。

<!-- more -->

## 1. 从问题而不是工具出发

三类信号各自解决不同问题：

| 信号 | 擅长回答 | 不适合替代 |
| --- | --- | --- |
| Metrics | 是否异常、影响多大、趋势 | 单请求完整上下文 |
| Logs | 发生了什么、错误细节 | 高维聚合和实时 SLO |
| Traces | 时间花在哪一跳 | 所有成功请求永久留存 |

先定义服务 SLO 和 Runbook，再决定采集。HTTP 服务通常按 RED（Rate、Errors、Duration），主机按 USE（Utilization、Saturation、Errors）组织。

## 2. 容量模型

### 2.1 Prometheus 样本

```text
每日样本数 = 活跃时间序列 × 86400 ÷ 抓取间隔秒数
```

100 万序列、15 秒抓取约产生 57.6 亿样本/天。把间隔从 15 秒改为 5 秒会直接增大 3 倍，不是“更精确且免费”。

### 2.2 日志

```text
每日原始日志 = 峰值事件/秒 × 平均字节 × 86400 × 峰值折算系数
存储 = 每日原始量 × 保留天数 × 副本/压缩系数
```

### 2.3 链路

链路成本与采样率、每 Trace Span 数、属性长度和保留期相关。一次请求跨 30 个组件，比单服务 Trace 昂贵得多。先限制 Span/属性，再调整采样率。

## 3. 基数是首要风险

Prometheus 时间序列近似为“指标名 + 标签值组合”。以下标签禁止进入指标：userId、orderId、traceId、完整 URL、错误堆栈和随机容器 ID。

```promql
# 每个指标当前序列数量
topk(20, count by (__name__)({__name__=~".+"}))

# TSDB 活跃序列和样本写入速率
prometheus_tsdb_head_series
rate(prometheus_tsdb_head_samples_appended_total[5m])
```

HTTP 路径使用模板 `/orders/{id}`，状态码可归组为 `2xx/4xx/5xx`。traceId 放日志和 Span，用 Exemplars 从指标跳转链路。

Elastic 的动态字段同样会造成 mapping explosion。日志字段使用受控 ECS/Schema，未知业务字段进入扁平对象或原始消息，而不是自动创建数万个字段。

## 4. SkyWalking Agent

### 4.1 控制 Agent 开销

```text agent.config
agent.service_name=${SW_AGENT_NAME:order-service}
collector.backend_service=${SW_AGENT_COLLECTOR_BACKEND_SERVICES:oap-1:11800,oap-2:11800}
agent.sample_n_per_3_secs=${SW_AGENT_SAMPLE:100}
agent.span_limit_per_segment=${SW_AGENT_SPAN_LIMIT:300}
agent.ignore_suffix=.jpg,.jpeg,.png,.gif,.css,.js,.ico
logging.level=WARN
```

`sample_n_per_3_secs` 是每 3 秒固定采样数，不等同百分比。低流量关键服务可全采，普通高流量服务设置固定上限或使用后端策略。错误和慢请求若要提高保留，应结合尾部采样/规则能力设计。

Span 属性禁止放请求体、令牌、大 SQL 参数和长响应。SQL 记录模板而非敏感值。插件越多不代表越好，禁用不使用的框架插件，升级 Agent 前在压测中比较 CPU、分配率、p99 和网络。

### 4.2 OAP 与存储

OAP 无状态能力可以水平扩展，但分析、聚合和 Elasticsearch 写入才是实际上限。监控 OAP JVM、gRPC 接收、持久化队列、丢弃、存储 bulk 拒绝和查询 p99。

按服务等级设置保留：原始 Trace 短期保留，分钟/小时聚合保留更久。不要让调试期全采样长期占满生产存储。

## 5. Elastic Stack 日志链路

### 5.1 采集端先做减法

Filebeat/Elastic Agent 在边缘过滤 debug、健康检查和重复堆栈，敏感字段在离开主机前脱敏。队列必须有界，后端不可用时不能无限占满磁盘。

```yaml filebeat.yml
queue.mem:
  events: 8192
  flush.min_events: 1024
  flush.timeout: 2s

output.elasticsearch:
  hosts: ["https://es-1:9200", "https://es-2:9200"]
  worker: 2
  bulk_max_size: 1600
  compression_level: 3
  backoff.init: 1s
  backoff.max: 60s
```

批次过大会提高吞吐，也会增加内存和单次重试成本。逐步增加到 Elasticsearch bulk/rejection 或 p99 不再改善为止。

### 5.2 Data Stream 与 ILM

```json
PUT _ilm/policy/app-logs
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
        "actions": { "forcemerge": { "max_num_segments": 1 } }
      },
      "delete": {
        "min_age": "30d",
        "actions": { "delete": {} }
      }
    }
  }
}
```

保留期按合规和排障价值分层，不能所有日志都 180 天热存储。应用、审计和访问日志使用不同数据流和权限。

### 5.3 查询治理

默认查询限定时间范围，Dashboards 避免每次加载 30 天。高基数 terms 聚合限制 bucket，禁止用户提交无界通配符。慢查询与 ingest pipeline 分别监控。

## 6. Prometheus

### 6.1 抓取和 relabel

```yaml prometheus.yml
global:
  scrape_interval: 30s
  scrape_timeout: 10s
  evaluation_interval: 30s

scrape_configs:
  - job_name: spring-apps
    metrics_path: /actuator/prometheus
    kubernetes_sd_configs:
      - role: pod
    metric_relabel_configs:
      - source_labels: [__name__]
        regex: 'jvm_buffer_pool_used_bytes|jvm_classes_loaded_classes'
        action: drop
```

示例 drop 规则只能在确认不用这些指标后采用。`relabel_configs` 处理目标，`metric_relabel_configs` 处理抓到的样本；后者能减少存储，但样本已经通过网络传输并完成解析。

不同信号使用不同频率：核心请求 15～30 秒，变化慢的容量指标 60 秒。规则预聚合常用查询，减少看板反复扫描高基数原始序列。

### 6.2 本地存储和远端写

```text
--storage.tsdb.retention.time=15d
--storage.tsdb.retention.size=400GB
--storage.tsdb.wal-compression
```

同时设置时间和大小时，先达到者触发清理。磁盘必须给 WAL、compaction 和突发留空间。

remote_write 后端变慢时关注 pending samples、shards、retries 和 dropped。队列参数不能无限扩大来掩盖后端故障；本地 Prometheus 仍应保留短期数据供排障。

### 6.3 高可用

两套 Prometheus 独立抓取同一目标，Alertmanager 去重；不要让两个实例共享本地 TSDB。长期全局查询使用 Thanos/Mimir/VictoriaMetrics 等经过容量评估的方案。

## 7. Grafana 看板和告警

一个首页看板只回答“是否有问题、在哪里”，详情通过链接下钻。避免几十个 Panel 各自执行高成本查询。

- 模板变量限制值数量，禁止 `label_values` 扫全局高基数标签；
- 默认时间范围 1～6 小时，最小刷新 30 秒；
- 复用 recording rules；
- 给数据源设置查询超时和并发边界；
- Panel 用 p95/p99、错误率和饱和度，不只看平均值。

告警采用多窗口燃尽率或持续窗口，减少瞬时抖动。每条告警包含服务、影响、查询链接、Runbook、负责人和自动恢复条件。

```promql
# 5 分钟错误率示例
sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
/
sum(rate(http_server_requests_seconds_count[5m]))
```

生产应按请求量设置最小样本条件，低流量服务仅用比例会误报。

## 8. 日志、指标和链路关联

入口生成 traceId，并在进程内传播；日志结构化输出 traceId/spanId；指标通过 exemplar 关联代表性 Trace。跨消息队列要注入和提取上下文，但异步消费的业务因果关系与同步 RPC 不同，Span 类型要正确。

不要把 traceId 作为 Prometheus 标签。日志中也要限制每条记录长度和堆栈重复次数。

## 9. 降级和故障演练

观测后端不可用时业务仍应运行：

- Agent 上报队列有界，满后丢弃低价值遥测；
- 日志采集器不能占满系统盘；
- remote_write 失败不阻塞本地抓取；
- 高峰自动降低成功 Trace 采样，保留错误和关键交易；
- 查询与写入资源隔离，避免事故期间看板把存储压垮。

演练 OAP/Elasticsearch 不可达、Prometheus 重启、remote_write 阻塞、日志突增 10 倍和高基数标签误发布。验收数据丢失范围、业务开销和恢复时间。

## 10. 参考资料

- [Apache SkyWalking 官方文档](https://skywalking.apache.org/docs/)
- [SkyWalking Java Agent 配置](https://skywalking.apache.org/docs/skywalking-java/next/en/setup/service-agent/java-agent/configurations/)
- [Elastic 日志与数据生命周期](https://www.elastic.co/docs/manage-data/lifecycle)
- [Filebeat 内部队列](https://www.elastic.co/docs/reference/beats/filebeat/configuring-internal-queue)
- [Prometheus 存储](https://prometheus.io/docs/prometheus/latest/storage/)
- [Prometheus 配置](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)
- [Prometheus 指标与标签实践](https://prometheus.io/docs/practices/naming/)
- [Grafana 性能最佳实践](https://grafana.com/docs/grafana/latest/administration/)
- [Google SRE：基于 SLO 告警](https://sre.google/workbook/alerting-on-slos/)
- [阿里云 ARMS 可观测最佳实践](https://help.aliyun.com/zh/arms/use-cases/)

## 11. Ansible 配置

```yaml apm-tuning.yml
---
- name: 部署 Prometheus 与 Filebeat 容量基线
  hosts: monitoring_agents
  become: true
  vars:
    elasticsearch_hosts:
      - https://es-1:9200
      - https://es-2:9200
    elasticsearch_username: filebeat_writer
    elasticsearch_password: "{{ vault_elasticsearch_password }}"
  tasks:
    - name: 写入 Prometheus 启动参数
      ansible.builtin.copy:
        dest: /etc/default/prometheus
        mode: "0644"
        backup: true
        content: >-
          ARGS="--storage.tsdb.path=/var/lib/prometheus
          --storage.tsdb.retention.time=15d
          --storage.tsdb.retention.size=400GB
          --storage.tsdb.wal-compression"
      notify: 重启 Prometheus

    - name: 校验并发布 Prometheus 配置
      ansible.builtin.copy:
        dest: /etc/prometheus/prometheus.yml
        owner: root
        group: prometheus
        mode: "0640"
        backup: true
        content: |
          global:
            scrape_interval: 30s
            scrape_timeout: 10s
            evaluation_interval: 30s
          scrape_configs:
            - job_name: node
              static_configs:
                - targets: ['127.0.0.1:9100']
        validate: /usr/bin/promtool check config %s
      notify: 重载 Prometheus

    - name: 写入 Filebeat 配置
      ansible.builtin.copy:
        dest: /etc/filebeat/filebeat.yml
        owner: root
        group: root
        mode: "0640"
        backup: true
        content: |
          filebeat.inputs:
            - type: filestream
              id: application-json
              paths:
                - /var/log/apps/*.json
              parsers:
                - ndjson:
                    add_error_key: true
          queue.mem:
            events: 8192
            flush.min_events: 1024
            flush.timeout: 2s
          output.elasticsearch:
            hosts: {{ elasticsearch_hosts | to_json }}
            username: "{{ elasticsearch_username }}"
            password: "{{ elasticsearch_password }}"
            worker: 2
            bulk_max_size: 1600
            compression_level: 3
            backoff.init: 1s
            backoff.max: 60s
        validate: /usr/share/filebeat/bin/filebeat test config -c %s
      notify: 重启 Filebeat

  handlers:
    - name: 重启 Prometheus
      ansible.builtin.service:
        name: prometheus
        state: restarted

    - name: 重载 Prometheus
      ansible.builtin.service:
        name: prometheus
        state: reloaded

    - name: 重启 Filebeat
      ansible.builtin.service:
        name: filebeat
        state: restarted
```
