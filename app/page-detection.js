// 从 URL 路径识别页面类型与 handle。
// 注意:extensions/tracking-runtime/assets/tracker.js 里有一份镜像实现,改这里时需同步。

const SEGMENT_TYPE = {
  pages: "page",
  products: "product",
  collections: "collection",
};

export const PAGE_TYPES = ["global", "home", "page", "product", "collection", "component"];

// 公共组件:可复用的埋点模板,不直接生效(detectPage 永远不会返回 component,
// 运行时端点只下发 global + 当前页规则),在编辑埋点页面导入后才会生效。
export const COMPONENT_TYPE = "component";
export const COMPONENT_LABEL = "公共组件";

export const PAGE_TYPE_LABELS = {
  global: "全局(所有页面)",
  home: "首页",
  page: "页面",
  product: "产品",
  collection: "集合",
};

export function isValidPageType(type) {
  return PAGE_TYPES.includes(type);
}

export function detectPage(rawPath) {
  let path = rawPath || "/";
  if (!path.startsWith("/")) path = "/" + path;
  // 去掉 query / hash
  path = path.split("?")[0].split("#")[0];
  // 去掉可选的多语言前缀,如 /en-ca/pages/x 或 /fr/products/y
  const locale = path.match(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/|$)/i);
  if (locale) {
    path = path.slice(locale[0].length) || "/";
  }
  if (path === "/" || path === "") return { type: "home", handle: "" };

  const match = path.match(/^\/(pages|products|collections)\/([^/?#]+)/);
  if (!match) return { type: "other", handle: "" };
  return {
    type: SEGMENT_TYPE[match[1]],
    handle: decodeURIComponent(match[2]),
  };
}
