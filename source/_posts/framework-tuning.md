---
title: 框架调优
date: 2025-06-05 10:00:00
updated: 2025-12-31 15:00:00
description: Spring、Spring Boot、MyBatis/Plus、JPA、Netty 与 ShardingSphere-JDBC 的线程、连接、SQL 和分片调优方法。
categories:
  - 调优
  - 框架
tags:
  - Spring
  - Spring Boot
  - MyBatis
  - JPA
  - Netty
---

框架调优的主线是一次请求经过的资源池：入口线程、业务执行器、HTTP 连接池、数据库连接池、ORM、分片路由。每个池都必须有上限、等待时间、指标和拒绝策略。

<!-- more -->

## 1. 先建立统一容量模型

```text
并发需求 ≈ 峰值请求/秒 × 平均处理秒数
端到端 p99 ≈ 排队时间 + 应用执行 + RPC + 数据库 + 序列化
```

如果 1,000 RPS 的接口平均耗时 100 ms，平均在途请求约 100。线程池设为 500 并不会让下游数据库更快，只会允许更多请求同时排队。

| 资源池 | 必须设置 | 必须监控 |
| --- | --- | --- |
| Web 线程/虚拟线程 | 并发边界、请求超时 | busy、queue、reject |
| `@Async` 执行器 | core/max/queue/reject | active、queue、耗时 |
| HTTP 客户端 | max total/per route、超时 | lease wait、连接失败 |
| HikariCP | maximum、acquire timeout | active、pending、timeout |
| Netty EventLoop | 不执行阻塞任务 | pending tasks、event loop lag |

先按最稀缺下游做并发预算，再从外向内设置上限。所有队列无界是最危险的“稳定假象”。

## 2. 可观测基线

Spring Boot Actuator 只暴露必要端点并置于管理网：

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  endpoint:
    health:
      probes:
        enabled: true
  metrics:
    distribution:
      percentiles-histogram:
        http.server.requests: true
```

同时记录 JVM/JFR、Web p99、各执行器队列、Hikari pending、SQL 模板、HTTP 下游和 GC。只看接口平均耗时无法定位排队发生在哪一层。

## 3. Spring Core：代理边界和对象创建

### 3.1 事务与异步代理

`@Transactional`、`@Async` 和缓存通常通过代理实现；同类自调用会绕过代理。事务方法应短小，不能包含远程调用和长计算。

```java
@Service
public class OrderService {
    private final OrderRepository orderRepository;

    public OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Transactional(timeout = 2)
    public void confirm(long orderId) {
        orderRepository.markConfirmed(orderId);
    }
}
```

避免在事务内发同步 HTTP 或等待 MQ 确认。跨系统事件使用 Outbox 或事务消息，将锁持有时间限定在本地数据库操作。

### 3.2 Bean 与启动时间

不要用全包扫描把测试、脚本和无关模块带进生产上下文。大型项目按功能拆 `@Configuration`，使用条件装配，并通过 Spring Boot Startup Endpoint/JFR 找慢 Bean。`spring.main.lazy-initialization=true` 只把成本推迟到首个请求，还可能延后暴露配置错误，不宜作为默认优化。

## 4. Spring Boot Web 层

平台线程模型示例：

```yaml
server:
  tomcat:
    threads:
      max: 240
      min-spare: 20
    max-connections: 8192
    accept-count: 500
    connection-timeout: 3s
  shutdown: graceful

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

Java 21 可试验虚拟线程：

```yaml
spring:
  threads:
    virtual:
      enabled: true
```

启用后仍要限制数据库、HTTP 和消息消费并发。用 JFR 检查 pinned virtual thread，并确认所有监控组件兼容。

### 4.1 `@Async` 必须显式配置

```java
@Bean("notificationExecutor")
public ThreadPoolTaskExecutor notificationExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(8);
    executor.setMaxPoolSize(32);
    executor.setQueueCapacity(500);
    executor.setKeepAliveSeconds(60);
    executor.setThreadNamePrefix("notify-");
    executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
    executor.initialize();
    return executor;
}
```

`CallerRunsPolicy` 能产生反压，但会占用调用线程；不适合必须快速返回的入口。不同业务使用独立执行器，避免邮件任务堵塞订单任务。

## 5. HikariCP 与数据库容量

