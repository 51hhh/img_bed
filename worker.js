/**
 * Cloudflare Worker - ImgBed Admin Ultimate v7.0
 */

const CONFIG = {
    PROXY_PREFIX: '/51hhh/img_bed/main', 
    ADMIN_ROUTE: '/admin',
    UPSTREAM_DOMAIN: 'raw.githubusercontent.com',
    CACHE_TTL_DASHBOARD: 300, 
    CACHE_TTL_FOLDER: 60,
    COOKIE_NAME: 'imgbed_session',
    BLOCKED_REGIONS: ['KP', 'SY', 'PK', 'CU'],
    BLOCKED_IPS: ['0.0.0.0', '127.0.0.1'],
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        
        if (isBlocked(request)) return new Response('Access denied', { status: 403 });

        if (url.pathname.startsWith(CONFIG.PROXY_PREFIX)) {
            return ProxyService.handle(request, url);
        }
        if (url.pathname.startsWith(CONFIG.ADMIN_ROUTE)) {
            return AdminController.handle(request, env, ctx);
        }
        if (url.pathname === '/') {
            return Response.redirect(url.origin + CONFIG.ADMIN_ROUTE, 302);
        }
        return new Response('404 Not Found', { status: 404 });
    }
};

function isBlocked(request) {
    const region = request.cf?.country || 'XX';
    const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
    return CONFIG.BLOCKED_REGIONS.includes(region) || CONFIG.BLOCKED_IPS.includes(ip);
}

// =====================================================================
// Service Layer
// =====================================================================
class ProxyService {
    static async handle(request, url) {
        try {
            url.host = CONFIG.UPSTREAM_DOMAIN;
            const newHeaders = new Headers(request.headers);
            newHeaders.set('Host', CONFIG.UPSTREAM_DOMAIN);
            newHeaders.set('Referer', `https://github.com/51hhh/img_bed`);

            const originalResp = await fetch(url.href, { method: request.method, headers: newHeaders });
            if (originalResp.status === 404) return new Response("File not found.", { status: 404 });

            const newRespHeaders = new Headers(originalResp.headers);
            newRespHeaders.set('access-control-allow-origin', '*');
            newRespHeaders.set('cache-control', 'public, max-age=31536000');
            ['content-security-policy', 'x-frame-options'].forEach(h => newRespHeaders.delete(h));

            return new Response(originalResp.body, { status: originalResp.status, headers: newRespHeaders });
        } catch (e) {
            return new Response('Proxy Error', { status: 502 });
        }
    }
}

