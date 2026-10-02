import { describe, expect, test } from 'bun:test'
import { validateTestArchitecture } from './nanju-test-architecture'

const valid = `# 架构
## 交付与运行
- 目标平台：Linux X11
- 交付产物：08_APP/dist/tool
- 构建方式：按工程构建配置生成可执行文件
- 启动方式：双击可执行文件
## 测试架构
| 层级 | 框架 | 执行方式 | 证据 | 覆盖 |
| --- | --- | --- | --- | --- |
| 行为验收 | 桌面测试驱动 | 启动真实桌面程序 | 运行日志与输入结果 | US-01 |
### 真实与模拟边界
单元测试可隔离外部依赖，真实系统能力必须在目标系统验证。
### 失败回流
构建失败回开发，覆盖缺失回测试设计；无环境则阻塞，不伪造通过。
`

describe('Given 架构阶段交付文档 When 校验最低测试契约', () => {
  test('Then 完整桌面交付与测试计划通过结构校验（不是验收通过）', () => {
    expect(validateTestArchitecture(valid)).toEqual({ ok: true, problems: [] })
  })
  test('Then 仅标题或空表不算测试计划', () => {
    const result = validateTestArchitecture(valid.replace('| 行为验收 | 桌面测试驱动 | 启动真实桌面程序 | 运行日志与输入结果 | US-01 |', ''))
    expect(result.ok).toBe(false)
    expect(result.problems.join('；')).toContain('测试表')
  })
  test('Then 缺交付节或运行字段必须提示补全', () => {
    expect(validateTestArchitecture(valid.replace('## 交付与运行', '## 其他')).ok).toBe(false)
    expect(validateTestArchitecture(valid.replace('- 启动方式：双击可执行文件', '')).problems.join('；')).toContain('启动方式')
  })
  test('Then 其他同级章节的表格不能代替测试架构', () => {
    expect(validateTestArchitecture(valid.replace('## 测试架构', '## 测试架构\n## 附录')).ok).toBe(false)
  })
  test('Then 缺真实边界或失败回流说明不能通过', () => {
    expect(validateTestArchitecture(valid.replace('### 真实与模拟边界', '### 其他说明')).ok).toBe(false)
    expect(validateTestArchitecture(valid.replace('构建失败回开发，覆盖缺失回测试设计；无环境则阻塞，不伪造通过。', '')).ok).toBe(false)
  })
  test('Then 代码示例里的完整计划不算正文计划', () => {
    expect(validateTestArchitecture('```markdown\n' + valid + '```').ok).toBe(false)
    expect(validateTestArchitecture('~~~markdown\n' + valid + '~~~').ok).toBe(false)
  })
  test('Then 支持两列表格的运行说明与测试表空行', () => {
    const doc = valid.replace(/^- ([^：]+)：(.+)$/gm, '| $1 | $2 |').replace('| 行为验收 |', '\n| 行为验收 |')
    expect(validateTestArchitecture(doc).ok).toBe(true)
  })
  test('Then 允许标题编号与说明后缀，不误拦正常Markdown', () => {
    expect(validateTestArchitecture(valid.replace('## 测试架构', '## 4. 测试架构（验收设计）')).ok).toBe(true)
  })
})
