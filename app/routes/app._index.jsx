import { Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import {
  buildExportPayload,
  parseImportPayload,
  ruleNaturalKey,
} from "../rules.models";
// 应用首页:店铺页面列表(页面/产品/集合 + 首页/全局),入口到各页的埋点规则编辑器,含规则导入导出。
import { useEffect, useRef, useState } from "react";

import { PAGE_TYPE_LABELS as TYPE_LABELS } from "../page-detection";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { useSafeAppBridge } from "../use-safe-app-bridge";

const PAGE_SIZE = 20;

// 各页面类型对应的店铺前台路径(home 为根路径;global 无对应页面不展示跳转)
const STOREFRONT_PATHS = {
  page: "/pages/",
  product: "/products/",
  collection: "/collections/",
};

// 三类可从 Admin API 拉取列表的页面类型(游标分页:向后翻带 after,向前翻带 before)
const LIST_QUERIES = {
  page: {
    field: "pages",
    query: `#graphql
      query Pages($first: Int, $after: String, $last: Int, $before: String) {
        pages(first: $first, after: $after, last: $last, before: $before) {
          edges { node { id title handle } }
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        }
      }`,
  },
  product: {
    field: "products",
    query: `#graphql
      query Products($first: Int, $after: String, $last: Int, $before: String) {
        products(first: $first, after: $after, last: $last, before: $before, query: "status:active") {
          edges { node { id title handle } }
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        }
      }`,
  },
  collection: {
    field: "collections",
    query: `#graphql
      query Collections($first: Int, $after: String, $last: Int, $before: String) {
        collections(first: $first, after: $after, last: $last, before: $before) {
          edges { node { id title handle } }
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        }
      }`,
  },
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);

  // 导出整店规则(JSON,blob 下载);公共组件是模板不算生效规则,不随整店导出
  if (url.searchParams.get("export")) {
    const rules = await db.trackingRule.findMany({
      where: { shop: session.shop, pageType: { not: "component" } },
      orderBy: [
        { pageType: "asc" },
        { sortOrder: "asc" },
        { createdAt: "asc" },
      ],
    });
    return { __export: buildExportPayload(rules) };
  }

  const requestedType = url.searchParams.get("type");
  const type = LIST_QUERIES[requestedType] ? requestedType : "page";

  // 分页:page 从 1 开始;向后翻页带 after 游标,向前翻页带 before 游标;游标丢失时回第一页
  let page = Math.max(1, parseInt(url.searchParams.get("page"), 10) || 1);
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  if (page > 1 && !after && !before) page = 1;

  let items = [];
  let pageInfo = {
    hasNextPage: false,
    hasPreviousPage: false,
    startCursor: null,
    endCursor: null,
  };
  if (LIST_QUERIES[type]) {
    const variables = before
      ? { last: PAGE_SIZE, before }
      : { first: PAGE_SIZE, after: after || null };
    const response = await admin.graphql(LIST_QUERIES[type].query, {
      variables,
    });
    const { data } = await response.json();
    const connection = data[LIST_QUERIES[type].field];
    items = connection.edges.map((edge) => edge.node);
    pageInfo = connection.pageInfo;
  }

  const counts = await db.trackingRule.groupBy({
    by: ["pageType", "pageHandle"],
    where: { shop: session.shop, pageType: { not: "component" } },
    _count: { _all: true },
  });
  const ruleCounts = Object.fromEntries(
    counts.map((count) => [
      `${count.pageType}:${count.pageHandle}`,
      count._count._all,
    ]),
  );

  const [componentCount, setting] = await Promise.all([
    db.trackingRule.count({
      where: { shop: session.shop, pageType: "component" },
    }),
    db.trackingSetting.findUnique({ where: { shop: session.shop } }),
  ]);

  return {
    type,
    items,
    page,
    pageInfo,
    ruleCounts,
    globalCount: ruleCounts["global:"] || 0,
    componentCount,
    gtmId: setting?.gtmId || "",
    shopUrl: `https://${session.shop}`,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  // GA4 接入:保存 GTM 容器 ID(留空 = 不注入,店铺已自接 GTM 时用)
  if (formData.get("intent") === "saveSettings") {
    const gtmId = String(formData.get("gtmId") || "")
      .trim()
      .toUpperCase();
    if (gtmId && !/^GTM-[A-Z0-9]+$/.test(gtmId)) {
      return { error: "GTM 容器 ID 格式不正确,应为 GTM-XXXXXXX" };
    }
    await db.trackingSetting.upsert({
      where: { shop: session.shop },
      update: { gtmId },
      create: { shop: session.shop, gtmId },
    });
    return { saved: true };
  }

  if (formData.get("intent") !== "import") {
    return { error: "未知操作" };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "请选择要导入的 JSON 文件" };
  }

  const { rules, errors } = parseImportPayload(await file.text());
  if (errors) {
    return { error: errors.join("; ").slice(0, 300) };
  }

  const shop = session.shop;
  const replaceAll = formData.get("replaceAll") != null;

  if (replaceAll) {
    await db.trackingRule.deleteMany({ where: { shop } });
    await db.trackingRule.createMany({
      data: rules.map((rule) => ({ ...rule, shop })),
    });
    return { imported: rules.length, skipped: 0, replaced: true };
  }

  // 合并模式:按自然键去重,已存在的跳过
  const existing = await db.trackingRule.findMany({ where: { shop } });
  const existingKeys = new Set(existing.map(ruleNaturalKey));
  const toCreate = rules.filter(
    (rule) => !existingKeys.has(ruleNaturalKey(rule)),
  );
  if (toCreate.length) {
    await db.trackingRule.createMany({
      data: toCreate.map((rule) => ({ ...rule, shop })),
    });
  }
  return {
    imported: toCreate.length,
    skipped: rules.length - toCreate.length,
    replaced: false,
  };
};

