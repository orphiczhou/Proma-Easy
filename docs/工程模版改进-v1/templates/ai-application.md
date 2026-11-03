# AI 应用 · 工程模板 v2（改进草案）

> 版本：v2.0-draft | 代号：`ai-application` | 适用模式：快消型 & 长期迭代型
> 证据等级：**[实证]** / **[文证]** / **[推断]**。
> 与 v1 关系：v1（`/home/orphic/proma-patches/p1-quick-engineering/apps/electron/resources/nanju-engineering-templates/ai-application.md`）的 Vercel AI SDK 选型、prompt 管理、RAG 管线、护栏、token 计费、eval 模式、反模式表**保留沿用**（六品类中工程质量较高的部分）；本文新增 v2 章节，并吸收昨晚实测的云端 API 对接教训。

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

## 6. Spike 实验协议
引用 `../02-Spike实验协议.md`。**本品类是 Spike 高发品类**：
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
| vercel/ai | `examples/` 各 provider 样例 | streamText/tool 标准形态 | 待下载待解析 |
| langgenius/dify | `api/core/workflow/`、`rag/` | 管线模块化（长期迭代型） | 待下载待解析 |

## 9. 常见模式与反模式
v1 §5 反模式表完整保留。[文证] 追加一行：| 凭记忆写端点/模型名 | curl Spike + 卡片化已验证值 |

---
## CHANGELOG
- v2.0-draft（2026-09-18）：新增 §0/§2（含 DashScope 交叉引用）/§5 分层断言/§6/§7/§8；v1 核心章节保留沿用。
- v1.0（2026-07-17）：初始 249 行版本。
