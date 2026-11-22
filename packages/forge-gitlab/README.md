# GitLab 合并请求

`@onlyfeng/dsh-forge-gitlab` 在 DeepSeek Harness 的「变更请求与工作树」面板中显示 GitLab MR、补丁和行内讨论。插件使用本机已登录的 `glab`，默认以只读模式运行。为指定主机开启讨论写入后，有权限的用户可在面板回复、解决或重新打开已有讨论。

## 在 Desktop 中使用

1. 在插件页启用「变更请求与工作树」。同一 profile 中只能有一个 provider 注册 `gitlab`。
2. 在使用 Desktop 的系统账号下安装 `glab`，运行 `glab auth login --hostname gitlab.example.org`。登录信息由 `glab` 管理。只读访问需要账号对目标私有项目有相应权限。
3. 将分发包完整解压到一个长期保留的目录。在插件页选择「添加插件」并指定内含 `package.json` 的目录。也可以使用 Desktop 自带的 CLI。

```powershell
dsh plugin --profile desktop add 'C:\DSH-Plugins\forge-gitlab-0.2.0-rc.3'
```

默认识别 `gitlab.com`。自建 GitLab 在本机 profile 的 `cordis.patch.yml` 中覆盖已有行。`hosts` 是完整允许列表，示例使用保留域名。

```yaml
- id: forge-gitlab-reader
  config:
    hosts: [gitlab.example.org]
    glabCommand: glab
    timeoutMs: 15000
    maxOutputBytes: 4194304
    maxThreads: 100
    discussionWriteHosts: []
```

`timeoutMs` 和 `maxOutputBytes` 限制单次 CLI 调用。`maxThreads` 限制单次评审读取返回的线程数。包目录中已附上 JS 运行依赖，同事机器可直接使用编译好的 Desktop 和 `glab`。以本地路径安装后请保留该目录。

## 读取范围

- **MR 状态与发现**：从支持的 Git remote 或 MR 链接确定项目，按源分支查询打开的 MR。变更请求由面板跟踪，首版适用于已知仓库和 MR。
- **变更内容**：按审核时看到的 head 读取 diff，按提交读取文件。读取过程中 head 改变会返回 `stale`，应从面板刷新后再读。
- **评审讨论**：读取 GitLab Discussions API 的行内及文件讨论，保留用户回复和已解决状态。旧提交上的位置不会被画到当前提交。普通 MR 留言、系统事件、图片坐标及无法可靠定位的范围不在该面板列表中。达到线程上限或分页扫描上限时返回 `truncated`。
- **权限**：`discussionWriteHosts` 默认为空。此时只用 GET 读取数据，面板提供只读操作。

概览优先采用 GitLab 的增删行统计。REST 响应缺少统计时，插件通过固定的 GraphQL GET 读取同一 diff 版本的行数。旧实例未提供统计时，打开「变更」可查看补丁的实际行数。折叠、截断或无法表达的文件会在读取补丁时给出错误。

概览显示当前 head 的流水线状态。展开检查时，插件分页读取该流水线的作业和触发作业。合并结果流水线需要先核对临时提交的父提交。没有当前流水线时，检查清单显示 0 项。审批规则和下游流水线的内部作业请在 GitLab 查看。

Desktop `0.2.2-rc.5` 用户可在「设置 → 通用 → 语言」选择「中文（代码托管平台）」。线程卡片和讨论列表的链接都会显示「在代码托管平台查看」，分别打开该条讨论和整个 MR。

## 在线程中回复、解决和重新打开

在本机插件行的 `config` 中将 `discussionWriteHosts` 设置为允许写入的域名列表。每个域名也必须包含在 `hosts` 中。使用能在该项目发表评论的 `glab` 账号；令牌写入需要 GitLab 的 `api` scope。在变更请求面板打开目标 MR 的「变更」，展开线程，核对目标和正文后点击回复；展开线程，在回复框下方操作行点击「解决讨论」。按钮切换为「取消解决」，再次点击会重开同一条讨论；「已审阅」记录文件的阅读进度。

面板通过只读 GraphQL 查询核实当前账号在 MR 和开帖评论上的权限，按讨论 ID 和开帖评论 ID 匹配结果。权限查询有页数上限；未取得明确权限的线程保留只读展示。写入时插件重新读取目标线程、权限和当前 head。head 已变化会返回 `stale`。GitLab 的讨论写接口不接受预期 head 参数，最后一次查询与实际写入之间仍有并发窗口。

回复使用即时发布模式，正文按原样发送，单行开头带 `/` 的快捷操作会被拒绝。超时或返回内容无法确认写入结果时，插件报告 `unknown`；先在 GitLab 查看线程，再决定是否提交。此版本支持已有线程操作，创建行内评论、提交整组评审、批准和合并仍属于其他能力。

OCR 评审判断适合放在单独的工作流插件中。它按项目、MR 和 head 调度评审，核对发现对应的 diff 行，并记录已发布意见的标识。这样新提交可以触发复审，重复执行同一任务时也能识别已有评论。

## 开发与打包

仓库根目录运行以下命令。打包器从锁定的工作区依赖生成可复制目录，要求输出目录尚不存在，保留依赖许可。插件通过 Git 或打包目录分发。

```sh
pnpm install --frozen-lockfile
pnpm test
node scripts/package-forge-gitlab.mjs dist/forge-gitlab-0.2.0-rc.3
```

`tests/` 使用合成数据，可离线运行。`scripts/verify-forge-gitlab.mjs` 使用 Desktop 提供的 Electron Node 运行时，挂载真正的 `ForgeService` 并检查插件卸载。添加 `--live` 并在本机设置 `FORGE_SMOKE_MR_URL` 后，测试会对指定 MR 做只读验证，输出仅包含状态和计数。

Windows 上运行 `pwsh -File scripts/verify-forge-gitlab.ps1 -DiscussionFixture` 可用实际 Desktop 和 `glab` 对回环测试实例执行回复、解决、重开和回读，并检查服务端返回 503 时的写入次数。

## 来源

MR provider 以 [futuretea/dsh-forge-gitlab v0.1.1](https://github.com/futuretea/dsh-forge-gitlab/tree/7259e06addc2f9d8a47af059a905383985570ef6) 为参考基线，保留其 [MIT 许可](LICENSE.upstream)。此版本独立维护。评审讨论的字段与操作语义参考了 [GitLab Discussions API](https://docs.gitlab.com/api/discussions/) 和 [k0ndrateff 的评审服务](https://github.com/k0ndrateff/dsh-plugins/blob/32c09299805289e15e550368dc27d1fe9a3efbcc/packages/gitlab/src/host/review.ts)，评审适配器独立实现。
