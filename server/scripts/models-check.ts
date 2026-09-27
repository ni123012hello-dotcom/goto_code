import fs from "node:fs"
import { config } from "../src/config"
import {
  declaredOutput,
  limitsFilePath,
  listModelLimits,
  modelLimits,
  setModelLimits,
} from "../src/agent/models"
import { COMPACTION_BUFFER, limitsForModel, usable } from "../src/agent/overflow"
import { lookupModel, registryIds, registryMeta } from "../src/agent/registry"
import { contextInfo } from "../src/settings"

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${
      ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`
    }`,
  )
}

// models.ts writes to the real store, so back it up and start from empty
const store = limitsFilePath()
const backup = fs.existsSync(store) ? fs.readFileSync(store) : null
fs.rmSync(store, { force: true })

try {
  console.log(`环境: context=${config.contextWindow} output=${config.maxOutputTokens} buffer=${COMPACTION_BUFFER}`)

  console.log("--- 注册表装了什么")
  console.log(`        来源 ${registryMeta()?.source} · ${registryMeta()?.fetchedAt} · ${registryMeta()?.models} 条`)
  check("快照日期存在（UI 要靠它显示新旧）", typeof registryMeta()?.fetchedAt, "string")
  check("id 数量合理", registryIds().length > 3_000, true)

  console.log("--- 没填、注册表也没有 → 全局默认")
  // The registry holds 3678 ids, so "unknown" has to be chosen deliberately. Assert the
  // chosen one really is absent: otherwise a `models:sync` could make this fail for a reason
  // nobody would guess from the failure line.
  const ABSENT = "zzz-not-in-the-registry"
  check("选的这个 id 确实不在注册表里", registryIds().includes(ABSENT), false)
  check("没有这个模型的条目", modelLimits(ABSENT), {})
  check("也没有声明的 output", declaredOutput(ABSENT), undefined)
  const fallback = limitsForModel(ABSENT)
  check("context 回落到全局", fallback.context, config.contextWindow)
  check("output 回落到全局", fallback.maxOutputTokens, config.maxOutputTokens)
  check("input 是合成值（含缓冲）", fallback.inputLimit, config.contextWindow - COMPACTION_BUFFER)
  check("合成路径不重复扣 output", fallback.reserved, 0)
  check("预算 = context - buffer", usable(fallback), config.contextWindow - COMPACTION_BUFFER)
  check("来源标成 default", contextInfo(ABSENT).limitsFrom, "default")

  console.log("--- 注册表只填用户没填的，用户永远优先")
  const known = lookupModel("gpt-4o-mini")
  check("注册表认得 gpt-4o-mini", Boolean(known), true)
  const fromRegistry = limitsForModel("gpt-4o-mini")
  check("context 用注册表的值", fromRegistry.context, known?.limits.context)
  check("output 用注册表的值", fromRegistry.maxOutputTokens, known?.limits.output)
  check("来源标成 registry", contextInfo("gpt-4o-mini").limitsFrom, "registry")
  // gpt-4o-mini's window happens to BE 128000, so the window is not the interesting field
  // here - its output cap (16384) is four times the global default, which is the whole point.
  check("output 确实不是那个全局默认", known?.limits.output !== config.maxOutputTokens, true)
  const wide = lookupModel("claude-sonnet-4-5")
  check("大窗口模型真的拿到更大的窗口", (wide?.limits.context ?? 0) > config.contextWindow, true)

  setModelLimits("gpt-4o-mini", { context: 32_000 })
  const overridden = limitsForModel("gpt-4o-mini")
  check("用户填的 context 赢", overridden.context, 32_000)
  check("用户没填的 output 仍取注册表", overridden.maxOutputTokens, known?.limits.output)
  check("来源标成 user", contextInfo("gpt-4o-mini").limitsFrom, "user")
  setModelLimits("gpt-4o-mini", {}) // 后面要断言磁盘上只有两个条目

  console.log("--- 只填 context")
  setModelLimits("m-ctx-only", { context: 64_000 })
  const ctxOnly = limitsForModel("m-ctx-only")
  check("context 生效", ctxOnly.context, 64_000)
  check("input 按新 context 合成", ctxOnly.inputLimit, 64_000 - COMPACTION_BUFFER)
  check("预算跟着变小", usable(ctxOnly), 64_000 - COMPACTION_BUFFER)

  console.log("--- 填了 input 就是权威值")
  setModelLimits("m-full", { context: 128_000, input: 100_000, output: 8_192 })
  const full = limitsForModel("m-full")
  check("input 用声明的", full.inputLimit, 100_000)
  check("output 用声明的", full.maxOutputTokens, 8_192)
  check("声明路径要扣 output 储备", full.reserved, 8_192)
  check("预算 = input - output", usable(full), 100_000 - 8_192)
  check("declaredOutput 能读到", declaredOutput("m-full"), 8_192)

  console.log("--- 清理脏数据（手改坏了也不能毁掉预算）")
  setModelLimits("m-dirty", { context: -5, input: Number.NaN, output: 0 })
  check("全是无效值 → 不建条目", modelLimits("m-dirty"), {})
  setModelLimits("m-dirty", { context: 12_345.9, output: 3_000 })
  check("小数被取整", modelLimits("m-dirty"), { context: 12_345, output: 3_000 })
  check("模型名首尾空格被去掉", modelLimits("  m-dirty  "), { context: 12_345, output: 3_000 })

  console.log("--- 空字段 = 删除这个条目")
  setModelLimits("m-dirty", {})
  check("条目没了", listModelLimits()["m-dirty"], undefined)
  check("declaredOutput 也没了", declaredOutput("m-dirty"), undefined)

  console.log("--- 落盘并读回")
  const onDisk = JSON.parse(fs.readFileSync(store, "utf8")) as Record<string, unknown>
  check("文件里有两个模型", Object.keys(onDisk).sort(), ["m-ctx-only", "m-full"])
  check("文件里的内容正确", onDisk["m-full"], { context: 128_000, input: 100_000, output: 8_192 })
  check("列表接口一致", Object.keys(listModelLimits()).sort(), ["m-ctx-only", "m-full"])

  console.log("--- 空模型名的边界")
  check("空 id 查不到东西", modelLimits(""), {})
  let threw = false
  try {
    setModelLimits("   ", { context: 1 })
  } catch {
    threw = true
  }
  check("空 id 写入会抛错", threw, true)

  console.log("--- 扫全表：任何一个条目都不能把预算算成 0")
  // The registry caps some models' output ABOVE their own input (deepseek-reasoner is 65536
  // output on a 64000 input). Used directly as the reserve that is a zero budget, and a zero
  // budget means overflowAt() is true on every step, so compaction runs forever. overflow.ts
  // bounds the reserve; this proves the bound holds for all 3678 entries, not just the one
  // we happened to try by hand.
  let zeroBudget = 0
  let small = 0
  let tightest = { id: "", budget: Number.POSITIVE_INFINITY }
  for (const id of registryIds()) {
    const budget = usable(limitsForModel(id))
    if (budget <= 0) zeroBudget += 1
    if (budget > 0 && budget < 4_000) small += 1
    if (budget < tightest.budget) tightest = { id, budget }
  }
  check("没有任何一条算出 <= 0 的预算", zeroBudget, 0)
  console.log(`        最紧的一条：${tightest.id} → ${tightest.budget} tok`)
  // Reported, not asserted: these are genuinely tiny models (TTS, rerankers, image models)
  // that a coding agent has no business using. Seeing the number is enough.
  console.log(`        预算 < 4000 的条目：${small}`)

  console.log("--- 恢复真实文件")
} finally {
  if (backup) fs.writeFileSync(store, backup)
  else fs.rmSync(store, { force: true })
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
