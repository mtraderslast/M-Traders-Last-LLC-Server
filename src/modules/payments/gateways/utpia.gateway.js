import crypto from "crypto";
import axios from "axios";
import AppError from "../../../utils/AppError.js";
import { GATEWAYS, PAYMENT_STATUS } from "../constants.js";
import {
    getBackendUrl,
    getSuccessUrl,
    getWebhookUrl,
    splitName,
} from "../paymentConfig.js";

const VERSION = "1.0.0";
const REQUEST_TIMEOUT_MS = 20000;
const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || "").trim());

const getBaseUrl = () =>
    (process.env.UTPIA_BASE_URL || "https://gateway.utpia.net").replace(/\/+$/, "");

const unwrapKey = (value) => {
    if (!value) return "";
    let text = String(value).trim();
    if (
        (text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith("'") && text.endsWith("'"))
    ) {
        text = text.slice(1, -1);
    }
    return text.replace(/\\n/g, "\n").trim();
};

const toPem = (value, kind) => {
    const text = unwrapKey(value);
    if (!text) return "";
    if (text.includes("BEGIN")) return text;

    const body = text.replace(/\s+/g, "");
    const wrapped = body.match(/.{1,64}/g)?.join("\n") || body;
    const labels = kind === "private" ? ["PRIVATE KEY", "RSA PRIVATE KEY"] : ["PUBLIC KEY"];
    return labels.map((label) => `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`);
};

const loadKey = (value, kind) => {
    const candidates = toPem(value, kind);
    const list = Array.isArray(candidates) ? candidates : [candidates];
    for (const pem of list) {
        if (!pem) continue;
        try {
            return kind === "private" ? crypto.createPrivateKey(pem) : crypto.createPublicKey(pem);
        } catch {
            // Try the next PEM label. Raw dashboard keys have no header.
        }
    }
    return null;
};

const pemReady = (value, kind) => Boolean(loadKey(value, kind));

const queryEscape = (value) =>
    encodeURIComponent(value)
        .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/%20/g, "+");

const canonicalize = (value) => {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") {
        if (Array.isArray(value)) {
            throw new AppError(400, "Utpia requests cannot include arrays.");
        }
        return Object.keys(value)
            .sort()
            .map((key) => `${queryEscape(key)}=${canonicalize(value[key])}`)
            .join("&");
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value);
};

export const canonicalString = (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    return Object.keys(payload)
        .filter((key) => key !== "sign")
        .sort()
        .map((key) => `${queryEscape(key)}=${canonicalize(payload[key])}`)
        .join("&");
};

export const signBody = (payload, privateKeyPem) => {
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(canonicalString(payload), "utf8");
    signer.end();
    const key = loadKey(privateKeyPem, "private");
    if (!key) throw new Error("Utpia merchant private key could not be read.");
    return signer.sign(key, "base64");
};

export const verifyBody = (payload, publicKeyPem) => {
    const signature = payload?.sign;
    if (!signature || !publicKeyPem) return false;
    try {
        const verifier = crypto.createVerify("RSA-SHA256");
        verifier.update(canonicalString(payload), "utf8");
        verifier.end();
        const key = loadKey(publicKeyPem, "public");
        if (!key) return false;
        return verifier.verify(key, signature, "base64") === true;
    } catch {
        return false;
    }
};

const mapStatus = (status) => {
    if (String(status) === "1") return PAYMENT_STATUS.SUCCESS;
    if (String(status) === "2") return PAYMENT_STATUS.FAILED;
    return PAYMENT_STATUS.PENDING;
};

const asMajor = (value) => {
    if (value === undefined || value === null || value === "") return undefined;
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : undefined;
};

const nonce = () => crypto.randomBytes(6).toString("hex");

const readPayload = (req) => {
    if (req._utpiaPayload) return req._utpiaPayload;
    let raw = req.body;
    if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
    if (typeof raw !== "string" || !raw.trim()) return null;
    const parsed = JSON.parse(raw);
    req._utpiaPayload = parsed;
    return parsed;
};

const isConfigured = () => Boolean(
    process.env.UTPIA_MERCHANT_ID &&
    pemReady(process.env.UTPIA_MERCHANT_PRIVATE_KEY, "private") &&
    pemReady(process.env.UTPIA_PLATFORM_PUBLIC_KEY, "public")
);

