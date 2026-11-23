# onlyfeng 的 DSH 插件

在 DeepSeek Harness 的「插件 → 发现」中添加[插件索引](https://onlyfeng.github.io/dsh-plugins/market.json)，选择插件和版本。安装确认框会显示 GitHub 仓库、完整提交和包目录。

| 插件 | 包名 |
| --- | --- |
| GitLab 合并请求评审 | `@onlyfeng/dsh-forge-gitlab` |
| GitLab 项目合并请求选择器 | `@onlyfeng/dsh-forge-gitlab-project` |
| Open Code Review 团队审查任务 | `@onlyfeng/dsh-ocr-team` |
| Agent 团队协作与任务交接 | `@onlyfeng/dsh-team-coop` |
| 网页搜索网关 | `@onlyfeng/dsh-web-search-gateway` |

已有旧版网页搜索网关的用户可按[迁移说明](packages/web-search-gateway/README.md#从旧包升级)切换。GitLab 评审插件的稳定版本提供只读能力，候选版的讨论写入需要按主机启用。

## 发布约定

- 公开包使用 `@onlyfeng/dsh-<功能名>`。市场标题提供中英文，作者为 `onlyfeng`。
- 日常安装使用市场中的 Git 版本。源码链接用于开发，本地包归档用于测试。站点配置和凭据保存在使用者的环境。
- 每个包的每个 SemVer 版本对应一个固定的 Git 提交和包目录。候选版本可递增为 `rc.2` 等，稳定版本用 `latest` 标记。
- 发布新版本时，先提交源码和包版本，再把提交号追加到[发布清单](scripts/market-releases.json)，更新推荐版本并运行 `pnpm run market:build`。评审通过后采用保留源提交的合并方式，确保市场的 Git 安装地址持续可用。
- 运行 `pnpm test` 和 `pnpm run market:check` 校验插件和索引。修改开发代码或测试时，可以继续保留已发布版本的提交号。

### 发布内容检查

`node scripts/check-public-content.mjs` 检查 Git 暂存区的文本和路径，也会检查扫描器本身。公开 CI 使用通用规则。维护者可从已审查的扫描器版本执行以下命令，在本机核对候选提交及其补丁：

```sh
node scripts/check-public-content.mjs --repo <候选检出根目录> --ref <最终提交完整SHA> --base <基线完整SHA> --policy <仓库外策略文件>
```

策略采用 JSON 对象。`forbiddenTerms` 填写站点专用字面词，`allowedEmails` 填写获准公开的完整邮箱地址。策略文件由维护者保存在仓库外的私有目录。`--base` 会检查每个新增提交的署名、说明和补丁，其中包括删除行。检查命中时只显示条目序号、行号与规则类别。原始站点材料、PR 标题和正文由维护者在私有预审时核对。

### 私有预审与正式发布

1. 在私有预审仓库提交 PR。维护者核对最终差异、提交说明和作者信息中的敏感内容，处理 Codex 反馈，确认同一提交的审查与 CI 通过。
2. 从正式仓库的 `main` 建立发布分支，按预审清单移入已核准的最终文件。比对文件内容并检查正式 PR 的全部补丁。若补丁删除的旧行已含敏感信息，应先在私有环境评估公开补丁的暴露范围。新包版本按上面的发布约定登记正式仓库可达的源码提交。
3. 正式 PR 的最终提交通过 CI 和审核后合并。仅正式仓库的 `main` 可以通过工作流部署市场站点。发布后核对线上索引，再将正式 `main` 的提交快进同步到私有预审仓库的 `public-main` 分支，供下一次发布比对。
