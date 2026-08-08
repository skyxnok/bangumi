/**
 * Bangumi 数据同步脚本
 * 从 Bangumi API 拉取用户收藏 → 下载封面转 AVIF → 生成 data/*.json
 *
 * 用法：
 *   node scripts/sync.js
 *
 * 配置（环境变量，可写在 .env 或直接改下方默认值）：
 *   BGM_USERNAME:  Bangumi 用户 ID（默认 skyxnok）
 *   BGM_API_URL:   API 地址（默认 https://shyxnok.dpdns.org，即你的代理）
 *   BGM_SUBJECT_API: 条目信息接口前缀（默认同 apiUrl，用于补充数据）
 *   如需直连官方：BGM_API_URL=https://api.bgm.tv
 *   DOUBAN_ID:      豆瓣用户 ID（默认 296581086，留空则跳过豆瓣同步）
 *   DOUBAN_PAGE_DELAY_MS:     豆瓣翻页间隔 ms（默认 1500）
 *   DOUBAN_CATEGORY_DELAY_MS: 豆瓣分类/状态间隔 ms（默认 2000）
 */
import { createHmac } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const IMAGES_DIR = join(ROOT, "images");
const CUSTOM_DIR = join(ROOT, "custom");

const USERNAME = process.env.BGM_USERNAME || "skyxnok";
const API_URL = (process.env.BGM_API_URL || "https://api.bgm.tv").replace(/\/+$/, "");

// 分类映射：subject_type -> { dir, file, subjectType }
// doubanType 表示豆瓣对应的分类（movie -> 三次元 real；anime 无豆瓣对应分类）
const CATEGORIES = [
	{ key: "anime", subjectType: 2 },
	{ key: "book", subjectType: 1, doubanType: "book" },
	{ key: "music", subjectType: 3, doubanType: "music" },
	{ key: "game", subjectType: 4, doubanType: "game" },
	{ key: "real", subjectType: 6, doubanType: "movie" },
];

const LIMIT = 50;
const DELAY = 60; // 请求间隔 ms
const MAX_TOTAL = 1000;

// 封面压缩配置
const AVIF_MAX_WIDTH = 400; // 卡片只用到 medium 尺寸，400px 足够
const AVIF_QUALITY = 50;

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ===== 豆瓣（Frodo API）配置 =====
// 凭证逆向自豆瓣 Android APK，公开且所有用户共用，不涉及个人账号
const DOUBAN_API_URL = "https://frodo.douban.com";
const DOUBAN_API_KEY = "0dad551ec0f84ed02907ff5c42e8ec70";
const DOUBAN_SECRET = "bf7dddc7c9cfe6f7";
const DOUBAN_USER_AGENT =
	"api-client/1 com.douban.frodo/7.22.0.beta9(231) Android/23 product/Mate40 vendor/HUAWEI model/Mate40 brand/HUAWEI rom/android network/wifi platform/AndroidPad";
const DOUBAN_ID = (process.env.DOUBAN_ID || "296581086").trim();
const DOUBAN_PAGE_DELAY = Number(process.env.DOUBAN_PAGE_DELAY_MS || 1500);
const DOUBAN_CATEGORY_DELAY = Number(process.env.DOUBAN_CATEGORY_DELAY_MS || 2000);
const DOUBAN_IMAGE_DELAY = Number(process.env.DOUBAN_IMAGE_DELAY_MS || 300);
// 豆瓣条目 ID 命名空间，避免与 Bangumi ID 冲突（Svelte key / 跳转链接用）
const DOUBAN_NS = 10_000_000_000;
// 豆瓣收藏状态 -> 收藏类型（与 Bangumi 一致：1想看 2看过 3在看）
const DOUBAN_STATUS_TYPE = { done: 2, doing: 3, mark: 1 };

