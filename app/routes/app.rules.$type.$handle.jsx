// 埋点规则编辑器:/app/rules/:type/:handle(global/home 的 handle 为 "-")
// 规则三类:click(选择器点击)/ api_response(接口返回)/ exposure(曝光)
import { useEffect, useRef, useState } from "react";
import { Form, Link, useFetcher, useLoaderData } from "react-router";
import { useSafeAppBridge } from "../use-safe-app-bridge";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { buildExportPayload, PRODUCT_FIELDS, ruleNaturalKey, serializeRule, validateRule } from "../rules.models";
import { PAGE_TYPE_LABELS, isValidPageType } from "../page-detection";

const RULE_TYPE_LABELS = {
  click: "点击",
  api_response: "接口返回",
  exposure: "曝光",
};

// 三类规则徽章各配一色,便于扫读
const RULE_TYPE_BADGE = {
  click: "tp-badge--info",
  api_response: "tp-badge--purple",
  exposure: "tp-badge--teal",
};

const PARAM_SOURCE_LABELS = {
  static: "固定值",
  attr: "元素属性",
  text: "元素文本",
  json_path: "接口响应字段",
  product: "产品信息",
};

const PARAM_TRANSFORM_LABELS = {
  "": "保持原样",
  number: "转数字",
};

