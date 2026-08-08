# 手动条目

这里存放 Bangumi / 豆瓣都没有（或不想依赖它们）的条目，比如别的网站的动漫、书籍、电影。

> 注意：豆瓣收藏现在已经由 `pnpm sync` 自动同步合并（`movie`→`real`，`book`/`music`/`game` 一一对应），
> 不需要在这里手动加豆瓣条目；`custom/` 只用于其他来源。

## 怎么加

1. 在 `custom/` 下建对应分类文件：`anime.json`、`book.json`、`music.json`、`game.json`、`real.json`
2. 按下面的格式写条目（`custom: true` 标记必须保留，同步时靠它识别）
3. `images.medium` 有三种填法：
   - 留空 `""`：页面显示占位图
   - 填远程图片 URL（`https://...`）：同步时会自动下载并转成 AVIF 存到 `images/custom/{分类}/{id}.avif`，路径自动更新
   - 填相对路径（如 `images/custom/anime/900001.avif`）：直接使用你手动放好的文件
4. 运行 `pnpm sync`，手动条目会自动合并进 `data/*.json`（不会被冲掉）

## 格式示例（anime.json）

```json
[
  {
    "custom": true,
    "subject_id": 900001,
    "subject_type": 2,
    "rate": 9,
    "type": 2,
    "comment": "我的评价",
    "tags": ["自定义"],
    "ep_status": 0,
    "vol_status": 0,
    "updated_at": "2026-08-08T00:00:00+08:00",
    "private": false,
    "subject": {
      "id": 900001,
      "type": 2,
      "name": "作品原名",
      "name_cn": "中文名",
      "short_summary": "简介",
      "date": "2020-01-01",
      "images": { "medium": "https://example.com/cover.jpg" }, // 填 URL 或留空，同步时自动下载转 AVIF
      "volumes": 0,
      "eps": 12,
      "collection_total": 0,
      "score": 0,
      "rank": 0,
      "tags": []
    }
  }
]
```

## 字段说明

- `subject_id` / `subject.id`：随便填一个不冲突的数字（建议 900000 起），用于拼详情链接
- `type`：收藏状态 `1`想看 `2`看过 `3`在看 `4`搁置 `5`抛弃
- `subject_type`：`1`书籍 `2`动漫 `3`音乐 `4`游戏 `6`电影
- 其他字段含义参考 `docs/bangumi-api.md`（完整版）或博客 `src/types/bangumi.ts`

## 注意

- 手动条目的 `subject.id` 会拼到 `subjectBaseUrl` 后面做跳转链接，如果不希望跳转可以留 0 或不填
- 如果以后在 Bangumi 上也收藏了同一条目，会出现重复，删掉 `custom/` 里对应那条即可
