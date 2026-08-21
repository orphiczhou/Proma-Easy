/**
 * WO5.3（v0.17.59）：parseCtfVoiceTarget 四类用例
 * uuid 精确切分 / kebab 元素 id / 非 uuid 兜底 / null
 */
import { describe, expect, test } from 'bun:test'
import { CTF_VOICE_INPUT_PREFIX, parseCtfVoiceTarget } from '../ctf-voice'

const UUID = '77ceb370-fae4-4165-a115-37b5924bf02b'

describe('parseCtfVoiceTarget（WO6 迁出后行为不变）', () => {
  test('uuid 精确切分：rest[36] 恰为分隔符', () => {
    const r = parseCtfVoiceTarget(`${CTF_VOICE_INPUT_PREFIX}${UUID}-hero-title`)
    expect(r).toEqual({ agentSid: UUID, elementId: 'hero-title' })
  })

  test("kebab 元素 id：uuid 结构优先，元素 id 内的 '-' 不干扰", () => {
    const r = parseCtfVoiceTarget(`${CTF_VOICE_INPUT_PREFIX}${UUID}-nav-item-level-2`)
    expect(r).toEqual({ agentSid: UUID, elementId: 'nav-item-level-2' })
  })

  test('非 uuid 会话 id：lastIndexOf 兜底切分（命中告警）', () => {
    const r = parseCtfVoiceTarget(`${CTF_VOICE_INPUT_PREFIX}custom-session-elem`)
    expect(r).toEqual({ agentSid: 'custom-session', elementId: 'elem' })
  })

  test('无分隔符 / 空尾：返回 null（不抛错）', () => {
    expect(parseCtfVoiceTarget(`${CTF_VOICE_INPUT_PREFIX}`)).toBeNull()
    expect(parseCtfVoiceTarget(`${CTF_VOICE_INPUT_PREFIX}nodash`)).toBeNull()
    expect(parseCtfVoiceTarget(`${CTF_VOICE_INPUT_PREFIX}-leading`)).toBeNull()
  })
})
