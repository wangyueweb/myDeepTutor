# 📖 MyDeepTutor 个人使用说明

> 本仓库是 [HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor) 的个人部署版本。
> 我在源码基础上做了一些修复和本地化配置，记录在这里方便自己和朋友查阅。

---

## 一、这个项目是什么

DeepTutor 是一个**智能个性化学习助手**（开源），核心能力包括：

| 功能 | 说明 |
|---|---|
| 💬 Chat | 对话式答疑，可挂载知识库（RAG） |
| 📚 Knowledge | 知识库：上传教案/PPT/Word/PDF，AI 基于文档回答 |
| ✍️ Co-Writer | 协同写作：选中段落让 AI 扩写/精简/重写 |
| 📖 Book | 从知识库自动生成互动学习书（含测验/图示） |
| 🤖 Partners | 有"人格"的答疑机器人，可挂知识库 |
| 🧠 Memory | 三层记忆系统 |
| 📝 Notebook / Question Bank | 笔记本与题库 |

---

## 二、本机部署环境

| 组件 | 版本 | 说明 |
|---|---|---|
| macOS | — | Apple Silicon (M系列) |
| Python | 3.11.15 | 项目要求 3.11–3.13 |
| Node.js | 24.x | 源码安装要求 22 LTS+ |
| 安装方式 | 源码安装（`pip install -e .`） | 便于二次开发 |

---

## 三、我配置的服务

| 服务 | 提供商 | 模型 | 用途 |
|---|---|---|---|
| LLM（对话） | DeepSeek | `deepseek-v4-flash` / `deepseek-v4-pro` | AI 对话、写作、出题 |
| Embedding（向量化） | 阿里云 DashScope | `text-embedding-v3` | 知识库检索（RAG） |
| 网页搜索 | DuckDuckGo（内置） | — | 联网搜索 |

> ⚠️ **API Key 都保存在本地** `data/user/settings/model_catalog.json`（已被 .gitignore 忽略，**不会上传到 GitHub**）。更换机器后需要重新配置。

---

## 四、我的学习资料

| 类型 | 名称 | 内容 |
|---|---|---|
| 📚 知识库 | `分数乘法` | 3 份文档（教案 / 教学设计说明 / 课件要点），设为默认库 |
| 📚 知识库 | `初三语文` | 4 份文档 |
| 📚 知识库 | `wangyueweb` | 空（备用） |
| 🤖 伙伴 | 小算老师（`math-tutor`） | 小学数学辅导老师，已挂载"分数乘法"知识库 |
| 📖 互动书 | 《分数乘法魔法书》 | 6 章，含概念讲解、图示、测验 |

---

## 五、常用操作

### 1. 启动 / 停止

```bash
cd ~/www/DeepTutor          # 你的项目目录
source .venv/bin/activate   # 激活虚拟环境（重要！否则找不到 deeptutor 命令）

deeptutor start             # 生产模式启动（后端 8001 + 前端 3782）
deeptutor start --dev       # 开发模式（前端热重载 HMR）
# Ctrl+C 同时停止前后端
```

打开浏览器访问 **http://127.0.0.1:3782**

### 2. 上传教案 / PPT 到知识库

**网页方式**：左侧栏 → Knowledge Center → New knowledge base → 上传文件
**命令行方式**：

```bash
# 新建知识库并上传整个文件夹（教案、PPT、Word 都支持）
deeptutor kb create 我的教案 --docs-dir /path/to/教案文件夹

# 往已有知识库追加文档
deeptutor kb add 我的教案 --docs-dir /path/to/更多文件

# 设为默认库 / 查看 / 搜索
deeptutor kb set-default 我的教案
deeptutor kb list
deeptutor kb search 我的教案 "关键词"
```

### 3. 基于知识库提问 / 出题

```bash
# 聊天（自动用默认知识库）
deeptutor run chat "根据教案生成课堂导入方案" -t rag

# 基于知识库出练习题
deeptutor run deep_question "出3道课堂练习题，含答案" -t rag --kb 我的教案
```

### 4. 使用 Co-Writer 精修文档

打开 http://127.0.0.1:3782/co-writer → 新建/打开草稿 → **选中一段文字** → 在弹出的浮动框中：
- 输入指令（如"结合教案扩写"）
- Tools 勾选 Knowledge Base，选择知识库
- Mode 选 Expand / Shorten / Rewrite
- 点 ➤ 执行，AI 只修改你选中的段落，不满意按 Cmd+Z 撤销

### 5. 创建互动学习书

打开 http://127.0.0.1:3782/book → New book → 输入书名和意图（可挂知识库）→ 确认章节 → 自动编译成互动书。

---

## 六、我做的修改（相对原项目）

| 文件 | 修改内容 |
|---|---|
| `web/app/(workspace)/book/components/blocks/ConceptGraphBlock.tsx` | 修复：概念图章节链接使用 `/book?book=<id>&page=<id>`（原为 `/book/<id>?page=<id>`，点击 404） |
| `web/app/(workspace)/book/page.tsx` | 支持 `page` 查询参数深链接，点击概念图章节直接跳转对应页 |
| `.gitignore` | 忽略本地 `.npm-cache`；将 `web/.next-deeptutor` 构建产物移出版本控制 |

> 原项目文档见 [README.md](./README.md)（英文，官方内容）。
