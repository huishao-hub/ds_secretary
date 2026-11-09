/**
 * AI Personal Secretary — DSH Host 插件
 *
 * 职责（只做编排与桥接，业务逻辑都在本地服务里）：
 *  1. 拉起 / 复用本地规划引擎（node service/index.mjs，127.0.0.1 随机端口 + token）
 *  2. 拉起桌宠叠加层（app/Pet.ps1），DSH 关闭时一并收掉
 *  3. 把「看计划 / 建计划 / 5 天窗口」注册成 Agent 工具，让我能直接操作同一个库
 *
 * 安全：只连 127.0.0.1，token 存在 data/bridge.json；不接受模型生成的系统命令。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'ai-secretary'

const DEFAULTS = {
  enabled: true,
  root: 'D:\\AI-Secretary',
  launchService: true,
  launchPet: true,
  registerTools: true,
}

const TOKEN = { type: 'object', properties: {}, additionalProperties: false }

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (cfg.enabled === false) return

  const root = String(cfg.root || DEFAULTS.root)
  const dataDir = join(root, 'data')
  const logDir = join(root, 'logs')
  const bridgeFile = join(dataDir, 'bridge.json')
  const serviceEntry = join(root, 'service', 'index.mjs')
  const launchScript = join(root, 'app', 'launch.ps1')

  for (const dir of [dataDir, logDir]) {
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* best effort */ }
  }

  const note = (line) => {
    try {
      const stamp = new Date().toISOString().slice(11, 19)
      appendFileSync(join(logDir, 'plugin.log'), `${stamp}  ${line}\n`, 'utf8')
    } catch { /* logging is best effort */ }
  }

  let serviceProc = null
  let petProc = null
  let bridge = null

  function readBridge() {
    try {
      const raw = readFileSync(bridgeFile, 'utf8')
      const b = JSON.parse(raw)
      if (b?.port && b?.token) return b
    } catch { /* not ready */ }
    return null
  }

  async function callOnce(info, method, path, body, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${info.token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timer)
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
      if (!res.ok) {
        const message = json?.error || `http ${res.status}`
        throw new Error(message)
      }
      return json
    } catch (error) {
      clearTimeout(timer)
      throw error
    }
  }

  // 服务重启会换端口/token：失败时重读 bridge.json 再试一次
  async function httpCall(method, path, body, timeoutMs = 12000) {
    let info = bridge ?? readBridge()
    if (!info) throw new Error('本地规划服务未就绪（data/bridge.json 不存在）')
    try {
      return await callOnce(info, method, path, body, timeoutMs)
    } catch (error) {
      const fresh = readBridge()
      if (fresh && (fresh.port !== info.port || fresh.token !== info.token)) {
        bridge = fresh
        note(`bridge changed, retry on ${fresh.port}`)
        return await callOnce(fresh, method, path, body, timeoutMs)
      }
      throw error
    }
  }

  async function ensureService() {
    if (readBridge()) {
      bridge = readBridge()
      try {
        await httpCall('GET', '/health', undefined, 3000)
        note('service already alive')
        return true
      } catch {
        note('stale bridge.json, restarting service')
      }
    }
    if (!existsSync(serviceEntry)) {
      note(`service entry missing: ${serviceEntry}`)
      return false
    }
    note('starting service')
    serviceProc = spawn(process.execPath, [serviceEntry, '--data-dir', dataDir], {
      cwd: root,
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    })
    serviceProc.on('error', (error) => note(`service spawn failed: ${error.message}`))
    serviceProc.unref()

    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const info = readBridge()
      if (!info) continue
      bridge = info
      try {
        await httpCall('GET', '/health', undefined, 3000)
        note(`service healthy on ${info.port}`)
        return true
      } catch { /* keep waiting */ }
      if (serviceProc?.exitCode !== null && serviceProc?.exitCode !== undefined) break
    }
    note('service did not become healthy')
    return false
  }

  function startPet() {
    if (!existsSync(launchScript)) {
      note(`launcher missing: ${launchScript}`)
      return
    }
    const pidFile = join(dataDir, 'pet.pid')
    if (existsSync(pidFile)) {
      try {
        const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
        if (pid > 0) {
          process.kill(pid, 0)
          note(`pet already running pid ${pid}`)
          return
        }
      } catch { /* stale pid */ }
    }
    note('starting pet')
    petProc = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', launchScript, '-PetOnly',
    ], { cwd: root, stdio: 'ignore', windowsHide: true })
    petProc.on('error', (error) => note(`pet spawn failed: ${error.message}`))
    petProc.unref()
  }

  // ---------------- Agent 工具 ----------------
  const tools = ctx.get?.('tools')
  if (cfg.registerTools !== false && tools) {
    const define = (definition) => {
      try {
        const dispose = tools.register(definition)
        ctx.effect(() => dispose)
        note(`tool registered: ${definition.name}`)
      } catch (error) {
        note(`tool register failed ${definition.name}: ${error.message}`)
      }
    }

    const textRender = (args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ]

    define({
      name: 'secretary_agenda',
      description:
        '读取 AI 秘书的真实规划数据库：返回未来 N 天（默认 5 天）的安排、每日负荷、空闲时段、冲突，以及待安排计划池。只读。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '窗口天数 1-14，默认 5', minimum: 1, maximum: 14 },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: textRender },
      execute: async (args) => {
        const days = Math.min(14, Math.max(1, Number(args?.days ?? 5)))
        return await httpCall('GET', `/window?days=${days}`)
      },
    })

    define({
      name: 'secretary_plan_item',
      description:
        '在 AI 秘书里创建一条计划/任务。precision 决定时间精度：year/quarter/month/week/day/slot/unscheduled。' +
        '模糊计划只给区间（startDate/endDate），不要为了存库把年度目标写成某一天；slot 才需要 startTime/endTime（HH:mm）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '标题' },
          kind: { type: 'string', enum: ['goal', 'project', 'phase', 'milestone', 'task'], description: '节点类型，默认 task' },
          precision: {
            type: 'string',
            enum: ['year', 'quarter', 'month', 'week', 'day', 'slot', 'unscheduled'],
            description: '时间精度；拿不准就用 unscheduled',
          },
          startDate: { type: 'string', description: 'YYYY-MM-DD' },
          endDate: { type: 'string', description: 'YYYY-MM-DD（区间终点）' },
          startTime: { type: 'string', description: 'HH:mm（仅 slot）' },
          endTime: { type: 'string', description: 'HH:mm（仅 slot）' },
          priority: { type: 'integer', minimum: 0, maximum: 4, description: '优先级 0-4，默认 2' },
          parentId: { type: 'string', description: '父节点 id（可选）' },
          notes: { type: 'string' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: textRender },
      execute: async (args) => {
        const body = { ...args, source: 'ai' }
        if (!body.kind) body.kind = 'task'
        if (!body.precision) body.precision = 'unscheduled'
        return await httpCall('POST', '/items', body)
      },
    })

    define({
      name: 'secretary_findings',
      description: '读取 AI 秘书对真实计划的冲突与风险分析（时间冲突、截止风险、依赖冲突、负荷过高、目标停滞等）。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['5d', '30d', 'all'], description: '分析范围，默认 5d' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: textRender },
      execute: async (args) => {
        const scope = args?.scope ?? '5d'
        return await httpCall('POST', '/ai/analyze', { scope })
      },
    })

    define({
      name: 'secretary_open',
      description: '在桌面上打开 AI 秘书的时间规划中心窗口（用户可见的桌面应用）。',
      parameters: TOKEN,
      output: { schema: { type: 'object' }, render: textRender },
      execute: async () => {
        const script = join(root, 'app', 'PlanningCenter.ps1')
        if (!existsSync(script)) throw new Error(`找不到 ${script}`)
        const child = spawn('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root,
        ], { cwd: root, stdio: 'ignore', windowsHide: true, detached: true })
        child.unref()
        return { opened: true, script }
      },
    })
  } else if (cfg.registerTools !== false) {
    note('tools service unavailable; skipping tool registration')
  }

  // ---------------- 生命周期 ----------------
  ctx.effect(() => () => {
    note('plugin dispose')
    try {
      if (petProc && petProc.exitCode === null) petProc.kill()
    } catch { /* ignore */ }
    try {
      if (serviceProc && serviceProc.exitCode === null) serviceProc.kill()
    } catch { /* ignore */ }
  })

  void (async () => {
    try {
      const ok = cfg.launchService === false ? Boolean(readBridge()) : await ensureService()
      if (!ok) note('service unavailable; pet will run in degraded mode')
      if (cfg.launchPet !== false) startPet()
    } catch (error) {
      note(`startup failed: ${error?.message || error}`)
    }
  })()

  note(`plugin applied root=${root}`)
}
