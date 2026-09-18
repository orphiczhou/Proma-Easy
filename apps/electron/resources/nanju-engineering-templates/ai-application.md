# AI 应用 · 工程模板 v2

> 版本：v2.0 | 代号：`ai-application` | 适用模式：快消型 & 长期迭代型
> 证据等级：**[实证]** / **[文证]** / **[推断]**。
> 与 v1 关系：v1（全文见本文件附录 A）的 Vercel AI SDK 选型、prompt 管理、RAG 管线、护栏、token 计费、eval 模式、反模式表**保留沿用**（六品类中工程质量较高的部分）；本文新增 v2 章节，并吸收昨晚实测的云端 API 对接教训。

---

## 0. 品类判定

### 0.1 判定特征（≥3 条命中）
- [ ] 产品核心逻辑是 LLM/embedding API 调用（对话、生成、RAG、Agent）
- [ ] 移除 LLM 调用后产品不成立
- [ ] 用户说："AI 助手 / 智能客服 / 文档问答 / AI 写作"

### 0.2 反例与边界
| 表述 | 分流 |
|------|------|
| "网站带个 AI 小功能" | → `web-fullstack`（AI 作扩展） |
| "语音输入/ASR 硬件类工具" | → `desktop-app`（其 §2.4 有已验证 ASR 对接卡片，可直接引用） |
| "自己训练/微调模型" | 超出六品类范围（远期扩展） |

### 0.3 子形态
| 路径 | 适用 |
|------|------|
| 快速验证路径 | mock LLM（录制回放/固定响应）先打通驱动与断言链路 [推断] |
| 正式交付路径 | v1：Vercel AI SDK + Next.js + pgvector [文证] |

## 1. 技术栈矩阵
v1 §1 全表保留。[文证] 快速验证路径补：provider 用 OpenAI 兼容 mock server（或 DashScope 兼容模式），应用层不改代码切换。[推断待验证]

## 2. 组件环境清单

### 2.1 总览
| 组件 | 用途 | 必装性 |
|------|------|--------|
| Node.js 22 + pnpm | 运行时 | 必须 |
| API key 注入（env） | LLM 调用鉴权 | 联调类必须 |
| pgvector / LibSQL | 向量存储 | RAG 类按需 |
| 网络出口 | 云 API 可达 | 联调类必须 |

### 2.2 组件卡片
**C1 API key 管理**
- 探测：`test -n "$<PROVIDER>_API_KEY" && echo ok`
- 已知坑：key 写进代码/提交进 git 是最高频事故；驱动脚本从 env 读取并在输出中脱敏 [推断]（规范）。
- 降级替代：mock provider（录制回放），证据文件标注 `mock: true` [推断]

**C2 云端模型端点（以 DashScope 为参照）**
- **本品类与 desktop-app.md §2.4 共享同一坑**：模型名/端点/格式必须先一条 curl 验证再进架构；`fun-asr` 名不存在于 multimodal-generation 端点、正确模型 `qwen3-asr-flash`、音频走 base64 data URI——三者已实证 [实证，2026-09-17]，详见 `desktop-app.md` §2.4/§7.3 PIT-DA-008/009。
- 规则：**每个新端点/新模型，接入前 5 分钟 curl Spike，把已验证值写进本节卡片**。[推断——由教训泛化的流程规则]

**C3 pgvector**
- 探测：`psql -c "CREATE EXTENSION IF NOT EXISTS vector;"`
- 安装：postgres:16 + pgvector 镜像（`pgvector/pgvector:pg16`）[文证：pgvector 官方]
- 已知坑：普通 postgres 镜像无该扩展，CREATE EXTENSION 报错 [推断]
- 降级替代：LibSQL/Turso 或内存向量（小规模）[文证：v1 §1]

### 2.3 环境一键探测：同 desktop-app.md §2.3 骨架 + key 存在性 + 端点连通（HEAD 请求）。

### 2.4 外部服务环境
见 C2。每个 provider 卡片必须含：端点/模型名/鉴权/请求形态/常见错误四态（401/404 模型不存在/429/超时）——**错误四态要进驱动断言**。[推断]

## 3. 目录结构
v1 §2 保留。[文证] 增补 `drivers/`、`evidence/`、`00_SPIKES/`、`eval/ground-truth/`（评测集随库管理）。

## 4. 核心配置
v1 §3（prompt 管理规则、streamText 样例）保留。[文证]

## 5. 测试闭环样例

### 5.1 闭环定义
AI 应用的证据链：**驱动输入（prompt/音频/文档）→ 真实或 mock 响应 → 结构化证据（原始响应+指标）**。LLM 非确定性输出不得做同串断言（区别于其他品类）。

