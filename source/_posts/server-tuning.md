---
title: 服务器调优
date: 2024-01-18 10:00:00
updated: 2025-12-18 10:00:00
description: Ubuntu 24.04 LTS 从安全初始化、容量基线到文件句柄、内存、交换分区、磁盘与 TCP 的生产调优方法。
categories:
  - 调优
  - 服务器
tags:
  - Ubuntu
  - Linux
  - 安全
  - 内核
---

本文以 Ubuntu 24.04 LTS 为基线，目标不是复制一份“万能 sysctl”，而是建立从安全初始化、容量测量、单项变更到压测回滚的完整闭环。

<!-- more -->

## 1. 先定义目标和边界

服务器参数只改变资源队列、缓存和失败方式，不能创造 CPU、内存、IOPS 或带宽。调优前先写清四件事：

| 维度 | 示例目标 | 必须同时记录 |
| --- | --- | --- |
| 流量 | 峰值 20,000 请求/秒 | 平均连接时长、上下行字节数 |
| 延迟 | p99 小于 200 ms | p50、p95、错误率 |
| 可用性 | 单节点重启不丢服务 | 恢复时间、重连峰值 |
| 资源水位 | CPU 小于 70%，内存小于 80% | 运行队列、重传、磁盘时延 |

推荐的变更顺序是：**补丁和访问控制 -> 观测基线 -> 服务级限制 -> 内核参数 -> 压测 -> 小流量灰度**。每次只改一组参数，否则指标改善后无法确定原因。

## 2. 初始化 Ubuntu 24.04 LTS

### 2.1 更新、时间同步和管理账号

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y chrony unattended-upgrades auditd sysstat ufw fail2ban lynis
sudo timedatectl set-timezone Asia/Shanghai
sudo systemctl enable --now chrony auditd sysstat

# 核对时间源和安全更新状态
chronyc tracking
pro security-status 2>/dev/null || ubuntu-security-status
```

生产机使用独立管理账号和 `sudo`，禁止共享私钥。云主机还要在安全组中限制 SSH 来源，主机防火墙不能替代云安全组。

### 2.2 SSH 加固

先保持一个现有会话，再开第二个会话验证新配置，确认成功后才退出旧会话。

```text /etc/ssh/sshd_config.d/10-hardening.conf
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 30
AllowGroups ssh-users
X11Forwarding no
```

```bash
# 语法验证失败时不要重载服务
sudo sshd -t
sudo systemctl reload ssh
```

> **边界：** 如果业务依赖密码登录、堡垒机动态账号或云厂商注入机制，应先确认认证链路。不要在未验证密钥时关闭密码登录。

### 2.3 自动安全更新

`unattended-upgrades` 适合安装安全修复，但内核、驱动和容器运行时更新仍应经过维护窗口验证。启用后检查 `/var/log/unattended-upgrades/`，并为“需要重启”建立告警。

```bash
sudo dpkg-reconfigure -plow unattended-upgrades
test -f /var/run/reboot-required && cat /var/run/reboot-required.pkgs
```

## 3. 漏洞、安全扫描与封堵

安全扫描分四层，不要只跑一个工具：

| 层次 | 工具 | 发现的问题 | 推荐频率 |
| --- | --- | --- | --- |
| 软件包 | Ubuntu Security、Ubuntu Pro | CVE、ESM 覆盖 | 每日 |
| 主机基线 | USG CIS、Lynis | SSH、权限、内核基线 | 每周及变更后 |
| 容器/制品 | Trivy、Grype | 镜像包和密钥泄漏 | 每次构建 |
| 运行时 | auditd、云安全中心 | 异常进程、账号和文件变更 | 持续 |

```bash
sudo lynis audit system --quick

# 已启用 Ubuntu Pro 的机器可执行 CIS 审计
sudo pro enable usg
sudo usg audit cis_level1_server

# 镜像扫描应放在 CI 中，HIGH/CRITICAL 阻断发布
trivy image --severity HIGH,CRITICAL --ignore-unfixed registry.example.com/order-service:2025.12.1
```

扫描结果要进入工单，至少包含资产、CVE、可利用条件、负责人、修复版本和豁免到期日。开放端口定期用以下命令复核：

```bash
sudo ss -lntup
sudo nft list ruleset
sudo ufw status numbered
sudo ausearch -m USER_LOGIN -ts today
```

## 4. 防火墙与 Fail2ban

UFW 是 nftables 的管理层。默认拒绝入站，只开放明确端口；数据库、Redis、管理面板等端口不应直接暴露公网。

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 10.10.0.0/16 to any port 22 proto tcp comment '堡垒机 SSH'
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Fail2ban 用于降低暴力破解噪声，不能替代密钥认证、MFA 和来源白名单。

```ini /etc/fail2ban/jail.d/sshd.local
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
bantime.increment = true
bantime.factor = 2
```

```bash
sudo fail2ban-client -t
sudo systemctl restart fail2ban
sudo fail2ban-client status sshd
```

## 5. 建立性能基线

连续覆盖至少一个业务高峰，不能只截取一分钟的 `top`。

```bash
# CPU、运行队列、上下文切换
mpstat -P ALL 1
pidstat -durwt 1
vmstat 1

