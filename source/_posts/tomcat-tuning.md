---
title: Tomcat 调优
date: 2025-02-27 10:00:00
updated: 2025-12-31 13:00:00
description: Tomcat 10.1/11 从连接、线程、超时、请求体、压缩、会话和 JVM 入手，完成容量测算、诊断与压测验收。
categories:
  - 调优
  - Web 容器
tags:
  - Tomcat
  - 线程池
  - NIO
---

Tomcat 调优应沿一次 HTTP 请求的生命周期展开：连接进入 accept 队列、分配工作线程、执行业务和下游调用、写回响应、复用或关闭连接。任何一层无界都会把过载变成长尾延迟。

<!-- more -->

## 1. 版本和部署边界

Tomcat 10.1 对应 Jakarta Servlet 6.0，Tomcat 11 对应 Servlet 6.1 且要求 Java 17 及以上。`javax.*` 应用升级到 `jakarta.*` 前要完成依赖迁移，性能参数不能解决兼容问题。

典型生产链路是 CDN/SLB -> OpenResty/Nginx -> Tomcat。TLS、慢客户端和静态文件优先由入口层处理，Tomcat 聚焦动态请求。只有明确需要端到端 TLS 时才在 Tomcat 直接配置证书。

## 2. 从 Little's Law 估算线程

```text
服务内并发 ≈ 峰值请求/秒 × 平均处理秒数
```

例如 2,000 RPS、平均 50 ms，平均执行并发约为 100；p99 和突发会更高，可从 160～240 个线程压测。不要直接照抄 `maxThreads=1000`：线程越多，栈内存、上下文切换和对下游的并发冲击越大。

容量表必须把这些值放在一起：

| 层次 | 上限 | 失败方式 |
| --- | ---: | --- |
| 入口代理活动连接 | 20,000 | 限流或 503 |
| Tomcat `maxConnections` | 8,192 | 连接进入 OS backlog |
| `acceptCount` | 500 | 新连接被拒绝/超时 |
| 工作线程 | 200 | 请求等待线程 |
| 数据库连接池 | 32 | 线程等待连接 |

数据库池通常小于 Tomcat 线程池。如果所有工作线程都同步等待数据库，扩大 Tomcat 线程只会让数据库排队更严重。

## 3. Connector 和共享 Executor

现代 Tomcat 默认 NIO Connector 已适合大多数场景。使用共享 Executor 能让多个 Connector 共用明确的线程预算：

```xml server.xml
<Executor
  name="tomcatThreadPool"
  namePrefix="http-exec-"
  maxThreads="240"
  minSpareThreads="20"
  maxQueueSize="500"
  prestartminSpareThreads="true" />

<Connector
  executor="tomcatThreadPool"
  protocol="org.apache.coyote.http11.Http11NioProtocol"
  address="127.0.0.1"
  port="8080"
  maxConnections="8192"
  acceptCount="500"
  connectionTimeout="3000"
  keepAliveTimeout="15000"
  maxKeepAliveRequests="1000"
  maxHttpRequestHeaderSize="16384"
  maxPostSize="2097152"
  maxSwallowSize="2097152"
  compression="on"
  compressionMinSize="2048"
  compressibleMimeType="text/html,text/plain,text/css,application/json,application/javascript"
  server="" />
```

有共享 Executor 时 Connector 的 `maxThreads` 不生效。`maxQueueSize` 用来限制等待任务，避免无界排队；具体属性是否受目标 Tomcat 小版本支持，要在升级时对照官方组件文档并执行启动校验。

### 3.1 连接参数的关系

- `maxConnections`：Tomcat 同时接受并处理的连接上限；
- `acceptCount`：达到最大连接数后操作系统等待队列长度；
- `somaxconn`：内核监听队列上限；
- `maxKeepAliveRequests`：单连接最多请求数；
- `keepAliveTimeout`：等待下一请求的时间。

