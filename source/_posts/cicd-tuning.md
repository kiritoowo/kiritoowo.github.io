---
title: CI/CD 调优
date: 2025-10-30 10:00:00
updated: 2025-12-31 18:00:00
description: Git、Maven、Jenkins、GitLab CI/CD、Docker、Kubernetes 与 Ansible 的构建缓存、并行、供应链和发布调优。
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

CI/CD 调优的目标是缩短“提交到可信反馈”和“批准到稳定上线”的时间，同时保持构建可重复、制品不可变、门禁可审计、发布可回滚。

<!-- more -->

## 1. 先测流水线关键路径

不要只看总时长。为每个 stage 记录排队、下载、执行、上传和重试时间：

```text
交付周期 = Runner 排队 + 拉取源码 + 依赖解析 + 编译
         + 测试 + 扫描 + 制品上传 + 部署 + 灰度观察
```

| 指标 | 说明 |
| --- | --- |
| p50/p95 Pipeline duration | 稳态和长尾 |
| Queue duration | Runner 是否不足 |
| Cache hit ratio | 缓存是否真实有效 |
| Flaky test rate | 无效重跑和信任损失 |
| Deployment frequency | 交付吞吐 |
| Change failure rate / MTTR | 发布质量与恢复 |

先优化关键路径最长且频繁执行的任务。一个偶尔运行的 20 分钟任务，不一定比每次都运行的 5 分钟任务更值得先动。

## 2. Git 仓库和拉取

大仓库优先减少传输和工作区文件：

```bash
# CI 只需要当前提交时使用浅克隆
git clone --depth=20 --no-tags "$CI_REPOSITORY_URL" repository

# 超大仓库可按需获取 Blob
git clone --filter=blob:none --no-checkout "$CI_REPOSITORY_URL" repository
git -C repository sparse-checkout set service-a shared-libs
git -C repository checkout "$CI_COMMIT_SHA"
```

浅克隆不适合需要完整历史的版本计算、changelog 和 Sonar blame，应按 job 使用不同深度。定期清理误提交的大二进制，使用 Git LFS 或制品库；删除历史需要团队协调，不能直接重写共享分支。

保护主分支、要求评审和签名提交/Tag。CI 使用短期、最小权限凭据，禁止把访问令牌写进 remote URL 后打印日志。

## 3. Maven：先稳定依赖再并行

```bash
mvn --batch-mode --no-transfer-progress \
  -T 1C \
  -Dmaven.repo.local=.m2/repository \
  -Dstyle.color=never \
  verify
```

`-T 1C` 表示每核一个构建线程，但只有线程安全插件和模块依赖图允许时才有效。Runner 内存不足时并行反而触发 GC/OOM。

缓存 Key 至少包含操作系统、JDK 主版本和依赖描述摘要：

```text
maven-${OS}-${JDK_VERSION}-${hash(pom.xml, **/pom.xml)}
```

不要缓存整个 workspace，也不要把 `settings.xml`、私钥或部署凭据放进缓存。内部依赖使用 Nexus/Artifactory 镜像，发布版本不可覆盖；Snapshot 设置合理更新策略。

提升可重复性：固定插件版本、使用 Maven Wrapper、启用依赖校验、构建中写入统一时区和 `project.build.outputTimestamp`。同一 Git SHA 应只构建一次，测试通过后提升同一制品，而非每个环境重新编译。

## 4. 测试分层与并行边界

推荐顺序：格式/静态检查 -> 单元测试 -> 构建 -> 集成测试 -> 安全扫描 -> 制品发布 -> 部署验证。

- 单元测试按模块并行；
- 集成测试使用 Testcontainers 或独立临时环境；
- 端到端测试只覆盖关键用户路径；
- Flaky 测试不能靠无限 retry，应隔离、记录负责人和修复期限；
- 测试报告即使失败也要上传。

基于变更路径跳过无关模块前，要维护模块依赖图。错误的“智能跳过”比慢一些更危险。

## 5. Jenkins

Controller 只负责调度，不在其上运行构建。Agent 使用短生命周期容器/Pod，避免工作区污染。

```groovy
pipeline {
  agent none
  options {
    timestamps()
    timeout(time: 30, unit: 'MINUTES')
    disableConcurrentBuilds(abortPrevious: true)
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }
  stages {
    stage('验证') {
      parallel {
        stage('单元测试') {
          agent { label 'jdk21' }
          steps { sh './mvnw -B -ntp test' }
        }
        stage('静态检查') {
          agent { label 'jdk21' }
          steps { sh './mvnw -B -ntp verify -DskipTests' }
        }
      }
    }
  }
}
```

