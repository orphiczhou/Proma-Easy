/**
 * 点选纠错语音目标解析（WO6，v0.17.59 自 ClickToFixPanel 抽出）
 *
 * 纯常量 + 纯函数模块：不依赖 electron / renderer 运行时，渲染进程
 * （ClickToFixPanel / GlobalShortcuts）与主进程测试共用。不违反注入脚本
 * 唯一事实源铁律——本模块不进 iframe 注入脚本体。
 */

/** 语音意见收集器的 sourceInputId 前缀（点选元素旁的语音 bar 用）
 *  格式：ctf-voice-<agentSessionId>-<elementId>。两者都可能含 '-'（agentSid 是 36 字符
 *  uuid、元素 id 是 kebab-case），解析先按 uuid 固定结构切分，再 lastIndexOf 兜底。
 *  导出供 GlobalShortcuts 判定同一前缀（P3：ctf-voice 目标不抢焦点回输入框）。 */
export const CTF_VOICE_INPUT_PREFIX = 'ctf-voice-'

/** agent 会话 id 的 uuid 形状（8-4-4-4-12，共 36 字符）——用于 targetInputId 前缀解析 */
const AGENT_SID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 从 ctf-voice-<agentSid>-<elementId> 解析归属（P3：uuid 精确切分优先，lastIndexOf 兜底） */
export function parseCtfVoiceTarget(targetInputId: string): { agentSid: string; elementId: string } | null {
  const rest = targetInputId.slice(CTF_VOICE_INPUT_PREFIX.length)
  // agentSid 是 uuid（36 字符，自身含 4 个 '-'）且分隔符恰在 rest[36]：先按固定结构切
  if (rest.length > 37 && rest[36] === '-' && AGENT_SID_UUID_RE.test(rest.slice(0, 36))) {
    return { agentSid: rest.slice(0, 36), elementId: rest.slice(37) }
  }
  // 兜底（非 uuid 会话 id）：取最后一个 '-'——元素 id 含 '-' 时会切错，仅防御性保留；
  // M10（v0.17.59）：兜底命中告警（宿主侧可见，便于发现非 uuid 会话 id 的形态漂移）
  console.warn('[点选纠错] ctf-voice targetInputId 非 uuid 形态，走 lastIndexOf 兜底切分：', targetInputId)
  const dashIdx = rest.lastIndexOf('-')
  if (dashIdx <= 0) return null
  return { agentSid: rest.slice(0, dashIdx), elementId: rest.slice(dashIdx + 1) }
}