/** 计算 Frodo API 签名：HMAC-SHA1("GET&" + URL编码path + "&" + 时间戳秒) -> Base64 */
function doubanSignature(apiPath, ts) {
	const encodedPath = encodeURIComponent(apiPath).replace(/[!'()*]/g, (c) =>
		"%" + c.charCodeAt(0).toString(16).toUpperCase(),
	);
	const raw = ["GET", encodedPath, ts].join("&");
	return createHmac("sha1", DOUBAN_SECRET).update(raw).digest("base64");
}

/** 拉取豆瓣一页收藏；403/5xx 指数退避重试（最多 3 次） */
async function fetchDoubanPage(doubanId, type, status, start, count) {
	const apiPath = `/api/v2/user/${doubanId}/interests`;
	const ts = String(Math.floor(Date.now() / 1000));
	const params = new URLSearchParams({
		type,
		status,
		start: String(start),
		count: String(count),
		apiKey: DOUBAN_API_KEY,
		_ts: ts,
		_sig: doubanSignature(apiPath, ts),
		os_rom: "android",
	});
	const url = `${DOUBAN_API_URL}${apiPath}?${params}`;

	let lastErr;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const resp = await fetch(url, {
				headers: { "User-Agent": DOUBAN_USER_AGENT, Accept: "application/json" },
			});
			if (resp.status === 403 || resp.status === 429 || resp.status >= 500) {
				lastErr = new Error(`HTTP ${resp.status}`);
			} else if (!resp.ok) {
				lastErr = new Error(`HTTP ${resp.status}`);
			} else {
				const data = await resp.json();
				if (data && typeof data === "object" && data.code) {
					lastErr = new Error(`豆瓣返回错误 code=${data.code}: ${data.msg || ""}`);
				} else {
					return data;
				}
			}
		} catch (e) {
			lastErr = e;
		}
		const wait = 5000 * 2 ** attempt;
		console.warn(`  豆瓣请求失败（${lastErr.message}），${wait / 1000}s 后重试...`);
		await new Promise((r) => setTimeout(r, wait));
	}
	throw lastErr || new Error("豆瓣请求失败");
}

/** 拉取豆瓣某分类 + 状态的全部收藏（按 total 判断是否拉完，防止下架条目导致漏页） */
async function fetchDoubanAll(doubanId, type, status) {
	const all = [];
	let start = 0;
	let total = null;
	while (all.length < 1000) {
		const data = await fetchDoubanPage(doubanId, type, status, start, 50);
		if (total === null) {
			total = data.total || 0;
			if (total === 0) return [];
		}
		const batch = data.interests || [];
		all.push(...batch);
		if (all.length >= total) break;
		start += batch.length;
		await new Promise((r) => setTimeout(r, DOUBAN_PAGE_DELAY));
	}
	return all;
}

/** "2026-08-09 00:03:43" -> "2026-08-09T00:03:43+08:00"（与 Bangumi 格式对齐，便于排序） */
function normalizeDoubanTime(t) {
	if (!t) return "";
	const m = String(t).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
	return m ? `${m[1]}T${m[2]}+08:00` : String(t);
}

/** 豆瓣条目 -> Bangumi 兼容结构（ID 加命名空间避免冲突，链接用豆瓣原始 URL） */
async function toBangumiItem(interest, cat) {
	const subject = interest.subject || {};
	const doubanId = String(subject.id || "");
	const nsId = DOUBAN_NS + Number(doubanId || 0);
	const pic = subject.pic || {};
	const cover = pic.large || pic.normal || "";
	const rel = cover
		? await downloadCover(
				cat.key,
				"douban-" + doubanId,
				cover,
				DOUBAN_USER_AGENT,
				[subject.sharing_url, subject.url].filter(Boolean),
			)
		: "";
	const pubdate = Array.isArray(subject.pubdate) ? subject.pubdate[0] : (subject.pubdate || "");

	return {
		source: "douban",
		subject_id: nsId,
		subject_type: cat.subjectType,
		rate: Math.round((interest.rating?.value || 0) * 2),
		type: DOUBAN_STATUS_TYPE[interest.status] || 2,
		comment: interest.comment || "",
		tags: Array.isArray(interest.tags) ? interest.tags : [],
		ep_status: 0,
		vol_status: 0,
		updated_at: normalizeDoubanTime(interest.create_time),
		private: !!interest.is_private,
		subject: {
			id: nsId,
			type: cat.subjectType,
			name: subject.title || "",
			name_cn: subject.title || "",
			short_summary: subject.intro || "",
			date: pubdate,
			images: { medium: rel },
			url: subject.url || "",
			volumes: 0,
			eps: 0,
			collection_total: subject.rating?.count || 0,
			score: subject.rating?.value || 0,
			rank: 0,
			tags: [],
		},
	};
}

