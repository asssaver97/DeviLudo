"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import type { SteamDeliveryPreparation } from "@/lib/product/contracts";
import { RerunIcon } from "./console/Icons";
import { useLanguage } from "./i18n/LanguageProvider";

export function SteamPreparationNode(props: Readonly<{
  projectId: string;
  workflowId: string;
  workflowState: string;
  readOnly: boolean;
  onChanged: () => Promise<void>;
}>) {
  const { errorText, text } = useLanguage();
  const [preparation, setPreparation] = useState<SteamDeliveryPreparation | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/projects/${encodeURIComponent(props.projectId)}/steam-preparation?workflowId=${encodeURIComponent(props.workflowId)}`, { cache: "no-store", signal });
    const payload = await response.json() as { preparation?: SteamDeliveryPreparation | null; message?: string };
    if (!response.ok) throw new Error(errorText(payload.message, "Steam 商店准备状态读取失败", "Unable to load Steam preparation"));
    if (!signal?.aborted) setPreparation(payload.preparation ?? null);
  }, [errorText, props.projectId, props.workflowId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal)
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason)); }), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);
  useEffect(() => {
    if (!preparation || !["DRAFTING", "GENERATING_ASSETS", "SYNCING"].includes(preparation.state)) return;
    const interval = window.setInterval(() => void load().catch(() => undefined), 2500);
    return () => window.clearInterval(interval);
  }, [load, preparation]);

  const view = useMemo(() => preparationView(preparation, props.workflowState, text), [preparation, props.workflowState, text]);
  async function retry() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(props.projectId)}/steam-preparation/retry`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ workflowId: props.workflowId }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(errorText(payload.message, "准备节点重试失败", "Unable to retry preparation"));
      await Promise.all([load(), props.onChanged()]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return (
    <fieldset className="product-delivery-steam-group">
      <legend><span>{text("商店与 Depot", "STORE & DEPOTS")}</span><small>{text("E2E 通过后保存到 Steamworks", "SAVE TO STEAMWORKS AFTER E2E")}</small></legend>
      <ol className="product-delivery-material-stages product-delivery-steam-stages">
        <li className={`product-delivery-stage product-delivery-material-stage status-${view.kind}`} data-stage-kind="STEAM_PREPARATION" data-stage-status={view.kind}>
          <button aria-expanded={expanded} className="product-delivery-material-disclosure" onClick={() => setExpanded(value => !value)} type="button">
            <span aria-hidden="true" className="product-delivery-stage-marker">{view.symbol}</span>
            <b>{text("商店与 Depot", "STORE & DEPOTS")}</b><strong>{view.label}</strong>
            <small>{expanded ? text("收起准备详情", "HIDE PREPARATION") : text("查看准备详情", "VIEW PREPARATION")}</small>
          </button>
          {!props.readOnly && preparation && ["FAILED", "LOGIN_REQUIRED"].includes(preparation.state) ? (
            <button aria-label={text("重试商店与 Depot 准备", "Retry Store & Depots preparation")} className="product-delivery-stage-rerun-icon" disabled={busy} onClick={() => void retry()} type="button"><RerunIcon /></button>
          ) : null}
        </li>
      </ol>
      {expanded ? <SteamPreparationDetails preparation={preparation} readOnly={props.readOnly} text={text} /> : null}
      {error ? <p className="repository-onboarding-error" role="alert">{error}</p> : null}
    </fieldset>
  );
}

