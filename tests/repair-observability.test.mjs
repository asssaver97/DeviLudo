import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeliveryRepairNotice } from "../components/console/DeliveryRepairNotice.tsx";
import { GameDeliveryWorkflow } from "../lib/orchestration/game-delivery.ts";

const candidateSha = "a".repeat(40);

function approvedWorkflow(id) {
  const workflow = new GameDeliveryWorkflow({
    workflowId: id,
    tenantId: "tenant-1",
    projectId: "project-1",
    targetMatrix: ["linux", "windows"],
  });
  workflow.signal({ signalId: `${id}-01`, type: "SPEC_READY", specRevisionId: "SPEC-001" });
  workflow.signal({
    signalId: `${id}-02`, type: "SPEC_APPROVED", approvedSpecRevisionId: "SPEC-APPROVED-001",
    testPlanRevisionId: "PLAN-001", approvalReceiptId: "approval-001",
  });
  workflow.signal({ signalId: `${id}-03`, type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "run-config-original" });
  workflow.signal({ signalId: `${id}-04`, type: "AGENT_STARTED", runId: "run-original" });
  return workflow;
}

function render(snapshot) {
  return renderToStaticMarkup(createElement(DeliveryRepairNotice, { snapshot }));
}

test("repair notice exposes the immutable failed E2E binding and successor lineage", () => {
  const workflow = approvedWorkflow("delivery-repair-ui-e2e");
  workflow.signal({ signalId: "repair-ui-e2e-05", type: "AGENT_COMPLETED", candidateCommitSha: candidateSha, draftPullRequest: 41 });
  workflow.signal({
    signalId: "repair-ui-e2e-06", type: "E2E_FAILED", evidenceBundleId: "evidence-failed-001",
    repairPromptId: "repair:failed-bundle-001",
  });
  workflow.signal({ signalId: "repair-ui-e2e-07", type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: "run-config-repair-001" });

  const html = render(workflow.current());
  assert.match(html, /data-repair-attempt="1"/);
  assert.match(html, /data-repair-reason="E2E_FAILURE"/);
  assert.match(html, /候选矩阵 E2E 失败/);
  assert.match(html, /evidence-failed-001/);
  assert.match(html, /run-config-original/);
  assert.match(html, /run-config-repair-001/);
  assert.match(html, /aaaaaaaaaaaa/);
  assert.match(html, /PR #41/);
  assert.match(html, /repair:failed-bundle-001/);
  assert.match(html, /后继运行中/);
});

test("repair notice distinguishes Agent diagnostics and renders nothing before a failure", () => {
  const workflow = approvedWorkflow("delivery-repair-ui-agent");
  assert.equal(render(workflow.current()), "");

  workflow.signal({ signalId: "repair-ui-agent-05", type: "AGENT_FAILED", diagnosticId: "diagnostic-failed-001" });
  const html = render(workflow.current());
  assert.match(html, /data-repair-reason="AGENT_FAILURE"/);
  assert.match(html, /Agent 终止失败/);
  assert.match(html, /diagnostic-failed-001/);
  assert.match(html, /正在解析新配置/);
  assert.doesNotMatch(html, /失败证据包/);
});

test("repair notice exposes budget exhaustion and a human specification takeover", () => {
  const workflow = approvedWorkflow("delivery-repair-ui-budget");
  workflow.signal({ signalId: "repair-ui-budget-failed-1", type: "AGENT_FAILED", diagnosticId: "diagnostic-budget-1" });
  for (let attempt = 2; attempt <= 3; attempt += 1) {
    workflow.signal({ signalId: `repair-ui-budget-lock-${attempt}`, type: "RUN_CONFIGURATION_LOCKED", lockedRunConfigurationId: `run-config-budget-${attempt}` });
    workflow.signal({ signalId: `repair-ui-budget-start-${attempt}`, type: "AGENT_STARTED", runId: `run-budget-${attempt}` });
    workflow.signal({ signalId: `repair-ui-budget-failed-${attempt}`, type: "AGENT_FAILED", diagnosticId: `diagnostic-budget-${attempt}` });
  }

  const html = render(workflow.current());
  assert.equal(workflow.current().state, "WAITING_SPEC_APPROVAL");
  assert.match(html, /data-repair-attempt="3"/);
  assert.match(html, /等待人工修订/);
  assert.match(html, /三次自动修复额度已耗尽/);
  assert.match(html, /等待新规格/);
  assert.doesNotMatch(html, /后继运行中/);
});
