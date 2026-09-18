/** 工程契约示例只用于指导架构产出；不注入可执行命令或自动授权。 */
import { ENGINEERING_CONTRACT_PATH, ENGINEERING_DELIVERY_PATH } from './nanju-engineering-contract'

export const ENGINEERING_CONTRACT_GUIDE = [
  '工程交付契约（必须）：除 architecture.md 外，同时生成 ' + ENGINEERING_CONTRACT_PATH + '，schemaVersion=2（新工程默认；存量 v1 档案原样有效，不迁移不重写）。',
  'PRD决定目标平台与交付形态；架构决定工具链、真实产物与测试方式，工程模板仅作参考。',
  'JSON字段：target={platform,kind,entry}，kind取web/api/mobile/desktop/cli/ai；entry与artifacts数组路径均相对于08_APP，必须列出真实可交付文件，不能只列演示页面。',
  'build、run为构建/启动说明（字符串）；无需构建需说明原因。任何命令说明都不等于安装、运行或系统权限授权。',
  'tests至少一项行为验收，每项字段：id、layer（unit/integration/acceptance）、adapter（browser-file/browser-url/native-driver/cli-driver/api-driver/mobile-driver）、target（artifacts中的被测文件）、command（执行说明）、covers（US-编号数组）、requiresReal（布尔值）。',
  '只有acceptance项登记covers且不能为空；unit/integration项covers=[]，只作辅助证据。明确requiresReal，浏览器mock、单测或构建成功不能替代真实能力验收。',
  '浏览器测试声明scenarioFiles（相对06_TESTS的.steps.json路径数组），每个文件只归属一个test.id；架构列清单，testing生成文件，执行与交付将场景内容纳入版本绑定。browser-file可与CLI辅助测试混合逐项批准执行。',
  'adapter是所需能力声明，不是系统已具备的承诺；能力/环境不足须明确阻塞和下一步，不能静默改成mock交付。',
  '非浏览器测试可声明driver={runtime:"node"|"python3"|"native",path,args,timeoutMs,env}；path相对于08_APP且必须列入artifacts，args为字符串数组，timeoutMs为100至600000毫秒。env（可选，v2新增）为驱动所需环境变量名清单（如["DASHSCOPE_API_KEY"]，仅变量名不含值；值由宿主从自身环境注入，不得把密钥值写进契约或产物；须真实需要才声明）。当前宿主接入Node及原生进程；Python与Windows驱动缺运行支持时会明确阻塞，不自动安装。command仍只作说明。',
  'browser-url测试声明service={runtime,path,args,env,port,readyPath,readyTimeoutMs}：path相对于08_APP且必须列入artifacts，port为1024至65535的loopback固定端口，readyPath以/开头，env语义同driver（服务进程所需环境变量名清单，v2新增）。宿主在单次批准后启动该loopback服务并持有句柄，端口被占用即拒绝；服务须读取环境变量PROMA_ENGINEERING_READY_NONCE并在就绪响应header(x-proma-ready-nonce)或body回传该nonce，否则不会判定就绪；Windows平台尚未实现服务进程树回收，明确阻塞且不启动。',
  '驱动由coding实现于08_APP；stdin接收JSON {schemaVersion,testId,target,covers,evidenceDigest}，工作目录为08_APP。stdout只能输出单个JSON {testId,target,checks:[{storyId,label,expected,actual,evidence}]}；日志写stderr。expected/actual为字符串，evidence为非空字符串数组；辅助测试storyId=null。退出码由宿主实测，不能用驱动自报覆盖。',
  // L2-4（2026-09-18）：契约 env 声明字段提示（P0-1 schema v2 字段的提示词增补——
  // 上行 driver 字段说明聚焦 schema 写法，本行聚焦「何时该声明」；DASHSCOPE 硬编码
  // 兑底移除后，云端密钥项目的唯一透传通道 = 此处声明的 env 清单）
  '涉及云端服务/外部 API 的项目：在契约 driver.env / service.env 声明所需环境变量名（如 ["DASHSCOPE_API_KEY"]）——值由宿主从自身环境注入子进程，不得写入契约或产物；何时声明/字段写法见上行 driver 与 service 字段说明。',
  // L3-7c（2026-09-18）：spikes[]/envProbe 登记字段说明——spikes 由架构师按
  // 00_SPIKES/INDEX.md 与各 Spike README 结论段人工登记（markdown 不做自动解析；
  // 消费方式沿 03 §3.3：任务书注入 INDEX.md 路径+相关 Spike README 结论段）。
  // verdict=结论方向，与状态 FULL/PARTIAL（完成度）、坑库 [推断]/[实证]（证据等级）
  // 分属三个语义维度、互不替代。
  '涉及关键技术不确定点：Spike 未决前架构文档该决策点标 PENDING(SPIKE-NNN)，不得写成确定性结论；全部 Spike 验收后更新结论并把 PENDING 替换为结论引用。契约可登记 spikes=[{slug,verdict,conclusion,decided_by,ts}]（仅v2，≤16项）：slug=SPIKE-NNN-短名或00_SPIKES目录名（≤64字符、不重复），由架构师按 00_SPIKES/INDEX.md 与各 Spike README 结论段人工登记（markdown不做自动解析）；verdict=confirmed/refuted/partial（结论方向：证实/证伪/部分成立，区别于状态FULL/PARTIAL完成度与坑库[推断]/[实证]证据等级）；conclusion=一句话结论；decided_by=登记主体；ts=ISO日期。',
  '环境探测产出可在契约登记 envProbe={path,generatedAt}（仅v2；登记性字段不是执行指令——探测由项目启动钩子执行）：path 固定惯例 03_ARCHITECTURE/env_probe.json（可缺省），generatedAt 为生成时间。',
  '每次驱动执行均需真人单次批准。真实系统行为不能由项目驱动自报证明，requiresReal项目在独立验收证据接入前保留blocked，不得为了通过改成false。',
  '示例（需按实际PRD改写，不可直接把示例当项目决策）：',
  '```json',
  JSON.stringify({
    schemaVersion: 2,
    target: { platform: 'Linux', kind: 'cli', entry: 'bin/tool' },
    artifacts: ['bin/tool'], build: '按选定工具链构建到bin/tool', run: '在终端运行bin/tool',
    tests: [{ id: 'cli-acceptance', layer: 'acceptance', adapter: 'cli-driver', target: 'bin/tool', command: '真实驱动检查输入输出与退出状态', covers: ['US-01'], requiresReal: true }],
  }, null, 2),
  '```',
].join('\n')