function SteamPreparationDetails(props: Readonly<{ preparation: SteamDeliveryPreparation | null; readOnly: boolean; text: (zh: string, en: string) => string }>) {
  const { preparation, text } = props;
  if (!preparation) return <div className="steam-preparation-detail"><p>{text("等待本轮发布批准。批准后会自动生成文案与素材，并保存到 Steamworks。", "Waiting for release approval. Copy and assets will be generated and saved to Steamworks automatically.")}</p></div>;
  const draft = preparation.draft ?? {};
  const tags = Array.isArray(draft.tags) ? draft.tags.length : 0;
  const categories = Array.isArray(draft.categories) ? draft.categories.length : 0;
  const requirements = Array.isArray(draft.systemRequirements) ? draft.systemRequirements.length : 0;
  const receiptFields = Array.isArray(preparation.receipt?.savedFields) ? preparation.receipt.savedFields.length : 0;
  const receiptAssets = Array.isArray(preparation.receipt?.assets) ? preparation.receipt.assets.length : 0;
  return <div className="steam-preparation-detail">
    {props.readOnly ? <p className="product-iteration-readonly-notice">{text("这是该历史轮次保存的草稿与回执。", "This is the draft and receipt saved for this historical iteration.")}</p> : null}
    <dl>
      <div><dt>{text("源码修订", "Source revision")}</dt><dd>r{preparation.sourceRevision}</dd></div>
      <div><dt>{text("草稿版本", "Draft revision")}</dt><dd>v{preparation.draftRevision}</dd></div>
      <div><dt>{text("生成语言", "Languages")}</dt><dd>{preparation.generatedLanguages.join(", ") || "—"}</dd></div>
      <div><dt>{text("字段摘要", "Fields")}</dt><dd>{tags} tags · {categories} categories · {requirements} OS</dd></div>
      <div><dt>App ID</dt><dd>{preparation.validatedIds?.appId ?? "—"}</dd></div>
      <div><dt>Depot IDs</dt><dd>{preparation.validatedIds ? Object.entries(preparation.validatedIds.depots).map(([os, id]) => `${os}:${id}`).join(" · ") : "—"}</dd></div>
      <div><dt>{text("浏览器会话", "Browser session")}</dt><dd>{preparation.browserSession.state}</dd></div>
      <div><dt>{text("保存回执", "Save receipt")}</dt><dd>{preparation.receipt
        ? `${String(preparation.receipt.savedAt ?? preparation.savedAt ?? "SAVED")} · ${String(preparation.receipt.adapterVersion ?? "adapter unknown")} · ${receiptFields} fields · ${receiptAssets} assets`
        : "—"}</dd></div>
    </dl>
    {preparation.assets.length ? <div className="steam-preparation-assets">{preparation.assets.map(asset => <figure key={asset.id}>{asset.previewUrl ? <Image alt={asset.key} height={asset.height} src={asset.previewUrl} unoptimized width={asset.width} /> : <span aria-hidden="true">IMG</span>}<figcaption>{asset.key}<small>{asset.width}×{asset.height}</small></figcaption></figure>)}</div> : null}
    {preparation.failureMessage ? <div className="inline-notice danger"><strong>{preparation.failureCode}</strong><p>{preparation.failureMessage}</p></div> : null}
  </div>;
}

function preparationView(preparation: SteamDeliveryPreparation | null, workflowState: string, text: (zh: string, en: string) => string) {
  if (!preparation) return { kind: "pending", symbol: "—", label: text("等待发布批准", "AWAITING APPROVAL") } as const;
  const views = {
    PENDING: { kind: "pending", symbol: "—", label: text("等待发布批准", "AWAITING APPROVAL") },
    DRAFTING: { kind: "active", symbol: "↻", label: text("Agent 生成中", "AGENT DRAFTING") },
    GENERATING_ASSETS: { kind: "active", symbol: "↻", label: text("素材生成中", "GENERATING ASSETS") },
    SYNCING: { kind: "active", symbol: "↻", label: text("正在填写 Steamworks", "FILLING STEAMWORKS") },
    LOGIN_REQUIRED: { kind: "failed", symbol: "!", label: text("需要登录", "LOGIN REQUIRED") },
    FAILED: { kind: "failed", symbol: "!", label: text("填写失败", "SAVE FAILED") },
    SAVED: { kind: "completed", symbol: "✓", label: text("已保存", "SAVED") },
  } as const;
  void workflowState;
  return views[preparation.state];
}
