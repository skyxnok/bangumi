# 收藏数据 API（Bangumi + 豆瓣）

用 GitHub 仓库存储数据（JSON + AVIF 封面），Cloudflare Worker 作为 API 网关，为博客「番组计划」页面提供数据。数据源：

- **Bangumi**：`api.bgm.tv`（官方 API，覆盖 anime/book/music/game/real）
- **豆瓣**：`frodo.douban.com`（豆瓣 App 内部接口，覆盖 book/movie/music/game，其中 movie 合并到 real 分类）
- **手动条目**：`custom/*.json`（其他来源的条目）

## 结构

```
├── data/            # 分类数据 JSON（anime/book/music/game/real）
├── images/          # AVIF 封面图（按分类分目录）
├── worker/          # Cloudflare Worker 代码
├── scripts/sync.js  # 数据同步脚本
└── wrangler.toml    # Worker 部署配置
```

## 使用流程

### 1. 同步数据（本地执行）

```bash
npm install
npm run sync
```

会从 Bangumi API 拉取收藏，下载封面转 AVIF，生成 `data/*.json`。

环境变量可覆盖默认值：

```bash
BGM_USERNAME=skyxnok \
BGM_API_URL=https://shyxnok.dpdns.org \
DOUBAN_ID=296581086 \
npm run sync
```

豆瓣相关环境变量：

- `DOUBAN_ID`：豆瓣用户 ID（主页 `douban.com/people/<ID>/` 的 `<ID>`），留空则跳过豆瓣同步
- `DOUBAN_PAGE_DELAY_MS`：豆瓣翻页间隔，默认 `1500`
- `DOUBAN_CATEGORY_DELAY_MS`：豆瓣分类/状态间隔，默认 `2000`

豆瓣条目说明：

- 条目 ID 会加 `10_000_000_000` 命名空间，避免与 Bangumi ID 冲突
- 点击卡片跳转到豆瓣原始链接（`subject.url`）
- 收藏状态映射：`done`→看过、`doing`→在看、`mark`→想看
- 个人评分（5 星制）×2 转为 Bangumi 的 10 分制

### 2. 推送到 GitHub

```bash
git add -A
git commit -m "sync bangumi data"
git push
```

### 3. 部署 Worker

```bash
npm run deploy
```

或直接粘贴 `worker/worker.js` 到 Cloudflare Dashboard。配置 `GITHUB_USER` / `GITHUB_REPO` 变量后，绑定自定义域名即可。

### 4. 接入博客

`src/config/siteConfig.ts`：

```ts
bangumi: {
  apiUrl: "https://你的worker域名",
  subjectBaseUrl: "https://bgm.tv/subject/",
}
```

## API 说明

```
GET /v0/users/{username}/collections?subject_type=2&limit=50&offset=0
```

- `subject_type`: 1=书籍, 2=动画, 3=音乐, 4=游戏, 6=三次元
- 返回格式与 Bangumi 官方 `UserSubjectCollection` 兼容（字段参考 `docs/bangumi-api.md`）
- 图片相对路径由 Worker 自动补全为 jsDelivr CDN 地址
- 数据缓存 1 小时（`CACHE_TTL` 可调）
