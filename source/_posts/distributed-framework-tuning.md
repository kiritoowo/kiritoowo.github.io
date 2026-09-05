---
title: 分布式框架调优篇：Spring Cloud Alibaba、Nacos、Seata、Gateway、OpenFeign、Sentinel、Sharding-Proxy 与 XXL-JOB
date: 2025-03-06 10:00:00
categories:
  - 调优
  - 分布式
tags:
  - Spring Cloud
  - Nacos
  - Seata
  - Sentinel
---

<p class="tuning-lead">分布式调优首先控制重试和连接总量，把超时、重试、熔断、限流、注册中心和任务调度纳入容量预算，避免重试风暴。</p><h2>组件基线</h2><table><tr><th>组件</th><th>生产建议</th></tr><tr><td>Nacos</td><td>≥3 节点、鉴权；长轮询 30s，本地快照</td></tr><tr><td>OpenFeign</td><td>connectTimeout 1s、readTimeout 3s；幂等请求最多重试 1 次</td></tr><tr><td>Gateway</td><td>连接池按下游容量，response-timeout 5s</td></tr><tr><td>Sentinel</td><td>QPS+并发双维度限流，规则持久化 Nacos</td></tr><tr><td>Seata</td><td>AT 事务短小，undo 日志清理；强一致评估 TCC</td></tr><tr><td>XXL-JOB</td><td>线程池隔离，错峰触发，失败重试≤2</td></tr></table><h2>重试预算流程</h2><div class="mermaid">flowchart TD
U[用户请求]-->G[Gateway 5s]
G-->F[Feign 1s/3s 重试1]
F-->S[Sentinel 熔断限流]
S-->D[下游服务]
D-->DB[(数据库连接池)]</div><p>ShardingSphere-Proxy 开启 SQL 审计和连接池上限，分片键必须出现在查询条件；跨库事务交由 Seata 或最终一致方案。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://sca.aliyun.com/" target="_blank" rel="noopener">Spring Cloud Alibaba</a></li><li><a href="https://nacos.io/docs/latest/" target="_blank" rel="noopener">Nacos 文档</a></li><li><a href="https://sentinelguard.io/zh-cn/docs/" target="_blank" rel="noopener">Sentinel 文档</a></li><li><a href="https://seata.apache.org/zh-cn/docs/overview/" target="_blank" rel="noopener">Seata 文档</a></li><li><a href="https://www.xuxueli.com/xxl-job/" target="_blank" rel="noopener">XXL-JOB 文档</a></li><li><a href="https://help.aliyun.com/zh/mse/user-guide/performance-tuning" target="_blank" rel="noopener">阿里云 MSE 调优</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: microservices
  become: true
  tasks:
    - name: 写入统一超时配置
      ansible.builtin.copy:
        dest: /etc/myapp/bootstrap.properties
        mode: '0644'
        content: |
          spring.cloud.openfeign.client.config.default.connectTimeout=1000
          spring.cloud.openfeign.client.config.default.readTimeout=3000
          spring.cloud.gateway.httpclient.response-timeout=5s
          spring.cloud.sentinel.eager=true
          spring.cloud.nacos.discovery.watch.enabled=true</code></pre>

