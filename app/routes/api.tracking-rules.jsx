// 店面运行时的规则拉取端点,由 App Proxy(/a/trackpoint)转发到 /api/tracking-rules。
// 同源请求,无需 CORS;Shopify 会附带 HMAC 签名,authenticate.public.appProxy 校验失败抛 400。
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { serializeRule } from "../rules.models";
import { detectPage } from "../page-detection";

const CACHE_HEADERS = { "Cache-Control": "public, max-age=60" };

export async function loader({ request }) {
  const url = new URL(request.url);
  const { session, admin } = await authenticate.public.appProxy(request);

  // 店铺未安装/已卸载应用时没有 session,返回空规则即可,店面脚本静默退出
  if (!session) {
    const empty = url.searchParams.get("resource") === "product" ? { product: null } : { rules: [] };
    return Response.json(empty, { headers: CACHE_HEADERS });
  }

  // 单 app_proxy,用查询参数分发子资源:?resource=product&sku=|handle=|id= 返回实时商品信息
  if (url.searchParams.get("resource") === "product") {
    return productResource(admin, url);
  }

  const shop = url.searchParams.get("shop") || session.shop;
  const path = url.searchParams.get("path") || "/";
  const { type, handle } = detectPage(path);

  const [rules, setting] = await Promise.all([
    db.trackingRule.findMany({
      where: {
        shop,
        enabled: true,
        OR: [{ pageType: "global" }, { pageType: type, pageHandle: handle }],
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    // GA4 接入配置:gtmId 非空时由店面运行时注入 GTM 容器(开箱即用)
    db.trackingSetting.findUnique({ where: { shop } }),
  ]);

  return Response.json(
    { rules: rules.map(serializeRule), gtmId: setting?.gtmId || "" },
    { headers: CACHE_HEADERS },
  );
}

// ---------- ?resource=product:实时商品信息(字段 = rules.models.js 的 PRODUCT_FIELDS) ----------

const PRODUCT_FRAGMENT = `
  fragment ProductFields on Product {
    id handle title productType vendor onlineStoreUrl
    featuredImage { url }
    variants(first: 1) { edges { node { sku title price compareAtPrice } } }
  }`;

// Admin API 的 product(id:) 要求 id 必填且不支持仅按 handle 查,id 直查;handle / sku 走 search 查询
const PRODUCT_BY_ID_QUERY = `#graphql
  query ProductById($id: ID!) {
    product(id: $id) {
      ...ProductFields
    }
  }
  ${PRODUCT_FRAGMENT}`;

const PRODUCTS_BY_SEARCH_QUERY = `#graphql
  query ProductsBySearch($query: String!) {
    products(first: 1, query: $query) {
      edges {
        node {
          ...ProductFields
        }
      }
    }
  }
  ${PRODUCT_FRAGMENT}`;

// gid 数字部分转字符串;Admin API price 是 "124.95" 字符串,GA4 要数字
function flattenProduct(node) {
  if (!node) return null;
  const variant = node.variants?.edges?.[0]?.node || null;
  return {
    id: String(node.id || "").replace(/^gid:\/\/shopify\/Product\//, ""),
    handle: node.handle || "",
    title: node.title || "",
    productType: node.productType || "",
    vendor: node.vendor || "",
    url: node.onlineStoreUrl || `/products/${node.handle}`,
    image: node.featuredImage?.url || "",
    sku: variant?.sku || "",
    variantTitle: variant?.title || "",
    price: variant ? Number(variant.price) || 0 : 0,
    compareAtPrice: variant?.compareAtPrice ? Number(variant.compareAtPrice) || 0 : 0,
  };
}

async function productResource(admin, url) {
  const sku = url.searchParams.get("sku");
  const handle = url.searchParams.get("handle");
  const rawId = url.searchParams.get("id");
  const empty = Response.json({ product: null }, { headers: CACHE_HEADERS });

  if (!admin) return empty; // 离线 session 缺失等场景,静默返回空
  try {
    if (rawId) {
      const gid = /^\d+$/.test(rawId) ? `gid://shopify/Product/${rawId}` : rawId;
      const response = await admin.graphql(PRODUCT_BY_ID_QUERY, {
        variables: { id: gid },
      });
      const { data } = await response.json();
      return Response.json({ product: flattenProduct(data?.product) }, { headers: CACHE_HEADERS });
    }
    const query = sku ? `sku:${JSON.stringify(sku)}` : handle ? `handle:${JSON.stringify(handle)}` : "";
    if (!query) return empty;
    const response = await admin.graphql(PRODUCTS_BY_SEARCH_QUERY, {
      variables: { query },
    });
    const { data } = await response.json();
    return Response.json(
      { product: flattenProduct(data?.products?.edges?.[0]?.node) },
      { headers: CACHE_HEADERS },
    );
  } catch {
    return empty; // 埋点绝不因商品信息查询失败而影响店面
  }
}