# 内存、缺页和交换
free -h
sar -B -W 1 10

# 磁盘队列和尾延迟
iostat -xz 1

# 网络、连接和重传
ss -s
sar -n DEV,TCP,ETCP 1
nstat -az | grep -E 'Retrans|Listen|Syncookies'
```

判断瓶颈时看证据链：CPU 高要区分用户态、系统态、软中断和 steal；内存不足要同时看 major fault 与 swap I/O；磁盘看 `await`、队列深度和设备饱和度；网络看丢包、重传、SYN 队列溢出和带宽。

## 6. 文件句柄和 systemd 限制

`fs.file-max` 是全机上限，进程真正能拿到多少还受 PAM、systemd 和应用配置约束。容量估算应包含监听 socket、入站连接、上游连接、日志、JAR/动态库和监控探针。

```bash
cat /proc/sys/fs/file-max
cat /proc/sys/fs/file-nr
systemctl show myapp -p LimitNOFILE
cat /proc/$(pidof myapp)/limits
ls /proc/$(pidof myapp)/fd | wc -l
```

优先给服务设置局部上限：

```ini /etc/systemd/system/myapp.service.d/limits.conf
[Service]
LimitNOFILE=262144
TasksMax=16384
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart myapp
```

不要直接把所有服务的 `nofile` 调到百万级。过高上限会掩盖连接泄漏，并放大单进程耗尽系统资源的影响。

## 7. 内存、交换分区和脏页

生产服务器通常保留少量 swap 作为缓冲，而不是完全关闭。数据库是否允许 swap 应结合其内存锁定、容器限制和故障策略判断。

| 参数 | 16 GB 以上通用节点起点 | 判断依据 |
| --- | ---: | --- |
| `vm.swappiness` | `10` | `sar -W` 是否持续换入换出 |
| `vm.dirty_background_ratio` | `5` | 后台回写是否及时 |
| `vm.dirty_ratio` | `15` | 突发回写是否造成应用停顿 |
| `vm.max_map_count` | 按应用要求 | Elasticsearch 等 mmap 数量 |

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

> `dirty_*_ratio` 按总内存计算，大内存机器可能积累过多脏页。写入密集节点可改用 `dirty_background_bytes` 和 `dirty_bytes`，但同一组不要同时配置 ratio 与 bytes。

## 8. TCP 和监听队列

下面是 16 核、32 GB、万级并发 Web 节点的保守起点，不是所有机器的默认答案：

```sysctl /etc/sysctl.d/99-web-tuning.conf
fs.file-max = 1048576
vm.swappiness = 10
vm.dirty_background_ratio = 5
vm.dirty_ratio = 15

