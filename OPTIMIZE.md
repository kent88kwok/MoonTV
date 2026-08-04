# MoonTV Fork 优化报告 v2（借鉴 LunaTV）

> 部署：Cloudflare Pages（Functions 跑在 Cloudflare Workers 上）
> 存储：Cloudflare D1
> 路线：**就地优化现有 Fork，并借鉴官方继任项目 LunaTV（`MoonTechLab/LunaTV`，9199★）的架构做法**
> 方法：第一性原则分析 + 对抗式审查（已交叉验证）

---

## 1. 第一性原则：慢的真正根因（不变的事实）

Cloudflare Workers 对单请求有三道硬墙（官方文档，2026-08-04 核实）：

| 限制 | Free | Paid | 本项目相关性 |
|---|---|---|---|
| **并发出向连接** | **6 / 请求** | **6 / 请求** | ✅ 决定性瓶颈（两档完全相同） |
| 子请求数 | 50 / 请求 | 10,000 / 请求 | ⚠️ 仅 Free 下会直接报错 |
| CPU 时间 | 10ms | 5min | ❌ 网络等待不计入 |

搜索是**扇出架构**：每次搜索向每个资源站各发请求、每站翻多页。原 Fork 的 `config.json`
有 **20 站**、`SearchDownstreamMaxPage` 默认 **5 页** → 单次最多 **100 个 fetch**。
`Promise.all` 一次性全发 → 只有 6 个在飞，其余 14 个（含活站）全卡在 CF 的 pending
队列；其中 **11 个死/限流站**各占连接槽直到 8s 超时 → 活站被拖 8–16s。这就是"慢"。

> 你报告"慢"而非"报错" → 说明你在 **Paid**（Free 下 50 子请求会直接 500）。所以真正的
> 瓶颈是 **6 连接墙 + 死站 8s 占用**，不是子请求数。

**对抗式审查结论**：probe2（拉各站"最新入库"）显示 20 站全部 2026-08-04 仍在更新 →
**"资源过期"假设不成立**，问题纯在架构/配置。

---

## 2. 借鉴 LunaTV：它到底怎么解决同一道题

我拉取了 LunaTV（154 个文件，比原 Fork 成熟得多）的关键源码，提炼出它对"扇出慢"的
核心打法（见 `_luna/` 下的原始文件）：

| LunaTV 手法 | 作用 | 是否采纳 |
|---|---|---|
| **`search-cache.ts`：按 (源,词,页) 内存缓存，且缓存失败态**（`timeout`/`forbidden`，TTL 10min） | 热查询直接短路；死/被限流站 10 分钟内不再被重锤 | ✅ **核心采纳** |
| **搜索路由 `Promise.allSettled` + 每站 `Promise.race` 20s 兜底 + `.catch(()=>[])`** | 单站失败/超时绝不拖垮或打断整次搜索 | ✅ 采纳（叠加我的 6 连接池） |
| **`runtime='nodejs'`（非 edge）** | 让内存缓存在同实例内更持久、避开 edge 部分约束 | ⚠️ 暂不改（见 §5 风险说明） |
| **`proxy.worker.js`：独立 Worker 反代图片/m3u8** | 把带宽型代理从主 Worker 卸下，独占 6 连接预算 | ➕ 可选（见 §6） |
| **登录鉴权才允许搜索** | 防匿名滥用/刷爆子请求 | ❌ 不改（你这是自用/开放站，不在本次范围） |
| **结果形态加 `episodes_titles`、过滤 `episodes.length===0`** | 数据模型/质量改动，非性能 | ❌ 不改（避免动前端契约） |

**为什么 LunaTV 的缓存是"根因级"修复**：原 Fork（以及我 v1 的补丁）每次搜索都重新扇出；
LunaTV 把"某站某词某页"的结果（**含失败**）记 10 分钟。于是：
- 同一个热门词的重复搜索 → 几乎零延迟（不扇出）。
- 一个站挂了/被 403 → 被记为 `timeout`/`forbidden`，10 分钟内跳过，**不再每请求占用 8 秒连接**。
这正是原 Fork"死站长期拖累"的治本手段——我 v1 只删了死站（治标），v2 用缓存让"任何站临时挂掉"都不再拖慢（治本）。

---

## 3. v2 交付的补丁（本目录）