/** 按更新时间倒序排序（相同时间用 ID 兜底，保证多次运行输出稳定） */
function sortByUpdatedAt(items) {
	return [...items].sort((a, b) => {
		const diff = String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
		return diff !== 0 ? diff : Number(b.subject_id || 0) - Number(a.subject_id || 0);
	});
}

/** 处理手动条目封面：medium 为远程 URL 时下载转 AVIF 存到 images/custom/{cat}/{id}.avif */
async function processCustomItemCover(item, catKey) {
	if (!item || !item.subject || !item.subject.images) return item;
	const medium = item.subject.images.medium || "";
	if (!medium || /^https?:\/\//.test(medium) === false) return item;
	const rel = await downloadCover("custom/" + catKey, item.subject.id, medium);
	return {
		...item,
		subject: {
			...item.subject,
			images: { medium: rel },
		},
	};
}

/** 读取 custom/ 目录下的手动条目（按分类），没有则返回空数组 */
function readCustomItems(catKey) {
	const file = join(CUSTOM_DIR, catKey + ".json");
	if (!existsSync(file)) return [];
	try {
		const items = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(items)) return [];
		return items.filter((it) => it && it.custom === true);
	} catch (e) {
		console.warn("  读取 custom/" + catKey + ".json 失败: " + e.message);
		return [];
	}
}

async function fetchAll(username, subjectType) {
	const all = [];
	let offset = 0;
	while (true) {
		if (MAX_TOTAL > 0 && all.length >= MAX_TOTAL) break;
		const url = `${API_URL}/v0/users/${username}/collections?subject_type=${subjectType}&limit=${LIMIT}&offset=${offset}`;
		const resp = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
		if (!resp.ok) throw new Error(`获取失败 (${resp.status}): ${url}`);
		const data = await resp.json();
		const batch = data.data || [];
		all.push(...batch);
		if (batch.length < LIMIT || batch.length === 0) break;
		offset += LIMIT;
		await new Promise((r) => setTimeout(r, DELAY));
	}
	return all;
}

/** 下载图片并转为 AVIF，返回相对路径 images/{cat}/{id}.avif；失败返回原 URL */
async function fetchWithRetry(url, { headers = {}, timeoutMs = 20000, retries = 4 } = {}) {
	let lastErr;
	for (let attempt = 0; attempt < retries; attempt++) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const resp = await fetch(url, { headers, signal: ctrl.signal });
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			return resp;
		} catch (e) {
			lastErr = e;
			if (attempt < retries - 1) {
				const wait = 1500 * 2 ** attempt;
				console.warn(`  封面下载重试 ${attempt + 1}/${retries}（${e.message}），${wait}ms 后重试`);
				await new Promise((r) => setTimeout(r, wait));
			}
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr || new Error("fetch failed");
}

/** 下载图片并转为 AVIF，返回相对路径 images/{cat}/{id}.avif；失败返回原 URL */
async function downloadCover(catDir, id, url, ua = USER_AGENT, referers = []) {
	if (!url) return "";
	const safeId = String(id).replace(/[^\w.-]+/g, "-");
	const relPath = `images/${catDir}/${safeId}.avif`;
	const absPath = join(ROOT, relPath);

	// 豆瓣图床（doubanio）可能拒绝无 Referer / 非浏览器 UA 的请求，甚至直接断连
	// 依次尝试：无 Referer -> 各候选 Referer（sharing_url、条目页、豆瓣首页），去重
	const refererList = [""];
	for (const r of referers) {
		if (r && !refererList.includes(r)) refererList.push(r);
	}
	if (!refererList.includes("https://www.douban.com/")) {
		refererList.push("https://www.douban.com/");
	}

	for (const referer of refererList) {
		const headers = { "User-Agent": ua };
		if (referer) headers.Referer = referer;
		try {
			const resp = await fetchWithRetry(url, { headers });
			const buf = Buffer.from(await resp.arrayBuffer());
			const avifBuf = await sharp(buf)
				.resize({ width: AVIF_MAX_WIDTH, withoutEnlargement: true })
				.avif({ quality: AVIF_QUALITY, effort: 4 })
				.toBuffer();
			mkdirSync(dirname(absPath), { recursive: true });
			writeFileSync(absPath, avifBuf);
			return relPath;
		} catch (e) {
			console.warn(`  封面下载失败 ${id}（referer=${referer || "无"}）: ${e.message}`);
		}
	}
	console.warn(`  封面下载最终失败 ${id}，保留原链接: ${url}`);
	return url;
}