const signedPost = async (path, fields, orderId) => {
    const privateKey = process.env.UTPIA_MERCHANT_PRIVATE_KEY;
    let sign;
    try {
        sign = signBody(fields, privateKey);
    } catch (error) {
        console.error(`[UTPIA] could not sign request for ${orderId}: ${error.message}`);
        throw new AppError(500, "Utpia merchant key could not sign the request.");
    }

    const body = { ...fields, sign };
    try {
        const response = await axios.post(`${getBaseUrl()}${path}`, body, {
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            timeout: REQUEST_TIMEOUT_MS,
        });
        return response.data;
    } catch (error) {
        const status = error.response?.status;
        const data = error.response?.data;
        const message = (typeof data === "object" && data?.msg) || error.message || "Utpia request failed.";
        console.error(`[UTPIA] ${path} failed for ${orderId}: ${status || ""} ${data?.code || ""} ${message}`);
        if (status >= 400 && status < 500) throw new AppError(status, message);
        throw new AppError(502, message);
    }
};

const buildPayerData = (paymentData) => {
    const wallet = (process.env.UTPIA_WALLET || "Cash").trim();
    const { firstName, lastName } = splitName(paymentData.customerName);
    const customer = paymentData.customer || {};
    const country = String(customer.country || "").trim();
    const state = String(customer.state || "").trim();

    if (wallet === "Cash") {
        const street = String(customer.street || "").trim();
        const city = String(customer.city || "").trim();
        const postCode = String(customer.postCode || "").trim();
        const dateOfBirth = String(customer.dateOfBirth || "").trim();
        if (!street || !city || !postCode || !dateOfBirth || !country || !state) {
            throw new AppError(400, "Cash payment needs street, city, postal code, date of birth, country, and state.");
        }
        return {
            wallet,
            payerData: {
                wallet: "Cash",
                customer_details: {
                    first_name: firstName,
                    last_name: lastName,
                    card_street: street,
                    card_city: city,
                    card_post_code: postCode,
                    card_state_code: state,
                    state_of_residence: state,
                    country_of_residence: country,
                    date_of_birth: dateOfBirth,
                },
            },
        };
    }

    if (wallet === "PayPal" && !country) {
        throw new AppError(400, "Country is required for a Utpia PayPal payment.");
    }

    const details = {
        first_name: firstName,
        last_name: lastName,
    };
    if (paymentData.customerEmail) details.email = paymentData.customerEmail;
    if (customer.phone) details.phone = customer.phone;
    if (country) details.country_of_residence = country;
    if (state) details.state_of_residence = state;

    return { wallet, payerData: { wallet, customer_details: details } };
};

