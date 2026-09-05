---
title: JVM 调优
date: 2024-03-07 10:00:00
updated: 2025-12-22 10:00:00
description: 从 SLO、内存预算和 GC 日志出发，选择 Parallel GC、G1 GC 或 ZGC，并用 JFR 和压测验证结果。
categories:
  - 调优
  - JVM
tags:
  - Java
  - GC
  - G1GC
  - ZGC
---

JVM 调优的主线是“先定义延迟与吞吐目标，再从 GC 日志和 JFR 找到分配、晋升或停顿原因”。收集器参数是最后一步，不是第一步。

<!-- more -->

## 1. 版本和目标

生产基线优先选择 LTS JDK。JDK 21 仍被广泛使用，JDK 25 是更新的 LTS；先在真实压测流量下验证依赖、Agent 和容器镜像，再升级运行时。

| 工作负载 | 首要目标 | 推荐起点 |
| --- | --- | --- |
| 批处理、离线计算 | 最大吞吐 | Parallel GC |
| 普通 API 服务、4～32 GB 堆 | 可控停顿与吞吐平衡 | G1 GC |
| 大堆、低停顿交易服务 | 亚毫秒到毫秒级 GC 停顿 | ZGC |

先写清 SLO：吞吐、p95/p99、最大可接受停顿、CPU 上限和容器内存上限。`MaxGCPauseMillis` 是软目标，不是服务 p99 的保证。

## 2. JVM 内存不是只有 Java 堆

容器内存预算至少包括：

```text
容器上限 = Java 堆 + Metaspace + Code Cache + 线程栈
         + Direct Buffer + GC 原生结构 + JNI/Agent + 安全余量
```

假设容器限制为 12 GiB，常见起点是 7～8 GiB 堆，并为 500 个线程、Netty 直接内存、APM Agent 和文件缓存保留 30% 以上空间。堆占满容器会导致 Linux OOM Killer，来不及生成 Heap Dump。

```bash
# 观察堆、类元数据和原生内存
jcmd <pid> GC.heap_info
jcmd <pid> VM.native_memory summary
jcmd <pid> Thread.print
cat /proc/<pid>/status | grep -E 'VmRSS|VmSwap|Threads'
```

原生内存跟踪需要启动时加入 `-XX:NativeMemoryTracking=summary`，它有少量开销，适合诊断和基线环境。

## 3. 先启用诊断基线

```text JVM 通用启动参数
-Xms8g -Xmx8g
-Xss512k
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/log/myapp/heapdump.hprof
-XX:+ExitOnOutOfMemoryError
-XX:ErrorFile=/var/log/myapp/hs_err_pid%p.log
-Xlog:gc*,safepoint:file=/var/log/myapp/gc-%t.log:time,uptime,level,tags:filecount=10,filesize=100m
```

`Xms=Xmx` 能避免运行时扩堆抖动，但会更早占用内存。在共享开发环境可用 `-XX:InitialRAMPercentage` 和 `-XX:MaxRAMPercentage`；生产环境更适合直接做明确预算。不要同时设置固定 `Xmx` 与 `MaxRAMPercentage` 后期待二者叠加。

持续 JFR 的开销通常可控：

```text
-XX:StartFlightRecording=name=baseline,settings=default,disk=true,maxage=2h,maxsize=512m,filename=/var/log/myapp/baseline.jfr
```

问题现场再短期开启 profile 级别：

```bash
jcmd <pid> JFR.start name=hotspot settings=profile duration=5m filename=/tmp/hotspot.jfr
jcmd <pid> JFR.check
```

## 4. 用证据区分 GC 问题

| 现象 | 要找的证据 | 首选行动 |
| --- | --- | --- |
| Young GC 频繁 | 分配速率、TLAB、热点调用栈 | 减少临时对象和批量大小 |
| 老年代增长 | 晋升速率、缓存、类加载 | 修复泄漏或无界缓存 |
| Full GC | GC cause、Humongous、Metaspace | 针对原因处理，不只加堆 |
| p99 抖动但 GC 短 | safepoint、锁、CPU steal、I/O | 查非 GC 停顿 |
| RSS 远高于堆 | Direct Buffer、线程数、Agent | 限制原生内存来源 |