### 5.2 标准闭环：RAG 检索准确性（对 LLM 输出用指标，对检索用同串）[文证（v1 §4 eval 模式）+推断（串跑）]

```typescript
// tests/eval/rag.eval.ts
const CASES = [
  { q: "退货政策是什么？", expectContains: ["30天", "免费"] },   // 关键事实同串包含
];
for (const c of CASES) {
  const { chunks, answer } = await ragPipeline(c.q);
  // 检索层：命中 chunk 的文档 ID 可同串断言（确定性）
  // 生成层：关键词包含 + 语义相似度阈值（非同串）
  evidence.push({ q: c.q, hitDocIds: chunks.map(x => x.docId),
                  answerLen: answer.length, pass: /* 判定 */ });
}
writeFileSync("evidence/rag_eval.json", JSON.stringify({ ts: Date.now(), evidence }));
```

### 5.3 驱动断言规范（本品类特化）
- 分层断言：**确定性层（检索命中/格式合规/错误码）用严格同串；生成层用指标阈值**（关键词覆盖、相似度 ≥ 阈值）[推断]
- 证据落盘：原始响应全文必须存 evidence（含 model 名、请求 id、ts），不可只存指标 [推断]
- 崩溃隔离：超时/429/断网要产出结构化错误证据并区分错误四态 [推断；错误分类的重要性已实证——见 PIT-DA-008 教训]

### 5.4 降级验证（无 key/断网）
录制回放：首次真实调用把响应存 `evidence/fixtures/`；后续驱动读 fixture 并标注 `mock: true`。[推断待验证]

驱动骨架：`driver-skeleton.py` / `driver-skeleton.cjs`（随模版分发，含五项运行时自检：storyId 校验 / expected-actual 同源 / 输出 schema+退出码表 / 顶层异常包裹 / 环境前置自检）。

### 5.5 标杆测试闭环（本机可跑，B2 实证提炼）

> 来源：平台知识库《标杆解析-v1/测试闭环汇总》§2.7（2026-09-18，vercel/ai contributing/testing.md 全文实证）。[文证：标杆实证]，本品类模板未串跑。与 §5.4 的关系：§5.4"录制回放"是 [推断待验证] 概念条目；本节给出标杆实证的双命令机制——首个项目落地后可把 §5.4 升级为 [实证]。

**① 工具链与命令** [文证：标杆实证]

```json
// vercel/ai 形态：test / test:update 双命令显式分离
{
  "test": "vitest run",              // 读 __fixtures__/ 回放，CI 零 API key
  "test:update": "vitest run -u"     // 显式录制通道：本地一次性真 key 刷新 fixture
}
```
- `__fixtures__/` 存真实响应原文（JSONL / SSE 格式按 provider 适配），fixtures 进 git——CI 与本机跑同一份证据。
- 流式行为：mock server 按 chunk 序列回放 SSE，断言逐 chunk 结构而非只断最终聚合文本。
- 结构化输出：zod schema 断言，确定性层严格校验（同 §5.3 分层断言）。
- UI 对话链路无法回放 → 手工三例 checklist（generate / stream / UI 追问），真 key 本地人工跑，产物为 checklist 记录/截图。

**② 证据形态**
- 回放断言摘要（vitest）；新录 fixture 文件本身即证据（含请求/响应原文）
- 与本模版证据链对接：回放跑完仍按 §5.3 写 `evidence/`（含 model 名、请求 id、ts、`mock: true` 标注）

**③ 降级对照（一行表）**

| 受限 | 标杆替代 [文证：标杆实证] |
|---|---|
| 无 key（CI） | fixtures 回放，**key 永不进 CI** |
| 断网 | 同上（回放全离线） |
| 无 Docker | 本品类天然无容器需求 |

**④ DoD 要点**（取自汇总 §5 七条，本品类相关 3 条）
- `pnpm test` 零 key 全绿（回放）；`test:update` 与 `test` 分离，fixtures 进 git
- 单测不碰网络/容器/真 key
- 流式断言到 chunk 级；结构化输出有 zod schema 校验

## 6. Spike 实验协议
引用 `02-Spike实验协议.md`。**本品类是 Spike 高发品类**：
- 新模型/新端点可用性（昨晚教训直接来源）[实证]
- prompt 效果 A/B（同一评测集跑两版）[推断]
- embedding 模型切换对检索命中率的影响 [推断]

