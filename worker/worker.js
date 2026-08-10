/**
 * Bangumi 数据 API - Cloudflare Worker
 * 从 GitHub 仓库读取 JSON 数据，并提供图片代理，全部走你自己的域名（data.201562.xyz）
 *
 * 部署：wrangler deploy（或粘贴到 Cloudflare Dashboard）
 * 绑定域名后，博客 siteConfig.bangumi.apiUrl 指向该域名即可
 *
 * 环境变量（wrangler vars 或 Dashboard 设置）：
 *   GITHUB_USER: GitHub 用户名（必填）
 *   GITHUB_REPO: 仓库名（必填）
 *   GITHUB_BRANCH: 分支名，默认 main
 *   CACHE_TTL: 数据缓存秒数，默认 300（5分钟）
 *   IMAGE_CACHE_TTL: 图片缓存秒数，默认 86400（1天）
 *
 * 缓存说明：Cloudflare Cache API 的 cache.match() 不一定按 max-age 过期，
 * 所以这里用 x-cached-at 时间戳做显式 TTL。
 * 请求带 ?refresh=1 可强制绕过缓存回源。
 */

// subject_type -> 文件名
const TYPE_MAP = {
	1: "book",
	2: "anime",
	3: "music",
	4: "game",
	6: "real",
};

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Max-Age": "86400",
};

const MIME = {
	avif: "image/avif",
	webp: "image/webp",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
};

function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
	});
}

/** 显式 TTL 缓存读取：未命中/过期返回 null */
async function readCache(cache, cacheKey, ttlSeconds) {
	const cached = await cache.match(cacheKey);
	if (!cached) return null;
	const cachedAt = Number(cached.headers.get("x-cached-at") || 0);
	if (Date.now() - cachedAt >= ttlSeconds * 1000) return null;
	return cached;
}

