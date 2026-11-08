---
name: release
description: 发布 Bubble Code 的 GitHub Release 和 npm 包。用于用户要求发布版本、创建 beta/rc/正式 Release、推送版本标签、跟踪发布 workflow 或验证 npm dist-tag 时；严格使用本仓库的 GitHub Actions 自动发布流程。
---

# Release

将用户给出的语义化版本记为 `VERSION`，例如 `0.3.0-rc.1`。版本号不带 `v`。如果用户没有给出明确版本号，先询问，不要自行推断。

本仓库通过发布 GitHub Release 触发 `.github/workflows/npm-publish.yml`：先运行完整测试，再根据版本号选择 npm dist-tag，最后发布带 provenance 的包。不要用本机 `npm publish` 替代该流程。

发布会修改远端仓库和公共 npm registry。不要 force push、移动已有标签、覆盖已有 Release 或重复发布同一版本。任一检查失败时停止发布并说明阻塞原因。

## 1. 预检

1. 确认当前目录是目标仓库，读取 `package.json` 和发布 workflow。
2. 确认当前分支为 `main`，工作区干净，GitHub CLI 已认证：

   ```bash
   git status --short --branch
   git branch --show-current
   gh auth status
   ```

3. 拉取远端引用并检查分叉：

   ```bash
   git fetch origin main --tags
   git status --short --branch
   git rev-list --left-right --count origin/main...HEAD
   git tag --list "$VERSION"
   ```

   `main` 可以包含尚未推送的目标提交；如果落后、分叉、有无关改动，或标签已经存在，停止并报告。不要使用 `stash`、`reset --hard` 或 force push 清理现场。

4. 确认目标 Release 尚不存在。已存在时停止并报告，不要重复创建：

   ```bash
   gh release view "$VERSION"
   ```

5. 运行与发布 workflow 相同的完整检查：

   ```bash
   pnpm test
   ```

   该命令包含静态检查、构建和全部 Vitest 测试。测试失败时先定位并修复根因，再单独提交修复；不得忽略失败或降级测试来推进发布。

## 2. 更新并验证版本

1. 将 `package.json` 的 `version` 精确改为 `VERSION`。不要修改无关依赖或锁文件。
2. 在最终版本内容上重新运行：

   ```bash
   pnpm test
   npm pack --dry-run --json
   ```

3. 确认 dry-run 中的包名和版本正确，包含 `dist/cli.js` 及本次需要发布的编译产物。dry-run 不应生成需要提交的 tarball。

## 3. 提交版本并创建标签

只暂存本次版本修改涉及的文件。通常只有 `package.json`；如果确实修改了其他版本文件，逐个显式列出路径。

```bash
git add package.json
git status --short
git commit -m "refactor: bump version to $VERSION"
git tag "$VERSION"
git show --no-patch --format='%H %s' "$VERSION"
```

暂存后确认没有混入其他 session 或未提及的文件。测试修复应使用独立提交，不塞进版本提交。标签沿用仓库约定，使用不带 `v` 的轻量标签。

## 4. 推送提交和标签

```bash
git push origin main "$VERSION"
git status --short --branch
git ls-remote --tags origin "$VERSION"
```

不要 force push。确认远端标签指向刚才的版本提交。

## 5. 创建 GitHub Release

Release 名称与标签均使用 `VERSION`。如果用户提供发布说明，使用其原文；否则使用空 notes，不编造变更列表。

对于包含 `-beta` 或 `-rc` 的预发布版本：

```bash
gh release create "$VERSION" \
  --target main \
  --title "$VERSION" \
  --prerelease \
  --notes ""
```

对于正式版本，省略 `--prerelease`。创建后记录并检查 Release URL、`isPrerelease`、`targetCommitish` 和标签。

## 6. 等待自动发布

查找由本次 Release 触发的新 run。必须匹配 `headSha` 为版本提交、`event` 为 `release`，不要误看历史成功 run：

```bash
gh run list --workflow npm-publish.yml --limit 5 \
  --json databaseId,displayTitle,event,status,conclusion,headBranch,headSha,url,createdAt
```

用对应的 `databaseId` 等待：

```bash
gh run watch "$RUN_ID" --exit-status --interval 10
```

workflow 会执行以下规则：

- 版本包含 `-beta`：使用 npm `beta` 标签。
- 版本包含 `-rc`：使用 npm `rc` 标签。
- 其他版本：使用 npm `latest` 标签。

如果 run 失败，查看日志并停止在失败阶段：

```bash
gh run view "$RUN_ID" --log
```

不要仅因 GitHub Release 已创建或 Actions 显示成功就宣称 npm 发布完成。

## 7. 验证 npm registry

从 `package.json` 读取包名，然后验证目标版本和 dist-tags：

```bash
PACKAGE=$(node -p "require('./package.json').name")
npm view "$PACKAGE@$VERSION" version dist.tarball dist.integrity
npm view "$PACKAGE" dist-tags --json
```

npm 接受发布后可能继续处理数分钟，期间查询返回 404。先确认发布日志包含目标版本、正确 registry、预期 dist-tag 和最终 `+ <package>@<version>`，再每隔约 15 秒重试查询。不要因初始 404 重复执行 publish 或创建另一个 Release。

最终确认：

- `npm view <package>@<version>` 能返回目标版本和 tarball。
- beta/rc 分别写入对应 dist-tag，预发布不改变 `latest`。
- 正式版本将 `latest` 指向新版本。
- 发布 run 的 `status` 为 `completed` 且 `conclusion` 为 `success`。
- 本地 `main` 与远端一致，工作区干净。

## 8. 汇报

只有以上验证全部完成后才报告发布成功。回复应包含：

- 包名与版本。
- GitHub Release 和 Actions run URL。
- 最终 dist-tag，以及 `latest` 是否符合预期。
- 测试数量和结果。
- 安装命令，例如 `npm install -g <package>@rc`。

如果任一步骤未完成，明确区分“版本已提交”“Release 已创建”“workflow 已成功”和“npm 已可查询”，不要将中间状态称为发布完成。