async function syncCategory(cat) {
	console.log(`\n[${cat.key}] subject_type=${cat.subjectType} 拉取中...`);
	const items = await fetchAll(USERNAME, cat.subjectType);
	console.log(`[${cat.key}] Bangumi ${items.length} 条`);

	let out = [];
	for (const item of items) {
		const subject = item.subject || {};
		const img = subject.images || {};
		const medium = img.medium || img.common || img.large || "";
		const rel = await downloadCover(cat.key, subject.id, medium);

		out.push({
			subject_id: item.subject_id,
			subject_type: item.subject_type,
			rate: item.rate,
			type: item.type,
			comment: item.comment || "",
			tags: item.tags || [],
			ep_status: item.ep_status,
			vol_status: item.vol_status,
			updated_at: item.updated_at,
			private: item.private,
			subject: {
				id: subject.id,
				type: subject.type,
				name: subject.name,
				name_cn: subject.name_cn,
				short_summary: subject.short_summary || "",
				date: subject.date || "",
				images: { medium: rel },
				volumes: subject.volumes,
				eps: subject.eps,
				collection_total: subject.collection_total,
				score: subject.score,
				rank: subject.rank,
				tags: (subject.tags || []).map((t) => ({ name: t.name, count: t.count, total_cont: t.total_cont })),
			},
		});
		await new Promise((r) => setTimeout(r, 20));
	}

	// 豆瓣收藏合并（book/music/game/real 有对应豆瓣分类）
	const hasDouban = cat.doubanType && DOUBAN_ID;
	if (hasDouban) {
		for (const status of ["done", "doing", "mark"]) {
			const interests = await fetchDoubanAll(DOUBAN_ID, cat.doubanType, status);
			console.log(`[${cat.key}] 豆瓣 ${cat.doubanType}/${status}: ${interests.length} 条`);
			for (const it of interests) {
				out.push(await toBangumiItem(it, cat));
				await new Promise((r) => setTimeout(r, DOUBAN_IMAGE_DELAY));
			}
			if (status !== "mark") {
				await new Promise((r) => setTimeout(r, DOUBAN_CATEGORY_DELAY));
			}
		}
	}

	// 手动条目合并
	mkdirSync(DATA_DIR, { recursive: true });
	const customItems = readCustomItems(cat.key);
	if (customItems.length > 0) {
		const processed = [];
		for (const it of customItems) {
			processed.push(await processCustomItemCover(it, cat.key));
		}
		out.push(...processed);
		console.log(`[${cat.key}] 合并手动条目 ${customItems.length} 条`);
	}

	// 含豆瓣数据的分类按更新时间倒序，统一时间线（anime 保持原样）
	if (hasDouban) {
		out = sortByUpdatedAt(out);
	}
	writeFileSync(join(DATA_DIR, `${cat.key}.json`), JSON.stringify(out, null, 2));
	console.log(`[${cat.key}] 已写入 data/${cat.key}.json（共 ${out.length} 条）`);
}

// 清空旧的 images 分类目录，避免残留
for (const cat of CATEGORIES) {
	const dir = join(IMAGES_DIR, cat.key);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

for (const cat of CATEGORIES) {
	try {
		await syncCategory(cat);
	} catch (e) {
		console.error(`[${cat.key}] 同步失败: ${e.message}`);
	}
}

console.log("\n✅ 同步完成");
console.log("下一步：git add -A && git commit && git push");
