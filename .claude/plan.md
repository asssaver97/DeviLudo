# 基于功能点的 E2E 验收体系设计

## 目标

将当前 E2E 从「盲跑 120 秒」升级为「按功能清单逐项验证」，确保 Agent 生成的游戏每个声明功能都真实可用。

## 现状分析

**当前链路**：
- Agent 收到 `specification.json`（包含 title/vision/coreLoop/acceptanceCriteria）
- Agent 写 Godot 项目到 `/workspace/project`
- E2E 只执行 `--headless --quit-after 120`，退出码 0→PASSED，非 0→FAILED
- 没有验证任何具体功能

**已有基础设施**：
- `fixtures/godot-smoke/tests/e2e.gd` 已实现结构化测试框架：
  - `check(condition, name)` 记录每个断言
  - `DEVILUDO_E2E_RESULT:{"suite":"...","checks":[],"failures":[],"duration_ms":...}` 输出
  - 验证游戏逻辑（collect_ember/pause/damage）、存档往返、性能预算
- Godot 4 支持 `--script res://tests/e2e.gd` 在 headless 模式直接跑测试脚本

## 设计方案

### 1. 协议扩展：测试清单（Test Manifest）

在 `specification.json` 中新增 `testManifest` 字段，Agent 必须根据项目说明文档的功能声明生成：

```json
{
  "title": "余烬群岛",
  "vision": "...",
  "coreLoop": ["识别目标", "操作反馈", "结算进度"],
  "acceptanceCriteria": ["新玩家无需说明即可完成第一局", "..."],
  "testManifest": {
    "schemaVersion": "deviludo.test-manifest.v1",
    "features": [
      {
        "id": "collect-ember",
        "category": "core-loop",
        "description": "玩家可以收集余烬道具，重复收集同一道具会被拒绝",
        "verificationMethod": "unit",
        "gdsTestPath": "res://tests/e2e.gd",
        "checkNames": ["collect-first-ember", "reject-duplicate-ember"]
      },
      {
        "id": "pause-system",
        "category": "player-control",
        "description": "暂停时游戏时间停止流逝",
        "verificationMethod": "unit",
        "gdsTestPath": "res://tests/e2e.gd",
        "checkNames": ["pause-stops-clock"]
      },
      {
        "id": "win-condition",
        "category": "core-loop",
        "description": "收集足够余烬且船体完整时胜利",
        "verificationMethod": "unit",
        "gdsTestPath": "res://tests/e2e.gd",
        "checkNames": ["twenty-minute-core-loop-win"]
      },
      {
        "id": "save-persistence",
        "category": "data-integrity",
        "description": "游戏状态可以保存并原样恢复",
        "verificationMethod": "unit",
        "gdsTestPath": "res://tests/e2e.gd",
        "checkNames": ["save-open-write", "save-open-read", "save-json-valid", "save-round-trip"]
      },
      {
        "id": "headless-performance",
        "category": "runtime-quality",
        "description": "headless 模式下测试套件在 250ms 内完成",
        "verificationMethod": "unit",
        "gdsTestPath": "res://tests/e2e.gd",
        "checkNames": ["headless-performance-budget"]
      }
    ]
  }
}
```

**字段说明**：
- `features[].id` — 功能唯一标识（kebab-case）
- `features[].category` — 分类（core-loop / player-control / data-integrity / runtime-quality / ui / audio）
- `features[].description` — 人类可读的功能描述
- `features[].verificationMethod` — `"unit"`（GDScript 单测）| `"interactive"`（需要输入模拟）| `"visual"`（需要截图对比）
- `features[].gdsTestPath` — GDScript 测试脚本路径（相对于 `res://`）
- `features[].checkNames` — 该功能对应的断言名称列表

### 2. Agent 提示词更新

在 `task-runner.mjs` 的 Agent prompt 中增加：

```
生成的 agent.json 必须包含完整的 testManifest。testManifest.features 必须覆盖项目说明文档中声明的每个核心功能。

每个 feature 必须指定：
- verificationMethod: "unit" — 在 res://tests/e2e.gd 中用 check(condition, name) 实现自动化断言
- checkNames: 该功能对应的所有断言名称，断言名称使用 kebab-case

测试脚本必须：
1. 继承 SceneTree，在 _initialize() 中执行所有测试
2. 每个 check() 对应一个独立的功能验证点
3. 测试结束时输出 print("DEVILUDO_E2E_RESULT:", JSON.stringify({suite, checks, failures, duration_ms}))
4. 用 quit(0 if failures.is_empty() else 1) 退出

参考 fixtures/godot-smoke/tests/e2e.gd 的实现模式。
```

