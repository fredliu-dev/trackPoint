// 埋点规则的序列化 / 校验 / 导入导出。
// parameters 与 options 以 JSON 字符串存 Prisma(SQLite 上 Json 类型不稳),进出统一在这里转换。

import { isValidPageType } from "./page-detection";

export const RULE_TYPES = ["click", "api_response", "exposure"];
export const PARAM_SOURCES = ["static", "attr", "text", "json_path", "product"];

// 产品信息参数的可选字段(value = 代理端点返回的展平对象键,支持 dot-path)
export const PRODUCT_FIELDS = [
  { value: "sku", label: "SKU(item_id)" },
  { value: "title", label: "商品标题(item_name)" },
  { value: "price", label: "售价" },
  { value: "compareAtPrice", label: "原价" },
  { value: "productType", label: "产品类型" },
  { value: "vendor", label: "品牌" },
  { value: "variantTitle", label: "规格(变体名)" },
  { value: "handle", label: "Handle" },
  { value: "id", label: "商品 ID" },
  { value: "url", label: "商品链接" },
  { value: "image", label: "主图链接" },
];
export const IMPORT_FORMAT = "trackpoint-rules";
export const IMPORT_VERSION = 1;
const MAX_RULES_PER_IMPORT = 2000;
const MAX_PRODUCTS_PER_RULE = 50;

const DEFAULT_OPTIONS = { threshold: 0.5, capture: false };

function parseJSONSafe(text, fallback) {
  if (text == null || text === "") return fallback;
  if (typeof text === "object") return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// Prisma 记录 → 端点/前端可用的对象(parameters/options 解析为对象)
export function serializeRule(record) {
  return {
    id: record.id,
    pageType: record.pageType,
    pageHandle: record.pageHandle,
    name: record.name,
    eventName: record.eventName,
    ruleType: record.ruleType,
    selector: record.selector || "",
    urlPattern: record.urlPattern || "",
    matchMode: record.matchMode,
    enabled: record.enabled,
    parameters: parseJSONSafe(record.parameters, []),
    options: parseJSONSafe(record.options, {}),
    sortOrder: record.sortOrder,
  };
}

// 表单/导入的规则对象 → 可写库的字段;校验失败返回 { errors }
export function validateRule(input) {
  const errors = [];
  const name = String(input.name || "").trim();
  const eventName = String(input.eventName || "").trim();
  const ruleType = String(input.ruleType || "").trim();
  const selector = String(input.selector || "").trim();
  const urlPattern = String(input.urlPattern || "").trim();
  const matchMode = String(input.matchMode || "contains").trim();
  const pageType = String(input.pageType || "").trim();
  const pageHandle = String(input.pageHandle || "").trim();

  if (!name) errors.push("规则名称不能为空");
  if (!eventName) errors.push("事件名(event_name)不能为空");
  if (!RULE_TYPES.includes(ruleType)) errors.push(`埋点类型必须是 ${RULE_TYPES.join(" / ")} 之一`);
  if (!isValidPageType(pageType)) errors.push("页面类型不合法");
  if (pageType === "global" || pageType === "home" || pageType === "component") {
    if (pageHandle) errors.push("首页/全局/公共组件的 pageHandle 必须为空");
  } else if (!pageHandle) {
    errors.push("该页面类型的 handle 不能为空");
  }

  if (ruleType === "click" || ruleType === "exposure") {
    if (!selector) errors.push("点击/曝光规则必须填写 CSS 选择器");
  }
  if (ruleType === "api_response") {
    if (!urlPattern) errors.push("接口返回规则必须填写 URL 匹配模式");
    if (matchMode === "regex") {
      try {
        new RegExp(urlPattern);
      } catch {
        errors.push("URL 正则表达式无效");
      }
    }
  }
  // CSS 选择器不做服务端校验:运行时 closest() 失配即静默跳过,不会伤害店面

  // parameters:[{key, source, value, transform?}]
  const parameters = parseJSONSafe(input.parameters, null);
  if (!Array.isArray(parameters)) {
    errors.push("参数列表格式错误");
  } else {
    const seenKeys = new Set();
    parameters.forEach((param, index) => {
      const key = String(param?.key || "").trim();
      if (!key) errors.push(`第 ${index + 1} 个参数缺少 key`);
      if (seenKeys.has(key)) errors.push(`参数 key 重复:${key}`);
      seenKeys.add(key);
      if (!PARAM_SOURCES.includes(param?.source)) {
        errors.push(`参数 ${key || index + 1} 的取值方式不合法`);
      }
      if (param?.source === "product" && !String(param?.value || "").trim()) {
        errors.push(`参数 ${key || index + 1} 使用产品信息时必须选择字段`);
      }
    });
  }

  // options:{threshold?, capture?}
  let options = parseJSONSafe(input.options, {});
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    errors.push("options 格式错误");
    options = {};
  }
  const cleanOptions = {};
  if (options.threshold != null) {
    const threshold = Number(options.threshold);
    if (Number.isNaN(threshold) || threshold <= 0 || threshold > 1) {
      errors.push("曝光阈值必须是 0~1 之间的小数");
    } else {
      cleanOptions.threshold = threshold;
    }
  }
  if (options.capture) cleanOptions.capture = true;

  // 产品绑定:productAttr = 元素上读产品标识的属性名;products = 限定生效范围的白名单(空 = 不限)
  const productAttr = String(options.productAttr || "").trim();
  if (productAttr) cleanOptions.productAttr = productAttr;
  if (Array.isArray(options.products)) {
    if (options.products.length > MAX_PRODUCTS_PER_RULE) {
      errors.push(`绑定产品数量超过上限(${MAX_PRODUCTS_PER_RULE})`);
    }
    const seenHandles = new Set();
    const products = [];
    options.products.forEach((entry) => {
      const handle = String(entry?.handle || "").trim();
      if (!handle || seenHandles.has(handle)) return; // handle 跨店稳定,是预取与白名单匹配的主键
      seenHandles.add(handle);
      products.push({
        id: String(entry?.id || ""),
        handle,
        title: String(entry?.title || ""),
        ...(entry?.sku ? { sku: String(entry.sku) } : {}),
      });
    });
    if (products.length) cleanOptions.products = products;
  }

  if (errors.length) return { errors };

  return {
    data: {
      name,
      eventName,
      ruleType,
      selector: selector || null,
      urlPattern: urlPattern || null,
      matchMode,
      parameters: JSON.stringify(
        (Array.isArray(parameters) ? parameters : []).map((param) => ({
          key: String(param.key).trim(),
          source: param.source,
          value: String(param.value ?? ""),
          ...(param.transform ? { transform: String(param.transform) } : {}),
        })),
      ),
      options: JSON.stringify(cleanOptions),
    },
  };
}