Executor 数不应机械等于 CPU 核数：构建任务可能内存、磁盘或 Docker I/O 密集。用 queue time、CPU、内存和磁盘确定 Agent 池容量。凭据只在最小 stage 绑定，并对日志脱敏。

## 6. GitLab CI/CD

```yaml .gitlab-ci.yml
stages: [verify, package, security, deploy]

default:
  interruptible: true
  retry:
    max: 1
    when: [runner_system_failure, stuck_or_timeout_failure]

variables:
  MAVEN_OPTS: "-Dmaven.repo.local=$CI_PROJECT_DIR/.m2/repository"

cache:
  key:
    files:
      - pom.xml
      - .mvn/wrapper/maven-wrapper.properties
  paths:
    - .m2/repository/
  policy: pull-push

verify:
  stage: verify
  image: eclipse-temurin:21-jdk
  script:
    - ./mvnw -B -ntp -T 1C verify
  artifacts:
    when: always
    reports:
      junit: "**/target/surefire-reports/TEST-*.xml"

package-image:
  stage: package
  needs: [verify]
  script:
    - docker buildx build --cache-from type=registry,ref=$CACHE_IMAGE
      --cache-to type=registry,ref=$CACHE_IMAGE,mode=max
      --tag "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" --push .

deploy-production:
  stage: deploy
  needs: [package-image]
  resource_group: production
  environment: production
  when: manual
  script:
    - ./deploy.sh "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"
```

`needs` 构建 DAG，避免等待同 stage 无关任务。Cache 用于可重建依赖，Artifacts 用于同流水线传递结果，Registry/制品库保存发布产物。生产环境使用 protected environment 和审批。

## 7. Docker 与 BuildKit

### 7.1 优化层缓存

```dockerfile
# syntax=docker/dockerfile:1.7
FROM eclipse-temurin:21-jdk AS build
WORKDIR /workspace

COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
COPY service-a/pom.xml service-a/pom.xml
RUN --mount=type=cache,target=/root/.m2 ./mvnw -B -ntp dependency:go-offline

COPY service-a/src service-a/src
RUN --mount=type=cache,target=/root/.m2 ./mvnw -B -ntp -pl service-a -am package -DskipTests

FROM eclipse-temurin:21-jre
RUN useradd --system --uid 10001 app
WORKDIR /app
COPY --from=build --chown=app:app /workspace/service-a/target/app.jar app.jar
USER 10001
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
```

先复制变化少的依赖描述，再复制源码。使用 `.dockerignore` 排除 `.git`、target、日志和密钥。基础镜像用 digest 固定，并由 Renovate/Dependabot 定期更新，而不是永久不更新。

多阶段构建减小运行镜像；运行阶段只保留 JRE 和必要证书，不包含 Maven、编译器和源码。

### 7.2 镜像与供应链

```bash
syft "$IMAGE" -o cyclonedx-json > sbom.json
trivy image --exit-code 1 --severity HIGH,CRITICAL "$IMAGE"
cosign sign --yes "$IMAGE_DIGEST"
cosign verify "$IMAGE_DIGEST"
```

扫描规则要处理“有修复版本”和业务豁免，豁免必须有负责人、原因和到期日。发布使用 digest，不使用会移动的 `latest`。

## 8. Kubernetes 发布

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  replicas: 6
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  minReadySeconds: 20
  progressDeadlineSeconds: 600
  template:
    spec:
      terminationGracePeriodSeconds: 40
      containers:
        - name: app
          image: registry.example.com/order-service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              memory: "2Gi"
          startupProbe:
            httpGet: { path: /actuator/health/readiness, port: 8080 }
            failureThreshold: 30
            periodSeconds: 5
          readinessProbe:
            httpGet: { path: /actuator/health/readiness, port: 8080 }
            periodSeconds: 5
            timeoutSeconds: 2
          livenessProbe:
            httpGet: { path: /actuator/health/liveness, port: 8080 }
            periodSeconds: 10
            timeoutSeconds: 2