/** 从 GitHub raw 拉取文件；失败返回 null */
async function fetchRaw(user, repo, branch, relPath, accept) {
	const url = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${relPath}`;
	try {
		const resp = await fetch(url, {
			headers: { Accept: accept || "*/*", "User-Agent": "BangumiDataAPI" },
		});
		if (!resp.ok) return null;
		return resp;
	} catch {
		return null;
	}
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const cache = caches.default;

		// OPTIONS 预检
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS });
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return jsonResponse({ error: "Method Not Allowed" }, 405);
		}

		if (!env.GITHUB_USER || !env.GITHUB_REPO) {
			return jsonResponse({ error: "Worker 未配置 GITHUB_USER / GITHUB_REPO" }, 500);
		}
		const branch = env.GITHUB_BRANCH || "main";
		const forceRefresh = url.searchParams.get("refresh") === "1";

		// ---------- 路由：GET /images/{path}（封面图片代理，同源返回） ----------
		const imgMatch = url.pathname.match(/^\/images\/(.+)$/);
		if (imgMatch) {
			const rel = imgMatch[1];
			// 只允许普通文件名路径，防目录穿越
			if (!/^[A-Za-z0-9_./-]+$/.test(rel) || rel.includes("..") || rel.includes("//")) {
				return jsonResponse({ error: "Invalid image path" }, 400);
			}
			const imgTtl = Number(env.IMAGE_CACHE_TTL || 86400);
			const cacheKey = new Request(`${url.origin}/images/${rel}`);

			if (!forceRefresh) {
				const cached = await readCache(cache, cacheKey, imgTtl);
				if (cached) return cached;
			}

			const resp = await fetchRaw(env.GITHUB_USER, env.GITHUB_REPO, branch, `images/${rel}`);
			if (!resp) return jsonResponse({ error: `图片不存在: images/${rel}` }, 404);
			const buf = await resp.arrayBuffer();
			const ext = rel.split(".").pop().toLowerCase();
			const imgResp = new Response(buf, {
				headers: {
					"Content-Type": MIME[ext] || "application/octet-stream",
					"Cache-Control": `public, max-age=${imgTtl}`,
					"x-cached-at": String(Date.now()),
					...CORS,
				},
			});
			ctx.waitUntil(cache.put(cacheKey, imgResp.clone()));
			return imgResp;
		}

		// ---------- 路由：GET /friends.json（友链数据，来自独立仓库） ----------
		if (url.pathname === "/friends.json") {
			const friendsRepo = env.GITHUB_FRIENDS_REPO || env.GITHUB_REPO;
			const cacheTtl = Number(env.CACHE_TTL || 300);
			const dataUrl = `https://raw.githubusercontent.com/${env.GITHUB_USER}/${friendsRepo}/${branch}/friends.json`;
			const cacheKey = new Request(dataUrl);

			if (!forceRefresh) {
				const cached = await readCache(cache, cacheKey, cacheTtl);
				if (cached) return cached;
			}

			const resp = await fetchRaw(env.GITHUB_USER, friendsRepo, branch, "friends.json");
			if (!resp) return jsonResponse({ error: "friends.json 不存在于该仓库" }, 404);
			const body = await resp.text();
			const out = new Response(body, {
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": `public, max-age=${cacheTtl}`,
					"x-cached-at": String(Date.now()),
					...CORS,
				},
			});
			ctx.waitUntil(cache.put(cacheKey, out.clone()));
			return out;
		}

		// ---------- 路由：GET /friends/avatars/{path}（友链头像代理，来自独立仓库 avatars/ 目录） ----------
		const favMatch = url.pathname.match(/^\/friends\/avatars\/(.+)$/);
		if (favMatch) {
			const rel = favMatch[1];
			if (!/^[A-Za-z0-9_.\/-]+$/.test(rel) || rel.includes("..") || rel.includes("//")) {
				return jsonResponse({ error: "Invalid avatar path" }, 400);
			}
			const friendsRepo = env.GITHUB_FRIENDS_REPO || env.GITHUB_REPO;
			const imgTtl = Number(env.IMAGE_CACHE_TTL || 86400);
			const cacheKey = new Request(`${url.origin}/friends/avatars/${rel}`);

			if (!forceRefresh) {
				const cached = await readCache(cache, cacheKey, imgTtl);
				if (cached) return cached;
			}

			const resp = await fetchRaw(env.GITHUB_USER, friendsRepo, branch, `avatars/${rel}`);
			if (!resp) return jsonResponse({ error: `头像不存在: avatars/${rel}` }, 404);
			const buf = await resp.arrayBuffer();
			const ext = rel.split(".").pop().toLowerCase();
			const imgResp = new Response(buf, {
				headers: {
					"Content-Type": MIME[ext] || "application/octet-stream",
					"Cache-Control": `public, max-age=${imgTtl}`,
					"x-cached-at": String(Date.now()),
					...CORS,
				},
			});
			ctx.waitUntil(cache.put(cacheKey, imgResp.clone()));
			return imgResp;
		}

		// ---------- 路由：GET /v0/users/{username}/collections ----------
		const m = url.pathname.match(/^\/v0\/users\/([^/]+)\/collections$/);
		if (!m) {
			return jsonResponse({ error: "Not Found", path: url.pathname }, 404);
		}

		const username = m[1];
		const subjectType = Number(url.searchParams.get("subject_type") || 2);
		const limit = Math.min(Number(url.searchParams.get("limit") || 50), 100);
		const offset = Number(url.searchParams.get("offset") || 0);

		const fileKey = TYPE_MAP[subjectType];
		if (!fileKey) {
			return jsonResponse({ error: `Unsupported subject_type: ${subjectType}` }, 400);
		}

		const cacheTtl = Number(env.CACHE_TTL || 300);
		const dataUrl = `https://raw.githubusercontent.com/${env.GITHUB_USER}/${env.GITHUB_REPO}/${branch}/data/${fileKey}.json`;
		const cacheKey = new Request(dataUrl);

		let items;
		if (!forceRefresh) {
			const cached = await readCache(cache, cacheKey, cacheTtl);
			if (cached) items = await cached.json();
		}
		if (!items) {
			const resp = await fetchRaw(env.GITHUB_USER, env.GITHUB_REPO, branch, `data/${fileKey}.json`, "application/json");
			if (!resp) return jsonResponse({ error: `数据文件获取失败: ${fileKey}.json` }, 502);
			items = await resp.json();

			const cacheResp = new Response(JSON.stringify(items), {
				headers: {
					"Content-Type": "application/json",
					"x-cached-at": String(Date.now()),
					"Cache-Control": `public, max-age=${cacheTtl}`,
				},
			});
			ctx.waitUntil(cache.put(cacheKey, cacheResp));
		}

		if (!Array.isArray(items)) {
			return jsonResponse({ error: "数据文件格式错误：应为数组" }, 500);
		}

		// ---------- 图片地址补全（相对路径 -> 当前域名 /images/...） ----------
		const origin = url.origin;
		const fillImageUrl = (p) => {
			if (!p) return "";
			if (/^https?:\/\//.test(p)) return p; // 远程原图（封面下载失败的兜底）
			return `${origin}/${p.replace(/^\/+/, "")}`;
		};

		const pageItems = items.slice(offset, offset + limit).map((item) => {
			const subject = item.subject || {};
			const images = subject.images || {};
			return {
				...item,
				subject: {
					...subject,
					images: {
						large: fillImageUrl(images.large || images.medium || ""),
						common: fillImageUrl(images.common || images.medium || ""),
						medium: fillImageUrl(images.medium || ""),
						small: fillImageUrl(images.small || images.medium || ""),
						grid: fillImageUrl(images.grid || images.small || images.medium || ""),
					},
				},
			};
		});

		return jsonResponse({
			data: pageItems,
			total: items.length,
			limit,
			offset,
		});
	},
};