## 7. 坑库
**PIT-AI-001** 云 API 模型名/端点凭记忆书写 → 强制 curl Spike + §2.4 卡片。关联实证：PIT-DA-008（同源教训）。
**PIT-AI-002** [推断待验证] 流式响应在 Next.js Route Handler 的缓冲导致假"无输出" → `toDataStreamResponse` 并验证 chunk 到达时序。
**PIT-AI-003** [推断] 429 限流无退避 → 指数退避重试 + 驱动脚本断言重试后成功。
**PIT-AI-004** [推断] pgvector 扩展缺失误判为"检索质量差" → §2.2 C3 探测前置。

## 8. 标杆项目映射

| 项目 | 看什么文件 | 验证什么 | 解析状态 |
|------|-----------|---------|---------|
| vercel/ai | `examples/` 各 provider 样例、contributing/testing.md | streamText/tool 标准形态；录制回放+test:update 双命令（测试与 key 解耦） | B2 已实证 ●（2026-09-18 平台标杆解析） |
| langchain-ai/langchain-nextjs-template | package.json、app 结构 | 官方模板结构基线（无测试，如实记录已给补法） | B2 已实证 ● |
| langgenius/dify | `api/pytest.ini`+`conftest.py`、`core/workflow/nodes/`、`core/rag/`、Makefile、`tests/` 三层 | 平台型分层：workflow 节点即目录/RAG 管线分包；pytest 三层（unit/integration/containers）+compose 栈挂 pytest 钩子；VDB 四引擎矩阵；MOCK_SWITCH 零凭据可测 | ✅ 二轮已解析 · 二轮已实证 ●（2026-09-18，见 标杆解析-v1/二轮-dify.md） |
| lobehub/lobe-chat | 根 package.json、`vitest.config.mts`、`e2e/` 独立包、`src/components/`、`packages/builtin-tool-*` | test-app/test-server 分域 vitest+Cucumber+Playwright e2e 标签分级（@smoke/@P0）；builtin-tool 一包一插件；dpdm+knip 门禁 | 二轮已实证 ●（2026-09-18，见 标杆解析-v1/二轮-lobe-chat.md） |

## 9. 常见模式与反模式
v1 §5 反模式表完整保留。[文证] 追加一行：| 凭记忆写端点/模型名 | curl Spike + 卡片化已验证值 |

---
## CHANGELOG

- v2.3（2026-09-18）：§8 补二轮标杆 2 项（dify 平台型分层/lobe-chat 插件化 monorepo，均二轮已实证 ●），原 dify「未立项」行更新为✅ 二轮已解析，详见 标杆解析-v1/二轮-*.md。
- v2.2（2026-09-18）：§5.5 标杆测试闭环并入——vercel/ai 录制回放双命令（test/test:update 分离、fixtures 进 git、chunk 级流式断言），证据等级 [文证：标杆实证]；来源：平台知识库《标杆解析-v1/测试闭环汇总》。
- v2.1（2026-09-18）：L2-5 驱动自检骨架——`driver-skeleton.py`/`driver-skeleton.cjs` 随模版分发（五项运行时自检：storyId 非空 / expected-actual 同源 / 输出 schema 校验+退出码表 / 顶层异常包裹 / 环境前置自检）；§5 增骨架引用（desktop-app §5.3 骨架代码段升级为骨架文件引用，三条硬规则保留并标注由骨架承载）。
- v2.0（2026-09-18）：迁移定稿入运行时快照 `nanju-engineering-templates/` 与模版源头 `nanju-guide/09_工程模板/`（平台 v0.17.126）；§8 标杆映射按 B2 标杆解析（2026-09-18，14 仓库实证）回填实测状态、剔除/替代 404 条目。
- v2.0-draft（2026-09-18，草案）：新增 §0/§2（含 DashScope 交叉引用）/§5 分层断言/§6/§7/§8；v1 核心章节保留沿用。
- v1.0（2026-07-17）：初始 249 行版本。

---

# 附录 A：v1 保留沿用内容（v1.0，2026-07-17）

> 正文引用的「v1 §N」均指本附录内容；v1 与 v2 冲突处以 v2 正文为准。

---

# AI 应用 · 工程模板

> 版本：v1.0 | 代号：`ai-application` | 适用模式：快消型 & 长期迭代型

---

## 元信息

### 适用场景
- 以 LLM API 调用为核心逻辑的应用：聊天机器人、文本生成/分析工具、RAG 知识库问答、AI Agent 平台
- 用户说："做一个 AI 助手 / 智能客服 / 文档问答机器人 / AI 写作工具"

### 不适用场景
- LLM 只是锦上添花而非核心功能 → 用 `01-web-fullstack`，把 AI 功能作为扩展
- 不调用 LLM 的传统应用

---

## 1. 技术栈

### 推荐选型