export const loader = async ({ request, params }) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shop = session.shop;

  const type = params.type;
  if (!isValidPageType(type)) {
    throw new Response("未知页面类型", { status: 404 });
  }
  const handle = params.handle === "-" ? "" : params.handle;
  if (!["global", "home", "component"].includes(type) && !handle) {
    throw new Response("缺少页面 handle", { status: 404 });
  }

  const where = { shop, pageType: type, pageHandle: handle };

  // 产品绑定选择器的搜索(Admin API → JSON,fetcher.load 消费)
  const searchQuery = url.searchParams.get("product_search");
  if (searchQuery != null) {
    const q = searchQuery.trim();
    if (!q) return { __products: [] };
    const response = await admin.graphql(
      `#graphql
      query ProductPicker($query: String!) {
        products(first: 20, query: $query) {
          edges {
            node {
              id
              title
              handle
              variants(first: 1) {
                edges {
                  node {
                    sku
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { query: q } },
    );
    const { data } = await response.json();
    return {
      __products: (data?.products?.edges || []).map((edge) => ({
        id: String(edge.node.id || "").replace(/^gid:\/\/shopify\/Product\//, ""),
        title: edge.node.title,
        handle: edge.node.handle,
        sku: edge.node.variants?.edges?.[0]?.node?.sku || "",
      })),
    };
  }

  // 单页导出
  if (url.searchParams.get("export")) {
    const rules = await db.trackingRule.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return { __export: buildExportPayload(rules), type, handle };
  }

  const rules = await db.trackingRule.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  // 公共组件列表:供本页导入使用(公共组件页面自身不需要)
  const components =
    type === "component"
      ? []
      : (
          await db.trackingRule.findMany({
            where: { shop, pageType: "component" },
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          })
        ).map(serializeRule);

  return {
    rules: rules.map(serializeRule),
    components,
    type,
    handle,
    title:
      url.searchParams.get("title") ||
      `${PAGE_TYPE_LABELS[type] || "公共组件"}${handle ? ` / ${handle}` : ""}`,
  };
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const type = params.type;
  const handle = params.handle === "-" ? "" : params.handle;
  const formData = await request.formData();
  const intent = formData.get("intent");
  const shop = session.shop;

  // 从公共组件导入:复制组件为本页规则(按自然键跳过重复)
  if (intent === "import_components") {
    if (type === "component") return { error: "不能在公共组件页面导入组件" };
    const ids = formData.getAll("ids").map(String).filter(Boolean);
    if (!ids.length) return { error: "请先勾选要导入的组件" };
    const comps = await db.trackingRule.findMany({
      where: { id: { in: ids }, shop, pageType: "component" },
    });
    if (!comps.length) return { error: "所选组件不存在或已被删除" };
    const existing = await db.trackingRule.findMany({
      where: { shop, pageType: type, pageHandle: handle },
    });
    const existingKeys = new Set(existing.map(ruleNaturalKey));
    const toCreate = comps
      .filter((comp) => !existingKeys.has(ruleNaturalKey({ ...comp, pageType: type, pageHandle })))
      .map((comp) => ({
        name: comp.name,
        eventName: comp.eventName,
        ruleType: comp.ruleType,
        selector: comp.selector,
        urlPattern: comp.urlPattern,
        matchMode: comp.matchMode,
        parameters: comp.parameters,
        options: comp.options,
        sortOrder: comp.sortOrder,
        enabled: true,
        shop,
        pageType: type,
        pageHandle: handle,
      }));
    if (toCreate.length) await db.trackingRule.createMany({ data: toCreate });
    const skipped = comps.length - toCreate.length;
    return {
      ok: true,
      message: `已导入 ${toCreate.length} 条${skipped ? `,跳过重复 ${skipped} 条` : ""}`,
    };
  }

  if (intent === "delete" || intent === "toggle") {
    const id = String(formData.get("id") || "");
    const existing = await db.trackingRule.findFirst({ where: { id, shop } });
    if (!existing) return { error: "规则不存在,可能已被删除" };
    if (intent === "delete") {
      await db.trackingRule.delete({ where: { id } });
      return { ok: true, message: "已删除" };
    }
    await db.trackingRule.update({
      where: { id },
      data: { enabled: !existing.enabled },
    });
    return { ok: true, message: existing.enabled ? "已停用" : "已启用" };
  }

  if (intent !== "create" && intent !== "update") {
    return { error: "未知操作" };
  }

  // options 由 threshold + 产品绑定(productAttr / products)合成,统一过 validateRule 白名单
  const threshold = formData.get("threshold");
  const options = {};
  if (threshold) options.threshold = Number(threshold);
  const productAttr = String(formData.get("productAttr") || "").trim();
  if (productAttr) options.productAttr = productAttr;
  let products = [];
  try {
    products = JSON.parse(formData.get("products") || "[]");
  } catch {
    products = [];
  }
  if (Array.isArray(products) && products.length) options.products = products;

  const { data, errors } = validateRule({
    pageType: type,
    pageHandle: handle,
    name: formData.get("name"),
    eventName: formData.get("eventName"),
    ruleType: formData.get("ruleType"),
    selector: formData.get("selector"),
    urlPattern: formData.get("urlPattern"),
    matchMode: formData.get("matchMode") || "contains",
    parameters: formData.get("parameters") || "[]",
    options: JSON.stringify(options),
  });
  if (errors) return { error: errors.join("; ") };

  if (intent === "update") {
    const id = String(formData.get("id") || "");
    const existing = await db.trackingRule.findFirst({ where: { id, shop } });
    if (!existing) return { error: "规则不存在,可能已被删除" };
    await db.trackingRule.update({ where: { id }, data });
    return { ok: true, message: "已保存" };
  }

  await db.trackingRule.create({
    data: { ...data, shop, pageType: type, pageHandle: handle },
  });
  return { ok: true, message: "已创建" };
};

function emptyParam() {
  return { key: "", source: "static", value: "", transform: "" };
}

export default function RulesEditor() {
  const { rules, components, type, handle, title } = useLoaderData();
  const shopify = useSafeAppBridge();
  const isComponent = type === "component";
  const typeLabel = PAGE_TYPE_LABELS[type] || "公共组件";

  // 编辑器状态: null = 收起;"new" = 新增;规则对象 = 编辑
  const [editing, setEditing] = useState(null);
  const [ruleType, setRuleType] = useState("click");
  const [matchMode, setMatchMode] = useState("contains");
  const [params, setParams] = useState([emptyParam()]);
  const [confirmId, setConfirmId] = useState(null);
  const lastToastRef = useRef(null);

  // 产品绑定状态:搜索词 + 已选产品列表(随表单隐藏域提交)
  const [productQuery, setProductQuery] = useState("");
  const [boundProducts, setBoundProducts] = useState([]);

  const formFetcher = useFetcher();
  const productFetcher = useFetcher();

  const productSearchHref = (q) =>
    `/app/rules/${type}/${handle || "-"}?product_search=${encodeURIComponent(q)}`;

  const searchProducts = () => {
    const q = productQuery.trim();
    if (q.length < 2) return;
    productFetcher.load(productSearchHref(q));
  };

  const addProduct = (product) => {
    setBoundProducts((prev) =>
      prev.some((item) => item.handle === product.handle) ? prev : [...prev, product],
    );
  };

  const removeProduct = (handleToRemove) => {
    setBoundProducts((prev) => prev.filter((item) => item.handle !== handleToRemove));
  };

  const searchResults = productFetcher.data?.__products || [];

  const startCreate = () => {
    setEditing("new");
    setRuleType("click");
    setMatchMode("contains");
    setParams([emptyParam()]);
    setProductQuery("");
    setBoundProducts([]);
  };

  const startEdit = (rule) => {
    setEditing(rule);
    setRuleType(rule.ruleType);
    setMatchMode(rule.matchMode || "contains");
    setParams(
      Array.isArray(rule.parameters) && rule.parameters.length
        ? rule.parameters.map((param) => ({
            key: param.key || "",
            source: param.source || "static",
            value: param.value ?? "",
            transform: param.transform || "",
          }))
        : [emptyParam()],
    );
    setProductQuery("");
    setBoundProducts(
      Array.isArray(rule.options?.products) ? rule.options.products : [],
    );
  };

  // 表单提交结果 → toast + 收起表单
  useEffect(() => {
    const result = formFetcher.data;
    if (formFetcher.state === "idle" && result && lastToastRef.current !== result) {
      lastToastRef.current = result;
      if (result.error) {
        shopify?.toast?.show(`保存失败:${result.error}`);
      } else {
        shopify?.toast?.show(result.message || "已保存");
        setEditing(null);
      }
    }
  }, [formFetcher.state, formFetcher.data, shopify]);

  // 单页导出
  const exportFetcher = useFetcher();
  const lastExportRef = useRef(null);
  useEffect(() => {
    const payload = exportFetcher.data?.__export;
    if (exportFetcher.state === "idle" && payload && lastExportRef.current !== payload) {
      lastExportRef.current = payload;
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `trackpoint-rules-${type}-${handle || type}-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
      shopify?.toast?.show(`已导出 ${payload.rules.length} 条规则`);
    }
  }, [exportFetcher.state, exportFetcher.data, shopify, type, handle]);

  const updateParam = (index, field, value) => {
    setParams((prev) =>
      prev.map((param, i) => (i === index ? { ...param, [field]: value } : param)),
    );
  };

  const editingRule = editing && editing !== "new" ? editing : null;
  const formKey = editingRule?.id || "new";
  const exportUrl = `/app/rules/${type}/${handle || "-"}?export=1`;

  const busy = formFetcher.state !== "idle";

  return (
    <div className="tp-page">
      <div className="tp-header">
        <div>
          <Link to="/app" className="tp-back">
            ← 返回页面列表
          </Link>
          <h1>{isComponent ? "公共组件库" : `埋点规则:${title}`}</h1>
          <p className="tp-sub">
            {isComponent
              ? "组件是可复用的埋点模板,不会直接生效;在各页面的「编辑埋点」里导入后生效。"
              : `${typeLabel} · 点击 / 接口返回 / 曝光三类规则,改动实时推送到 GA4 dataLayer。`}
          </p>
        </div>
        <div className="tp-header__actions">
          <button className="tp-btn" onClick={() => exportFetcher.load(exportUrl)}>
            导出本页规则
          </button>
          <button className="tp-btn tp-btn--primary" onClick={startCreate}>
            {isComponent ? "新增公共组件" : "新增规则"}
          </button>
        </div>
      </div>

      {isComponent && (
        <div className="tp-banner tp-banner--info">
          公共组件是可复用的埋点模板,保存在这里不会直接生效;到具体页面的「编辑埋点」里导入后,才会成为该页的规则生效。
        </div>
      )}

      <div className="tp-card">
        <div className="tp-card__head">
          <div>
            <h2 className="tp-card__title">{isComponent ? "组件列表" : "规则列表"}</h2>
            <p className="tp-card__desc">
              共 {rules.length} 条
              {!isComponent && rules.length
                ? `,启用 ${rules.filter((rule) => rule.enabled).length} 条`
                : ""}
            </p>
          </div>
        </div>
        <table className="tp-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>事件名</th>
              <th>类型</th>
              <th>目标</th>
              {!isComponent && <th>状态</th>}
              <th className="actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id} style={rule.enabled || isComponent ? undefined : { opacity: 0.55 }}>
                <td style={{ fontWeight: 500 }}>{rule.name}</td>
                <td className="tp-mono" style={{ maxWidth: 160 }}>
                  {rule.eventName}
                </td>
                <td>
                  <span className={`tp-badge ${RULE_TYPE_BADGE[rule.ruleType] || "tp-badge--info"}`}>
                    {RULE_TYPE_LABELS[rule.ruleType]}
                  </span>
                </td>
                <td>
                  <span className="tp-mono">{rule.selector || rule.urlPattern}</span>
                </td>
                {!isComponent && (
                  <td>
                    {rule.enabled ? (
                      <span className="tp-badge tp-badge--success">启用</span>
                    ) : (
                      <span className="tp-badge tp-badge--critical">停用</span>
                    )}
                  </td>
                )}
                <td className="actions">
                  {!isComponent && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="toggle" />
                      <input type="hidden" name="id" value={rule.id} />
                      <button type="submit" className="tp-btn tp-btn--ghost tp-btn--sm">
                        {rule.enabled ? "停用" : "启用"}
                      </button>
                    </Form>
                  )}
                  <button
                    type="button"
                    className="tp-btn tp-btn--ghost tp-btn--sm"
                    onClick={() => startEdit(rule)}
                  >
                    编辑
                  </button>
                  {confirmId === rule.id ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={rule.id} />
                      <button type="submit" className="tp-btn tp-btn--danger tp-btn--sm">
                        确认删除?
                      </button>
                    </Form>
                  ) : (
                    <button
                      type="button"
                      className="tp-btn tp-btn--danger tp-btn--sm"
                      onClick={() => setConfirmId(rule.id)}
                    >
                      删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!rules.length && (
              <tr>
                <td colSpan={isComponent ? 5 : 6}>
                  <div className="tp-empty">
                    <b>{isComponent ? "暂无公共组件" : "暂无规则"}</b>
                    {isComponent
                      ? "点击右上角「新增公共组件」,把反复出现的埋点沉淀成模板"
                      : "点击「新增规则」,或从下方公共组件一键导入"}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!isComponent && (
        <div className="tp-card">
          <div className="tp-card__head">
            <div>
              <h2 className="tp-card__title">从公共组件导入</h2>
              <p className="tp-card__desc">
                勾选需要的组件导入本页,导入后立即参与埋点;与本页已有规则重复的自动跳过。
              </p>
            </div>
          </div>
          <div className="tp-card__body">
            {components.length ? (
              <formFetcher.Form method="post">
                <input type="hidden" name="intent" value="import_components" />
                <div className="tp-component-list">
                  {components.map((comp) => (
                    <label key={comp.id} className="tp-component-row">
                      <input type="checkbox" name="ids" value={comp.id} className="tp-check" />
                      <span className={`tp-badge ${RULE_TYPE_BADGE[comp.ruleType] || "tp-badge--info"}`}>
                        {RULE_TYPE_LABELS[comp.ruleType]}
                      </span>
                      <span className="tp-name">{comp.name}</span>
                      <code className="tp-code">{comp.selector || comp.urlPattern}</code>
                      <span className="tp-muted">{comp.eventName}</span>
                    </label>
                  ))}
                </div>
                <div className="tp-toolbar" style={{ marginTop: 14 }}>
                  <button type="submit" className="tp-btn tp-btn--primary" disabled={busy}>
                    {busy ? "导入中…" : `导入所选到本页`}
                  </button>
                </div>
              </formFetcher.Form>
            ) : (
              <p className="tp-muted" style={{ margin: 0 }}>
                还没有公共组件。先去
                <Link to="/app/components" className="tp-link">
                  公共组件库
                </Link>
                把店铺里反复出现的元素埋点(如加购按钮、优惠券接口)沉淀成模板,各页面一键复用。
              </p>
            )}
          </div>
        </div>
      )}

      {editing && (
        <div className="tp-card">
          <div className="tp-card__head">
            <div>
              <h2 className="tp-card__title">
                {editingRule ? `编辑:${editingRule.name}` : isComponent ? "新增公共组件" : "新增规则"}
              </h2>
              <p className="tp-card__desc">
                {isComponent
                  ? "组件定义与规则一致,只是不直接生效"
                  : "保存后立即生效(店面规则缓存约 1 分钟)"}
              </p>
            </div>
          </div>
          <div className="tp-card__body">
            <formFetcher.Form method="post" key={formKey}>
              <input type="hidden" name="intent" value={editingRule ? "update" : "create"} />
              {editingRule && <input type="hidden" name="id" value={editingRule.id} />}
              <input type="hidden" name="ruleType" value={ruleType} />
              <input type="hidden" name="matchMode" value={matchMode} />
              <input type="hidden" name="parameters" value={JSON.stringify(params)} />

              <div className="tp-form-grid">
                <label className="tp-field">
                  <span className="tp-field__label">规则名称</span>
                  <input
                    className="tp-input"
                    name="name"
                    defaultValue={editingRule?.name || ""}
                    placeholder="如:Banner Shop Now 按钮"
                    required
                  />
                </label>
                <label className="tp-field">
                  <span className="tp-field__label">GA4 事件名(event_name)</span>
                  <input
                    className="tp-input"
                    name="eventName"
                    defaultValue={editingRule?.eventName || ""}
                    placeholder="如:select_item"
                    required
                  />
                </label>
              </div>

              <div className="tp-field" style={{ marginTop: 14 }}>
                <span className="tp-field__label">{isComponent ? "组件类型" : "埋点类型"}</span>
                <div className="tp-seg">
                  {Object.entries(RULE_TYPE_LABELS).map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={ruleType === value ? "is-active" : ""}
                      onClick={() => setRuleType(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {ruleType !== "api_response" && (
                <label className="tp-field" style={{ marginTop: 14 }}>
                  <span className="tp-field__label">CSS 选择器</span>
                  <input
                    className="tp-input"
                    name="selector"
                    defaultValue={editingRule?.selector || ""}
                    placeholder="如:.section-home-slideshow .slideshow-btn"
                    required
                  />
                  <span className="tp-field__hint">
                    匹配要埋点的元素,支持逗号分隔多个;建议只保留稳定的类名,不要带动画状态类。
                  </span>
                </label>
              )}

              {ruleType === "api_response" && (
                <div className="tp-form-grid" style={{ marginTop: 14 }}>
                  <label className="tp-field">
                    <span className="tp-field__label">接口 URL 匹配模式</span>
                    <input
                      className="tp-input"
                      name="urlPattern"
                      defaultValue={editingRule?.urlPattern || ""}
                      placeholder="如:/cart.js 或 /cart/add"
                      required
                    />
                  </label>
                  <div className="tp-field">
                    <span className="tp-field__label">匹配方式</span>
                    <div className="tp-seg">
                      <button
                        type="button"
                        className={matchMode === "contains" ? "is-active" : ""}
                        onClick={() => setMatchMode("contains")}
                      >
                        包含匹配
                      </button>
                      <button
                        type="button"
                        className={matchMode === "regex" ? "is-active" : ""}
                        onClick={() => setMatchMode("regex")}
                      >
                        正则匹配
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {ruleType === "exposure" && (
                <label className="tp-field" style={{ marginTop: 14, maxWidth: 260 }}>
                  <span className="tp-field__label">曝光阈值(元素可见面积比例 0~1)</span>
                  <input
                    className="tp-input"
                    name="threshold"
                    type="number"
                    step="0.05"
                    min="0.05"
                    max="1"
                    defaultValue={
                      editingRule?.options?.threshold != null
                        ? String(editingRule.options.threshold)
                        : "0.5"
                    }
                  />
                </label>
              )}

              {ruleType !== "api_response" && (
                <div className="tp-params-box" style={{ marginTop: 16 }}>
                  <div className="tp-params-head">
                    <div>
                      <h3 className="tp-card__title" style={{ fontSize: 13 }}>
                        产品信息绑定(可选)
                      </h3>
                      <p className="tp-card__desc">
                        参数取值方式选「产品信息」时使用:命中元素后按产品标识实时获取商品数据,
                        后台改了商品信息,埋点数据自动跟着更新。
                      </p>
                    </div>
                  </div>
                  <div className="tp-form-grid">
                    <label className="tp-field">
                      <span className="tp-field__label">产品 ID 属性名</span>
                      <input
                        className="tp-input"
                        name="productAttr"
                        defaultValue={editingRule?.options?.productAttr || ""}
                        placeholder="data-sku"
                      />
                      <span className="tp-field__hint">
                        元素(或其祖先)上带产品标识的属性名。留空自动依次尝试 data-sku、data-product-id、链接里的 /products/handle。
                      </span>
                    </label>
                    <div className="tp-field">
                      <span className="tp-field__label">限定产品(可多选)</span>
                      <div className="tp-product-search">
                        <input
                          className="tp-input"
                          placeholder="搜索产品标题 / handle / SKU"
                          value={productQuery}
                          onChange={(e) => setProductQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault(); // 阻止回车提交整个规则表单
                              searchProducts();
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="tp-btn tp-btn--sm"
                          onClick={searchProducts}
                          disabled={productFetcher.state !== "idle"}
                        >
                          {productFetcher.state === "idle" ? "搜索" : "搜索中…"}
                        </button>
                      </div>
                      {!!searchResults.length && (
                        <div className="tp-product-results">
                          {searchResults.map((product) => {
                            const bound = boundProducts.some(
                              (item) => item.handle === product.handle,
                            );
                            return (
                              <div key={product.handle} className="tp-product-row">
                                <span className="tp-name">{product.title}</span>
                                <span className="tp-muted tp-mono" style={{ maxWidth: 180 }}>
                                  {product.handle}
                                </span>
                                {product.sku && <code className="tp-code">{product.sku}</code>}
                                <button
                                  type="button"
                                  className="tp-btn tp-btn--sm tp-product-add"
                                  disabled={bound}
                                  onClick={() => addProduct(product)}
                                >
                                  {bound ? "已添加" : "+ 添加"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {!!boundProducts.length && (
                        <div className="tp-chips">
                          {boundProducts.map((product) => (
                            <span key={product.handle} className="tp-chip">
                              {product.title || product.handle}
                              <button
                                type="button"
                                className="tp-chip__x"
                                aria-label="移除产品"
                                onClick={() => removeProduct(product.handle)}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <span className="tp-field__hint">
                        {boundProducts.length
                          ? `已限定 ${boundProducts.length} 个产品:页面加载即预取其信息,点击瞬间带出数据;其他产品不触发本规则。`
                          : "未选择 = 不限范围,命中任何带产品标识的元素都会触发(信息在点击时实时获取)。"}
                      </span>
                    </div>
                  </div>
                  <input type="hidden" name="products" value={JSON.stringify(boundProducts)} />
                </div>
              )}

              <div className="tp-params-box" style={{ marginTop: 16 }}>
                <div className="tp-params-head">
                  <div>
                    <h3 className="tp-card__title" style={{ fontSize: 13 }}>
                      事件参数(event_parameters)
                    </h3>
                    <p className="tp-card__desc">
                      固定值 = 直接填;元素属性 = 填 attribute 名(如 data-sku);元素文本 =
                      取元素文本;接口响应字段 = 填响应 JSON 路径(如 items.0.id,仅接口返回类型可用);
                      产品信息 = 下拉选择商品字段(点击/曝光类型,需在上方绑定产品)。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="tp-btn tp-btn--sm"
                    onClick={() => setParams((prev) => [...prev, emptyParam()])}
                  >
                    + 添加参数
                  </button>
                </div>
                {params.map((param, index) => (
                  <div key={index} className="tp-param-row">
                    <input
                      className="tp-input"
                      placeholder="参数名,如 button_name"
                      value={param.key}
                      onChange={(e) => updateParam(index, "key", e.target.value)}
                    />
                    <select
                      className="tp-select"
                      value={param.source}
                      onChange={(e) => {
                        const source = e.target.value;
                        // 切到产品信息时,当前值不是已知字段则清空待选
                        setParams((prev) =>
                          prev.map((item, i) =>
                            i === index
                              ? {
                                  ...item,
                                  source,
                                  value:
                                    source === "product" &&
                                    !PRODUCT_FIELDS.some((field) => field.value === item.value)
                                      ? ""
                                      : item.value,
                                }
                              : item,
                          ),
                        );
                      }}
                    >
                      {Object.entries(PARAM_SOURCE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {param.source === "product" ? (
                      <select
                        className="tp-select"
                        value={param.value}
                        onChange={(e) => updateParam(index, "value", e.target.value)}
                      >
                        <option value="">选择产品字段…</option>
                        {PRODUCT_FIELDS.map((field) => (
                          <option key={field.value} value={field.value}>
                            {field.label}
                          </option>
                        ))}
                        {param.value && !PRODUCT_FIELDS.some((field) => field.value === param.value) && (
                          <option value={param.value}>{param.value}</option>
                        )}
                      </select>
                    ) : (
                      <input
                        className="tp-input"
                        placeholder="值 / 属性名 / JSON 路径"
                        value={param.value}
                        onChange={(e) => updateParam(index, "value", e.target.value)}
                      />
                    )}
                    <select
                      className="tp-select"
                      value={param.transform}
                      onChange={(e) => updateParam(index, "transform", e.target.value)}
                    >
                      {Object.entries(PARAM_TRANSFORM_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="tp-btn tp-btn--danger tp-btn--sm"
                      onClick={() =>
                        setParams((prev) =>
                          prev.length > 1 ? prev.filter((_, i) => i !== index) : prev,
                        )
                      }
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>

              <div className="tp-toolbar" style={{ marginTop: 16, justifyContent: "flex-end" }}>
                <button type="button" className="tp-btn" onClick={() => setEditing(null)}>
                  取消
                </button>
                <button type="submit" className="tp-btn tp-btn--primary" disabled={busy}>
                  {busy ? "提交中…" : editingRule ? "保存修改" : "创建规则"}
                </button>
              </div>
            </formFetcher.Form>
          </div>
        </div>
      )}
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
