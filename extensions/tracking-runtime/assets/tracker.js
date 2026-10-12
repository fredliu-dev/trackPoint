/**
 * TrackPoint 运行时:按页面拉取埋点规则并执行,推送 GA4 dataLayer。
 *
 * 规则来源:App Proxy(/a/trackpoint)→ 应用 /api/tracking-rules,HMAC 签名,同源无 CORS。
 * 支持三类规则:
 *   click        — document 捕获阶段委托监听,规则选择器 closest() 匹配
 *   api_response — patch fetch + XMLHttpRequest,响应 JSON 按路径提取字段
 *   exposure     — IntersectionObserver 曝光,每元素只触发一次,DOM 变更后重扫
 *
 * 铁律:埋点绝不弄坏商店 —— 所有入口都包 try/catch。
 * 注意:页面识别逻辑与 app/page-detection.js 保持同步。
 */
(function () {
  "use strict";

  var config = window.__TRACKPOINT__ || {};
  var proxyPath = config.proxyPath || "/a/trackpoint";

  var rules = { click: [], api: [], exposure: [] };

  // ---------- 页面识别(与 app/page-detection.js 镜像) ----------
  function detectPage(rawPath) {
    var path = rawPath || "/";
    if (path.charAt(0) !== "/") path = "/" + path;
    path = path.split("?")[0].split("#")[0];
    var locale = path.match(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/|$)/i);
    if (locale) path = path.slice(locale[0].length) || "/";
    if (path === "/" || path === "") return { type: "home", handle: "" };
    var m = path.match(/^\/(pages|products|collections)\/([^/?#]+)/);
    if (!m) return { type: "other", handle: "" };
    var map = { pages: "page", products: "product", collections: "collection" };
    return { type: map[m[1]], handle: decodeURIComponent(m[2]) };
  }

  // ---------- GA4 推送(格式与手写埋点逐字节一致) ----------
  function pushGa4(eventName, parameters) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event_parameters: null });
      window.dataLayer.push({
        event: "ga4Event",
        event_name: eventName,
        event_parameters: parameters || {},
      });
    } catch (error) {
      /* 静默 */ }
  }

  // ---------- 参数解析 ----------
  function getPath(obj, dottedPath) {
    if (!dottedPath) return "";
    var parts = String(dottedPath).split(".");
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return "";
      cur = cur[parts[i]];
    }
    return cur == null ? "" : cur;
  }

  function resolveParams(parameterList, context) {
    var result = {};
    if (!Object.prototype.toString.call(parameterList).match("Array")) return result;
    for (var i = 0; i < parameterList.length; i++) {
      var spec = parameterList[i];
      if (!spec || !spec.key) continue;
      var value = "";
      try {
        if (spec.source === "static") {
          value = spec.value;
        } else if (spec.source === "attr") {
          value = context.element ? context.element.getAttribute(spec.value) : "";
        } else if (spec.source === "text") {
          value = context.element
            ? (context.element.textContent || "").trim()
            : "";
        } else if (spec.source === "json_path") {
          value = getPath(context.response, spec.value);
        } else if (spec.source === "product") {
          value = getPath(context.product, spec.value);
        }
        if (spec.transform === "number") {
          value = value === "" ? 0 : parseFloat(value);
          if (isNaN(value)) value = 0;
        } else if (spec.source !== "product") {
          // 产品信息字段保持原生类型(price 等数字不做字符串化,与主题 parseFloat 手法一致)
          value = value == null ? "" : String(value);
        }
      } catch (error) {
        value = "";
      }
      result[spec.key] = value;
    }
    return result;
  }

  // ---------- 产品信息(参数 source="product" 时按元素上的产品标识实时获取) ----------
  // 页面级缓存按别名键(sku:/handle:/id:)存同一份信息;查不到记 null 防反复请求
  var productCache = {};
  var productPending = {};

  function cacheAliases(info) {
    if (!info) return;
    if (info.sku) productCache["sku:" + info.sku] = info;
    if (info.handle) productCache["handle:" + info.handle] = info;
    if (info.id) productCache["id:" + info.id] = info;
  }

  function resolvePending(key, info) {
    var waiting = productPending[key] || [];
    delete productPending[key];
    for (var i = 0; i < waiting.length; i++) {
      try {
        waiting[i](info);
      } catch (error) {
        /* 静默 */ }
    }
  }

  // ref = {type: "sku"|"handle"|"id", value};并发请求合并,结果别名入缓存
  function fetchProductInfo(ref, callback) {
    var key = ref.type + ":" + ref.value;
    if (Object.prototype.hasOwnProperty.call(productCache, key)) {
      try { callback(productCache[key]); } catch (error) { /* 静默 */ }
      return;
    }
    if (productPending[key]) {
      productPending[key].push(callback);
      return;
    }
    productPending[key] = [callback];
    try {
      var xhr = new XMLHttpRequest();
      xhr.open(
        "GET",
        proxyPath + "?resource=product&" + ref.type + "=" + encodeURIComponent(ref.value),
        true
      );
      xhr.onload = function () {
        var info = null;
        try {
          info = (JSON.parse(xhr.responseText) || {}).product || null;
        } catch (error) {
          info = null;
        }
        cacheAliases(info);
        if (!info) productCache[key] = null; // 负缓存:商品不存在/查询失败不再重试
        resolvePending(key, info);
      };
      xhr.onerror = function () {
        resolvePending(key, null); // 网络瞬断不写负缓存,下次点击可重试
      };
      xhr.send();
    } catch (error) {
      resolvePending(key, null);
    }
  }

  // 从命中元素找产品标识:配置属性 → data-sku → data-product-id(含祖先)→ /products/<handle> 链接
  // 链接三种形态:命中元素自身/祖先上的 <a>(Shokz 卡片)、命中元素内部的 <a>(Dawn 卡片)、
  // 原始点击目标自身/祖先上的 <a>(点了卡片内标题/图片)
  function productRefFromLink(node) {
    try {
      var m = node && (node.getAttribute("href") || "").match(/\/products\/([^/?#]+)/);
      if (m && m[1]) return { type: "handle", value: decodeURIComponent(m[1]) };
    } catch (error) {
      /* 静默 */ }
    return null;
  }

  function resolveProductRef(el, attrName, rawTarget) {
    var chain = attrName ? [attrName, "data-sku", "data-product-id"] : ["data-sku", "data-product-id"];
    var roots = rawTarget && rawTarget !== el ? [el, rawTarget] : [el];
    for (var i = 0; i < chain.length; i++) {
      for (var r = 0; r < roots.length; r++) {
        try {
          var node = roots[r].closest("[" + chain[i] + "]");
          var raw = node ? (node.getAttribute(chain[i]) || "").trim() : "";
          if (raw) {
            return /^\d+$/.test(raw) ? { type: "id", value: raw } : { type: "sku", value: raw };
          }
        } catch (error) {
          /* 无效属性名,试下一个 */ }
      }
    }
    var ref;
    try {
      ref = productRefFromLink(el.closest('a[href*="/products/"]'));
      if (ref) return ref;
    } catch (error) {
      /* 静默 */ }
    for (var t = 0; t < roots.length && !ref; t++) {
      try {
        if (roots[t].closest) {
          ref = productRefFromLink(roots[t].closest('a[href*="/products/"]'));
        }
      } catch (error) {
        /* 静默 */ }
    }
    if (!ref) {
      try {
        // 命中元素内部的后代链接(Dawn 卡片:链接在 .card-wrapper 里)
        ref = productRefFromLink(el.querySelector('a[href*="/products/"]'));
      } catch (error) {
        /* 静默 */ }
    }
    return ref || null;
  }

  function ruleNeedsProduct(rule) {
    var list = rule.parameters || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].source === "product") return true;
    }
    return false;
  }

  // 白名单:元素标识或取回信息命中任一已选产品才算数;空名单 = 不限
  function matchesWhitelist(rule, ref, info) {
    var list = (rule.options && rule.options.products) || [];
    if (!list.length) return true;
    var refKey = ref ? ref.type + ":" + ref.value : "";
    for (var i = 0; i < list.length; i++) {
      var entry = list[i] || {};
      if ((entry.handle && refKey === "handle:" + entry.handle) ||
          (entry.id && refKey === "id:" + entry.id) ||
          (entry.sku && refKey === "sku:" + entry.sku)) return true;
      if (info && ((entry.handle && info.handle === entry.handle) ||
                   (entry.id && info.id === entry.id))) return true;
    }
    return false;
  }

  // 点击/曝光共用的触发口:需要产品信息的规则先解析标识 → 缓存命中同步推,否则取回后再推
  function fireElementRule(rule, el, rawTarget) {
    if (!ruleNeedsProduct(rule)) {
      pushGa4(rule.eventName, resolveParams(rule.parameters, { element: el }));
      return;
    }
    var options = rule.options || {};
    var ref = resolveProductRef(el, options.productAttr, rawTarget);
    if (!ref) {
      // 元素上没有产品标识:不限范围时照常发事件(产品参数留空),限定范围则跳过
      if ((options.products || []).length) return;
      pushGa4(rule.eventName, resolveParams(rule.parameters, { element: el }));
      return;
    }
    var key = ref.type + ":" + ref.value;
    if (Object.prototype.hasOwnProperty.call(productCache, key)) {
      fireWithProduct(rule, el, ref, productCache[key]); // 预加载命中,同步推送
      return;
    }
    fetchProductInfo(ref, function (info) {
      fireWithProduct(rule, el, ref, info);
    });
  }

  function fireWithProduct(rule, el, ref, info) {
    if (!matchesWhitelist(rule, ref, info)) return;
    pushGa4(rule.eventName, resolveParams(rule.parameters, { element: el, product: info }));
  }

  // 白名单产品的信息在规则到位后立刻预取,点击瞬间即可同步带出
  function preloadProductRules() {
    var seen = {};
    var all = rules.click.concat(rules.exposure);
    for (var i = 0; i < all.length; i++) {
      var list = (all[i].options && all[i].options.products) || [];
      if (!list.length || !ruleNeedsProduct(all[i])) continue;
      for (var j = 0; j < list.length; j++) {
        var handle = list[j] && list[j].handle;
        if (handle && !seen[handle]) {
          seen[handle] = true;
          fetchProductInfo({ type: "handle", value: handle }, function () { /* 预热即可 */ });
        }
      }
    }
  }

  // ---------- 点击(捕获阶段委托,先于一切目标处理器) ----------
  // 点击候选:事件目标本身 + 点在 label 上时其关联控件
  // (Dawn 等主题的表单悬浮标签覆盖在输入框上,与输入框是兄弟节点,
  //  target=label 时 closest() 找不到输入框,需换算到关联控件再匹配)
  function clickCandidates(target) {
    var candidates = [target];
    try {
      var label = target.closest ? target.closest("label") : null;
      var control = null;
      if (label) {
        control = label.control || (label.htmlFor ? document.getElementById(label.htmlFor) : null);
      }
      if (control && candidates.indexOf(control) === -1) candidates.push(control);
    } catch (error) {
      /* 静默 */ }
    return candidates;
  }

  document.addEventListener(
    "click",
    function (event) {
      try {
        if (!rules.click.length) return;
        var target = event.target;
        if (!target || !target.closest) return;
        var candidates = clickCandidates(target);
        for (var i = 0; i < rules.click.length; i++) {
          var rule = rules.click[i];
          var el = null;
          try {
            for (var c = 0; c < candidates.length && !el; c++) {
              el = candidates[c].closest(rule.selector);
            }
          } catch (error) {
            el = null; /* 无效选择器,跳过该规则 */
          }
          if (el) {
            fireElementRule(rule, el, target);
          }
        }
      } catch (error) {
        /* 静默 */ }
    },
    true
  );

  // pointerdown 预热:需要产品信息的点击规则,按下即开始取数(先于点击跳转,缩短异步窗口)
  document.addEventListener(
    "pointerdown",
    function (event) {
      try {
        if (!rules.click.length) return;
        var target = event.target;
        if (!target || !target.closest) return;
        var candidates = clickCandidates(target);
        for (var i = 0; i < rules.click.length; i++) {
          var rule = rules.click[i];
          if (!ruleNeedsProduct(rule)) continue;
          var el = null;
          try {
            for (var c = 0; c < candidates.length && !el; c++) {
              el = candidates[c].closest(rule.selector);
            }
          } catch (error) {
            el = null;
          }
          if (el) {
            var ref = resolveProductRef(el, (rule.options || {}).productAttr, target);
            if (ref && !Object.prototype.hasOwnProperty.call(productCache, ref.type + ":" + ref.value)) {
              fetchProductInfo(ref, function () { /* 预热即可 */ });
            }
          }
        }
      } catch (error) {
        /* 静默 */ }
    },
    true
  );

  // ---------- 接口返回 ----------
  function fireApiRules(url, responseBody) {
    try {
      for (var i = 0; i < rules.api.length; i++) {
        var rule = rules.api[i];
        var matched = false;
        try {
          matched =
            rule.matchMode === "regex"
              ? new RegExp(rule.urlPattern).test(url)
              : url.indexOf(rule.urlPattern) !== -1;
        } catch (error) {
          matched = false;
        }
        if (matched) {
          pushGa4(rule.eventName, resolveParams(rule.parameters, { response: responseBody }));
        }
      }
    } catch (error) {
      /* 静默 */ }
  }

  function shouldWatchApi() {
    return rules.api.length > 0;
  }

  // patch fetch(clone 响应后再读 JSON,不影响主题自己的 .json() 调用)
  if (typeof window.fetch === "function") {
    var nativeFetch = window.fetch;
    window.fetch = function (input) {
      var url = "";
      try {
        url = typeof input === "string" ? input : (input && input.url) || String(input);
      } catch (error) {
        url = "";
      }
      var promise = nativeFetch.apply(this, arguments);
      if (shouldWatchApi() && url) {
        try {
          promise.then(function (response) {
            if (!response || !response.clone) return;
            response
              .clone()
              .json()
              .then(function (body) { fireApiRules(url, body); })
              .catch(function () { /* 非 JSON 响应,忽略 */ });
          }).catch(function () { /* 请求失败,忽略 */ });
        } catch (error) {
          /* 静默 */ }
      }
      return promise;
    };
  }

  // patch XMLHttpRequest(jQuery $.ajax 等走这里)
  if (typeof window.XMLHttpRequest === "function") {
    var nativeOpen = XMLHttpRequest.prototype.open;
    var nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__trackpointUrl = String(url || "");
      return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      if (shouldWatchApi() && xhr.__trackpointUrl) {
        try {
          xhr.addEventListener("load", function () {
            try {
              var body = JSON.parse(xhr.responseText);
              fireApiRules(xhr.__trackpointUrl, body);
            } catch (error) {
              /* 非 JSON,忽略 */ }
          });
        } catch (error) {
          /* 静默 */ }
      }
      return nativeSend.apply(this, arguments);
    };
  }

  // ---------- 曝光(IntersectionObserver,每元素一次,DOM 变更重扫) ----------
  var exposureObservers = [];
  var seenElements = typeof WeakSet === "function" ? new WeakSet() : null;

  function observeExposureRule(rule) {
    if (typeof IntersectionObserver !== "function") return;
    var threshold = 0.5;
    try {
      if (rule.options && rule.options.threshold) {
        threshold = Number(rule.options.threshold) || 0.5;
      }
    } catch (error) {
      threshold = 0.5;
    }
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          if (seenElements && seenElements.has(entry.target)) return;
          if (seenElements) seenElements.add(entry.target);
          observer.unobserve(entry.target);
          fireElementRule(rule, entry.target);
        });
      },
      { threshold: threshold }
    );
    rule.__observer = observer;
    scanExposureRule(rule);
  }

  function scanExposureRule(rule) {
    try {
      var nodes = document.querySelectorAll(rule.selector);
      for (var i = 0; i < nodes.length; i++) {
        if (rule.__observer) rule.__observer.observe(nodes[i]);
      }
    } catch (error) {
      /* 无效选择器,跳过 */ }
  }

  function scanAllExposure() {
    for (var i = 0; i < rules.exposure.length; i++) {
      scanExposureRule(rules.exposure[i]);
    }
  }

  // AJAX 插入的元素(购物车抽屉、推荐位等)延迟重扫
  if (typeof MutationObserver === "function") {
    var rescanTimer = null;
    var bodyObserver = new MutationObserver(function () {
      if (rescanTimer) clearTimeout(rescanTimer);
      rescanTimer = setTimeout(scanAllExposure, 300);
    });
    function startBodyObserver() {
      if (document.body) {
        bodyObserver.observe(document.body, { childList: true, subtree: true });
      } else {
        setTimeout(startBodyObserver, 200);
      }
    }
    startBodyObserver();
  }

  // ---------- GTM 注入(店铺未自接 GTM 时由 App 代为引入,GA4 转发由容器内配置完成) ----------
  // 与主题手写片段一致:dataLayer 就绪 → push gtm.start → 异步加载 gtm.js。
  // 店里已有 GTM(主题接入或容器已初始化)则跳过,避免双容器重复上报;
  // noscript 回退帧无法用 JS 动态创建(JS 关闭时本脚本也不会执行),故不注入。
  function injectGtm(containerId) {
    try {
      if (!containerId || !/^GTM-[A-Z0-9]+$/.test(containerId)) return;
      if (window.google_tag_manager) return;
      var scripts = document.getElementsByTagName("script");
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].getAttribute("src") || "";
        if (src.indexOf("googletagmanager.com/gtm.js") !== -1) return;
      }
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ "gtm.start": new Date().getTime(), event: "gtm.js" });
      var gtmScript = document.createElement("script");
      gtmScript.async = true;
      gtmScript.src =
        "https://www.googletagmanager.com/gtm.js?id=" + encodeURIComponent(containerId);
      var first = scripts[0];
      if (first && first.parentNode) {
        first.parentNode.insertBefore(gtmScript, first);
      } else {
        document.head.appendChild(gtmScript);
      }
    } catch (error) {
      /* 静默 */
    }
  }

  // ---------- 拉取规则并启动 ----------
  function applyRules(payload) {
    injectGtm((payload && payload.gtmId) || "");
    var list = (payload && payload.rules) || [];
    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (!rule || !rule.eventName) continue;
      if (rule.ruleType === "click" && rule.selector) {
        rules.click.push(rule);
      } else if (rule.ruleType === "api_response" && rule.urlPattern) {
        rules.api.push(rule);
      } else if (rule.ruleType === "exposure" && rule.selector) {
        rules.exposure.push(rule);
        observeExposureRule(rule);
      }
    }
    try {
      if (typeof console !== "undefined" && console.info) {
        console.info(
          "[trackpoint] " +
            list.length +
            " rules (" +
            rules.click.length +
            " click / " +
            rules.api.length +
            " api / " +
            rules.exposure.length +
            " exposure)"
        );
      }
    } catch (error) {
      /* 静默 */ }
    preloadProductRules();
  }

  try {
    var requestUrl =
      proxyPath +
      (proxyPath.indexOf("?") === -1 ? "?" : "&") +
      "path=" +
      encodeURIComponent(window.location.pathname);
    // 原生 fetch 此刻已被 patch,用 XMLHttpRequest 拉规则避免自匹配
    var xhr = new XMLHttpRequest();
    xhr.open("GET", requestUrl, true);
    xhr.onload = function () {
      try {
        applyRules(JSON.parse(xhr.responseText));
      } catch (error) {
        /* 静默 */ }
    };
    xhr.send();
  } catch (error) {
    /* 静默 */ }
})();