class GitHubService {
    constructor(env, ctx) {
        this.token = env.GH_TOKEN;
        this.repo = env.GH_REPO;
        this.branch = 'main';
        this.baseUrl = `https://api.github.com/repos/${this.repo}`;
        this.ctx = ctx;
        this.headers = {
            'User-Agent': 'Cloudflare-Worker-Admin',
            'Authorization': `token ${this.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        };
    }

    async getAllFilesCached(requestUrl) {
        const cache = caches.default;
        // Key updated to force refresh for v7
        const cacheKey = new URL(new URL(requestUrl).origin + '/cache-key-tree-v7'); 
        
        let response = await cache.match(cacheKey);
        if (response) return await response.json();

        const url = `${this.baseUrl}/git/trees/${this.branch}?recursive=1`;
        const res = await fetch(url, { headers: this.headers });
        if (!res.ok) throw new Error('GitHub API Error');
        const data = await res.json();

        const images = data.tree
            .filter(i => i.type === 'blob' && /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(i.path))
            .map(i => ({ path: i.path, url: `${CONFIG.PROXY_PREFIX}/${i.path}` }));

        const jsonBody = JSON.stringify(images);
        const cachedResponse = new Response(jsonBody, {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CONFIG.CACHE_TTL_DASHBOARD}` }
        });
        this.ctx.waitUntil(cache.put(cacheKey, cachedResponse.clone()));
        return images;
    }

    async listPath(path = '') {
        const url = `${this.baseUrl}/contents/${path}?ref=${this.branch}`;
        const res = await fetch(url, { headers: this.headers });
        if (!res.ok) throw new Error(`Fetch Path Error: ${res.status}`);
        const data = await res.json();
        
        if (Array.isArray(data)) {
            return data.map(item => ({
                name: item.name,
                path: item.path,
                type: item.type,
                sha: item.sha,
                download_url: item.download_url
            })).sort((a, b) => {
                if (a.type === b.type) return a.name.localeCompare(b.name);
                return a.type === 'dir' ? -1 : 1;
            });
        }
        return [];
    }

    async deleteFile(path, sha) {
        const url = `${this.baseUrl}/contents/${path}`;
        const body = JSON.stringify({ message: `Delete ${path}`, sha, branch: this.branch });
        await fetch(url, { method: 'DELETE', headers: this.headers, body });
    }

    async moveFile(oldPath, newPath, sha, fileUrl) {
        const contentResp = await fetch(fileUrl);
        if (!contentResp.ok) throw new Error('Download source failed');
        const buffer = await contentResp.arrayBuffer();
        const content = btoa(String.fromCharCode(...new Uint8Array(buffer)));

        const putUrl = `${this.baseUrl}/contents/${newPath}`;
        const putBody = JSON.stringify({
            message: `Move ${oldPath} to ${newPath}`,
            content: content,
            branch: this.branch
        });
        const putRes = await fetch(putUrl, { method: 'PUT', headers: this.headers, body: putBody });
        if (!putRes.ok) throw new Error('Create new file failed');

        await this.deleteFile(oldPath, sha);
    }
}

// =====================================================================
// Controller Layer
// =====================================================================
class AdminController {
    static async handle(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === `${CONFIG.ADMIN_ROUTE}/login` && request.method === 'POST') {
            return this.handleLogin(request, env);
        }

