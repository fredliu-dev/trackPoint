// 公共组件库:/app/components —— 复用规则编辑器,type 固定为 component。
// 组件不直接生效(运行时端点只下发 global + 当前页规则),在编辑埋点页面导入后才会生效。
import RulesEditor, {
  loader as editorLoader,
  action as editorAction,
  headers,
} from "./app.rules.$type.$handle";

export { headers };

export const loader = async ({ request }) => {
  return editorLoader({ request, params: { type: "component", handle: "-" } });
};

export const action = async (args) => {
  return editorAction({ ...args, params: { type: "component", handle: "-" } });
};

export default RulesEditor;
