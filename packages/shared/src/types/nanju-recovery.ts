/** 回滚 IPC 的结果契约；对象存在不代表恢复成功。 */
export interface ProjectRecoveryResult {
  ok: boolean
  status: 'restored' | 'partial' | 'failed'
  message: string
  activeSessionId: string | null
  restoredSnapshotId: number | null
  preRestoreSnapshotId: number | null
  fileRestore: {
    ok: boolean
    complete: boolean
    notRestored: string[]
    actionable: boolean
    userMessage: string
    preRestoreBackupDir?: string
    backupSizeBytes?: number
  } | null
}

/** 用户与模型看到同一份结构化拒因，不以自然语言反解析状态。 */
export interface AdvanceGateCheck {
  id: string
  path?: string
  expected: string
  actual: string
  pass: boolean
  nextAction?: string
}
export interface AdvanceCorrectionView {
  state: 'blocked' | 'correcting' | 'cancelled'
  target: string
  message: string
  checks: AdvanceGateCheck[]
}
export const NANJU_CANCEL_ADVANCE_CORRECTION = 'nanju:cancel-advance-correction'