优先检查 JSON 序列化、重复解压、全量集合、日志参数拼接、未限制缓存和大 `byte[]`。减少分配通常比继续微调区域比例更稳定。

## 5. Parallel GC：吞吐优先

Parallel GC 的年轻代和老年代回收都使用 Stop-The-World 并行线程，适合批处理、报表和可以接受较长停顿的服务。

```text
-XX:+UseParallelGC
-XX:MaxGCPauseMillis=500
-XX:GCTimeRatio=19
```

`GCTimeRatio=19` 表示期望 GC 时间约不超过总时间的 1/(1+19)，也是软目标。先让 JVM 自适应，再根据 CPU 配额考虑 `ParallelGCThreads`；容器只有 4 核却手工设 16 个 GC 线程会加重调度竞争。

适合的验收指标：单位时间完成任务数、总 CPU 时间、GC 总时间和最长停顿。只看平均停顿会掩盖 Full GC。

## 6. G1 GC：通用服务起点

G1 是现代 JDK 的默认收集器。先使用少量参数：

```text
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:+ParallelRefProcEnabled
```

只有在日志显示 Mixed GC 启动太晚、老年代持续逼近上限时，再试验：

```text
-XX:InitiatingHeapOccupancyPercent=35
```

常见误区：

- 不要固定 `NewRatio`、`SurvivorRatio` 或年轻代大小，它们会削弱 G1 为停顿目标做的自适应。
- 大于单个 Region 一半的对象会成为 Humongous Object。先减少大数组或流式处理，再考虑 `G1HeapRegionSize`。
- `System.gc()` 来源明确时修复调用方；确实无法改代码时才评估 `-XX:+DisableExplicitGC`，因为它也可能影响直接内存回收行为。
- `MaxGCPauseMillis` 调得越小，年轻代通常越小、GC 越频繁且吞吐下降。

## 7. ZGC：低停顿优先

ZGC 将绝大部分工作并发执行，适合大堆和严格停顿目标，但通常需要更多 CPU 与内存余量。

JDK 21 使用分代 ZGC 时需加入 `-XX:+ZGenerational`；从 JDK 23 起分代模式成为默认，JDK 24 移除了非分代模式。新项目应按当前 JDK 文档确认，不要永久复制旧标志。

```text JDK 21
-XX:+UseZGC
-XX:+ZGenerational
-Xms16g -Xmx16g
-XX:SoftMaxHeapSize=14g
```

```text JDK 24 及以后
-XX:+UseZGC
-Xms16g -Xmx16g
-XX:SoftMaxHeapSize=14g
```

`SoftMaxHeapSize` 是软上限：正常情况下控制堆占用，压力上升时仍可增长到 `Xmx`。ZGC 最关键的是给并发回收留出 CPU；如果 Allocation Stall 出现，先降低分配速率或增加 CPU/堆余量。

## 8. 线程、直接内存和类元数据

### 8.1 线程栈

线程数 × `Xss` 会快速吃掉原生内存。不要仅为避免 `StackOverflowError` 全局增大到 2 MB；先查递归深度。平台线程池必须有界，JDK 21 虚拟线程也不能解除数据库连接、外部 API 并发和内存限制。

### 8.2 Direct Buffer

Netty、NIO 和压缩库常用堆外内存。必要时设置：

```text
-XX:MaxDirectMemorySize=2g
```

限制过低会出现 `OutOfMemoryError: Direct buffer memory`，过高则可能先触发容器 OOM。结合 Netty allocator 指标和 NMT 验证。

### 8.3 Metaspace

