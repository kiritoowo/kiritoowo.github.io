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

<h2>容量规划与变更顺序</h2>
<p>调优不是把所有上限调大。先依据连接数、文件描述符、网卡带宽、磁盘 IOPS 和内存水位建立容量表，再定位最先饱和的资源。应用最大连接数、反向代理连接数、数据库连接池和 <code>nofile</code> 必须来自同一份预算；否则应用看似仍有线程，实际已被内核队列或端口耗尽限制。</p>
<table><tr><th>阶段</th><th>动作</th><th>通过条件</th></tr><tr><td>基线</td><td>连续采集 24 小时 CPU、内存、网络、磁盘、连接数</td><td>明确高峰 QPS 与 p99</td></tr><tr><td>压测</td><td>逐级提高并发，单次只改一个参数组</td><td>无连接拒绝、无明显重传</td></tr><tr><td>灰度</td><td>先 5% 流量、观察一个高峰周期</td><td>错误率和 p99 不劣化</td></tr><tr><td>回滚</td><td>保留旧 sysctl 文件与服务限制</td><td>可在分钟级恢复</td></tr></table>
<h2>安全基线细节</h2>
<p>SSH 只允许密钥登录并限制来源网段；管理面端口不要和公网业务端口混用。Fail2ban 的封禁仅用于减缓暴力破解，不能替代安全组和身份认证。对外服务应启用自动安全更新，并在维护窗口验证内核升级后的驱动、容器运行时和 eBPF 监控兼容性。</p>
<pre><code># 查看有效限制与连接状态
systemctl show your-service -p LimitNOFILE
ulimit -n
ss -s
cat /proc/sys/fs/file-nr
# 查看半连接与重传
netstat -s | grep -E 'listen|retransmit|SYN'</code></pre>
<div class="tuning-warn">不要启用已废弃或风险不明确的网络参数，例如 <code>tcp_tw_recycle</code>。NAT、移动网络和多出口环境下，它会造成正常连接被错误丢弃。</div>
<p class="tuning-lead">Ubuntu 24.04 LTS（兼容 22.04 LTS）生产基线，覆盖初始化、漏洞扫描、UFW/Fail2ban、防火墙、文件句柄、交换分区与 TCP 栈。</p>

<!-- more --><h2>初始化与安全</h2><div class="mermaid">flowchart LR

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