入口代理到 Tomcat 应复用 upstream keep-alive。若每个请求都新建连接，临时端口、握手和 `TIME_WAIT` 会先成为瓶颈。

## 4. 超时必须从入口向下递减

假设网关总预算 5 s，可采用：Tomcat 异步请求 4.5 s、远程调用 2 s、数据库查询 1 s、连接池获取 200 ms。上游先超时而下游继续执行会浪费资源。

Tomcat 的 `connectionTimeout` 是读取请求行/建立请求的边界，不是业务方法执行超时。业务超时要在 Servlet Async、Spring MVC、数据库和 HTTP 客户端分别配置，并传递截止时间。

对上传接口单独设置路径和大小限制。全站把 `maxPostSize=-1` 会让异常请求占用内存、临时磁盘和线程。

## 5. 平台线程与虚拟线程

Java 21 + 支持版本的 Tomcat 可使用虚拟线程 Executor：

```xml
<Executor
  name="virtualThreadExecutor"
  className="org.apache.catalina.core.StandardVirtualThreadExecutor"
  namePrefix="tomcat-vt-" />
```

虚拟线程适合大量阻塞 I/O，但不会增加数据库连接、CPU 或下游容量。必须用 Semaphore、连接池、限流器等限制外部资源并发。JNI、长时间 synchronized pinning 和 APM Agent 需要通过 JFR `jdk.VirtualThreadPinned` 事件验证。

平台线程模型更成熟且容易用有界队列施加背压。两者应在真实请求和故障场景下比较 p99、RSS、CPU、下游并发和拒绝行为。

## 6. JVM 和内存

Tomcat 本身通常不是主要堆消费者，Web 应用、缓存、Session 和序列化对象才是。容器内存必须预留 Metaspace、线程栈、Direct Buffer、Agent 和 PageCache。

```text
-Xms4g -Xmx4g
-Xss512k
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/log/tomcat/heapdump.hprof
-XX:+ExitOnOutOfMemoryError
-Xlog:gc*,safepoint:file=/var/log/tomcat/gc-%t.log:time,level,tags:filecount=10,filesize=100m
```

不要把 Heap Dump 写到空间很小的根分区。线程数增长时，同时计算 `线程数 × Xss` 和本地线程资源。

## 7. Session 和应用部署

无状态服务优先把 Session 变为短期令牌或外部存储。Tomcat 内存 Session 会增加堆和 Full GC 风险，集群复制 Session 会产生网络与序列化开销。

必须使用 Session 时：

- 设置合理的 `session-timeout`；
- 不保存大对象、连接、线程或不可序列化对象；
- 监控活动 Session 数与平均大小；
- 粘性会话要有节点故障后的重新登录/恢复策略。

生产关闭 JSP 热检查、自动部署和目录扫描中不需要的功能。固定构建制品，一次部署一个版本，滚动更新前确保 readiness 真正代表可接流量。

## 8. 静态资源、压缩和代理头

静态文件优先由 CDN/入口代理提供。小 JSON/文本适合 gzip/brotli；图片、ZIP 等已压缩内容不要重复压缩。CPU 饱和时对比压缩等级与带宽收益。

反向代理场景必须正确处理 `RemoteIpValve`，并只信任内部代理网段，否则客户端可伪造 `X-Forwarded-For`：

```xml
<Valve
  className="org.apache.catalina.valves.RemoteIpValve"
  internalProxies="10\.0\.\d+\.\d+|192\.168\.\d+\.\d+"
  remoteIpHeader="x-forwarded-for"
  protocolHeader="x-forwarded-proto" />
```

## 9. 诊断与指标

通过 JMX/Micrometer 采集：

- 当前/最大线程、busy threads、队列和拒绝；
- 当前连接、请求数、错误数、接收/发送字节；
- 各 URI 的 RPS、p95/p99；
- JVM GC、堆、线程、类和 Direct Buffer；
- 数据库/HTTP 连接池等待。

