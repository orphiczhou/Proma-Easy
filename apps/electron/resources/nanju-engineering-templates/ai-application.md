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