| 层级 | 推荐 | 版本 | 为什么 |
|------|------|------|--------|
| **AI SDK** | Vercel AI SDK | v4+ | 统一的 LLM 调用接口（OpenAI/Anthropic/Google 等）、streaming 原生支持、React hooks |
| **向量数据库** | 轻量: LibSQL (Turso) / 生产: pgvector | — | 前者零配置，后者与 PostgreSQL 统一 |
| **Embedding** | OpenAI text-embedding-3-small | — | 性价比最高 |
| **Prompt 管理** | `.prompt` 文件 + version control | — | Git 可追踪、可 diff、可 review |
| **框架** | Next.js App Router | v15+ | Web 前端 + API Routes 一体 |
| **ORM** | Drizzle ORM | latest | 统一管理业务数据 + 向量数据 |
| **认证** | Better Auth | latest | 用户会话管理 |
| **流式输出** | Vercel AI SDK `streamText` | v4+ | 逐 token 推送到前端 |

### 备选方案

| 层级 | 备选 | 适用场景 |
|------|------|---------|
| **AI SDK** | LangChain (langgraph.js) | 需要复杂 Agent 工作流（多步推理、工具调用链） |
| **向量数据库** | Weaviate / Pinecone / Qdrant | 大规模生产部署（百万+文档） |
| **Embedding** | BGE-M3 (本地部署) | 数据隐私要求高，不能调用外部 API |

---

## 2. 目录结构

```
project/
├── .github/workflows/
│   └── ci.yml
├── src/
│   ├── app/                       # Next.js 前端
│   │   ├── (chat)/                #   聊天主界面
│   │   │   ├── page.tsx           #     /chat
│   │   │   └── _components/
│   │   │       ├── ChatInput.tsx   #       输入框（客户端）
│   │   │       ├── MessageList.tsx #       消息列表（客户端）
│   │   │       ├── MessageBubble.tsx#      消息气泡
│   │   │       └── ThinkingIndicator.tsx#  AI 思考中动画
│   │   ├── api/
│   │   │   └── chat/
│   │   │       └── route.ts       #     POST /api/chat（流式响应）
│   │   ├── layout.tsx
│   │   └── globals.css
│   ├── server/
│   │   ├── ai/                    # AI 核心逻辑
│   │   │   ├── model.ts           #   LLM provider 配置与切换
│   │   │   ├── prompts/           #   Prompt 模板目录
│   │   │   │   ├── chat.system.prompt    #  系统 prompt
│   │   │   │   ├── summarize.prompt      #  摘要 prompt
│   │   │   │   └── rag.query.prompt      #  RAG 查询重写 prompt
│   │   │   ├── rag/               #   RAG 管线
│   │   │   │   ├── embed.ts       #     embedding 生成
│   │   │   │   ├── retrieve.ts    #     向量检索
│   │   │   │   ├── chunk.ts       #     文档分块策略
│   │   │   │   └── re-rank.ts     #     重排序
│   │   │   ├── tools/             #   Function Calling 工具
│   │   │   │   ├── search-web.ts
│   │   │   │   └── calculator.ts
│   │   │   └── guardrails/        #   安全护栏
│   │   │       ├── input-guard.ts #      输入过滤（敏感词、注入检测）
│   │   │       └── output-guard.ts#      输出校验（格式检查、内容安全）
│   │   ├── db/
│   │   │   ├── schema.ts          #   Drizzle schema（对话 + 文档 + 用户）
│   │   │   └── migrations/
│   │   └── lib/
│   │       ├── auth.ts
│   │       └── cost.ts            #   Token 用量追踪
│   ├── components/
│   │   └── ui/                    #   shadcn/ui 基础组件
│   └── env.ts                     #   环境变量验证
├── tests/
│   ├── unit/                      #   prompt 模板测试、工具函数测试
│   ├── integration/               #   RAG 检索准确性测试
│   └── eval/                      #   LLM 输出质量评估
├── .env.example
├── tailwind.config.ts
├── tsconfig.json
├── package.json
└── README.md

```

---

## 3. AI 应用特有的工程关注点

### 3.1 Prompt 管理

```
规则：
1. 所有 prompt 模板放在 src/server/ai/prompts/ 下
2. 使用 .prompt 扩展名（或 .md），支持 Git diff
3. Prompt 中使用 {{placeholder}} 语法做变量替换
4. 每个 prompt 文件头注释说明：用途、期望的输入格式、期望的输出格式
5. Prompt 变更必须经过测试（用 eval 验证输出质量）
```

### 3.2 流式响应的端到端实现

