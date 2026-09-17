import { expect, test } from 'bun:test'
import { findHostPython3 } from './nanju-engineering-runtime'

test('Given 宿主PATH含当前目录或项目相对目录 When 探测Python Then 只检查绝对目录且不执行shell', async () => {
  const checked: string[] = []
  const result = await findHostPython3({ path: '.:relative:/usr/local/bin:/usr/bin', platform: 'linux', executable: (path) => { checked.push(path); return path === '/usr/bin/python3' }, version: async () => 'Python 3.12.1' })
  expect(result).toBe('/usr/bin/python3')
  expect(checked).toEqual(['/usr/local/bin/python3', '/usr/bin/python3'])
})
test('Given 错误Python版本或探测失败 When 寻找宿主运行时 Then 不接受未知版本而继续下个候选', async () => {
  expect(await findHostPython3({ path: '/a:/b', platform: 'linux', executable: () => true, version: async (path) => path.startsWith('/a/') ? 'Python 2.7.18' : 'Python 3.11.4' })).toBe('/b/python3')
  expect(await findHostPython3({ path: '/a', platform: 'linux', executable: () => true, version: async () => { throw new Error('启动失败') } })).toBeUndefined()
})
test('Given Windows进程树执行尚未支持 When 探测 Then 不激活未知Python启动器', async () => {
  expect(await findHostPython3({ path: 'C:\\Python', platform: 'win32', executable: () => { throw new Error('不应执行') }, version: async () => 'Python 3.12.1' })).toBeUndefined()
})
