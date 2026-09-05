---
title: MySQL 调优篇：InnoDB、连接池与慢查询治理
date: 2024-04-10 10:00:00
categories:
  - 调优
  - 数据库
tags:
  - MySQL
  - InnoDB
  - SQL
---

<p class="tuning-lead">MySQL 8.0 调优围绕 InnoDB Buffer Pool、redo/binlog 持久化、连接池和慢 SQL 证据展开，示例面向 32GB 专用节点。</p><h2>InnoDB 基线</h2><pre><code>[mysqld]
innodb_buffer_pool_size=24G
innodb_buffer_pool_instances=8
innodb_log_file_size=2G
innodb_log_files_in_group=2
innodb_flush_method=O_DIRECT
innodb_flush_log_at_trx_commit=1
sync_binlog=1
max_connections=1000
table_open_cache=8192
slow_query_log=ON
long_query_time=0.5</code></pre><p>Buffer Pool 从内存 60%–75% 起步；强持久化保持 flush_log_at_trx_commit=1、sync_binlog=1。连接池通常 CPU×2–4 后压测。</p><h2>SQL 与观测</h2><pre><code>SELECT * FROM sys.statement_analysis ORDER BY total_latency DESC LIMIT 10;
EXPLAIN ANALYZE SELECT ...;
SHOW ENGINE INNODB STATUS\G
SELECT VARIABLE_VALUE FROM performance_schema.global_status
WHERE VARIABLE_NAME IN ('Threads_connected','Innodb_buffer_pool_reads');</code></pre><p>联合索引遵循等值→范围→排序；避免隐式类型转换、SELECT *。验收命中率、P95/P99、锁等待、redo 刷盘和复制延迟。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://dev.mysql.com/doc/refman/8.0/en/optimization.html" target="_blank" rel="noopener">MySQL 优化文档</a></li><li><a href="https://help.aliyun.com/zh/rds/apsaradb-rds-for-mysql/user-guide/optimize-the-performance-of-an-apsaradb-rds-for-mysql-instance" target="_blank" rel="noopener">阿里云 RDS MySQL</a></li><li><a href="https://www.percona.com/blog/" target="_blank" rel="noopener">Percona 性能实践</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: mysql
  become: true
  tasks:
    - name: 安装 MySQL
      ansible.builtin.apt: {name: mysql-server, state: present, update_cache: true}
    - name: 部署调优片段
      ansible.builtin.copy:
        dest: /etc/mysql/mysql.conf.d/99-tuning.cnf
        mode: '0644'
        content: |
          innodb_buffer_pool_size=24G
          innodb_flush_method=O_DIRECT
          innodb_flush_log_at_trx_commit=1
          sync_binlog=1
          slow_query_log=ON
          long_query_time=0.5
      notify: 重启 MySQL
  handlers:
    - name: 重启 MySQL
      ansible.builtin.service: {name: mysql, state: restarted}</code></pre>

