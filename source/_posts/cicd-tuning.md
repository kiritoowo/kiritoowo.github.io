---
title: CI/CD 调优篇：Git、Maven、Jenkins、GitLab CI/CD、Docker、K8s 与 Ansible
date: 2025-06-12 10:00:00
categories:
  - 调优
  - DevOps
tags:
  - Git
  - Maven
  - Jenkins
  - Docker
  - Kubernetes
---

<h2>流水线缓存与并行化边界</h2>
<p>缓存只保存可重建的依赖和中间产物，不缓存密钥、部署凭据和未验证的构建结果。Maven、npm、Docker layer cache 要按锁文件和基础镜像摘要分 key；缓存命中后仍执行校验。测试按单元、集成、端到端分层并行，集成测试依赖临时数据库或 Testcontainers。</p>
<pre><code># 发布前的最小门禁示例
mvn -B -T 1C verify
trivy image --exit-code 1 --severity HIGH,CRITICAL "$IMAGE"
cosign verify "$IMAGE"
kubectl apply --server-side --dry-run=server -f k8s/</code></pre>
<h2>发布策略与供应链</h2>
<p>Deployment 使用 RollingUpdate 时设置 <code>maxUnavailable=0</code> 和适度 <code>maxSurge</code>，readinessProbe 必须验证真实依赖可用。灰度期间比较错误率、p95、资源使用和业务转化率，自动回滚不能只看 Pod 是否 Running。Ansible Vault、GitLab protected variables 和 OIDC 短期凭据优于长期明文 token。</p>
<div class="tuning-warn">不要在 CI 日志打印环境变量、云凭据或完整构建命令中的 token；依赖升级必须经过锁文件变更审查和漏洞报告。</div>
<p class="tuning-lead">CI/CD 调优目标是更短反馈时间和可重复发布。缓存依赖与镜像层、并行化测试、限制构建资源，并将 SBOM、签名和漏洞门禁纳入流水线。</p>

<!-- more --><h2>构建与缓存</h2><pre><code># Git 全局配置

git config --global fetch.parallel 8
git config --global core.compression 1
# Maven 并行构建
mvn -T 1C -Dmaven.repo.local=.m2/repository verify
# Docker BuildKit 缓存
RUN --mount=type=cache,target=/root/.m2 mvn -T 1C package</code></pre><p>Jenkins Pipeline 使用并行 stage，executor 不超过节点 CPU；GitLab Runner 使用 Docker executor 与缓存。Kubernetes 构建 Pod 设置 requests/limits，镜像用 Trivy/Grype 扫描并 Cosign 签名。</p><h2>发布流程</h2><div class="mermaid">flowchart LR
A[提交/合并请求]-->B[单测+静态扫描]
B-->C[缓存构建]
C-->D[SBOM/漏洞门禁]
D-->E[K8s 灰度]
E-->F[指标验收]
F--通过-->G[全量发布]
F--失败-->H[自动回滚]</div><p>Ansible 使用幂等模块、ansible-lint 和 Vault；K8s Deployment 配置 readinessProbe、PDB 与滚动更新上限，发布前执行 server-side dry-run。</p><h2>参考资料</h2><ul class="tuning-refs"><li><a href="https://git-scm.com/book/en/v2/Git-on-the-Server-Optimizing-Git" target="_blank" rel="noopener">Git 优化</a></li><li><a href="https://maven.apache.org/guides/mini/guide-configuring-maven.html" target="_blank" rel="noopener">Maven 配置</a></li><li><a href="https://www.jenkins.io/doc/book/pipeline/" target="_blank" rel="noopener">Jenkins Pipeline</a></li><li><a href="https://docs.gitlab.com/ee/ci/caching/" target="_blank" rel="noopener">GitLab CI/CD 缓存</a></li><li><a href="https://docs.docker.com/build/cache/" target="_blank" rel="noopener">Docker 构建缓存</a></li><li><a href="https://kubernetes.io/docs/concepts/configuration/overview/" target="_blank" rel="noopener">Kubernetes 配置</a></li><li><a href="https://help.aliyun.com/zh/ack/ack-managed-and-ack-dedicated/user-guide/optimize-cluster-performance" target="_blank" rel="noopener">阿里云 ACK 优化</a></li></ul><h2>Ansible 配置</h2><pre><code>- hosts: ci_runner
  become: true
  tasks:
    - name: 安装构建依赖
      ansible.builtin.apt:
        name: [git, maven, docker.io, ansible-lint]
        update_cache: true
        state: present
    - name: runner 加入 docker 组
      ansible.builtin.user: {name: gitlab-runner, groups: docker, append: true}
    - name: 配置 Docker 日志轮转
      ansible.builtin.copy:
        dest: /etc/docker/daemon.json
        mode: '0644'
        content: '{"log-driver":"json-file","log-opts":{"max-size":"100m","max-file":"3"}}'
      notify: 重启 Docker
  handlers:
    - name: 重启 Docker
      ansible.builtin.service: {name: docker, state: restarted}</code></pre>
