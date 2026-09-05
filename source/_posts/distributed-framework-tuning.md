---
title: 分布式框架调优
date: 2025-07-24 10:00:00
updated: 2025-12-31 16:00:00
description: Spring Cloud Alibaba、Nacos、Seata、Gateway、OpenFeign、Sentinel、ShardingSphere-Proxy 与 XXL-JOB 的系统调优。
categories:
  - 调优
  - 分布式
tags:
  - Spring Cloud
  - Nacos
  - Seata
  - Sentinel
---

分布式调优不是分别放大每个组件的线程和连接，而是统一设计端到端截止时间、重试上限、熔断、限流和资源隔离，防止一次下游抖动演变成全链路重试风暴。

<!-- more -->

## 1. 先做版本矩阵

Spring Boot、Spring Cloud、Spring Cloud Alibaba、Nacos、Sentinel 和 Seata 有明确的兼容矩阵。先选择一个发布列车并锁定 BOM，不能只把某个组件升级到 latest。

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.cloud</groupId>
      <artifactId>spring-cloud-dependencies</artifactId>
      <version>${spring-cloud.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
    <dependency>
      <groupId>com.alibaba.cloud</groupId>
      <artifactId>spring-cloud-alibaba-dependencies</artifactId>
      <version>${spring-cloud-alibaba.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

升级时执行契约测试、故障注入和滚动兼容验证，特别关注配置格式、序列化、注册协议和客户端重试默认值。

## 2. 端到端时间预算

假设入口 SLO 为 3 秒，可以分配：Gateway 2.8 秒、服务总预算 2.5 秒、单次 Feign 800 ms、连接建立 200 ms、数据库 500 ms，并为序列化和排队留余量。

```text
总预算 >= 排队 + 本地计算 + Σ(远程尝试耗时) + 数据库 + 返回传输
```

重试放大近似为：

```text
最坏下游请求数 = 上游并发 × 每层尝试次数的乘积
```

三层各重试 3 次，最坏可能把一次调用放大为 27 次。通常只在最了解幂等与剩余预算的一层重试一次，并带指数退避和随机抖动。

## 3. Gateway：入口背压

WebFlux Gateway 基于 Reactor/Netty，路由过滤器中不能调用阻塞 JDBC、`RestTemplate` 或文件 I/O。确有阻塞遗留逻辑时移到受限的 `boundedElastic`，并尽快消除。

```yaml
spring:
  cloud:
    gateway:
      httpclient:
        connect-timeout: 500
        response-timeout: 3s
        pool:
          type: fixed
          max-connections: 500
          acquire-timeout: 500
          max-idle-time: 30s
          max-life-time: 5m
      routes:
        - id: order-service
          uri: lb://order-service
          predicates:
            - Path=/api/orders/**
```

属性前缀在不同 Spring Cloud 主版本可能调整，升级时以该发布列车的配置元数据为准。

连接池上限按每个下游拆分，不能让一个慢服务耗尽全部连接。监控 acquire pending、连接建立、响应头、完整响应和 4xx/5xx。

入口还应限制请求体、Header、路由并发和租户 QPS。限流返回 429 并携带可观测错误码，不要排队到超时。

## 4. OpenFeign：连接、超时与重试

```yaml
spring:
  cloud:
    openfeign:
      client:
        config:
          default:
            connectTimeout: 500
            readTimeout: 2000
            loggerLevel: basic
          inventory-service:
            connectTimeout: 300
            readTimeout: 800
```

Spring Cloud OpenFeign 默认创建 `Retryer.NEVER_RETRY`，这是合理起点。只对 GET 或具备幂等键的调用启用有限重试，并确认 HTTP 客户端连接池总量。

Feign FULL 日志会复制请求/响应内容、泄露敏感字段并显著增加 I/O，只在隔离诊断时短期开启。生产记录路由、状态、耗时、异常类型和 traceId。

## 5. Sentinel：限流、熔断和系统保护

先用历史峰值和压测建立基线，再设置规则：

| 规则 | 适用问题 | 注意点 |
| --- | --- | --- |
| QPS 限流 | 平滑流量超过容量 | 对快接口直观 |
| 并发线程数 | 慢调用占满资源 | 能反映耗时上升 |
| 慢调用比例熔断 | 下游持续变慢 | 需要最小请求数 |
| 异常比例/数 | 下游错误 | 过滤业务预期异常 |
| 系统规则 | 全机过载 | 不能替代资源级规则 |

规则持久化到 Nacos 等数据源，并区分环境和集群。降级结果必须是业务可接受的缓存、默认值或明确失败，不能返回“成功 + 空数据”掩盖问题。

热点参数限流适合商品 ID 等局部热点，但要限制参数解析和规则数量。集群流控 Token Server 本身需要高可用和容量监控。

## 6. Nacos：注册与配置分开看

生产使用至少 3 个节点并跨故障域部署，启用鉴权和 TLS/网络隔离。Nacos 2.x/3.x 除 HTTP 端口外还有客户端 gRPC 等端口，防火墙和负载均衡必须按目标版本官方端口表开放。

### 6.1 注册中心

- 实例健康检查和客户端心跳不能过于激进；
- 推空保护和本地缓存是故障兜底，不代表永久使用旧地址；
- 客户端收到实例变更后要平滑更新连接池；
- 监控注册实例数、推送延迟、失败、Raft 和 JVM。

### 6.2 配置中心

Namespace 隔离环境，Group 隔离应用域，Data ID 表达具体配置。配置发布必须有 schema 校验、灰度、审计和一键回滚。

不要把大文件、高频变化数据或密钥明文当普通配置推送。动态线程池参数也必须有最小/最大边界，不能让错误配置瞬间放大到全实例。

## 7. Seata：全局事务要短

AT 模式依赖数据库本地事务、undo log 和全局锁。全局事务中不能包含用户交互、长 RPC 或大批量更新。

重点指标：全局事务数/耗时、分支注册、全局锁等待、回滚失败、`undo_log` 增长和 TC 存储延迟。

优化顺序：

1. 缩短全局事务，减少参与者；
2. 所有 SQL 使用索引，避免锁住大范围；
3. 将可异步步骤改为 Saga/最终一致；
4. 高争用资源评估 TCC，由业务实现 Try/Confirm/Cancel 幂等；
5. 定期清理已完成的 undo log，并告警异常增长。

Seata 超时应小于上游总预算但大于正常事务 p99。超时过长会长期持锁，过短会制造回滚风暴。

## 8. ShardingSphere-Proxy

Proxy 让多语言客户端使用数据库协议接入分片，但新增一跳网络、解析、路由、归并和连接池。

- Proxy 集群无状态部署，配置中心和元数据需一致；
- 前端连接数、后端每数据源连接池和数据库总连接统一预算；
- SQL 必须携带分片键，限制广播查询、跨库排序和无界分页；
- DistSQL 变更纳入版本控制和审计；
- SQL Federation 只用于明确接受代价的跨源查询。

慢查询要拆分 Proxy 耗时和真实数据库耗时。Proxy CPU 高常见于 SQL 解析、大量路由单元和内存归并，不是增加数据库连接就能解决。

## 9. XXL-JOB：调度不等于执行无限任务

调度中心高可用依赖共享数据库，执行器按业务隔离。每个任务定义：幂等业务键、最大运行时间、失败重试、分片参数、并发策略和告警负责人。

| 场景 | 建议 |
| --- | --- |
| 大表扫描 | 按主键/时间分片，记录 checkpoint |
| 多实例并行 | 分片广播，确保分片参数稳定 |
| 长任务 | 子任务化，支持断点续跑 |
| 重复触发 | 数据库唯一键或状态机幂等 |
| 错过调度 | 明确忽略、立即执行或补数策略 |

失败重试不能直接重复一个非幂等长事务。任务线程池与在线请求隔离，批任务对数据库和 MQ 限速。

## 10. 统一观测和故障演练

每次远程调用记录：traceId、调用方、目标服务、路由、剩余 deadline、尝试次数、连接/响应耗时、状态、异常和 fallback。

统一看板按入口 -> 服务 -> 中间件 -> 数据库展开，避免每个组件单独“都是绿色”。核心告警：

- Gateway pending/429/5xx；
- Feign 连接池等待和超时；
- Sentinel block、熔断状态和 fallback；
- Nacos 推送/注册失败；
- Seata 全局锁和回滚；
- Proxy 路由单元、连接池和归并；
- XXL-JOB 延迟、运行时长和失败。

依次演练 Nacos 单节点/多数节点故障、下游延迟、连接池耗尽、错误配置推送、Seata TC 故障、Proxy 节点退出和任务重复触发。验收恢复过程，而非只验证组件能启动。

## 11. 参考资料

- [Spring Cloud 官方文档](https://spring.io/projects/spring-cloud)
- [Spring Cloud Alibaba 版本说明](https://sca.aliyun.com/docs/2023/overview/version-explain/)
- [Spring Cloud Gateway](https://docs.spring.io/spring-cloud-gateway/reference/)
- [Spring Cloud OpenFeign](https://docs.spring.io/spring-cloud-openfeign/reference/)
- [Nacos 官方文档](https://nacos.io/docs/latest/overview/)
- [Sentinel 官方文档](https://sentinelguard.io/zh-cn/docs/introduction.html)
- [Apache Seata 官方文档](https://seata.apache.org/docs/overview/what-is-seata/)
- [ShardingSphere Proxy](https://shardingsphere.apache.org/document/current/en/user-manual/shardingsphere-proxy/)
- [XXL-JOB 官方文档](https://www.xuxueli.com/xxl-job/)
- [阿里云 MSE 微服务治理最佳实践](https://help.aliyun.com/zh/mse/use-cases/)

## 12. Ansible 配置

示例把统一超时和治理开关发布到服务本地配置；认证信息应由 Vault 或密钥服务注入。

```yaml distributed-framework-tuning.yml
---
- name: 部署微服务治理基线
  hosts: microservices
  become: true
  vars:
    service_name: order-service
    nacos_server_addr: "nacos-1:8848,nacos-2:8848,nacos-3:8848"
  tasks:
    - name: 创建服务配置目录
      ansible.builtin.file:
        path: "/etc/{{ service_name }}"
        state: directory
        owner: "{{ service_name }}"
        group: "{{ service_name }}"
        mode: "0750"

    - name: 写入微服务治理参数
      ansible.builtin.copy:
        dest: "/etc/{{ service_name }}/application-cloud.yml"
        owner: "{{ service_name }}"
        group: "{{ service_name }}"
        mode: "0640"
        backup: true
        content: |
          spring:
            cloud:
              nacos:
                discovery:
                  server-addr: {{ nacos_server_addr }}
                  namespace: production
                  group: ORDER
                config:
                  server-addr: {{ nacos_server_addr }}
                  namespace: production
                  group: ORDER
              openfeign:
                client:
                  config:
                    default:
                      connectTimeout: 500
                      readTimeout: 2000
                      loggerLevel: basic
              gateway:
                httpclient:
                  connect-timeout: 500
                  response-timeout: 3s
                  pool:
                    type: fixed
                    max-connections: 500
                    acquire-timeout: 500
              sentinel:
                eager: true
      notify: 重启微服务

  handlers:
    - name: 重启微服务
      ansible.builtin.service:
        name: "{{ service_name }}"
        state: restarted
```