| 文件 | 改动 | 作用 |
|---|---|---|
| `config.json` | 站点 20 → **30 活站**（删 11 死站 + 参考 qist/tvbox 扩 12 新站 §8 + 参考 TVAPP 扩 9 新站 §9） | 消灭稳定死站的 8s 占用 + 大幅扩大片源覆盖 |
| `src/lib/search-cache.ts` | **新增**，逐字移植 LunaTV 的按源缓存（含失败态、10min TTL、LRU 清理） | 热查询短路 + 死站负缓存 |
| `src/lib/downstream.ts` | `searchFromApi` 改为走 `searchWithCache`（403→forbidden、超时→timeout 均写入缓存）；单站超时 5s；**单站翻页硬上限 2 页** | 30×2=60 子请求（**仅 Paid 安全**；Free 下需设 `NEXT_PUBLIC_SEARCH_MAX_PAGE=1` → 30）；失败不再重锤 |
| `src/app/api/search/route.ts` | **6 路并发池** + 每站 `Promise.race` 20s 兜底 + `.catch(()=>[])` | 不超 6 连接墙；单站失败绝不拖垮整体 |
| `src/app/api/douban/categories/route.ts` | 豆瓣超时 10s → **6s**（v1 已含） | 首页冷缓存更快兜底 |
| `proxy.worker.js` | **可选**：独立反代 Worker（移植 LunaTV） | 卸下图片/m3u8 代理，救首页海报加载慢 |

### 优化前后（搜索耗时）

| 指标 | 原 Fork | 本 v2（冷查询首跳） | 本 v2（热查询/10min 内复搜） |
|---|---|---|---|
| 参与站点 | 20（11 死） | 30（全活） | 30（全活，但走缓存） |
| 单次子请求 | ≤100 | ≤60* | **0（短路）** |
| 在飞连接 | 撞 6 上限+14 排队 | ≤6，无排队 | 0 |
| 死站最坏占用 | 8s×11 | 5s×0（已删且被缓存） | 0 |
| 预计耗时 | 8–16s | **~1–2s** | **毫秒级** |

> \* 30 站 × 2 页 = 60 子请求，**超过 Free 的 50 子请求上限** → Free 计划下必须把
> `NEXT_PUBLIC_SEARCH_MAX_PAGE` 设为 `1`（30×1=30<50，安全），或升级 Workers Paid
> （10,000/请求）。6 连接墙两档相同，已由 6 路并发池处理。若你就是 Paid（见 §1 推断），
> 则 2 页 60 子请求完全没问题。

---

## 4. 落地步骤

1. 覆盖 `config.json` 到仓库根。
2. 新增 `src/lib/search-cache.ts`；覆盖 `src/lib/downstream.ts` 与
   `src/app/api/search/route.ts`；覆盖 `src/app/api/douban/categories/route.ts`。
3. （推荐）CF Pages 环境变量加 `NEXT_PUBLIC_SEARCH_MAX_PAGE=2`（与代码硬上限一致，双保险）。
4. 提交推送，CF Pages 自动重建部署。
5. 验证：搜一个词约 1–2s；**立刻再搜同一词应快到毫秒级**（缓存生效）；部署后预热一次
   3 个豆瓣 URL 让首页也秒开。

> 不要在 Free 下把翻页调回 5：那会重新逼近 50 子请求墙。想扩站点/翻页 → 升 Workers Paid
> （$5/月，子请求 50→10,000；6 连接墙仍在，但缓存已让热路径几乎不扇出）。

---

## 5. 对抗式自检：v2 还有哪些没解决 / 风险

- **内存缓存在 CF edge 非全局**：`search-cache.ts` 用的是进程内 `Map`，只在**同一 isolate
  实例**内热。CF 会回收 isolate，跨边缘节点不共享 → 冷启动的第一个请求仍会扇出。对个人
  站（流量集中、isolate 复用率高）收益已很大；若要"全边缘命中"，下一步是把缓存后端换成
  **D1（你已有）或 KV**（见 §7）。LunaTV 本身也用内存缓存，说明这是被验证可用的取舍。
- **未改 `runtime='nodejs'`**：LunaTV 用它来让缓存更持久 + 避开 edge 约束。但 CF Pages +
  `next-on-pages` 下切换 runtime 有部署风险，且内存缓存在 edge 也能用（per-isolate）。
  若你愿意冒一点部署验证成本，可把 `search/route.ts` 与 `downstream.ts` 的
  `export const runtime = 'edge'` 改为 `'nodejs'`——这能提升缓存命中率。**可选，非必须。**