连接池不是越大越快。数据库 CPU 核数、I/O 和活跃查询才决定有效并发。每实例从 10～30 条连接压测，集群总连接要小于数据库预算。

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 24
      minimum-idle: 8
      connection-timeout: 1000
      validation-timeout: 1000
      idle-timeout: 600000
      max-lifetime: 1740000
      keepalive-time: 120000
```

`max-lifetime` 应短于数据库、代理和网络设备的连接回收时间。`leak-detection-threshold` 适合诊断期，阈值过低会生成大量堆栈并把慢 SQL 误报为泄漏。

关键指标是 pending threads 和 acquire time。连接持续不够时先看慢 SQL、事务和数据库饱和度，再决定扩池。

## 6. MyBatis 与 MyBatis-Plus

### 6.1 查询边界

```yaml
mybatis:
  configuration:
    default-statement-timeout: 3
    default-fetch-size: 200
    map-underscore-to-camel-case: true
    local-cache-scope: statement
```

`fetch-size` 是驱动提示，实际行为取决于 JDBC 驱动。列表接口使用明确 DTO、字段清单和最大页大小，不要返回实体全列。

MyBatis 的嵌套 select 容易形成 N+1：一页 100 条数据再查询 100 次关联表。改为 JOIN、批量 `IN`（有数量上限）或两阶段批量查询，并用 SQL 计数测试防回归。

### 6.2 批量写

```java
try (SqlSession session = sqlSessionFactory.openSession(ExecutorType.BATCH, false)) {
    OrderMapper mapper = session.getMapper(OrderMapper.class);
    for (int i = 0; i < orders.size(); i++) {
        mapper.insert(orders.get(i));
        if ((i + 1) % 500 == 0) {
            session.flushStatements();
            session.commit();
            session.clearCache();
        }
    }
    session.commit();
}
```

批次按行数和字节数双重限制。MySQL 驱动批写还需验证 `rewriteBatchedStatements` 对当前语句是否有效。

### 6.3 MyBatis-Plus 防失控

分页插件设置 `maxLimit`，并限制单页大小；多租户、逻辑删除和数据权限插件会改写 SQL，上线前必须对生成 SQL 执行 `EXPLAIN ANALYZE`。Wrapper 中禁止直接拼接未校验的列名和 SQL 片段。

## 7. JPA/Hibernate

```yaml
spring:
  jpa:
    open-in-view: false
    properties:
      hibernate:
        jdbc:
          batch_size: 50
          fetch_size: 200
        order_inserts: true
        order_updates: true
        query:
          fail_on_pagination_over_collection_fetch: true
```

关闭 Open Session in View 后，查询边界变得明确，避免模板/序列化阶段意外触发 SQL。通过 fetch join、EntityGraph 或 DTO projection 解决 N+1，但不能同时 fetch 多个大集合后分页。

批量写入每 50～500 条 `flush()` + `clear()`，否则 Persistence Context 会持续持有实体。数据库使用 IDENTITY 主键时，Hibernate JDBC batching 可能受限，需按数据库策略验证。

二级缓存只适合读多写少且失效语义明确的数据。缓存命中率低或失效频繁时，它会增加复杂度而非提速。

## 8. Netty

Netty 的 EventLoop 负责 I/O 事件，严禁在其中执行 JDBC、阻塞 HTTP、文件 I/O 或长计算。

```java
EventLoopGroup bossGroup = new NioEventLoopGroup(1);
EventLoopGroup workerGroup = new NioEventLoopGroup();
DefaultEventExecutorGroup businessGroup = new DefaultEventExecutorGroup(32);

ServerBootstrap bootstrap = new ServerBootstrap()
    .group(bossGroup, workerGroup)
    .channel(NioServerSocketChannel.class)
    .option(ChannelOption.SO_BACKLOG, 4096)
    .childOption(ChannelOption.TCP_NODELAY, true)
    .childOption(ChannelOption.SO_KEEPALIVE, true)
    .childOption(ChannelOption.WRITE_BUFFER_WATER_MARK,
        new WriteBufferWaterMark(32 * 1024, 64 * 1024));

