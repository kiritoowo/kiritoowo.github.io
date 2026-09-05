---
title: 服务器参数调优篇：Ubuntu LTS 初始化、安全与内核基线
date: 2024-01-18 10:00:00
categories:
  - 调优
  - 服务器
tags:
  - Ubuntu
  - Linux
  - 安全
  - 内核
---

<p class="tuning-lead">Ubuntu 24.04 LTS（兼容 22.04 LTS）生产基线，覆盖初始化、漏洞扫描、UFW/Fail2ban、防火墙、文件句柄、交换分区与 TCP 栈。</p><h2>初始化与安全</h2><div class="mermaid">flowchart LR
A[更新补丁/时区]-->B[SSH最小权限]
B-->C[Lynis/USG/Trivy扫描]
C-->D[UFW+Fail2ban]
D-->E[sysctl与limits]
E-->F[压测灰度]</div><pre><code>sudo apt update &amp;&amp; sudo apt full-upgrade -y
sudo timedatectl set-timezone Asia/Shanghai
sudo apt install -y unattended-upgrades auditd chrony sysstat lynis fail2ban ufw
# SSH 配置文件
PermitRootLogin no
PasswordAuthentication no
MaxAuthTries 3</code></pre><p>Ubuntu Pro/USG 执行 CIS Level 1 审计，Trivy 扫描镜像，Lynis 审计主机；云安全组与 UFW 双层白名单。</p><h2>内核参数基线</h2><table><tr><th>类别</th><th>起始值</th><th>关注指标</th></tr><tr><td>句柄</td><td><code>fs.file-max=2097152</code>，nofile=1048576</td><td>EMFILE</td></tr><tr><td>交换</td><td>≥16G 内存配置 4–8G swap，<code>vm.swappiness=1</code></td><td>major fault/IO wait</td></tr><tr><td>脏页</td><td><code>vm.dirty_ratio=10</code>、background=3</td><td>写入尖峰</td></tr><tr><td>队列</td><td><code>somaxconn=65535</code>、<code>tcp_max_syn_backlog=262144</code></td><td>SYN 丢弃</td></tr><tr><td>端口</td><td><code>ip_local_port_range=10240 65535</code>、<code>tcp_fin_timeout=15</code></td><td>TIME_WAIT</td></tr><tr><td>拥塞</td><td><code>tcp_congestion_control=bbr</code></td><td>吞吐/重传</td></tr></table><pre><code>cat &gt; /etc/sysctl.d/99-tuning.conf &lt;&lt;'EOF'
fs.file-max=2097152
vm.swappiness=1
vm.dirty_ratio=10
vm.dirty_background_ratio=3
net.core.somaxconn=65535
net.ipv4.tcp_max_syn_backlog=262144
net.ipv4.ip_local_port_range=10240 65535
net.ipv4.tcp_fin_timeout=15
net.ipv4.tcp_congestion_control=bbr
EOF
sudo sysctl --system</code></pre><p>使用 <code>pidstat</code>、<code>ss -s</code>、<code>sar -n TCP,DEV</code> 建立基线；每次只改一组并保留回滚文件。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://ubuntu.com/server/docs" target="_blank" rel="noopener">Ubuntu Server</a></li><li><a href="https://ubuntu.com/security/cis" target="_blank" rel="noopener">Ubuntu CIS/USG</a></li><li><a href="https://help.aliyun.com/zh/ecs/user-guide/optimize-linux-instances" target="_blank" rel="noopener">阿里云 Linux 优化</a></li><li><a href="https://www.fail2ban.org/wiki/index.php/Main_Page" target="_blank" rel="noopener">Fail2ban</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: linux
  become: true
  tasks:
    - name: 安装安全工具
      ansible.builtin.apt:
        name: [ufw, fail2ban, lynis, auditd, sysstat]
        update_cache: true
        state: present
    - name: 写入 sysctl
      ansible.builtin.copy:
        dest: /etc/sysctl.d/99-tuning.conf
        content: |
          fs.file-max=2097152
          vm.swappiness=1
          net.core.somaxconn=65535
          net.ipv4.tcp_max_syn_backlog=262144
    - name: 应用参数
      ansible.builtin.command: sysctl --system
    - name: 放行 SSH/HTTP/HTTPS
      community.general.ufw:
        rule: allow
        port: "{{ item }}"
        proto: tcp
      loop: [22, 80, 443]</code></pre>