// 合并模式去重用的自然键
export function ruleNaturalKey(rule) {
  return [rule.pageType, rule.pageHandle, rule.name, rule.ruleType, rule.selector || "", rule.urlPattern || ""].join("|");
}

export function buildExportPayload(rules, exportedAt = new Date()) {
  return {
    format: IMPORT_FORMAT,
    version: IMPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    rules: rules.map(serializeRule).map((rule) => ({
      pageType: rule.pageType,
      pageHandle: rule.pageHandle,
      name: rule.name,
      eventName: rule.eventName,
      ruleType: rule.ruleType,
      selector: rule.selector,
      urlPattern: rule.urlPattern,
      matchMode: rule.matchMode,
      enabled: rule.enabled,
      parameters: rule.parameters,
      options: Object.keys(rule.options).length ? rule.options : DEFAULT_OPTIONS,
      sortOrder: rule.sortOrder,
    })),
  };
}

// 解析导入的 JSON 文本 → { rules } 或 { errors };不含 shop/id,导入时落到当前店铺并重新生成 id
export function parseImportPayload(text) {
  const errors = [];
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { errors: ["文件不是合法的 JSON"] };
  }
  if (payload?.format !== IMPORT_FORMAT) {
    return { errors: [`文件格式不对:缺少 format: "${IMPORT_FORMAT}" 标识,请确认是本应用导出的文件`] };
  }
  if (payload.version !== IMPORT_VERSION) {
    return { errors: [`文件版本(${payload.version})不被当前版本(${IMPORT_VERSION})支持`] };
  }
  if (!Array.isArray(payload.rules)) {
    return { errors: ["文件缺少 rules 数组"] };
  }
  if (payload.rules.length > MAX_RULES_PER_IMPORT) {
    return { errors: [`规则数量超过上限(${MAX_RULES_PER_IMPORT})`] };
  }

  const rules = [];
  payload.rules.forEach((raw, index) => {
    const result = validateRule({ ...raw, parameters: raw.parameters ?? [], options: raw.options ?? {} });
    if (result.errors) {
      errors.push(`第 ${index + 1} 条(${raw?.name || "未命名"}):${result.errors.join(";")}`);
      return;
    }
    rules.push({
      pageType: raw.pageType,
      pageHandle: String(raw.pageHandle || ""),
      ...result.data,
      enabled: raw.enabled !== false,
      sortOrder: Number.isFinite(raw.sortOrder) ? Number(raw.sortOrder) : 0,
    });
  });

  if (errors.length) return { errors: [`${errors.length} 条规则未通过校验:`, ...errors] };
  return { rules };
}