net.core.somaxconn = 4096
net.core.netdev_max_backlog = 8192
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.ip_local_port_range = 10000 65535
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_mtu_probing = 1
```

```bash
sudo sysctl --system
sysctl net.core.somaxconn net.ipv4.tcp_max_syn_backlog
```

三层队列必须一起校验：内核 `somaxconn`、Web 容器 backlog、应用 accept 队列。只扩大内核值而应用仍为 128 不会生效。短连接压测还要检查客户端临时端口，而非只调服务端。

不要使用已删除的 `tcp_tw_recycle`，也不要为减少 `TIME_WAIT` 盲目缩短连接生命周期。优先启用连接池和 HTTP keep-alive。

### 8.1 BBR 的使用边界

Ubuntu 24.04 内核通常包含 BBR。它主要改善有带宽时延积、丢包或长距离链路的吞吐，本机房低延迟 RPC 未必受益。

```bash
sysctl net.ipv4.tcp_available_congestion_control
sudo modprobe tcp_bbr
sudo sysctl -w net.ipv4.tcp_congestion_control=bbr
sysctl net.ipv4.tcp_congestion_control
```

开启前后比较吞吐、p99、重传、丢包和 CPU，结果不改善就回滚到原拥塞算法。

## 9. 压测、灰度与回滚

1. 保存 `sysctl -a`、systemd 限制、防火墙规则和 24 小时指标。
2. 固定压测数据、请求比例和下游容量，阶梯增加并发。
3. 单次只修改内存、队列或 TCP 中的一组。
4. 先灰度一台或 5% 流量，观察至少一个高峰周期。
5. 出现错误率上升、p99 劣化 10%、重传增加或 swap 持续写入时立即回滚。

```bash
# 回滚示例：删除独立调优文件即可恢复发行版默认值
sudo rm /etc/sysctl.d/99-web-tuning.conf
sudo sysctl --system
```

## 10. 参考资料

- [Ubuntu Server 官方文档](https://documentation.ubuntu.com/server/)
- [Ubuntu 安全与 USG CIS 加固](https://documentation.ubuntu.com/security/compliance/usg/)
- [Ubuntu 自动安全更新](https://documentation.ubuntu.com/server/how-to/software/automatic-updates/)
- [Linux 内核网络 sysctl](https://docs.kernel.org/networking/ip-sysctl.html)
- [systemd.exec 资源限制](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [Fail2ban 官方文档](https://github.com/fail2ban/fail2ban/wiki)
- [阿里云 ECS Linux 实例问题排查](https://help.aliyun.com/zh/ecs/support/linux-instance/)
- [阿里云安全中心主机基线](https://help.aliyun.com/zh/security-center/user-guide/baseline-check)

## 11. Ansible 配置

执行前安装防火墙集合：`ansible-galaxy collection install community.general`。将管理网段和服务名放在 inventory 变量中，不要把示例地址直接带入生产。

```yaml server-tuning.yml
---
- name: 配置 Ubuntu 生产基线
  hosts: ubuntu_servers
  become: true
  vars:
    ssh_admin_cidr: "10.10.0.0/16"
    managed_service: "myapp"
  tasks:
    - name: 安装安全和观测工具
      ansible.builtin.apt:
        name:
          - auditd
          - chrony
          - fail2ban
          - lynis
          - sysstat
          - ufw
          - unattended-upgrades
        state: present
        update_cache: true

    - name: 写入 SSH 加固配置
      ansible.builtin.copy:
        dest: /etc/ssh/sshd_config.d/10-hardening.conf
        mode: "0644"
        content: |
          PermitRootLogin no
          PasswordAuthentication no
          KbdInteractiveAuthentication no
          PubkeyAuthentication yes
          MaxAuthTries 3
          LoginGraceTime 30
          X11Forwarding no
        validate: /usr/sbin/sshd -t -f %s
      notify: 重载 SSH

    - name: 写入内核参数
      ansible.builtin.copy:
        dest: /etc/sysctl.d/99-web-tuning.conf
        mode: "0644"
        content: |
          fs.file-max = 1048576
          vm.swappiness = 10
          vm.dirty_background_ratio = 5
          vm.dirty_ratio = 15
          net.core.somaxconn = 4096
          net.core.netdev_max_backlog = 8192
          net.ipv4.tcp_max_syn_backlog = 8192
          net.ipv4.ip_local_port_range = 10000 65535
          net.ipv4.tcp_syncookies = 1
          net.ipv4.tcp_keepalive_time = 600
          net.ipv4.tcp_keepalive_intvl = 30
          net.ipv4.tcp_keepalive_probes = 5
          net.ipv4.tcp_mtu_probing = 1
      notify: 应用内核参数

    - name: 创建服务限制目录
      ansible.builtin.file:
        path: "/etc/systemd/system/{{ managed_service }}.service.d"
        state: directory
        mode: "0755"

    - name: 配置服务文件句柄上限
      ansible.builtin.copy:
        dest: "/etc/systemd/system/{{ managed_service }}.service.d/limits.conf"
        mode: "0644"
        content: |
          [Service]
          LimitNOFILE=262144
          TasksMax=16384
      notify: 重载 systemd

    - name: 默认拒绝入站流量
      community.general.ufw:
        direction: incoming
        policy: deny

    - name: 允许管理网段访问 SSH
      community.general.ufw:
        rule: allow
        src: "{{ ssh_admin_cidr }}"
        port: "22"
        proto: tcp

    - name: 允许 Web 端口
      community.general.ufw:
        rule: allow
        port: "{{ item }}"
        proto: tcp
      loop:
        - "80"
        - "443"

    - name: 启用防火墙
      community.general.ufw:
        state: enabled

  handlers:
    - name: 重载 SSH
      ansible.builtin.service:
        name: ssh
        state: reloaded

    - name: 应用内核参数
      ansible.builtin.command: /usr/sbin/sysctl --system
      changed_when: true

    - name: 重载 systemd
      ansible.builtin.systemd_service:
        daemon_reload: true
```
