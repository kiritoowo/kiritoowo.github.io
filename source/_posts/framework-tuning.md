---
title: 框架调优篇：Spring、Spring Boot、MyBatis/Plus、JPA、Netty 与 Sharding-JDBC
date: 2025-01-16 10:00:00
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

<p class="tuning-lead">以 Spring Boot 3.x + Java 21 为例，从线程模型、连接池和序列化边界入手；所有超时小于上游网关并为重试预留预算。</p><h2>Spring Boot 与连接池</h2><pre><code>server.tomcat.threads.max=400
server.tomcat.accept-count=200
spring.mvc.async.request-timeout=5000
spring.datasource.hikari.maximum-pool-size=32
spring.datasource.hikari.connection-timeout=3000
spring.datasource.hikari.leak-detection-threshold=5000
management.endpoints.web.exposure.include=health,metrics,prometheus</code></pre><h2>MyBatis/JPA/分库分表</h2><p>MyBatis/Plus 分页单页限制 1000 行，批量写使用 BATCH；JPA 关闭 Open Session in View，设置 <code>hibernate.jdbc.batch_size=50</code>、<code>order_inserts=true</code> 并用实体图解决 N+1。Sharding-JDBC 明确分片键、广播表和 SQL 重写日志。</p><h2>Netty</h2><pre><code>bossEventLoopGroup=1
workerEventLoopGroup=CPU*2
ChannelOption.SO_BACKLOG=4096
ChannelOption.TCP_NODELAY=true
WRITE_BUFFER_WATER_MARK=32MB/64MB</code></pre><p>阻塞操作投递到独立线程池；关注 eventLoop pending tasks 与 direct memory。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://docs.spring.io/spring-boot/docs/current/reference/html/application-properties.html" target="_blank" rel="noopener">Spring Boot 配置</a></li><li><a href="https://mybatis.org/mybatis-3/performance.html" target="_blank" rel="noopener">MyBatis 性能 FAQ</a></li><li><a href="https://netty.io/wiki/user-guide-for-4.x.html" target="_blank" rel="noopener">Netty 用户指南</a></li><li><a href="https://help.aliyun.com/zh/mse/user-guide/performance-tuning" target="_blank" rel="noopener">阿里云 Spring Cloud 实践</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: spring_app
  become: true
  tasks:
    - name: 写入 Spring Boot 参数
      ansible.builtin.copy:
        dest: /etc/myapp/application-prod.properties
        mode: '0644'
        content: |
          server.tomcat.threads.max=400
          spring.datasource.hikari.maximum-pool-size=32
          spring.datasource.hikari.connection-timeout=3000
          management.endpoints.web.exposure.include=health,metrics,prometheus</code></pre>

