import { ServerPoolDashboard } from "@/components/ServerPoolDashboard";
import { ProductShell } from "@/components/ProductShell";

export default function ServerPoolsPage() {
  return (
    <ProductShell>
      <section className="adminPage">
        <header className="page-heading">
          <div>
            <span className="eyebrow">PLATFORM CAPACITY · 后台诊断</span>
            <h1>固定服务器池</h1>
            <p>此页面只用于运维诊断，不是 DeviLudo 产品入口。系统只接受五种池类型。</p>
          </div>
        </header>
        <ServerPoolDashboard />
      </section>
    </ProductShell>
  );
}
