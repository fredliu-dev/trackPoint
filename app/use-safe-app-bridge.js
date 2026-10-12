// App Bridge 安全包装:CDN 脚本(app-bridge.js)加载与 React 水合存在时序竞争,
// 脚本未就绪时 useAppBridge() 会 throw,而路由 ErrorBoundary 会把普通 Error 重新抛出 → 白屏。
// 这里捕获并降级为 null(useAppBridge 内部没有任何 hook,包 try/catch 不影响 hook 顺序),
// 调用处用 shopify?.toast?.show(...);脚本就绪后的下一次渲染自然恢复。
import { useAppBridge } from "@shopify/app-bridge-react";

export function useSafeAppBridge() {
  try {
    return useAppBridge();
  } catch {
    return null;
  }
}