### 3. E2E 执行器升级

#### 3.1 修改 `local-macos-job.mjs`

当前执行：`--headless --quit-after 120`

升级为：
```javascript
// 1. 解压制品后，检查是否存在 agent.json（里面有 testManifest）
const agentJson = await readFile(`${project}/agent.json`, "utf8").catch(() => null);
const manifest = agentJson ? JSON.parse(agentJson).testManifest : null;

// 2. 如果有 testManifest，验证是否有 unit 测试
const unitFeatures = manifest?.features?.filter(f => f.verificationMethod === "unit") ?? [];
const hasTests = unitFeatures.length > 0;

// 3. 决定执行模式
if (hasTests) {
  // 找到主测试脚本（通常是 res://tests/e2e.gd）
  const testScript = unitFeatures[0].gdsTestPath; // 假设都在同一个脚本
  executable = `${executable} --script ${testScript}`;
  // 执行测试，解析 DEVILUDO_E2E_RESULT
  const result = await execute(executable, ["--headless"], { timeout: 180_000, ... });
  const resultMatch = result.stdout.match(/DEVILUDO_E2E_RESULT:(.+)/);
  if (resultMatch) {
    const testResult = JSON.parse(resultMatch[1]);
    // 验证 manifest 中声明的所有 checkNames 是否都被执行
    const declaredChecks = new Set(unitFeatures.flatMap(f => f.checkNames));
    const executedChecks = new Set(testResult.checks);
    const missingChecks = [...declaredChecks].filter(c => !executedChecks.has(c));
    
    if (missingChecks.length > 0) {
      outcome = "FAILED";
      failureDomain = "PRODUCT";
      summary = `Test manifest declared ${missingChecks.length} checks that were not executed: ${missingChecks.join(", ")}`;
    } else if (testResult.failures.length > 0) {
      outcome = "FAILED";
      failureDomain = "PRODUCT";
      summary = `${testResult.failures.length} feature checks failed: ${testResult.failures.join(", ")}`;
      testDetails = testResult; // 包含在 guest 里
    } else {
      outcome = "PASSED";
      summary = `All ${testResult.checks.length} feature checks passed in ${testResult.duration_ms.toFixed(1)}ms`;
      testDetails = testResult;
    }
  } else {
    outcome = "FAILED";
    failureDomain = "PRODUCT";
    summary = "Test script did not output DEVILUDO_E2E_RESULT";
  }
} else {
  // 回退模式：没有测试清单，用旧方式盲跑
  const result = await execute(executable, ["--headless", "--quit-after", "120"], ...);
  outcome = exitCode === 0 ? "PASSED" : "FAILED";
  summary = exitCode === 0 ? "Game started and exited successfully" : `Game exited with code ${exitCode}`;
}
```

#### 3.2 扩展 `deviludo.godot-guest-report.v1` 协议

```json
{
  "schemaVersion": "deviludo.godot-guest-report.v1",
  "action": "test",
  "jobId": "...",
  "inputDigest": "sha256:...",
  "outcome": "PASSED" | "FAILED",
  "failureDomain": null | "PRODUCT",
  "summary": "All 9 feature checks passed in 127.3ms",
  "testDetails": {
    "suite": "deviludo-local-godot-e2e",
    "checks": ["collect-first-ember", "reject-duplicate-ember", "pause-stops-clock", ...],
    "failures": [],
    "duration_ms": 127.3
  },
  "guest": {
    "executor": "native-macos-export",
    "isolation": "DEVELOPMENT_NATIVE",
    "exitCode": 0,
    "stdout": "...",
    "stderr": "..."
  }
}
```

新增 `testDetails` 字段（可选），当有测试清单时填充。

### 4. 修复工作流：E2E 失败时 Agent 修复

当前：E2E 失败 → Agent 收到 `e2eRepairContext`（整个 guest report）

升级后：
- `e2eRepairContext.testDetails.failures` 明确指出哪些功能点失败
- Agent 提示词补充：

```
E2E failure report shows specific feature checks that failed:
${e2eRepairContext.testDetails.failures.join(", ")}

Review the test script at ${manifest中对应的gdsTestPath}, identify which game logic caused each failure, and fix the source code or scene configuration. Do not modify the test assertions unless they are objectively wrong.
```

### 5. UI 展示升级

**ProjectStudio E2E 阶段显示**：

