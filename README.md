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
