const trimSlash = (url) => String(url || "").replace(/\/+$/, "");

export const MAX_AMOUNT = 1_000_000;

export const getFrontendUrl = () =>
    trimSlash(process.env.FRONTEND_URL || "http://localhost:3000");

export const getBackendUrl = () => trimSlash(process.env.BACKEND_URL || "");

export const isPublicHttps = (url) =>
    /^https:\/\//i.test(url) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url);

export const getSuccessUrl = (orderId) =>
    `${getFrontendUrl()}/success?orderId=${encodeURIComponent(orderId)}`;

export const getFailUrl = (orderId) =>
    `${getFrontendUrl()}/canceled?orderId=${encodeURIComponent(orderId)}`;

export const getCheckoutUrl = (itemId) =>
    `${getFrontendUrl()}/checkout/${itemId}`;

export const getWebhookUrl = (gatewayName) => {
    const backendUrl = getBackendUrl();
    if (!isPublicHttps(backendUrl)) return "";
    return `${backendUrl}/api/payments/webhook/${String(gatewayName || "").toLowerCase()}`;
};

export const toMinorUnits = (amount) => Math.round(Number(amount) * 100);

export const toMajorAmount = (minor) => Number(minor) / 100;

export const getClientIp = (req) => {
    const forwarded = req.headers?.["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
        return forwarded.split(",")[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || "";
};

export const splitName = (fullName) => {
    const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: "Customer", lastName: "Customer" };
    if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
    return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
};
