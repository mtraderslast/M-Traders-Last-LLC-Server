import axios from "axios";
import { randomUUID } from "crypto";

// Allpaypayz API v4 client (Bearer <API Key>)
// Staging : https://staging-api4.allpaypayz.com
// Live    : https://api4.allpaypayz.com  (অথবা Cabinet-এর Live Environment লিংক)

const getBaseUrl = () =>
    (process.env.ALLPAYPAYZ_BASE_URL || "https://staging-api4.allpaypayz.com").replace(/\/+$/, "");

const authHeaders = () => ({
    Authorization: `Bearer ${process.env.ALLPAYPAYZ_API_KEY}`,
    Accept: "application/json",
});

// গেটওয়ের এরর কোড অনুযায়ী ইউজার-ফ্রেন্ডলি মেসেজ
const FRIENDLY_MESSAGES = {
    "terminal.no_methods_for_amount":
        "No payment method is available for this amount on the payment terminal. Please contact support.",
    "auth.required": "Payment gateway authentication failed. Please contact support.",
    "conflict.duplicate_reference": "This order reference was already used. Please try again.",
};

/**
 * Allpaypayz এরর ফরম্যাট: { ok:false, error:{ type, code, message, details[] }, request_id }
 */
export const parseGatewayError = (err) => {
    const status = err.response?.status;
    const body = err.response?.data;
    const apiError = typeof body === "object" ? body?.error : null;

    const code = apiError?.code || null;
    const details = Array.isArray(apiError?.details)
        ? apiError.details.map((d) => `${d.field || ""} ${d.issue || d.message || ""}`.trim()).join(", ")
        : "";

    let message =
        (code && FRIENDLY_MESSAGES[code]) ||
        apiError?.message ||
        (typeof body === "string" && body.includes("404")
            ? `Payment gateway endpoint not found (404). Check ALLPAYPAYZ_BASE_URL.`
            : err.code === "ECONNABORTED"
                ? "Payment gateway timed out."
                : "Failed to communicate with payment gateway.");

    if (details && !FRIENDLY_MESSAGES[code]) message = `${message} (${details})`;

    return { status, code, message, requestId: body?.request_id || apiError?.trace_id || null };
};

/**
 * POST /v4/payments/redirect — hosted checkout তৈরি করে।
 * সফল হলে রেসপন্স: { ok:true, data:{ id, status, redirect_url, ... } }
 */
export const createHostedPayment = async (payload) => {
    const response = await axios.post(`${getBaseUrl()}/v4/payments/redirect`, payload, {
        headers: {
            ...authHeaders(),
            "Content-Type": "application/json",
            "Idempotency-Key": randomUUID(),
        },
        timeout: 20000,
    });
    return response.data;
};

/**
 * GET /v4/payments?merchant_reference=... — webhook না এলেও পেমেন্ট স্ট্যাটাস যাচাই করা যায়।
 */
export const findPaymentByReference = async (merchantReference) => {
    const response = await axios.get(`${getBaseUrl()}/v4/payments`, {
        headers: authHeaders(),
        params: { merchant_reference: merchantReference },
        timeout: 15000,
    });
    const data = response.data?.data;
    return Array.isArray(data) ? data[0] : data;
};