// 渲染规则数角标(两种状态都用徽章,视觉权重一致)
function renderRuleCount(count) {
  return count > 0 ? (
    <span className="tp-badge tp-badge--success">{count} 条</span>
  ) : (
    <span className="tp-badge tp-badge--neutral">未配置</span>
  );
}

export default function Index() {
  const {
    type,
    items,
    page,
    pageInfo,
    ruleCounts,
    globalCount,
    componentCount,
    gtmId,
    shopUrl,
  } = useLoaderData();
  const shopify = useSafeAppBridge();
  const revalidator = useRevalidator();

  // GA4 接入保存结果提示
  const settingsFetcher = useFetcher();
  useEffect(() => {
    const result = settingsFetcher.data;
    if (settingsFetcher.state === "idle" && result) {
      if (result.error) {
        shopify?.toast?.show(`保存失败:${result.error}`);
      } else {
        shopify?.toast?.show("GA4 接入配置已保存,店面约 1 分钟内生效");
        revalidator.revalidate();
      }
    }
  }, [settingsFetcher.state, settingsFetcher.data, shopify, revalidator]);

  // 导出:fetcher.load 拿 JSON → blob 触发下载(嵌入式 iframe 里 <a download> 不可靠)
  const exportFetcher = useFetcher();
  const lastExportRef = useRef(null);
  useEffect(() => {
    const payload = exportFetcher.data?.__export;
    if (
      exportFetcher.state === "idle" &&
      payload &&
      lastExportRef.current !== payload
    ) {
      lastExportRef.current = payload;
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `trackpoint-rules-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
      shopify?.toast?.show(`已导出 ${payload.rules.length} 条规则`);
    }
  }, [exportFetcher.state, exportFetcher.data, shopify]);

  // 导入结果提示
  const importFetcher = useFetcher();
  const [importFileName, setImportFileName] = useState("");
  useEffect(() => {
    const result = importFetcher.data;
    if (importFetcher.state === "idle" && result) {
      if (result.error) {
        shopify?.toast?.show(`导入失败:${result.error}`);
      } else {
        shopify?.toast?.show(
          result.replaced
            ? `已替换全部规则,共导入 ${result.imported} 条`
            : `导入完成:新增 ${result.imported} 条,跳过重复 ${result.skipped} 条`,
        );
        revalidator.revalidate();
      }
    }
  }, [importFetcher.state, importFetcher.data, shopify, revalidator]);

  const editHref = (pageType, pageHandle, title) =>
    `/app/rules/${pageType}/${pageHandle || "-"}?title=${encodeURIComponent(title)}`;

  // 行内「页面跳转」目标:拼店铺前台 URL;global 无对应页面返回 null 不渲染按钮
  const storefrontHref = (pageType, handle) => {
    if (pageType === "home") return `${shopUrl}/`;
    const prefix = STOREFRONT_PATHS[pageType];
    return prefix && handle ? `${shopUrl}${prefix}${handle}` : null;
  };

  // 首页/全局是固定单行;其余类型渲染 Admin API 拉回的列表(补上当前筛选的 pageType)
  const fixedRows =
    type === "global"
      ? [{ pageType: "global", handle: "", title: "所有页面(全局规则)" }]
      : type === "home"
        ? [{ pageType: "home", handle: "", title: "首页" }]
        : [];
  const listRows = fixedRows.length
    ? []
    : items.map((item) => ({ ...item, pageType: type }));

  return (
    <div className="tp-page">
      <div className="tp-header">
        <div>
          <h1>埋点管理</h1>
          <p className="tp-sub">
            按页面配置点击 / 接口返回 / 曝光三类规则,改动实时推送到 GA4
            dataLayer(经 GTM 转发)。
          </p>
        </div>
        <div className="tp-header__actions">
          <button
            className="tp-btn"
            onClick={() => exportFetcher.load("/app?export=1")}
            disabled={exportFetcher.state !== "idle"}
          >
            {exportFetcher.state === "idle" ? "导出全部规则" : "导出中…"}
          </button>
        </div>
      </div>

      <div className="tp-stats">
        <div className="tp-stat">
          <div className="tp-stat__num">{globalCount}</div>
          <div className="tp-stat__label">全局规则(对所有页面生效)</div>
        </div>
        <div className="tp-stat">
          <div className="tp-stat__num">{componentCount}</div>
          <div className="tp-stat__label">公共组件(模板,不直接生效)</div>
        </div>
        <div className="tp-stat">
          <div className="tp-stat__num">
            {items.length}
            {pageInfo.hasNextPage ? "+" : ""}
          </div>
          <div className="tp-stat__label">{TYPE_LABELS[type]}</div>
        </div>
      </div>

      <div className="tp-tabs">
        {Object.entries(TYPE_LABELS).map(([value, label]) => (
          <Link
            key={value}
            to={`/app?type=${value}`}
            className={value === type ? "active" : ""}
          >
            {label}
          </Link>
        ))}
      </div>

      <div className="tp-card">
        <div className="tp-card__head">
          <div>
            <h2 className="tp-card__title">页面列表</h2>
            <p className="tp-card__desc">
              点击「编辑埋点」进入对应页面的规则编辑器。
            </p>
          </div>
        </div>
        <table className="tp-table">
          <thead>
            <tr>
              <th>标题</th>
              <th>Handle</th>
              <th>规则数</th>
              <th className="actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {[...fixedRows, ...listRows].map((row) => {
              const jumpHref = storefrontHref(row.pageType, row.handle);
              return (
                <tr key={`${row.pageType}:${row.handle}`}>
                  <td style={{ fontWeight: 500 }}>{row.title || row.handle}</td>
                  <td>
                    <span className="tp-mono">{row.handle || "—"}</span>
                  </td>
                  <td>
                    {renderRuleCount(
                      ruleCounts[`${row.pageType}:${row.handle}`] || 0,
                    )}
                  </td>
                  <td className="actions">
                    {jumpHref && (
                      <button
                        className="tp-btn tp-btn--ghost tp-btn--sm"
                        onClick={() =>
                          window.open(jumpHref, "_blank", "noopener,noreferrer")
                        }
                      >
                        页面跳转 ↗
                      </button>
                    )}
                    <Link
                      className="tp-link"
                      to={editHref(
                        row.pageType,
                        row.handle,
                        row.title || row.handle,
                      )}
                    >
                      编辑埋点 →
                    </Link>
                  </td>
                </tr>
              );
            })}
            {!fixedRows.length && !listRows.length && (
              <tr>
                <td colSpan={4}>
                  <div className="tp-empty">
                    <b>暂无{TYPE_LABELS[type]}</b>
                    该类型下没有可配置的页面
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {!fixedRows.length && (listRows.length > 0 || page > 1) && (
          <div className="tp-pagination">
            {pageInfo.hasPreviousPage ? (
              <Link
                className="tp-btn"
                to={`/app?type=${type}&page=${page - 1}&before=${encodeURIComponent(pageInfo.startCursor)}`}
              >
                上一页
              </Link>
            ) : (
              <button className="tp-btn" disabled>
                上一页
              </button>
            )}
            <span className="tp-muted">
              第 {page} 页 · 每页 {PAGE_SIZE} 条
            </span>
            {pageInfo.hasNextPage ? (
              <Link
                className="tp-btn"
                to={`/app?type=${type}&page=${page + 1}&after=${encodeURIComponent(pageInfo.endCursor)}`}
              >
                下一页
              </Link>
            ) : (
              <button className="tp-btn" disabled>
                下一页
              </button>
            )}
          </div>
        )}
      </div>

      <div className="tp-card">
        <div className="tp-card__head">
          <div>
            <h2 className="tp-card__title">GA4 接入</h2>
            <p className="tp-card__desc">
              填写 GTM 容器 ID 后,应用在店面自动引入 GTM 并转发
              GA4,无需修改主题;店铺已自行接入 GTM 时请留空,避免重复上报。
            </p>
          </div>
          <div className="tp-header__actions">
            {gtmId ? (
              <span className="tp-badge tp-badge--success">已接入 {gtmId}</span>
            ) : (
              <span className="tp-badge tp-badge--neutral">未接入</span>
            )}
          </div>
        </div>
        <div className="tp-card__body">
          <settingsFetcher.Form method="post" className="tp-toolbar">
            <input type="hidden" name="intent" value="saveSettings" />
            <input
              className="tp-input"
              name="gtmId"
              placeholder="GTM-XXXXXXX"
              defaultValue={gtmId}
              style={{ width: 200 }}
            />
            <button
              type="submit"
              className="tp-btn tp-btn--primary"
              disabled={settingsFetcher.state !== "idle"}
            >
              {settingsFetcher.state === "idle" ? "保存" : "保存中…"}
            </button>
            <span className="tp-muted">改动实时下发,无需重新发布主题</span>
          </settingsFetcher.Form>
        </div>
      </div>

      <div className="tp-card">
        <div className="tp-card__head">
          <div>
            <h2 className="tp-card__title">公共组件库</h2>
            <p className="tp-card__desc">
              把反复出现的元素埋点(加购按钮、优惠券接口等)沉淀为组件,在各页面编辑埋点时一键导入复用。
            </p>
          </div>
          <div className="tp-header__actions">
            <Link to="/app/components" className="tp-btn">
              管理公共组件 →
            </Link>
          </div>
        </div>
        {componentCount > 0 && (
          <div className="tp-card__body" style={{ paddingBottom: 16 }}>
            <span className="tp-chip">已创建 {componentCount} 个组件</span>
          </div>
        )}
      </div>

      <div className="tp-card">
        <div className="tp-card__head">
          <div>
            <h2 className="tp-card__title">导入 / 导出</h2>
            <p className="tp-card__desc">
              规则以 JSON 文件在店铺间同步(如 CA/US
              双店)。导出文件不含店铺信息,可直接导入其他店铺。
            </p>
          </div>
        </div>
        <div className="tp-card__body">
          <importFetcher.Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="import" />
            <div className="tp-toolbar">
              <label className="tp-btn" style={{ cursor: "pointer" }}>
                选择 JSON 文件
                <input
                  type="file"
                  name="file"
                  accept=".json,application/json"
                  className="tp-filehide"
                  required
                  onChange={(e) =>
                    setImportFileName(e.target.files?.[0]?.name || "")
                  }
                />
              </label>
              <span
                className="tp-muted"
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 260,
                }}
              >
                {importFileName || "未选择文件"}
              </span>
              <label className="tp-check-label">
                <input type="checkbox" name="replaceAll" className="tp-check" />
                替换全部(先清空本店规则再导入)
              </label>
              <button
                type="submit"
                className="tp-btn tp-btn--primary"
                disabled={importFetcher.state !== "idle"}
                style={{ marginLeft: "auto" }}
              >
                {importFetcher.state === "idle" ? "导入" : "导入中…"}
              </button>
            </div>
          </importFetcher.Form>
        </div>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