pipeline.addLast(businessGroup, "businessHandler", businessHandler);
```

默认 worker 线程数通常已按 CPU 计算，先保留默认。监控 pending tasks、EventLoop lag、direct memory、allocator、channel 数和不可写时间。Channel `isWritable=false` 时上游必须停止或降低写入。

引用计数 `ByteBuf` 必须在所有异常分支释放；测试环境启用高级 leak detector，生产保留较低采样以控制开销。

Linux 可在验证兼容性后使用 native epoll/io_uring transport，但收益取决于负载，不应在没有基准测试时替换。

## 9. ShardingSphere-JDBC

分片的第一性能原则是让 SQL 携带 shard key。缺失分片键会路由到全部数据源，分页、排序和聚合需要在内存归并。

```yaml
spring:
  shardingsphere:
    datasource:
      names: ds0,ds1
    rules:
      sharding:
        tables:
          t_order:
            actual-data-nodes: ds$->{0..1}.t_order_$->{0..15}
            database-strategy:
              standard:
                sharding-column: tenant_id
                sharding-algorithm-name: tenant-inline
            table-strategy:
              standard:
                sharding-column: order_id
                sharding-algorithm-name: order-inline
```

调优时检查：实际路由单元、每个物理数据源连接池、SQL 改写、归并内存和跨库事务。广播表适合小且变化不频繁的字典，不适合大表。

避免跨分片无界分页。按分片键定向查询，或者建设独立检索/分析索引。分片数、表数和数据源连接池相乘后可能产生巨大连接总量，必须做全局预算。

## 10. 压测与回归门禁

1. 固定数据规模、JDK、容器资源和下游版本。
2. 预热 JIT、连接池和缓存后再采样。
3. 阶梯增加并发，找到 Web、执行器、连接池、数据库或 CPU 中第一个饱和点。
4. 故意让数据库和 RPC 变慢，验证超时、拒绝和恢复。
5. 比较吞吐、p99、队列、pending、SQL 数、扫描行、GC 和 RSS。

性能测试中增加断言：单请求 SQL 数上限、最大分页、连接池等待、分片路由数和响应字节数，防止后续代码重新引入 N+1。

## 11. 参考资料

- [Spring Framework 参考文档](https://docs.spring.io/spring-framework/reference/)
- [Spring Boot 性能与生产特性](https://docs.spring.io/spring-boot/reference/actuator/)
- [Spring Boot 应用属性](https://docs.spring.io/spring-boot/appendix/application-properties/)
- [HikariCP 配置说明](https://github.com/brettwooldridge/HikariCP#configuration-knobs-baby)
- [MyBatis 官方配置](https://mybatis.org/mybatis-3/configuration.html)
- [MyBatis-Plus 分页插件](https://baomidou.com/plugins/pagination/)
- [Hibernate 性能调优](https://docs.jboss.org/hibernate/orm/current/userguide/html_single/Hibernate_User_Guide.html#performance)
- [Netty 用户指南](https://netty.io/wiki/user-guide-for-4.x.html)
- [Apache ShardingSphere 性能测试](https://shardingsphere.apache.org/document/current/en/reference/sharding/)

## 12. Ansible 配置

```yaml framework-tuning.yml
---
- name: 部署 Spring Boot 生产参数
  hosts: spring_apps
  become: true
  vars:
    application_name: order-service
    datasource_pool_size: 24
  tasks:
    - name: 创建应用配置目录
      ansible.builtin.file:
        path: "/etc/{{ application_name }}"
        state: directory
        owner: "{{ application_name }}"
        group: "{{ application_name }}"
        mode: "0750"

    - name: 写入生产配置
      ansible.builtin.copy:
        dest: "/etc/{{ application_name }}/application-prod.yml"
        owner: "{{ application_name }}"
        group: "{{ application_name }}"
        mode: "0640"
        backup: true
        content: |
          server:
            tomcat:
              threads:
                max: 240
                min-spare: 20
              max-connections: 8192
              accept-count: 500
              connection-timeout: 3s
            shutdown: graceful
          spring:
            lifecycle:
              timeout-per-shutdown-phase: 30s
            datasource:
              hikari:
                maximum-pool-size: {{ datasource_pool_size }}
                minimum-idle: 8
                connection-timeout: 1000
                validation-timeout: 1000
                max-lifetime: 1740000
                keepalive-time: 120000
            jpa:
              open-in-view: false
          management:
            endpoints:
              web:
                exposure:
                  include: health,info,metrics,prometheus
      notify: 重启应用

  handlers:
    - name: 重启应用
      ansible.builtin.service:
        name: "{{ application_name }}"
        state: restarted
```