export const ENGINEERING_CODING_GUIDE = [
  '依据PRD、UX和03_ARCHITECTURE/architecture.md及engineering.json实现真实工程，禁止为方便预览把产品降为网页模拟。',
  '产物：按engineering.json的artifacts清单生成于08_APP/；交付说明写入' + ENGINEERING_DELIVERY_PATH + '，包含「## 构建与运行」和「## 测试状态」，如实列出未验证项。',
  '只有架构明确选择静态网页时使用纯HTML/JS与本地存储；后端、构建、桌面壳、原生能力按架构实际实现，不限制为index.html。',
  '02_UX_DESIGN/prototype.html只是视觉/交互参考，不是所有产品的运行或验收主体。',
  'HTML UI保留data-ai-id/data-ai-type点选标记；非HTML界面依据实际平台测试驱动，不强加DOM标记。',
  '所有工程文件写入08_APP/，不得触碰其他项目或工作区配置；不将密钥放进交付产物或浏览器代码。',
  '依据契约实现driver测试脚本，列入artifacts并绑定实际被测产物；不写固定PASS结果。testing阶段只读取并独立核验这些驱动，不以修改驱动来掩盖应用缺陷。',
  '构建、分层测试和真实用户故事验证依照架构执行；调用现有受控工具，环境安装、权限变化和外部发送须真人确认。',
  '浏览器预览只用于适用UI：使用受管浏览器预览工具，不使用chrome-devtools或file://替代原生运行。缺少执行能力明确说明阻塞，不把人工读代码记为实测通过。',
].join('\n')