const createSession = async (paymentData) => {
    const merchantId = process.env.UTPIA_MERCHANT_ID;
    const orderId = paymentData.orderId;
    const phone = String(paymentData.customer?.phone || "").trim();
    const email = String(paymentData.customerEmail || "").trim();
    const notifyUrl = getWebhookUrl(GATEWAYS.UTPIA)
        || `${getBackendUrl() || "http://localhost:5000"}/api/payments/webhook/utpia`;
    const amount = Number(paymentData.amount);

    if (!merchantId) throw new AppError(400, "Utpia merchant id is not configured.");
    if (orderId.length < 6 || orderId.length > 32) {
        throw new AppError(400, "This order reference is not accepted by Utpia.");
    }
    if (!email) throw new AppError(400, "An email address is required for Utpia.");
    if (!phone) throw new AppError(400, "A phone number is required for Utpia.");
    if (!Number.isFinite(amount) || amount < USD_MIN_AMOUNT || amount > USD_MAX_AMOUNT) {
        throw new AppError(400, `Utpia USD payments must be between ${USD_MIN_AMOUNT} and ${USD_MAX_AMOUNT}. This package is ${Number.isFinite(amount) ? amount.toFixed(2) : "invalid"}.`);
    }

    const { payerData } = buildPayerData(paymentData);

    const fields = {
        version: VERSION,
        merchant_id: String(merchantId),
        merchant_order_id: orderId,
        amount: amount.toFixed(2),
        currency: paymentData.currency || "USD",
        notify_url: notifyUrl,
        return_url: getSuccessUrl(orderId),
        email,
        phone,
        username: paymentData.customerName || "Customer",
        req_time: String(Math.floor(Date.now() / 1000)),
        nonce_str: nonce(),
        payer_data: payerData,
    };

    if (paymentData.ipAddress) fields.payer_ip = paymentData.ipAddress;

    const result = await signedPost("/api/v1/payin/order", fields, orderId);
    const data = result?.data;
    const code = Number(result?.code);

    if (code !== 200) {
        const message = result?.msg || "Utpia could not create the payment.";
        console.error(`[UTPIA] createSession rejected ${orderId}: ${code} ${message}`);
        const error = new AppError(code >= 400 && code < 500 ? code : 502, message);
        error.failureReason = message;
        throw error;
    }

    if (mapStatus(data?.status) === PAYMENT_STATUS.FAILED) {
        const message = data?.msg || "The payment could not be started.";
        console.error(`[UTPIA] createSession failed for ${orderId}: ${message}`);
        const error = new AppError(400, message);
        error.gatewayPaymentId = data?.utp_order_id || "";
        error.failureReason = message;
        throw error;
    }

    const payUrl = isHttpUrl(data?.pay_url) ? data.pay_url.trim() : "";

    if (!payUrl) {
        if (data?.utp_order_id) {
            console.log(`[UTPIA] test order ${orderId} created as ${data.utp_order_id}. Test mode did not return a payment page.`);
            return {
                checkoutUrl: "",
                gatewayPaymentId: data.utp_order_id,
                raw: data,
                testMode: true,
            };
        }
        const message = data?.msg || "Payment page could not be created. Please try again.";
        console.error(`[UTPIA] pay_url missing for ${orderId}: ${message}`);
        const error = new AppError(502, message);
        error.failureReason = message;
        throw error;
    }

    return {
        checkoutUrl: payUrl,
        gatewayPaymentId: data.utp_order_id || "",
        raw: data,
        testMode: false,
    };
};

const inquireStatus = async ({ orderId, gatewayPaymentId }) => {
    const merchantId = process.env.UTPIA_MERCHANT_ID;
    const fields = {
        version: VERSION,
        merchant_id: String(merchantId || ""),
        req_time: String(Math.floor(Date.now() / 1000)),
        nonce_str: nonce(),
    };

    if (gatewayPaymentId) fields.utp_order_id = gatewayPaymentId;
    else fields.merchant_order_id = orderId;

    const result = await signedPost("/api/v1/payin/status", fields, orderId);
    if (Number(result?.code) !== 200) {
        throw new AppError(502, result?.msg || "Utpia status inquiry failed.");
    }

    const data = result?.data || {};
    const status = mapStatus(data.status);
    return {
        status,
        proofId: data.utp_order_id || gatewayPaymentId || "",
        gatewayPaymentId: data.utp_order_id || gatewayPaymentId || "",
        amount: asMajor(status === PAYMENT_STATUS.SUCCESS ? (data.paid_amount || data.amount) : data.amount),
        failureReason: status === PAYMENT_STATUS.FAILED ? (data.msg || "Payment failed") : "",
        raw: data,
    };
};

const verifyWebhook = (req) => {
    try {
        const payload = readPayload(req);
        if (!payload) return false;
        return verifyBody(payload, process.env.UTPIA_PLATFORM_PUBLIC_KEY);
    } catch {
        return false;
    }
};

const parseWebhook = (req) => {
    const payload = readPayload(req);
    if (!payload) throw new AppError(400, "Invalid body");

    const status = mapStatus(payload.status);
    return {
        orderId: payload.merchant_order_id || "",
        status,
        proofId: payload.utp_order_id || "",
        gatewayPaymentId: payload.utp_order_id || "",
        amount: asMajor(payload.real_amount || payload.amount),
        failureReason: status === PAYMENT_STATUS.FAILED ? (payload.msg || "Payment failed") : "",
        raw: payload,
    };
};

const webhookAck = () => "SUCCESS";

export const utpiaGateway = {
    name: GATEWAYS.UTPIA,
    label: "Utpia",
    isConfigured,
    createSession,
    inquireStatus,
    verifyWebhook,
    parseWebhook,
    webhookAck,
};