- **`proxy.worker.js` 未接前端**：它只是个独立 Worker 模板，需要你另建一个 Worker 并把
  图片/m3u8 代理地址指向它（见文件内注释）。属"锦上添花"，不影响搜索速度。

---

## 6. 可选增强：独立反代 Worker（救"打开慢"里的海报加载）

首页"打开慢"有一部分是**海报图从第三方站经 image-proxy 加载**，与主搜索抢 6 连接。
LunaTV 的做法是单独跑一个 `proxy.worker.js`，把这类代理流量隔离出去。本目录已附
`proxy.worker.js`（含部署注释），按需启用。

---

## 7. 下一步可选演进

- **缓存后端持久化**：把 `search-cache.ts` 的 `Map` 换成 D1（`kvrocks`/`upstash` 亦可），
  实现跨 isolate/跨边缘的全局命中，冷启动也秒回。
- **迁移到 LunaTV**：若你更想要"少维护 + 架构更优"，可直接 fork `MoonTechLab/LunaTV`
  （2026-05 仍在发版 v100.1.3）。本 v2 的思路（精简死站 + 按源缓存 + 6 连接池）在
  LunaTV 上同样成立，可作为你评估迁移与否的对照基线。

---

## 8. 源列表刷新（参考 qist/tvbox，2026-08-04）

用户要求「参考 `qist/tvbox` 更新 Fork 的源」。按第一性原则 + 对抗式审查执行，结论如下。

### 8.1 第一性：qist/tvbox 不能直接照搬

`qist/tvbox`（10.7k★，1087 文件）是一个 **TVBox 配置仓库**，里面绝大多数源是：
- TVBox spider 自定义源、IPTV 直播（`.m3u`）、网盘分享（115/夸克/阿里）、哔哩/课堂等
  ——这些**与 MoonTV 完全不兼容**。MoonTV 只会调 appleCMS 的 `provide/vod` 接口
  （见 `downstream.ts`：`apiBaseUrl + '?ac=videolist&wd=' + query`）。

所以「参考」≠「复制」。正确做法是：**只抽取其中 appleCMS `provide/vod` 格式的端点**，
其余格式一律丢弃——否则写进 config 也是 404/空结果。

### 8.2 方法（可复现，见 `_tvbox_scan.py` / `_tvbox_probe.py`）

1. GitHub API 取 `master` 全树（1087 文件），用 `raw.githubusercontent` **逐 .json 下载**
   （规避本机大 tarball 被截断的老问题）。
2. 正则抽取所有 `.../api.php/provide/vod...` 端点 → 77 个候选。
3. **归一化**：去掉 TVBox 专属后缀（`/?ac=list`、`/at/xml`、`/at/json`、`/from/xxxm3u8`），
   只留 `https://host/api.php/provide/vod` 基址 → 去重到 **69 个唯一端点**。
4. **对抗式实测**：对每个端点发 MoonTV 真实格式的搜索请求
   `?ac=videolist&wd=流浪地球`（失败再试 `庆余年`），检查返回是否为合法 vod JSON 且
   `list` 非空。**不是看"最新更新"就当活**（上次 probe2 已证明该指标会骗人），而是
   必须真能搜出结果。

### 8.3 结果

| 实测分类 | 数量 | 说明 |
|---|---|---|
| **OK（真实可搜）** | **23** | 返回合法 vod 结果 → 纳入 |
| EMPTY / NOLIST | 若干 | 接口在但搜不到 → 弃 |
| HTTP 403/502 | 若干 | 禁搜索/网关错 → 弃 |
| BADJSON | 若干 | 反爬 HTML → 弃 |
| NETERR | 46 | 本机网络不可达，**无法判定 CF 边缘是否可达** → 稳妥起见不纳入（见 §8.5） |

关键发现：**原 9 站全部仍在 OK 列表**（ffzy5/ruyi/dyttzy/jisu/zy360/lzi/bfzy/zuid/mdzy），
说明这次不是「替换」而是「扩充」。最终去重为 **21 站**（9 原站 + 12 新站，均来自 qist/tvbox）。

新增的 12 站（已实测可搜）：

