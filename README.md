# ImgBed Admin Ultimate (Cloudflare Worker)

[![Cloudflare Workers](https://img.shields.io/badge/Deployed%20on-Cloudflare%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Version](https://img.shields.io/badge/Version-7.0.0-green)

这是一个基于 **Cloudflare Workers** 的高性能 GitHub 图床管理系统。它不仅提供了 GitHub Raw 文件的 CDN 加速代理，还内置了一个功能强大的 **Web 管理后台**。

无需服务器，零成本部署，拥有现代化的 UI 设计、极速的文件浏览体验以及完善的安全保护。

---

## ✨ 核心特性

*   **⚡️ 极速访问**：利用 Cloudflare 全球边缘网络加速 GitHub 图片访问。
*   **🛡️ 安全防护**：
    *   内置 **登录验证** 系统（Cookie 保持会话）。
    *   支持 **地区屏蔽**（默认屏蔽 KP, SY 等）和 IP 黑名单。
*   **🎨 现代化仪表盘**：
    *   **瀑布流布局**：美观展示最近上传和随机图片。
    *   **智能缓存**：利用 Cache API 缓存目录结构，毫秒级加载。
*   **📂 全功能文件管理**：
    *   **资源管理器**：层级浏览文件夹，支持面包屑导航。
    *   **文件操作**：支持 **重命名**、**移动**（修改路径）、**删除**图片。
    *   **批量导出**：一键生成当前目录下所有图片的完整 URL 链接。
*   **🔍 增强预览体验**：
    *   大图预览支持 **滚轮缩放**、**拖拽平移**。
    *   默认 50% 缩放比例，适合浏览高清大图。
*   **💻 优化的 UI/UX**：
    *   深色高对比度侧边栏，清晰的按钮间距。
    *   操作反馈（Toast 提示、加载动画）。

---

## 🚀 部署指南

### 1. 准备工作
*   拥有一个 Cloudflare 账号。
*   拥有一个 GitHub 账号，并创建一个用于存放图片的仓库（例如 `img_bed`）。
*   生成一个 GitHub Personal Access Token (PAT)：
    *   访问 [GitHub Settings > Tokens](https://github.com/settings/tokens).
    *   生成新 Token (Classic)，勾选 **`repo`** 权限。

### 2. 创建 Worker
1.  登录 Cloudflare Dashboard。
2.  进入 **Workers & Pages** -> **Create Application** -> **Create Worker**。
3.  命名您的 Worker（例如 `img-admin`），点击 **Deploy**。

### 3. 部署代码
1.  点击 **Edit code**。
2.  将提供的 `worker.js` (v7.0) 代码完全覆盖编辑器中的内容。
3.  点击 **Save and deploy**。

### 4. 配置环境变量 (关键步骤)
为了安全起见，不要将敏感信息写在代码里。请在 Worker 的 **Settings** -> **Variables** 中添加以下环境变量：

| 变量名 | 示例值 | 说明 |
| :--- | :--- | :--- |
| `GH_TOKEN` | `ghp_xxxxxxxx...` | 您的 GitHub Personal Access Token (必须) |
| `GH_REPO` | `yourname/repo` | 仓库路径，如 `51hhh/img_bed` (必须) |
| `ADMIN_USER` | `admin` | 后台登录用户名 (必须) |
| `ADMIN_PASS` | `password123` | 后台登录密码 (必须) |

### 5. 访问后台
*   访问 `https://您的Worker域名.workers.dev/admin`。
*   输入您设置的账号密码即可登录。

---

## ⚙️ 代码配置 (Config)

代码顶部的 `CONFIG` 常量可以根据需要微调：

```javascript
const CONFIG = {
    // 代理访问前缀 (对应 GitHub 目录结构)
    PROXY_PREFIX: '/51hhh/img_bed/main', 
    
    // 管理后台路径
    ADMIN_ROUTE: '/admin',
    
    // 缓存时间 (秒)
    CACHE_TTL_DASHBOARD: 300, // 仪表盘缓存 5 分钟
    CACHE_TTL_FOLDER: 60,     // 文件夹缓存 1 分钟
    
    // 屏蔽的地区代码 (ISO 3166-1 alpha-2)
    BLOCKED_REGIONS: ['KP', 'SY', 'PK', 'CU'],
    
    // 屏蔽的 IP
    BLOCKED_IPS: ['0.0.0.0', '127.0.0.1'],
};
```

---

## 📖 使用说明

### 仪表盘 (Dashboard)
*   进入首页会自动加载最近上传的 20 张图片和随机推荐的图片。
*   点击图片可全屏预览，支持缩放。
*   点击卡片上的 "复制链接" 可快速获取图片 URL。

### 文件管理 (Explorer)
*   **浏览**：点击文件夹图标进入子目录。
*   **移动/重命名**：点击图片上的黄色 **笔形图标**。
    *   修改文件名 = 重命名。
    *   修改路径前缀 = 移动文件到新文件夹。
*   **批量导出**：点击顶部的 **"导出本目录"** 按钮，系统会递归获取当前目录下所有图片的完整链接并复制到剪贴板。

### 系统设置 (Settings)
*   **清理缓存**：如果您通过其他方式（如 Git）直接提交了图片，后台可能因为缓存没有立即显示。点击 "清理" 按钮强制刷新前端缓存。

---

## 🛠️ 常见问题

**Q: 为什么图片移动/重命名比较慢？**
A: GitHub API 不直接支持移动操作。程序实际执行的是 "复制新文件 -> 删除旧文件" 的过程，这需要两次 API 调用。

**Q: 为什么导出链接需要一点时间？**
A: 批量导出利用了 Worker 的缓存树。如果缓存过期，Worker 需要重新从 GitHub 拉取完整的文件树（Recursive Tree），这取决于您的仓库文件数量。

**Q: 如何修改缩放比例？**
A: 默认打开图片为 50% 缩放。您可以在预览界面的底部控制栏点击 "+" 或 "-" 调整，或使用鼠标滚轮。

---

## 📝 License

MIT License. 您可以自由修改和分发此代码。
