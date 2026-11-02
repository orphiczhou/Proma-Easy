/**
 * `test-home-fixture` 自测（NEXT-05 Batch B 的前置保障）。
 *
 * 夹具本身必须被验证，否则「以为隔离了其实没隔离」会成为新的假绿：
 * 1. `homedir()` 被重定向到临时目录，`config-paths.getConfigDir()` 不再指向真实 `~/.proma`；
 * 2. 在隔离目录内写文件，不会出现在真实配置目录；
 * 3. `reset()` 清空配置目录，`restore()` 把解析指回真实 HOME 且目录被删除；
 * 4. `withIsolatedPromaConfigDir` 单次包裹在抛错时也会还原。
 *
 * 注意：本文件刻意**不使用** `useIsolatedPromaConfigDir()`（顶层安装），
 * 而是逐步收发 rig，才能验证 restore 前后的差异。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import * as nodeOs from 'node:os'
import { join } from 'node:path'

import { getConfigDir, getChannelsPath } from '../config-paths'
import {
  assertInsideRig,
  installIsolatedPromaConfigDir,
  withIsolatedPromaConfigDir,
  type IsolatedPromaConfigDirRig,
} from './test-home-fixture'

/** 真实配置目录（夹具 restore 后应回到这里） */
const REAL_CONFIG_DIR = join(nodeOs.homedir(), '.proma')

/**
 * 环境探针：本夹具是「mock `node:os` + 临时目录」实现，前提是进程内没有别的
 * `mock.module('node:os')` 抢先接管。`bun test`（非 `--isolate`）全仓运行时，
 * 其他测试文件的 mock 会按加载顺序顶掉本夹具（实测得到别的文件的临时 HOME），
 * 此时本文件的端到端断言不再具备判定意义，应显式跳过而不是给出误导性的红。
 *
 * 门禁口径：`bun test --isolate`（每文件独立模块注册表）下探针为 true，用例全跑。
 */
const isolationAvailable = (() => {
  const rig = installIsolatedPromaConfigDir()
  try {
    return getConfigDir() === join(rig.homeDir, '.proma')
  } finally {
    rig.restore()
  }
})()

if (!isolationAvailable) {
  console.warn(
    '[test-home-fixture] 当前进程的 node:os mock 已被其他测试文件接管，跳过夹具端到端自测；' +
      '请在 `bun test --isolate` 下运行以获得真实判定。',
  )
}

/** 仅在隔离可生效时运行的 test（跳过的用例会在汇总里计为 skip，不计 pass） */
const testIsolated = test.skipIf(!isolationAvailable)

let activeRig: IsolatedPromaConfigDirRig | null = null

afterEach(() => {
  activeRig?.restore()
  activeRig = null
})

describe('installIsolatedPromaConfigDir', () => {
  testIsolated('Given 安装夹具 When 解析配置目录 Then 落在临时根目录而非真实 ~/.proma', () => {
    activeRig = installIsolatedPromaConfigDir()

    // node:os 已被 mock：两条解析路径都必须指向隔离根
    expect(nodeOs.homedir()).toBe(activeRig.homeDir)
    expect(getConfigDir()).toBe(join(activeRig.homeDir, '.proma'))
    expect(getChannelsPath()).toBe(join(activeRig.homeDir, '.proma', 'channels.json'))

    // 不得等于真实配置目录（唯一硬约束）
    expect(getConfigDir()).not.toBe(REAL_CONFIG_DIR)
  })

  testIsolated('Given 隔离生效 When 写入渠道文件 Then 只出现在隔离目录，真实目录不被创建新文件', () => {
    activeRig = installIsolatedPromaConfigDir()
    const channelsPath = getChannelsPath()
    assertInsideRig(activeRig, channelsPath, 'channels.json')

    const existedBefore = existsSync(join(REAL_CONFIG_DIR, 'channels.json.selftest'))
    writeFileSync(channelsPath, JSON.stringify({ version: 2, channels: [] }), 'utf-8')
    expect(existsSync(channelsPath)).toBe(true)
    // 真实目录不因本用例新增文件（用 selftest 专名避免误判既有资产）
    expect(existsSync(join(REAL_CONFIG_DIR, 'channels.json.selftest'))).toBe(existedBefore)
  })

  testIsolated('Given reset 调用 When 再次读取 Then 配置目录被清空重建', () => {
    activeRig = installIsolatedPromaConfigDir()
    const channelsPath = getChannelsPath()
    writeFileSync(channelsPath, '{"version":2,"channels":[]}', 'utf-8')
    expect(existsSync(channelsPath)).toBe(true)

    activeRig.reset()
    expect(existsSync(channelsPath)).toBe(false)
    expect(existsSync(activeRig.configDir)).toBe(true)
  })

  testIsolated('Given restore 调用 When 再次解析 Then 回到真实 HOME 且临时目录被删除', () => {
    const rig = installIsolatedPromaConfigDir()
    const isolatedHome = rig.homeDir
    expect(nodeOs.homedir()).toBe(isolatedHome)

    rig.restore()
    expect(existsSync(isolatedHome)).toBe(false)
    // 关键语义：解析已指回真实 HOME（不等于已删除的临时目录）
    expect(nodeOs.homedir()).not.toBe(isolatedHome)
    expect(getConfigDir()).not.toBe(join(isolatedHome, '.proma'))
  })
})

describe('withIsolatedPromaConfigDir', () => {
  testIsolated('Given 包裹同步逻辑 When 执行 Then 局部隔离生效且结束后还原', async () => {
    const realHome = nodeOs.homedir()
    const inner = await withIsolatedPromaConfigDir((rig) => {
      expect(getConfigDir()).toBe(join(rig.homeDir, '.proma'))
      return rig.homeDir
    })
    expect(existsSync(inner)).toBe(false)
    expect(nodeOs.homedir()).toBe(realHome)
  })

  testIsolated('Given 包裹逻辑抛错 When 异常传播 Then 仍然还原并清理临时目录', async () => {
    const realHome = nodeOs.homedir()
    let capturedHome = ''
    await expect(
      withIsolatedPromaConfigDir((rig) => {
        capturedHome = rig.homeDir
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(capturedHome.length).toBeGreaterThan(0)
    expect(existsSync(capturedHome)).toBe(false)
    expect(nodeOs.homedir()).toBe(realHome)
  })
})

describe('assertInsideRig', () => {
  testIsolated('Given 路径在隔离根之外 When 断言 Then 抛出明确错误', () => {
    activeRig = installIsolatedPromaConfigDir()
    expect(() => assertInsideRig(activeRig!, join(REAL_CONFIG_DIR, 'channels.json'), 'channels')).toThrow(
      '未落在隔离目录内',
    )
    expect(() => assertInsideRig(activeRig!, join(activeRig!.configDir, 'ok.json'), 'ok')).not.toThrow()
  })
})