动态代理、热部署或大量类加载器可能泄漏 Metaspace。`MaxMetaspaceSize` 是故障保护，不是常规性能开关；设置前用 JFR/Class Histogram 确认正常水位。

## 9. 调优实验与验收

1. 用同一 JDK、同一镜像和同一压测数据记录基线。
2. 预热到 JIT、连接池和缓存稳定，不能把冷启动混入稳态结果。
3. 每轮只调整收集器或一组参数，至少重复三次。
4. 同时比较吞吐、p50/p95/p99、最大暂停、GC CPU、进程 RSS 和错误率。
5. 灰度后观察一个业务高峰，并保留旧启动参数文件。

当 CPU 上升超过预算、RSS 接近容器限制、p99 劣化 10% 或出现新的 Full GC/Allocation Stall 时回滚。

## 10. 参考资料

- [Oracle JDK 25 GC 调优指南](https://docs.oracle.com/en/java/javase/25/gctuning/)
- [Oracle JDK 21 GC 调优指南](https://docs.oracle.com/en/java/javase/21/gctuning/)
- [JEP 439：Generational ZGC](https://openjdk.org/jeps/439)
- [JEP 474：Generational ZGC 默认启用](https://openjdk.org/jeps/474)
- [JEP 490：移除非分代 ZGC](https://openjdk.org/jeps/490)
- [JDK Flight Recorder 官方文档](https://docs.oracle.com/en/java/javase/25/jfapi/)
- [阿里云 ARMS JVM 监控](https://help.aliyun.com/zh/arms/application-monitoring/user-guide/jvm-monitoring)
- [Netflix TechBlog：Java 性能工程实践](https://netflixtechblog.com/tagged/java)

## 11. Ansible 配置

以下片段通过 systemd 环境文件管理 JVM 参数。堆大小必须按目标主机变量配置，不能把示例的 8 GiB 用于所有节点。

```yaml jvm-tuning.yml
---
- name: 配置 Java 服务运行参数
  hosts: java_services
  become: true
  vars:
    java_service_name: myapp
    java_heap_size: 8g
    java_gc: G1GC
  tasks:
    - name: 安装 JDK 21
      ansible.builtin.apt:
        name: openjdk-21-jdk-headless
        state: present
        update_cache: true

    - name: 创建 JVM 日志目录
      ansible.builtin.file:
        path: /var/log/myapp
        state: directory
        owner: myapp
        group: myapp
        mode: "0750"

    - name: 写入 JVM 环境文件
      ansible.builtin.copy:
        dest: /etc/default/myapp-jvm
        mode: "0644"
        content: >-
          JAVA_OPTS="-Xms{{ java_heap_size }} -Xmx{{ java_heap_size }}
          -XX:+Use{{ java_gc }}
          -XX:MaxGCPauseMillis=200
          -XX:+HeapDumpOnOutOfMemoryError
          -XX:HeapDumpPath=/var/log/myapp/heapdump.hprof
          -XX:+ExitOnOutOfMemoryError
          -Xlog:gc*,safepoint:file=/var/log/myapp/gc-%t.log:time,uptime,level,tags:filecount=10,filesize=100m"
      notify: 重启 Java 服务

    - name: 创建 systemd 覆盖目录
      ansible.builtin.file:
        path: "/etc/systemd/system/{{ java_service_name }}.service.d"
        state: directory
        mode: "0755"

    - name: 关联 JVM 环境文件
      ansible.builtin.copy:
        dest: "/etc/systemd/system/{{ java_service_name }}.service.d/jvm.conf"
        mode: "0644"
        content: |
          [Service]
          EnvironmentFile=/etc/default/myapp-jvm
          LimitNOFILE=262144
      notify:
        - 重载 systemd
        - 重启 Java 服务

  handlers:
    - name: 重载 systemd
      ansible.builtin.systemd_service:
        daemon_reload: true

    - name: 重启 Java 服务
      ansible.builtin.service:
        name: "{{ java_service_name }}"
        state: restarted
```
