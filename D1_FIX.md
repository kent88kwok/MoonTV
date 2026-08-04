# D1 配置对齐 —— 修正版说明

## 0. 先纠正一个关键事实
之前几轮我说"D1 覆盖 config.json，只改 config.json 线上不生效"——
**不准确**，已通过读源码纠正。

实际行为（`src/lib/config.ts` 的 `getConfig`，存储=DB 时）：
- 每次请求读取 D1 的 `admin_config(id=1)` 行；
- 然后把**仓库编译进代码的 `config.json` 合并进去**：
  - 同名 key → config.json 的 `name/api/detail` 覆盖 D1；
  - config.json 里的新 key → 直接追加；
  - D1 里、但不在 config.json 的 key → 保留为 `from:'custom'`。
- 所以**新增/修改的源，部署后就会生效**。你担心的"改了白改"在"加源"动作上不成立。

## 1. D1 真正会"压过"config.json 的两种情况
1. **disabled 开关**：合并逻辑**不碰 `disabled` 字段**。若你曾在后台禁用某源
   （D1 里 `disabled:true`），config.json 没法把它重新启用。
2. **后台独有的 custom 源**：你在后台手动加的、不在 config.json 里的源，会一直残留。

→ 只有想"**彻底以 config.json 为准**、清掉后台残留 / 重新启用被禁源"时，才需要动 D1。

## 2. 最省事解法（不需要给我任何密钥）
你的 Fork 自带 `GET /api/admin/reset` 接口（`src/app/api/admin/reset/route.ts`），
它调用 `resetConfig()`：**用 config.json 完全重建 D1 那一行**（30 源、全部 enabled、
清掉 custom 残留），并保留已有用户。

步骤：
1. 把 `moontv-optimize/config.json`（30 源）+ 三个 `.ts` 补丁 + `search-cache.ts`
   推上仓库，CF Pages 自动重建部署（构建会把新 config.json 编译进 `runtime`）。
2. 以**站长身份**登录后台（登录名须等于部署环境变量 `USERNAME`）。
3. 浏览器访问（或后台"重置配置"按钮）：
   `https://<你的域名>/api/admin/reset`
   返回 `{"ok":true}` 即成功。
4. 之后线上源 = config.json 的 30 源，干净无残留。

⚠️ reset 只认站长：`username === process.env.USERNAME`。若 `USERNAME` 没设成你的
登录名，会返回 401。请在 CF 项目环境变量里把 `USERNAME` 设为你的后台登录名。

## 3. 想走 CLI（npx wrangler）也行
先去 CF 控制台 → D1 → 找到绑定到这个 Pages 项目的数据库名
（代码里绑定名是 `DB`，但 wrangler 命令要用**数据库名**）。

```bash
# 删除 admin_config 第 1 行；下次请求自动从 config.json 重建（等价于 reset）
npx wrangler d1 execute <DB_NAME> --remote \
  --command "DELETE FROM admin_config WHERE id = 1;"

# 或直接写死 30 源（把 config.json 转成 AdminConfig 形状后）
npx wrangler d1 execute <DB_NAME> --remote \
  --command "INSERT OR REPLACE INTO admin_config (id, config) VALUES (1, '<JSON字符串>');"
```

表结构：`admin_config(id INTEGER PRIMARY KEY, config TEXT)`，D1 实现见 `src/lib/d1.db.ts`。

## 4. 如果你坚持让我代劳
我需要（但**不建议把 token 粘进聊天**，有泄露风险）：
- Cloudflare **Account ID**
- **D1 数据库名称/ID**
- 一个**最小权限** API Token（仅 D1 编辑权限）

更安全的做法是你本地跑上面的 wrangler 命令，或点后台"重置配置"。

## 5. 与 CF 子请求预算的关系
30 源 × 2 页 = 60 > Free 的 50 子请求上限。仍建议：
- **Free 计划**：设 `NEXT_PUBLIC_SEARCH_MAX_PAGE=1`（30×1=30，安全）；
- **或升 Workers Paid**（你"慢而不报错"的现象提示大概率已是 Paid，2 页可用）。

无论哪种，v2 的「按源负缓存」让热词复搜几乎不扇出，稳态远低于峰值。
