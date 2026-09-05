---
title: JVM 调优篇：通用参数与 ParallelGC、G1GC、ZGC 选择
date: 2024-02-22 10:00:00
categories:
  - 调优
  - JVM
tags:
  - Java
  - GC
  - G1GC
  - ZGC
---

<p class="tuning-lead">以 JDK 21 LTS 为例，先设堆边界、GC 日志和 OOM 行为，再按停顿目标选收集器；容器预算需包含堆外与线程栈。</p><h2>通用参数</h2><pre><code>-Xms8g -Xmx8g -Xss1m
-XX:MaxMetaspaceSize=512m
-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/var/log/jvm
-XX:+ExitOnOutOfMemoryError
-Xlog:gc*,safepoint:file=/var/log/jvm/gc-%t.log:time,level,tags:filecount=10,filesize=100m</code></pre><p>通常令 Xms=Xmx 避免扩容抖动；MaxRAMPercentage 场景给 native 预留 25%–35%。</p><h2>收集器对照</h2><table><tr><th>收集器</th><th>场景</th><th>参数起点</th></tr><tr><td>ParallelGC</td><td>吞吐/批处理</td><td><code>-XX:+UseParallelGC -XX:MaxGCPauseMillis=200 -XX:ParallelGCThreads=8</code></td></tr><tr><td>G1GC</td><td>通用服务</td><td><code>-XX:+UseG1GC -XX:MaxGCPauseMillis=100 -XX:InitiatingHeapOccupancyPercent=30</code></td></tr><tr><td>ZGC</td><td>大堆低停顿</td><td><code>-XX:+UseZGC -XX:+ZGenerational -XX:SoftMaxHeapSize=12g</code></td></tr></table><div class="mermaid">flowchart TD
A[SLO/压测]-->B[GC日志/JFR/p99]
B-->C{停顿 or 吞吐}
C--停顿-->D[G1/ZGC与减少分配]
C--吞吐-->E[ParallelGC或增大堆]
D-->F[灰度回滚]
E-->F</div><p class="tuning-warn">JDK 21 自适应策略通常优于手工固定年轻代比例，只有日志证明必要时再覆盖。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://docs.oracle.com/en/java/javase/21/gctuning/" target="_blank" rel="noopener">Oracle JDK 21 GC</a></li><li><a href="https://wiki.openjdk.org/display/zgc" target="_blank" rel="noopener">OpenJDK ZGC</a></li><li><a href="https://help.aliyun.com/zh/arms/application-monitoring/user-guide/jvm-monitoring" target="_blank" rel="noopener">阿里云 JVM 调优</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: java
  become: true
  tasks:
    - name: 安装 JDK 21
      ansible.builtin.apt: {name: openjdk-21-jdk, state: present, update_cache: true}
    - name: 写入 JVM 选项
      ansible.builtin.copy:
        dest: /etc/profile.d/jvm.sh
        mode: '0644'
        content: "export JAVA_TOOL_OPTIONS='-Xms8g -Xmx8g -XX:+UseG1GC -XX:MaxGCPauseMillis=100'\n"</code></pre>

