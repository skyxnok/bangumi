/**
 * Bangumi 数据 API - Cloudflare Worker
 * 从 GitHub 仓库读取 JSON 数据并提供给博客的番组计划页面
 *
 * 部署：wrangler deploy（或粘贴到 Cloudflare Dashboard）
 * 绑定域名后，博客 siteConfig.bangumi.apiUrl 指向该域名即可
 *
 * 环境变量（wrangler vars 或 Dashboard 设置）：
 *   GITHUB_USER: GitHub 用户名（必填）
 *   GITHUB_REPO: 仓库名（必填）
 *   GITHUB_BRANCH: 分支名，默认 main
 *   CACHE_TTL: 数据缓存秒数，默认 300（5分钟）
 *
 * 缓存说明：Cloudflare Cache API 的 cache.match() 不一定按 max-age 过期，
 * 所以这里用 x-cached-at 时间戳做显式 TTL，保证同步后数据能及时更新。
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

// 图片根路径（jsDelivr CDN，比 raw.githubusercontent.com 更稳）
function imageCdnUrl(env) {
	return `https://cdn.jsdelivr.net/gh/${env.GITHUB_USER}/${env.GITHUB_REPO}@${env.GITHUB_BRANCH || "main"}`;
}

function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
	});
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// OPTIONS 预检
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS });
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return jsonResponse({ error: "Method Not Allowed" }, 405);
		}

		// 路由：GET /v0/users/{username}/collections
		const m = url.pathname.match(/^\/v0\/users\/([^/]+)\/collections$/);
		if (!m) {
			return jsonResponse({ error: "Not Found", path: url.pathname }, 404);
		}

		const username = m[1];
		const subjectType = Number(url.searchParams.get("subject_type") || 2);
		const limit = Math.min(
			Number(url.searchParams.get("limit") || 50),
			100,
		);
		const offset = Number(url.searchParams.get("offset") || 0);

		const fileKey = TYPE_MAP[subjectType];
		if (!fileKey) {
			return jsonResponse({ error: `Unsupported subject_type: ${subjectType}` }, 400);
		}

		if (!env.GITHUB_USER || !env.GITHUB_REPO) {
			return jsonResponse({ error: "Worker 未配置 GITHUB_USER / GITHUB_REPO" }, 500);
		}

		const branch = env.GITHUB_BRANCH || "main";
		const cacheTtl = Number(env.CACHE_TTL || 300);
		const forceRefresh = url.searchParams.get("refresh") === "1";

		// ---------- 读取数据（带缓存） ----------
		// 数据文件用 raw.githubusercontent.com 保证始终最新；
		// jsDelivr 对 @main 分支的缓存刷新可能延迟很久，不适合数据文件。
		const rawUrl = `https://raw.githubusercontent.com/${env.GITHUB_USER}/${env.GITHUB_REPO}/${branch}/data/${fileKey}.json`;
		const cdnUrl = `https://cdn.jsdelivr.net/gh/${env.GITHUB_USER}/${env.GITHUB_REPO}@${branch}/data/${fileKey}.json`;
		const cacheKey = new Request(rawUrl);
		const cache = caches.default;

		let items;
		if (!forceRefresh) {
			const cached = await cache.match(cacheKey);
			if (cached) {
				const cachedAt = Number(cached.headers.get("x-cached-at") || 0);
				if (Date.now() - cachedAt < cacheTtl * 1000) {
					items = await cached.json();
				}
			}
		}
		if (!items) {
			let resp = await fetch(rawUrl, {
				headers: { Accept: "application/json", "User-Agent": "BangumiDataAPI" },
			});
			if (!resp.ok) {
				// raw 失败时回退到 jsDelivr CDN
				resp = await fetch(cdnUrl, {
					headers: { Accept: "application/json", "User-Agent": "BangumiDataAPI" },
				});
				if (!resp.ok) {
					return jsonResponse({ error: `数据文件获取失败: ${fileKey}.json` }, 502);
				}
			}
			items = await resp.json();

			// 缓存成功响应（clone 后放入，原 body 仍可读）
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

		// ---------- 图片地址补全（相对路径 -> jsDelivr CDN） ----------
		const cdnBase = imageCdnUrl(env);
		const fillImageUrl = (p) => {
			if (!p) return "";
			if (/^https?:\/\//.test(p)) return p;
			return `${cdnBase}/${p.replace(/^\/+/, "")}`;
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