当前只显示「测试中」或「测试通过/失败」。

升级后（当 `E2E_REPORT` artifact 包含 `testDetails` 时）：

```tsx
{artifact.kind === "E2E_REPORT" && artifact.testDetails && (
  <div className="e2e-test-details">
    <div className="test-summary">
      {artifact.testDetails.checks.length} checks · 
      {artifact.testDetails.failures.length === 0 
        ? <span className="passed">全部通过</span>
        : <span className="failed">{artifact.testDetails.failures.length} 项失败</span>
      } · {artifact.testDetails.duration_ms.toFixed(1)}ms
    </div>
    {artifact.testDetails.failures.length > 0 && (
      <ul className="test-failures">
        {artifact.testDetails.failures.map(name => (
          <li key={name}><code>{name}</code></li>
        ))}
      </ul>
    )}
  </div>
)}
```

### 6. 实施步骤

1. **定义协议**（1 个文件）
   - 创建 `lib/product/test-manifest.ts`，导出 TypeScript 类型

2. **更新 Agent 提示词**（2 个文件）
   - `services/sandbox-executor/task-runner.mjs` — runAgent 的 prompt
   - 可选：`services/core/src/product-conversation.ts` — 对话 Agent 也提示生成测试清单

3. **升级 E2E 执行器**（3 个文件）
   - `scripts/executors/local-macos-job.mjs` — 解析 agent.json，执行测试，验证覆盖率
   - `services/e2e-node/src/executor.ts` — 扩展 validateExecutionReceipt 支持 testDetails
   - `deploy/assets/e2e-*-guest-runner.sh` — 生产环境同样逻辑（后续）

4. **更新协议验证**（1 个文件）
   - `services/e2e-node/src/executor.ts` — validateExecutionReceipt 允许 testDetails 可选字段

5. **UI 展示**（1-2 个文件）
   - `components/ProjectStudio.tsx` — 渲染测试详情
   - `lib/product/contracts.ts` — 扩展 ArtifactRecord 类型（可选）

6. **文档和参考**（2 个文件）
   - 更新 `fixtures/godot-smoke/tests/e2e.gd` 加详细注释作为 Agent 参考
   - 更新 `README.md` E2E 章节

## 向后兼容

- 旧项目没有 `testManifest` → E2E 执行器回退到盲跑模式
- 旧协议 `deviludo.godot-guest-report.v1` 不变，只新增可选 `testDetails` 字段
- 不影响现有工作流

## 预期效果

**before**：
```
E2E_TEST → game.app --headless --quit-after 120
         → exit 0 → PASSED (不知道功能是否正常)
         → exit 1 → FAILED "exited with code 1" (不知道哪里错)
```

**after**：
```
E2E_TEST → 读取 agent.json testManifest
         → game.app --headless --script res://tests/e2e.gd
         → 解析 DEVILUDO_E2E_RESULT
         → 验证声明的 9 个 checkNames 全部执行
         → 0 failures → PASSED "All 9 feature checks passed in 127ms"
         → 2 failures → FAILED "2 feature checks failed: save-round-trip, pause-stops-clock"
         → Agent 修复时明确知道哪两个功能点坏了
```

## 风险和缓解

**风险 1**：Agent 生成的 testManifest 不准确，声明了功能但测试脚本里没写对应断言

**缓解**：E2E 执行器强制验证 `declaredChecks ⊆ executedChecks`，缺失的断言会导致 E2E FAILED

**风险 2**：增加 Agent 负担，可能导致生成失败率上升

**缓解**：
- testManifest 生成是结构化的，比自由文本容易
- 可以先在 repair pass 要求更严格的测试，初次生成可以宽松
- 提供清晰的参考实现（godot-smoke）

**风险 3**：interactive/visual 验证方法暂时不实现，功能覆盖不全

**缓解**：
- v1 只实现 `unit` 验证（已经覆盖核心逻辑、存档、性能）
- UI/音效类功能可以先标记 `verificationMethod: "manual"`，E2E 跳过
- 后续版本再补充 Godot 的 Input 模拟和截图对比

## 总结

这个设计：
1. ✅ 让每个游戏功能都有可验证的断言
2. ✅ E2E 失败时给出具体的失败功能点，而不是盲目的退出码
3. ✅ Agent 修复时有精确的目标
4. ✅ 向后兼容，不破坏现有流程
5. ✅ 基于已验证的 Godot 测试模式（fixtures/godot-smoke）
6. ✅ 可增量实施，先上 unit 验证，后续扩展 interactive/visual
