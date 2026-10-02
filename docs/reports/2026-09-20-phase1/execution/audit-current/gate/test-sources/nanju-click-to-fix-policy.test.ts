import { describe, expect, test } from 'bun:test'
import { clickToFixPolicy } from './nanju-click-to-fix-policy'
describe('点选纠错按业务阶段路由', () => {
  test('prototype仍改原型并允许同步PRD', () => expect(clickToFixPolicy('prototype')).toEqual({ application: false, target: '02_UX_DESIGN/prototype.html', syncPrd: true, mustRetest: false }))
  test('testing改08_APP且必须重测，不能回写PRD', () => expect(clickToFixPolicy('testing')).toEqual({ application: true, target: '08_APP/', syncPrd: false, mustRetest: true }))
  test('coding改应用但不把普通点选误判为需求变更', () => expect(clickToFixPolicy('coding')).toEqual({ application: true, target: '08_APP/', syncPrd: false, mustRetest: false }))
  test('delivered的修复同样失效旧交付事实并重测', () => expect(clickToFixPolicy('delivered')).toEqual({ application: true, target: '08_APP/', syncPrd: false, mustRetest: true }))
})