| key | 名称 | 端点 |
|---|---|---|
| ffzy2 | 非凡影视(采集) | http://cj.ffzyapi.com/api.php/provide/vod |
| bdzy | 百度资源 | https://api.apibdzy.com/api.php/provide/vod |
| s11bat | 11bat资源 | http://api.11bat.com/api.php/provide/vod |
| ddapi | DD资源 | https://api.ddapi.cc/api.php/provide/vod |
| fhzy | 凤凰资源 | http://fhapi9.com/api.php/provide/vod |
| m155 | 155资源 | https://155api.com/api.php/provide/vod |
| lsbzy | 绿色资源 | https://apilsbzy1.com/api.php/provide/vod |
| hhzy | HH资源 | https://hhzyapi.com/api.php/provide/vod |
| p2100 | P2100资源 | https://p2100.net/api.php/provide/vod |
| subo | 速播资源 | https://subocaiji.com/api.php/provide/vod |
| lbzy | 蓝光资源 | https://lbapi9.com/api.php/provide/vod |
| hongniu | 红牛资源 | https://www.hongniuzy2.com/api.php/provide/vod |

完整 21 站见 `config.json`；另附 `sources_import.json`（扁平数组，便于导入后台/D1）。

### 8.4 子请求预算仍是安全的

21 站 × 2 页（v2 硬上限）= **42 子请求 < Free 的 50 上限**；Paid 更宽裕。
配合 v2 的「按源负缓存」，死站/临时挂掉的站 10 分钟内不再被重锤，稳定态实际扇出远小于 42。

### 8.5 ⚠️ 关键坑：你用 D1 存配置，只改 config.json 可能「不生效」

你之前确认存储是 **Cloudflare D1**。MoonTV/LunaTV 的加载顺序是：**D1 里有 config 行就用 D1，
否则才 fallback 到仓库 `config.json`**。如果你的站点已经在 D1 里（通过后台管理 UI 加过），
那直接覆盖仓库 `config.json` 不会改到线上行为——线上读的是 D1 那份旧 9 站/旧 20 站。

**正确落地（二选一 / 都做）：**
1. **仍用仓库 config.json 作唯一源**：清空 D1 里的 config 行（或把读取逻辑指向文件），
   然后照 §4 覆盖 `config.json` 即可。
2. **用 D1/后台管理作唯一源**（推荐，因为你已在用）：把 `sources_import.json` 的 21 条
   逐条同步进后台「资源管理」或 D1 表（删掉旧死站、补上 12 新站）。
   `sources_import.json` 就是为此准备的扁平结构，可直接映射成添加接口/SQL 的参数。

> 一句话：先看线上读的是 D1 还是文件，再决定改哪边。**两边保持一致**才不会白忙。

### 8.6 想更激进扩源（可选，风险自负）

`_tvbox_probe_result.txt` 里 46 个 NETERR 端点**本机连不上**，但 Cloudflare 边缘节点的
出口 IP 与我家不同，其中一部分在 CF 上**可能可达**。若你想最大化片源覆盖，可从中挑几个
加进 config 试跑；即便不通，v2 的负缓存也会在首次超时后自动跳过，不会拖慢稳态。
但首次搜索会为这些站各付一次超时（被 6 连接池分摊），属可接受成本。

---

## 9. 源列表再次刷新（参考 youhunwl/TVAPP，2026-08-04）

用户要求「参考 `youhunwl/TVAPP` 更新 Fork 的源」。继续用第一性原则 + 对抗式审查执行。

### 9.1 第一性：TVAPP 不是"源仓库"，是"APK 仓库 + 配置源索引"

`youhunwl/TVAPP`（20.7k★，**~33GB**）本体是 **Android TV 盒子 APK 合集**（影视壳/直播/工具
的 apk 安装包）。它的描述里写的「TVBox/影视仓等影音壳接口配置源」**不是文件，而是 README 里
罗列的一批外部配置源 URL**（指向 `maoystv/6`、`guot55/YGBH` 等仓库的 `*.json`）。

所以这次「参考」的路径是：**抓 README 里的配置源 URL → 下载这些 JSON → 解析其中 `sites` 数组
→ 抽 appleCMS `provide/vod` 端点**（与 §8 同一接口）。仓库本身不托管任何 `provide/vod`，不能直接拷。

> 对抗式提醒：33GB 里绝大多数是 apk 二进制，**全量递归 tree 不可取**——我只拉了根 `README.md`
> （24KB）和 `TVBox/README.md`（超时未取到，但不影响，根 README 已含全部配置源链接）。

