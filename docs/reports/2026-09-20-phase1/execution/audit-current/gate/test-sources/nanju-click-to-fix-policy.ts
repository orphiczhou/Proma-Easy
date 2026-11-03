import type { ProjectStage } from './nanju-project'

/** 点选修改只由当前业务阶段决定，预览元素文字不参与授权判断。 */
export function clickToFixPolicy(stage: ProjectStage): { application: boolean; target: string; syncPrd: boolean; mustRetest: boolean } {
  const application = stage === 'coding' || stage === 'testing' || stage === 'delivered'
  return { application, target: application ? '08_APP/' : '02_UX_DESIGN/prototype.html', syncPrd: !application, mustRetest: stage === 'testing' || stage === 'delivered' }
}