```typescript
// src/app/api/chat/route.ts
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai("gpt-4o-mini"),
    system: SYSTEM_PROMPT,        // 从 .prompt 文件加载
    messages,
    tools: {                       // Function Calling 工具
      searchWeb: searchWebTool,
      calculator: calculatorTool,
    },
    onFinish: async ({ usage }) => {
      await trackCost(req.user.id, usage);  // Token 计费
    },
  });

  return result.toDataStreamResponse();
}
```

### 3.3 RAG 管线

```text
文档入库流程：
  用户上传文档
  → chunk（按段落/语义分块，默认 512 tokens，重叠 64 tokens）
  → embed（调用 embedding 模型生成向量）
  → store（存入向量数据库，附带 metadata）

查询流程：
  用户提问
  → query rewrite（可选：用 LLM 改写查询以提高召回率）
  → embed（生成查询向量）
  → retrieve（向量相似度搜索，top-K=5）
  → re-rank（可选：用 LLM 对候选段落重新排序）
  → context assemble（组装为 LLM 的 context）
  → generate answer（LLM 基于 context 生成答案 + 引用来源）
```

### 3.4 安全护栏

```
输入护栏（请求发给 LLM 前）：
  - 内容安全：检测 S 情/暴力/仇恨言论
  - Prompt 注入：检测 "ignore previous instructions" 等注入尝试
  - 长度限制：单次输入 ≤ 8000 chars

输出护栏（LLM 返回后）：
  - 格式验证：JSON schema 校验（如期望 JSON 输出）
  - 敏感信息泄露：检测 API key/密码/身份证号等
  - 内容安全：输出也过一遍安全检测
```

### 3.5 Token 用量追踪

```typescript
// src/server/lib/cost.ts
interface UsageRecord {
  userId: string;
  sessionId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;         // 按各模型定价计算
  timestamp: Date;
}
// 存储到 DB，定期汇总到看板
```

---

## 4. 测试策略

AI 应用需要**额外的评估维度**：

| 测试类型 | 工具 | 内容 | 频率 |
|---------|------|------|------|
| 单元测试 | Vitest | prompt 模板渲染、chunk 算法、护栏规则 | 每次提交 |
| 集成测试 | Vitest | RAG 检索精度、API endpoint | 每次提交 |
| Eval 测试 | 自定义 eval 框架 | LLM 输出质量（准确性、幻觉率、格式合规率） | 每次 prompt 变更 / 定期 |
| 安全测试 | 自动化工具 | 注入攻击、越狱尝试 | 每次部署前 |

### Eval 测试模式

```typescript
// 人工标注一组 Q&A 作为 ground truth
const evalSet = [
  { question: "退货政策是什么？", expectedAnswer: "30天内免费退货..." },
  // ...
];

// 自动评测
for (const { question, expectedAnswer } of evalSet) {
  const answer = await askAI(question);
  const score = await evaluateAnswer(answer, expectedAnswer);
  // 指标：语义相似度、关键事实覆盖、幻觉检测
}
// 要求：总体通过率 ≥ 90%
```

---

## 5. AI 应用反模式

| DON'T ❌ | DO ✅ |
|----------|------|
| 在客户端调用 LLM API（暴露 key） | 始终在服务端调用，API key 仅存于环境变量 |
| Prompt 硬编码在代码中 | Prompt 独立文件管理，版本可追踪 |
| 没有输入限制就发给 LLM | 输入护栏 + 长度限制 |
| 直接展示 LLM 原始输出 | 输出护栏 + 格式化展示 |
| 没有 token 用量追踪 | 每次 LLM 调用记录用量和成本 |
| 无限制地让 AI 调用工具 | 关键操作需用户确认（如：删除、支付） |
| 把敏感数据发给 LLM | 敏感数据脱敏后再发送 |

---

## 6. 参考项目

| 项目 | 关键借鉴 |
|------|---------|
| [Vercel AI SDK](https://github.com/vercel/ai) | `streamText`、`useChat` hooks、多 provider 统一接口 |
| [langchain-ai/langchain-nextjs-template](https://github.com/langchain-ai/langchain-nextjs-template) | Structured Output + Zod、Agent 工作流、RAG 链式调用 |
| [Dify](https://github.com/langgenius/dify) (60K+ ⭐) | DDD 分层架构、Workflow 引擎、RAG 管线、多租户设计 |
| [Conrad-Labs/nextjs-chatbot-ui-template](https://github.com/Conrad-Labs/nextjs-chatbot-ui-template) | 多 provider 切换、聊天历史、文件分析、速率限制 |
| [Lobe Chat](https://github.com/lobehub/lobe-chat) (60K+ ⭐) | 插件系统、多模型管理、Agent 市场、Chat UI 最佳实践 |