### 9.2 方法（可复现，见 `_tvapp_extract.py` / `_tvapp_probe.py`）

1. 解析根 `README.md`，抽出所有配置源 URL → 25 个候选（多为 `raw.githubusercontent` 的 tvbox
   JSON，也有 gitee/cnb/kstore 等）。
2. 并发下载这些 JSON，解析 `sites` 数组，正则抽取 `.../api.php/provide/vod...` 端点 →
   **83 个候选**（主要来自 `maoystv/6/main/000.json` 的 27 条；其余多为 `.m3u` 直播或下载失败）。
3. **归一化**（去 TVBox 专属后缀、`?ac=list`、`/at/xml`、双斜杠）→ 去重到 **82 个唯一端点**。
4. **对抗式实测**：对每个端点发 MoonTV 真实格式搜索 `?ac=videolist&wd=流浪地球`
   （失败再试 `庆余年`/`狂飙`），只收 `list` 非空的 → **23 个真实可搜**。
5. 与现有 21 站比对：23 个里 **14 个是现有站（交叉印证仍活）**，**9 个是全新可用源**。

### 9.3 本轮新增的 9 站（已实测可搜）

| key | 名称 | 端点 |
|---|---|---|
| co4k_ip | CO4K资源 | http://8.134.205.252:39466/pz/co4k.php/api.php/provide/vod |
| mini69 | 69mini资源 | http://qp.69mini.com/api.php/provide/vod |
| xmomoz | 小蘑菇资源 | http://zy.xiaomaomi.cc/api.php/provide/vod |
| guangs | 光速资源 | https://api.guangsuapi.com/api.php/provide/vod |
| maoyan | 猫眼资源 | https://api.maoyanapi.top/api.php/provide/vod |
| uku88 | UKU资源 | https://api.ukuapi88.com/api.php/provide/vod |
| jusj | 聚速资源 | https://cj.jusj.top/api.php/provide/vod |
| iqiyizy | 爱奇艺采集 | https://iqiyizyapi.com/api.php/provide/vod |
| huya | 虎牙资源 | https://www.huyaapi.com/api.php/provide/vod |

> 注：`co4k_ip` 是裸 IP:端口 + 非标准路径，能用但略野，介意可删。其余 8 个是正常域名。

### 9.4 合并结果

现有 21 站（§8 验证过）+ 本轮 9 站 = **30 站**，写入 `config.json`，且 `sources_import.json`
同步更新为 30 条。JSON 已校验：30 条、api 全唯一、无重复。

### 9.5 ⚠️ 预算变化：30 站让 2 页模式在 Free 下超支

- 30 站 × 2 页 = **60 子请求 > Free 的 50 上限** → **Free 计划下冷搜索会直接 500 报错**。
- 30 站 × 1 页 = **30 子请求 < 50** → Free 安全。
- Paid（10,000/请求）下 60 完全没问题（结合 §1「你报告慢非报错→大概率 Paid」的推断）。

**落地必读（两选一，配合 §4/§8.5）：**
- **Free 计划**：把 `NEXT_PUBLIC_SEARCH_MAX_PAGE` 设为 `1`（宽度优先、每站 1 页，30 子请求安全）。
  或直接把 `config.json` 站点数砍到 ≤24（24×2=48<50）。
- **Paid 计划**：保持 2 页（60 子请求）即可，片源更深。
- 无论哪种，v2 的「按源负缓存」让你的热词复搜几乎不扇出，稳态远低于上面的峰值。

### 9.6 仍适用的老坑（别忘）

- **D1 覆盖**：线上若读 D1 而非仓库 `config.json`，只改文件不生效（详见 §8.5）。30 站要同步进 D1 /
  后台，或用 `sources_import.json`（已含 30 条）导入。
- **NETERR 不可判死**：本轮 23 个 OK 之外的 60 个里有大量 NETERR（本机不可达），CF 边缘可能可达，
  可后续按需试加，v2 负缓存会自动跳过不通的。

### 9.7 三轮汇总（源规模演进）

| 轮次 | 来源 | 站数 |
|---|---|---|
| 原 Fork | 自带 | 20（11 死） |
| v1 | 删死站 | 9 |
| §8 | + qist/tvbox 实测可用 | 21 |
| §9（本轮） | + TVAPP 实测可用 | **30** |

