import { ServerPoolDashboard } from "@/components/ServerPoolDashboard";
import { ProductShell } from "@/components/ProductShell";

export default function ServerPoolsPage() {
  return (
    <ProductShell>
      <section className="adminPage">
        <p className="productEyebrow">PLATFORM CAPACITY · 后台诊断</p>
        <h1 className="pageTitle">固定服务器池</h1>
        <p className="pageIntro">
          此页面只用于运维诊断，不是 DeviLudo 产品入口。系统只接受五种池类型。
        </p>
        <ServerPoolDashboard />
      </section>
    </ProductShell>
  );
}
