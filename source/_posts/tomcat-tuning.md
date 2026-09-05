---
title: Tomcat 调优篇：线程池、连接器与会话管理
date: 2024-11-07 10:00:00
categories:
  - 调优
  - Web容器
tags:
  - Tomcat
  - 线程池
  - NIO
---

<p class="tuning-lead">Tomcat 10.1 调优遵循“线程数匹配下游容量”。先用 NIO/NIO2 与共享线程池，再依据 p99、队列和 GC 调整 maxThreads。</p><h2>连接器基线</h2><pre><code>&lt;Executor name="tomcatThreadPool" namePrefix="catalina-exec-" maxThreads="400" minSpareThreads="50"/&gt;
&lt;Connector executor="tomcatThreadPool" protocol="org.apache.coyote.http11.Http11NioProtocol"
 connectionTimeout="5000" keepAliveTimeout="5000" maxKeepAliveRequests="100"
 acceptCount="200" maxConnections="10000" URIEncoding="UTF-8"/&gt;</code></pre><p>maxThreads 从 CPU×(1+等待/计算比)起步，但必须小于数据库与下游连接池容量；acceptCount 只是队列，不能掩盖慢请求。</p><h2>保护与会话</h2><p>启用 AccessLog 采样、JMX 和 Micrometer；上传限制、请求超时和拒绝策略显式配置。集群将 session 外置到 Redis/数据库，避免本地粘滞。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://tomcat.apache.org/tomcat-10.1-doc/config/http.html" target="_blank" rel="noopener">Tomcat HTTP 配置</a></li><li><a href="https://wiki.apache.org/tomcat/FAQ/PerformanceAndMonitoring" target="_blank" rel="noopener">Tomcat 性能 FAQ</a></li><li><a href="https://help.aliyun.com/zh/ecs/user-guide/optimize-tomcat" target="_blank" rel="noopener">阿里云 Tomcat 优化</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: tomcat
  become: true
  vars: {tomcat_home: /opt/tomcat}
  tasks:
    - name: 写入线程池连接器
      ansible.builtin.blockinfile:
        path: "{{ tomcat_home }}/conf/server.xml"
        marker: "<!-- {mark} ANSIBLE 调优 -->"
        insertafter: '<Service name="Catalina">'
        block: |
          &lt;Executor name="tomcatThreadPool" namePrefix="catalina-exec-" maxThreads="400" minSpareThreads="50"/&gt;
      notify: 重启 Tomcat
  handlers:
    - name: 重启 Tomcat
      ansible.builtin.service: {name: tomcat, state: restarted}</code></pre>

