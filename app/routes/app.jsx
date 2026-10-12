import { Link, Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { GlobalStyles } from "../ui";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", shop: session.shop };
};

export default function App() {
  const { apiKey, shop } = useLoaderData();
  const location = useLocation();
  const isComponents =
    location.pathname.startsWith("/app/components") ||
    location.pathname.startsWith("/app/rules/component");

  return (
    <AppProvider embedded apiKey={apiKey}>
      <GlobalStyles />
      <div className="tp-nav">
        <div className="tp-nav__inner">
          <span className="tp-nav__brand">
            <span className="tp-nav__dot" />
            TrackPoint
          </span>
          <nav className="tp-nav__links">
            <Link to="/app" className={!isComponents ? "active" : ""}>
              页面列表
            </Link>
            <Link to="/app/components" className={isComponents ? "active" : ""}>
              公共组件
            </Link>
          </nav>
          <span className="tp-nav__shop">{shop}</span>
        </div>
      </div>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