        if (!this.checkCookie(request, env)) {
            if (url.pathname.includes('/api/')) return this.json({ error: 'Unauthorized' }, 401);
            return new Response(LOGIN_HTML, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        }

        const gh = new GitHubService(env, ctx);

        // API: Dashboard
        if (url.pathname === `${CONFIG.ADMIN_ROUTE}/api/dashboard`) {
            try {
                const allImages = await gh.getAllFilesCached(request.url);
                const sorted = allImages.sort((a, b) => (a.path > b.path ? -1 : 1));
                const recent = sorted.slice(0, 20);
                const others = sorted.slice(20);
                const random = [];
                const count = Math.min(20, others.length);
                for(let i=0; i<count; i++) {
                    const idx = Math.floor(Math.random() * others.length);
                    random.push(others[idx]);
                    others.splice(idx, 1);
                }
                return this.json({ recent, random });
            } catch (e) { return this.json({ error: e.message }, 500); }
        }

        // API: Browse
        if (url.pathname === `${CONFIG.ADMIN_ROUTE}/api/browse`) {
            const path = url.searchParams.get('path') || '';
            try {
                const items = await gh.listPath(path);
                const result = items.map(i => ({
                    ...i,
                    url: i.type === 'file' && /\.(jpg|png|gif|webp|svg|jpeg)$/i.test(i.name) 
                         ? `${CONFIG.PROXY_PREFIX}/${i.path}` : null
                }));
                return this.json(result, 200, { 'Cache-Control': `private, max-age=${CONFIG.CACHE_TTL_FOLDER}` });
            } catch (e) { return this.json({ error: e.message }, 500); }
        }

        // API: Batch Export (Links)
        if (url.pathname === `${CONFIG.ADMIN_ROUTE}/api/batch_export`) {
            const prefix = url.searchParams.get('path') || '';
            try {
                const allImages = await gh.getAllFilesCached(request.url);
                const filtered = allImages.filter(img => img.path.startsWith(prefix));
                return this.json({ urls: filtered.map(i => i.url) });
            } catch (e) { return this.json({ error: e.message }, 500); }
        }

        // API: Move
        if (request.method === 'POST' && url.pathname === `${CONFIG.ADMIN_ROUTE}/api/move`) {
            try {
                const { oldPath, newPath, sha, fileUrl } = await request.json();
                if (!newPath || newPath === oldPath) throw new Error("Invalid path");
                const fullUrl = fileUrl.startsWith('http') ? fileUrl : new URL(request.url).origin + fileUrl;
                await gh.moveFile(oldPath, newPath, sha, fullUrl);
                return this.json({ success: true });
            } catch (e) { return this.json({ error: e.message }, 500); }
        }

        // API: Delete
        if (request.method === 'POST' && url.pathname === `${CONFIG.ADMIN_ROUTE}/api/delete`) {
            try {
                const { path, sha } = await request.json();
                await gh.deleteFile(path, sha);
                return this.json({ success: true });
            } catch (e) { return this.json({ error: e.message }, 500); }
        }

        // Logout
        if (url.pathname === `${CONFIG.ADMIN_ROUTE}/logout`) {
            return new Response('Logged out', {
                status: 302,
                headers: { 
                    'Location': CONFIG.ADMIN_ROUTE,
                    'Set-Cookie': `${CONFIG.COOKIE_NAME}=; Path=${CONFIG.ADMIN_ROUTE}; Max-Age=0; HttpOnly; SameSite=Strict`
                }
            });
        }

        return new Response(MAIN_HTML, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    static handleLogin(request, env) {
        return request.formData().then(formData => {
            const username = formData.get('username');
            const password = formData.get('password');
            if (username === env.ADMIN_USER && password === env.ADMIN_PASS) {
                const token = btoa(`${username}:${password}`);
                return new Response('Success', {
                    status: 302,
                    headers: {
                        'Set-Cookie': `${CONFIG.COOKIE_NAME}=${token}; Path=${CONFIG.ADMIN_ROUTE}; Max-Age=86400; HttpOnly; SameSite=Strict; Secure`,
                        'Location': CONFIG.ADMIN_ROUTE
                    }
                });
            }
            return new Response(LOGIN_HTML.replace('<!-- ERROR -->', '<p class="text-red-500 text-sm mt-3 bg-red-50 p-2 rounded border border-red-100 text-center">账号或密码错误</p>'), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        });
    }

    static checkCookie(request, env) {
        const cookie = request.headers.get('Cookie');
        if (!cookie) return false;
        const match = cookie.match(new RegExp(`${CONFIG.COOKIE_NAME}=([^;]+)`));
        if (!match) return false;
        try {
            const [u, p] = atob(match[1]).split(':');
            return u === env.ADMIN_USER && p === env.ADMIN_PASS;
        } catch { return false; }
    }

    static json(data, status = 200, extraHeaders = {}) {
        return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
    }
}

// =====================================================================
// Frontend Templates
// =====================================================================

const LOGIN_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>图床登录</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { background: #f8fafc; }</style>
</head>
<body class="flex items-center justify-center min-h-screen">
    <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-sm border border-gray-100">
        <div class="text-center mb-8">
            <div class="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-blue-600 text-white mb-4 shadow-lg shadow-blue-200">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"></path></svg>
            </div>
            <h1 class="text-2xl font-bold text-gray-800 tracking-tight">ImgBed Admin</h1>
        </div>
        <form action="${CONFIG.ADMIN_ROUTE}/login" method="POST" class="space-y-5">
            <div><label class="block text-xs font-semibold text-gray-500 uppercase mb-1 ml-1">Username</label><input type="text" name="username" required class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"></div>
            <div><label class="block text-xs font-semibold text-gray-500 uppercase mb-1 ml-1">Password</label><input type="password" name="password" required class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"></div>
            <!-- ERROR -->
            <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition duration-200 shadow-lg shadow-blue-500/30 transform hover:scale-[1.02]">登 录</button>
        </form>
    </div>
</body>
</html>
`;

const MAIN_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>图床控制台</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        [v-cloak] { display: none; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
        
        /* 侧边栏大间距优化 */
        .nav-item { 
            @apply flex items-center px-4 py-3 rounded-xl cursor-pointer transition-all duration-300 ease-in-out select-none text-gray-400 border border-transparent; 
        }
        .nav-item:hover { 
            @apply bg-gray-800 text-white translate-x-1 shadow-md; 
        }
        .nav-item.active { 
            @apply bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-lg shadow-blue-500/30 font-bold; 
        }
        .nav-item i { width: 24px; text-align: center; margin-right: 12px; font-size: 1.1em; }

        .masonry-columns { column-count: 2; column-gap: 1.5rem; }
        @media (min-width: 768px) { .masonry-columns { column-count: 3; } }
        @media (min-width: 1280px) { .masonry-columns { column-count: 5; } }
        .masonry-item { break-inside: avoid; margin-bottom: 1.5rem; }
        .img-overlay { background: linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 100%); }
    </style>
</head>
<body class="bg-gray-100 h-screen overflow-hidden font-sans text-sm selection:bg-blue-200 text-gray-700">
    <div id="app" class="flex h-full" v-cloak>
        
        <!-- Sidebar -->
        <aside class="w-64 bg-gray-900 flex flex-col shadow-2xl z-20">
            <div class="p-6 flex items-center gap-3 text-white border-b border-gray-800 h-20">
                <div class="w-9 h-9 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/40">
                    <i class="fa-solid fa-cloud text-sm"></i>
                </div>
                <h1 class="text-lg font-bold tracking-wide">ImgBed</h1>
            </div>
            
            <!-- 导航区：增加 space-y-6 实现大间距 -->
            <nav class="flex-1 py-8 px-4 space-y-6 overflow-y-auto">
                <div @click="switchTab('dashboard')" :class="['nav-item', currentTab === 'dashboard' ? 'active' : '']">
                    <i class="fa-solid fa-gauge-high"></i>
                    <span>仪表盘</span>
                </div>
                <div @click="switchTab('explorer')" :class="['nav-item', currentTab === 'explorer' ? 'active' : '']">
                    <i class="fa-solid fa-folder-tree"></i>
                    <span>文件管理</span>
                </div>
                <div @click="switchTab('settings')" :class="['nav-item', currentTab === 'settings' ? 'active' : '']">
                    <i class="fa-solid fa-gear"></i>
                    <span>系统设置</span>
                </div>
            </nav>

            <div class="p-4 border-t border-gray-800">
                 <a href="${CONFIG.ADMIN_ROUTE}/logout" class="flex items-center justify-center w-full py-3 text-red-400 hover:text-white hover:bg-red-500/20 rounded-lg transition duration-200 gap-2 font-medium">
                    <i class="fa-solid fa-right-from-bracket"></i> 退出登录
                 </a>
            </div>
        </aside>

        <!-- Main Content -->
        <main class="flex-1 flex flex-col h-full overflow-hidden bg-gray-50 relative">
            
            <!-- Tab: Dashboard -->
            <div v-show="currentTab === 'dashboard'" class="h-full overflow-y-auto p-6 scroll-smooth">
                <div class="max-w-7xl mx-auto">
                    <div class="mb-8"><h2 class="text-2xl font-bold text-gray-800">概览</h2><p class="text-gray-500 mt-1 text-xs">Library Overview</p></div>

                    <div v-if="dashboardLoading" class="flex flex-col items-center justify-center h-64"><div class="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div><p class="mt-4 text-gray-400">正在同步...</p></div>
                    <div v-else>
                        <!-- Recent -->
                        <div class="mb-4 flex items-center gap-2 border-b pb-2 border-gray-200">
                            <span class="w-1 h-5 bg-blue-500 rounded-full"></span><h3 class="text-lg font-bold text-gray-700">最近上传</h3><span class="text-xs text-gray-400 ml-auto">{{ dashboardData.recent.length }} items</span>
                        </div>
                        <div class="masonry-columns mb-10">
                            <div v-for="(img, idx) in dashboardData.recent" :key="'rec-'+idx" class="masonry-item group relative rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 bg-white cursor-zoom-in" @click="preview(img)">
                                <img :src="img.url" class="w-full h-auto object-cover block" loading="lazy">
                                <div class="absolute inset-0 img-overlay opacity-0 group-hover:opacity-100 transition duration-300 flex flex-col justify-end p-4">
                                    <div class="text-white text-xs truncate opacity-90 mb-2">{{ getFileName(img.path) }}</div>
                                    <button @click.stop="copyLink(img)" class="bg-white/20 hover:bg-white/40 text-white px-3 py-1 rounded text-xs backdrop-blur-sm">复制链接</button>
                                </div>
                            </div>
                        </div>
                        <!-- Random -->
                        <div class="mb-4 flex items-center gap-3 border-b pb-2 border-gray-200">
                            <span class="w-1 h-5 bg-purple-500 rounded-full"></span><h3 class="text-lg font-bold text-gray-700">随机探索</h3>
                            <button @click="loadDashboard" class="text-gray-500 hover:text-purple-600 transition text-xs flex items-center gap-1 bg-white px-2 py-0.5 rounded border border-gray-200 hover:border-purple-300 ml-auto"><i class="fa-solid fa-rotate" :class="{'fa-spin': dashboardLoading}"></i> 换一批</button>
                        </div>
                        <div class="masonry-columns">
                            <div v-for="(img, idx) in dashboardData.random" :key="'rnd-'+idx" class="masonry-item group relative rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 bg-white cursor-zoom-in" @click="preview(img)">
                                <img :src="img.url" class="w-full h-auto object-cover block" loading="lazy">
                                <div class="absolute inset-0 img-overlay opacity-0 group-hover:opacity-100 transition duration-300 flex flex-col justify-end p-4">
                                    <div class="text-white text-xs truncate opacity-90 mb-2">{{ getFileName(img.path) }}</div>
                                    <button @click.stop="copyLink(img)" class="bg-white/20 hover:bg-white/40 text-white px-3 py-1 rounded text-xs backdrop-blur-sm">复制链接</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Tab: Explorer -->
            <div v-show="currentTab === 'explorer'" class="flex flex-col h-full">
                <div class="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between shadow-sm z-10">
                    <div class="flex items-center gap-2 overflow-x-auto no-scrollbar max-w-[70%]">
                        <button @click="goToFolder('')" class="p-2 rounded hover:bg-gray-100 text-gray-600 transition"><i class="fa-solid fa-house"></i></button>
                        <span v-if="breadcrumbs.length" class="text-gray-300">/</span>
                        <template v-for="(crumb, idx) in breadcrumbs" :key="idx">
                            <button @click="goToFolder(crumb.path)" class="px-2 py-1 rounded hover:bg-gray-100 text-gray-700 font-medium text-xs whitespace-nowrap">{{ crumb.name }}</button>
                            <span v-if="idx < breadcrumbs.length - 1" class="text-gray-300">/</span>
                        </template>
                    </div>
                    <div class="flex items-center gap-2">
                         <button @click="batchExport" class="bg-indigo-50 text-indigo-600 hover:bg-indigo-100 px-3 py-1.5 rounded text-xs font-medium transition flex items-center gap-1">
                            <i class="fa-solid fa-file-export"></i> 导出本目录
                        </button>
                        <button @click="refreshFolder" class="text-gray-400 hover:text-blue-600 p-2 transition"><i class="fa-solid fa-rotate-right" :class="{'fa-spin': explorerLoading}"></i></button>
                    </div>
                </div>
                <div class="flex-1 overflow-y-auto p-4 bg-gray-50/50" ref="fileListContainer">
                    <div v-if="explorerLoading" class="h-full flex flex-col items-center justify-center text-gray-400"><i class="fa-solid fa-circle-notch fa-spin text-2xl mb-2 text-blue-500"></i><p class="text-xs">加载中...</p></div>
                    <div v-else-if="currentFiles.length === 0" class="h-full flex flex-col items-center justify-center text-gray-400 opacity-50"><i class="fa-regular fa-folder-open text-4xl mb-2"></i><p>空文件夹</p></div>
                    <div v-else class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 content-start">
                        <div v-for="item in folders" :key="item.path" @click="goToFolder(item.path)" class="group flex flex-col items-center p-3 rounded-xl bg-white border border-gray-100 shadow-sm hover:shadow-md hover:border-blue-200 cursor-pointer transition-all active:scale-95">
                            <i class="fa-solid fa-folder text-3xl text-yellow-400 mb-2 group-hover:text-yellow-500 transition"></i>
                            <span class="text-xs text-gray-600 truncate w-full text-center group-hover:text-blue-600">{{ item.name }}</span>
                        </div>
                        <div v-for="item in files" :key="item.path" @click="preview(item)" class="group relative aspect-square bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden hover:shadow-lg cursor-pointer transition-all">
                            <div class="absolute inset-0 flex items-center justify-center bg-gray-100"><img :src="item.url" loading="lazy" class="w-full h-full object-cover transition duration-500 group-hover:scale-110"></div>
                            <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition flex flex-col items-center justify-center gap-2 p-2">
                                <div class="text-white text-[10px] break-all text-center line-clamp-2">{{ item.name }}</div>
                                <div class="flex gap-2 mt-1">
                                    <button @click.stop="copyLink(item)" class="bg-blue-600 hover:bg-blue-700 text-white p-1.5 rounded-full shadow text-xs transform hover:scale-110 transition"><i class="fa-solid fa-link"></i></button>
                                    <button @click.stop="openMoveModal(item)" class="bg-yellow-500 hover:bg-yellow-600 text-white p-1.5 rounded-full shadow text-xs transform hover:scale-110 transition"><i class="fa-solid fa-pen"></i></button>
                                    <button @click.stop="deleteFile(item)" class="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded-full shadow text-xs transform hover:scale-110 transition"><i class="fa-solid fa-trash"></i></button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Tab: Settings -->
            <div v-show="currentTab === 'settings'" class="h-full overflow-y-auto p-8">
                <h2 class="text-2xl font-bold text-gray-800 mb-6">系统设置</h2>
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 max-w-2xl">
                    <div class="flex items-center justify-between mb-4 pb-4 border-b border-gray-100">
                        <div><div class="font-medium text-gray-700">缓存清理</div><div class="text-xs text-gray-400 mt-1">强制刷新前端本地缓存</div></div>
                        <button @click="clearCache" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-lg text-xs transition"><i class="fa-solid fa-broom mr-1"></i> 清理</button>
                    </div>
                    <div class="flex items-center justify-between"><div><div class="font-medium text-gray-700">关于</div><div class="text-xs text-gray-400 mt-1">版本 7.0.0 (Ultimate)</div></div><a href="https://github.com/51hhh/img_bed" target="_blank" class="text-blue-500 hover:text-blue-600 text-xs">仓库地址</a></div>
                </div>
            </div>

        </main>

        <!-- Preview Modal -->
        <div v-if="previewUrl" class="fixed inset-0 z-50 bg-black/95 flex items-center justify-center overflow-hidden" @click="closePreview" @wheel.prevent="handleZoom">
            <div class="relative w-full h-full flex items-center justify-center">
                 <img :src="previewUrl" class="transition-transform duration-100 cursor-grab active:cursor-grabbing max-w-none origin-center" :style="{ transform: 'scale(' + zoomLevel + ') translate(' + panX + 'px, ' + panY + 'px)' }" @click.stop @mousedown="startDrag">
            </div>
            <div class="absolute bottom-8 left-1/2 transform -translate-x-1/2 flex gap-4 bg-white/10 backdrop-blur rounded-full px-6 py-2 text-white border border-white/20" @click.stop>
                <button @click="zoomLevel = Math.max(0.1, zoomLevel - 0.1)" class="hover:text-blue-400"><i class="fa-solid fa-minus"></i></button>
                <span class="text-xs font-mono w-12 text-center">{{ Math.round(zoomLevel * 100) }}%</span>
                <button @click="zoomLevel = Math.min(5, zoomLevel + 0.1)" class="hover:text-blue-400"><i class="fa-solid fa-plus"></i></button>
                <div class="w-px bg-white/20 mx-1"></div>
                <button @click="resetZoom" class="hover:text-yellow-400 text-xs">重置 (50%)</button>
            </div>
            <button class="absolute top-6 right-6 text-white/60 hover:text-white text-3xl" @click="closePreview">&times;</button>
        </div>

        <!-- Move Modal -->
        <div v-if="moveModal.show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div class="bg-white rounded-xl shadow-2xl w-96 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-4">移动 / 重命名</h3>
                <div class="mb-4">
                    <label class="block text-xs text-gray-500 mb-1">当前路径</label>
                    <input type="text" :value="moveModal.item.path" disabled class="w-full text-xs p-2 bg-gray-100 rounded text-gray-500">
                </div>
                <div class="mb-6">
                    <label class="block text-xs text-gray-500 mb-1">新路径 (含文件名)</label>
                    <input type="text" v-model="moveModal.newPath" class="w-full text-sm p-2 border border-blue-300 rounded focus:ring-2 focus:ring-blue-500 outline-none">
                </div>
                <div class="flex justify-end gap-2">
                    <button @click="moveModal.show = false" class="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded">取消</button>
                    <button @click="doMove" :disabled="moveModal.loading" class="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1">
                        <i v-if="moveModal.loading" class="fa-solid fa-spinner fa-spin"></i> 确认
                    </button>
                </div>
            </div>
        </div>

    </div>

    <script>
        const { createApp, ref, computed, onMounted } = Vue;
        const API_PREFIX = '${CONFIG.ADMIN_ROUTE}/api';

        createApp({
            setup() {
                const currentTab = ref('dashboard');
                
                // Preview State
                const previewUrl = ref(null);
                const zoomLevel = ref(0.5); // Default 50%
                const panX = ref(0); const panY = ref(0);
                let isDragging = false; let startX, startY, initialPanX, initialPanY;

                // Move Modal State
                const moveModal = ref({ show: false, item: null, newPath: '', loading: false });

                // Data
                const dashboardLoading = ref(false);
                const dashboardData = ref({ recent: [], random: [] });
                const currentPath = ref('');
                const explorerLoading = ref(false);
                const currentFiles = ref([]);
                const pathCache = new Map();

                const folders = computed(() => currentFiles.value.filter(i => i.type === 'dir'));
                const files = computed(() => currentFiles.value.filter(i => i.type === 'file'));
                const breadcrumbs = computed(() => currentPath.value ? currentPath.value.split('/').map((name, i, arr) => ({ name, path: arr.slice(0, i+1).join('/') })) : []);

                // --- Methods ---

                const switchTab = (tab) => {
                    currentTab.value = tab;
                    if (tab === 'dashboard' && !dashboardData.value.recent.length) loadDashboard();
                    if (tab === 'explorer' && !currentFiles.value.length && !currentPath.value) goToFolder('');
                };

                const loadDashboard = async () => {
                    dashboardLoading.value = true;
                    try {
                        const res = await fetch(\`\${API_PREFIX}/dashboard\`);
                        if (res.status === 401) return location.reload();
                        dashboardData.value = await res.json();
                    } catch (e) { console.error(e); } finally { dashboardLoading.value = false; }
                };

                const goToFolder = async (path) => {
                    currentPath.value = path;
                    if (pathCache.has(path)) { currentFiles.value = pathCache.get(path); refreshFolder(false); }
                    else { await refreshFolder(true); }
                };

                const refreshFolder = async (showLoading = true) => {
                    if (showLoading) explorerLoading.value = true;
                    try {
                        const res = await fetch(\`\${API_PREFIX}/browse?path=\${encodeURIComponent(currentPath.value)}\`);
                        if (res.status === 401) return location.reload();
                        const data = await res.json();
                        currentFiles.value = Array.isArray(data) ? data : [];
                        pathCache.set(currentPath.value, currentFiles.value);
                    } catch (e) { console.error(e); } finally { if (showLoading) explorerLoading.value = false; }
                };

                // Batch Export Fix: Prepend Domain
                const batchExport = async () => {
                    if(!confirm('确定要遍历导出当前目录下所有图片的链接吗？')) return;
                    try {
                        const res = await fetch(\`\${API_PREFIX}/batch_export?path=\${encodeURIComponent(currentPath.value)}\`);
                        const data = await res.json();
                        if(data.urls && data.urls.length > 0) {
                            // HERE IS THE FIX: Prepend window.location.origin
                            const text = data.urls.map(u => window.location.origin + u).join('\\n');
                            navigator.clipboard.writeText(text).then(() => alert(\`成功复制 \${data.urls.length} 条完整链接！\`));
                        } else {
                            alert('当前目录下没有找到图片。');
                        }
                    } catch(e) { alert('导出失败: ' + e.message); }
                };

                const openMoveModal = (item) => {
                    moveModal.value.item = item; moveModal.value.newPath = item.path; moveModal.value.show = true;
                };
                const doMove = async () => {
                    if(!moveModal.value.newPath || moveModal.value.newPath === moveModal.value.item.path) return;
                    moveModal.value.loading = true;
                    try {
                        const res = await fetch(\`\${API_PREFIX}/move\`, {
                            method: 'POST', body: JSON.stringify({
                                oldPath: moveModal.value.item.path,
                                newPath: moveModal.value.newPath,
                                sha: moveModal.value.item.sha,
                                fileUrl: moveModal.value.item.url
                            })
                        });
                        const data = await res.json();
                        if(data.error) throw new Error(data.error);
                        alert('操作成功'); moveModal.value.show = false; refreshFolder(true);
                    } catch(e) { alert('错误: ' + e.message); }
                    finally { moveModal.value.loading = false; }
                };

                const getFileName = (path) => path.split('/').pop();
                const copyLink = (item) => {
                    navigator.clipboard.writeText(window.location.origin + item.url).then(() => {
                        const btn = event.target.closest('button');
                        const org = btn.innerHTML;
                        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
                        setTimeout(() => btn.innerHTML = org, 1000);
                    });
                };

                const preview = (item) => { previewUrl.value = window.location.origin + item.url; resetZoom(); };
                const closePreview = () => previewUrl.value = null;
                const resetZoom = () => { zoomLevel.value = 0.5; panX.value = 0; panY.value = 0; };
                const handleZoom = (e) => {
                    const delta = e.deltaY > 0 ? -0.1 : 0.1;
                    zoomLevel.value = Math.min(Math.max(0.1, zoomLevel.value + delta), 5);
                };
                const startDrag = (e) => {
                    isDragging = true; startX = e.clientX; startY = e.clientY; initialPanX = panX.value; initialPanY = panY.value;
                    window.addEventListener('mousemove', onDrag); window.addEventListener('mouseup', stopDrag);
                };
                const onDrag = (e) => { if (!isDragging) return; e.preventDefault(); panX.value = initialPanX + (e.clientX - startX); panY.value = initialPanY + (e.clientY - startY); };
                const stopDrag = () => { isDragging = false; window.removeEventListener('mousemove', onDrag); window.removeEventListener('mouseup', stopDrag); };

                const deleteFile = async (item) => {
                    if (!confirm('确认删除?')) return;
                    try {
                        await fetch(\`\${API_PREFIX}/delete\`, { method: 'POST', body: JSON.stringify(item) });
                        currentFiles.value = currentFiles.value.filter(f => f.sha !== item.sha);
                        pathCache.set(currentPath.value, currentFiles.value);
                    } catch(e) { alert('失败'); }
                };
                const clearCache = () => { pathCache.clear(); alert('Local Cache Cleared'); };

                onMounted(() => loadDashboard());

                return {
                    currentTab, switchTab, previewUrl, zoomLevel, panX, panY,
                    dashboardLoading, dashboardData, explorerLoading, currentFiles, folders, files, breadcrumbs,
                    moveModal, openMoveModal, doMove, batchExport,
                    getFileName, loadDashboard, goToFolder, refreshFolder, copyLink, preview, deleteFile, clearCache,
                    closePreview, handleZoom, startDrag, resetZoom
                };
            }
        }).mount('#app');
    </script>
</body>
</html>
`;