```

Readiness 决定是否接流量，Liveness 只判断进程是否无法恢复，不能因数据库短暂不可用就重启全部 Pod。Startup Probe 保护慢启动应用。

CPU limit 可能导致延迟敏感 Java 服务被节流，可通过压测决定是否只设 request + memory limit，并遵循集群策略。Memory limit 必须覆盖堆外和 PageCache。

发布前执行：

```bash
kubectl diff -f k8s/
kubectl apply --server-side --dry-run=server -f k8s/
kubectl rollout status deployment/order-service --timeout=10m
```

使用 PDB、拓扑分布约束和反亲和避免滚动更新/节点维护同时失去过多副本。HPA 基于 CPU 之外还可用 RPS、队列等指标，但要考虑冷启动和下游容量。

## 9. 灰度、回滚和数据库变更

灰度比较新旧版本错误率、p95/p99、资源、关键业务指标，达到门槛自动暂停或回滚。Kubernetes `rollout undo` 只能恢复 Deployment 模板，不能自动撤销数据库 Schema 和外部配置。

数据库采用 Expand/Contract：

1. 先新增兼容字段/表；
2. 发布同时兼容新旧 Schema 的代码；
3. 回填并校验；
4. 切换读取；
5. 观察后删除旧字段。

不可逆数据迁移必须有备份、校验和前滚方案。

## 10. Ansible 工程化

Inventory 分环境，Role 按职责拆分，变量按 group/host 管理，密钥放 Vault 或外部密钥系统。所有任务优先幂等模块，不用无条件 shell。

```bash
ansible-lint
ansible-playbook --syntax-check site.yml
ansible-playbook --check --diff -l canary site.yml
ansible-playbook -l canary site.yml
ansible-playbook --serial 20% site.yml
```

`--check` 不是所有模块都能完整模拟，仍需预发布和 canary。滚动发布中 `serial`、`max_fail_percentage`、健康检查和负载均衡摘挂要一起设计。

## 11. 性能与可靠性门禁

推荐流水线硬门禁：

- 依赖锁定、许可证和 SBOM；
- 单元/集成测试及覆盖率趋势；
- SAST、Secret Scan、镜像 CVE；
- 构建签名和来源证明；
- 服务端 dry-run、策略校验；
- 灰度 SLO 和业务指标；
- 回滚演练。

不要把所有检查都放在合并后的发布流水线。快速检查前移到 Merge Request，耗时的全量回归按变更风险和夜间任务分层。

## 12. 参考资料

- [Git Partial Clone](https://git-scm.com/docs/partial-clone)
- [Maven 3 并行构建](https://cwiki.apache.org/confluence/display/MAVEN/Parallel+builds+in+Maven+3)
- [Jenkins Pipeline 最佳实践](https://www.jenkins.io/doc/book/pipeline/pipeline-best-practices/)
- [GitLab CI 缓存](https://docs.gitlab.com/ci/caching/)
- [GitLab DAG `needs`](https://docs.gitlab.com/ci/yaml/needs/)
- [Docker Build Cache](https://docs.docker.com/build/cache/)
- [Kubernetes 资源管理](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Kubernetes Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Ansible 最佳实践](https://docs.ansible.com/ansible/latest/tips_tricks/ansible_tips_tricks.html)
- [阿里云 ACK 最佳实践](https://help.aliyun.com/zh/ack/ack-managed-and-ack-dedicated/use-cases/)

## 13. Ansible 配置

下面的发布 Playbook 使用 digest 固定镜像、分批更新并在每批后验证健康。`healthcheck_url` 应指向经负载均衡摘挂后的真实探针。执行前安装 `community.docker`：`ansible-galaxy collection install community.docker`。

```yaml cicd-tuning.yml
---
- name: 分批发布应用
  hosts: application_servers
  become: true
  serial: "20%"
  max_fail_percentage: 0
  vars:
    service_name: order-service
    image_digest: "registry.example.com/order-service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    healthcheck_url: "http://127.0.0.1:8080/actuator/health/readiness"
  pre_tasks:
    - name: 从负载均衡摘除节点
      ansible.builtin.uri:
        url: "{{ load_balancer_api }}/nodes/{{ inventory_hostname }}/disable"
        method: POST
        status_code: [200, 204]
      delegate_to: localhost

  tasks:
    - name: 拉取不可变镜像
      community.docker.docker_image:
        name: "{{ image_digest }}"
        source: pull
        force_source: true

    - name: 更新应用容器
      community.docker.docker_container:
        name: "{{ service_name }}"
        image: "{{ image_digest }}"
        state: started
        restart_policy: always
        recreate: true
        memory: 2g
        env:
          SPRING_PROFILES_ACTIVE: production
        published_ports:
          - "127.0.0.1:8080:8080"

    - name: 等待应用通过就绪检查
      ansible.builtin.uri:
        url: "{{ healthcheck_url }}"
        status_code: 200
      register: healthcheck
      retries: 30
      delay: 5
      until: healthcheck.status == 200

  post_tasks:
    - name: 将节点加入负载均衡
      ansible.builtin.uri:
        url: "{{ load_balancer_api }}/nodes/{{ inventory_hostname }}/enable"
        method: POST
        status_code: [200, 204]
      delegate_to: localhost
```