```bash
# 线程和连接现场
jcmd <pid> Thread.print > /tmp/threads.txt
ss -ant '( sport = :8080 )'
pidstat -wt -p <pid> 1

# JMX 已接入 Prometheus 时检查线程饱和
curl -s localhost:8081/actuator/prometheus | grep -E 'tomcat_threads|http_server_requests'
```

大量线程都等待同一个连接池或锁时，调大 `maxThreads` 是反方向。

## 10. 压测和过载验收

压测应包含快接口、慢查询、上传、下载、keep-alive、连接突增和下游超时。阶梯加压直到首个资源饱和，再验证限流和拒绝是否快速、可观测。

至少比较吞吐、p95/p99、busy/max threads、队列、活动连接、上下文切换、GC、RSS、下游连接池等待和错误类型。p99 恶化 10%、队列持续增长或下游被压垮时回滚。

## 11. 参考资料

- [Tomcat 11 配置索引](https://tomcat.apache.org/tomcat-11.0-doc/config/)
- [Tomcat 11 HTTP Connector](https://tomcat.apache.org/tomcat-11.0-doc/config/http.html)
- [Tomcat 11 Executor](https://tomcat.apache.org/tomcat-11.0-doc/config/executor.html)
- [Tomcat 10.1 HTTP Connector](https://tomcat.apache.org/tomcat-10.1-doc/config/http.html)
- [Tomcat 安全注意事项](https://tomcat.apache.org/tomcat-11.0-doc/security-howto.html)
- [Oracle Java 25 GC 调优](https://docs.oracle.com/en/java/javase/25/gctuning/)
- [阿里云 Tomcat 站点性能问题排查](https://help.aliyun.com/zh/ecs/support/tomcat/)

## 12. Ansible 配置

示例只管理 JVM 和 systemd 边界；`server.xml` 建议在应用仓库中使用完整模板，经预发布验证后发布，避免片段替换破坏 XML。

```yaml tomcat-tuning.yml
---
- name: 配置 Tomcat 运行基线
  hosts: tomcat_servers
  become: true
  vars:
    tomcat_service: tomcat
    tomcat_user: tomcat
    tomcat_heap: 4g
  tasks:
    - name: 创建日志和转储目录
      ansible.builtin.file:
        path: /var/log/tomcat
        state: directory
        owner: "{{ tomcat_user }}"
        group: "{{ tomcat_user }}"
        mode: "0750"

    - name: 写入 Tomcat JVM 参数
      ansible.builtin.copy:
        dest: /etc/default/tomcat-jvm
        mode: "0644"
        backup: true
        content: >-
          CATALINA_OPTS="-Xms{{ tomcat_heap }} -Xmx{{ tomcat_heap }} -Xss512k
          -XX:+UseG1GC -XX:MaxGCPauseMillis=200
          -XX:+HeapDumpOnOutOfMemoryError
          -XX:HeapDumpPath=/var/log/tomcat/heapdump.hprof
          -XX:+ExitOnOutOfMemoryError
          -Xlog:gc*,safepoint:file=/var/log/tomcat/gc-%t.log:time,level,tags:filecount=10,filesize=100m"
      notify: 重启 Tomcat

    - name: 创建 systemd 覆盖目录
      ansible.builtin.file:
        path: "/etc/systemd/system/{{ tomcat_service }}.service.d"
        state: directory
        mode: "0755"

    - name: 配置服务资源边界
      ansible.builtin.copy:
        dest: "/etc/systemd/system/{{ tomcat_service }}.service.d/tuning.conf"
        mode: "0644"
        content: |
          [Service]
          EnvironmentFile=/etc/default/tomcat-jvm
          LimitNOFILE=262144
          TasksMax=8192
      notify:
        - 重载 systemd
        - 重启 Tomcat

  handlers:
    - name: 重载 systemd
      ansible.builtin.systemd_service:
        daemon_reload: true

    - name: 重启 Tomcat
      ansible.builtin.service:
        name: "{{ tomcat_service }}"
        state: restarted
```
