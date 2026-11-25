import crypto from "crypto";
import AppError from "../../../utils/AppError.js";
import { GATEWAYS, PAYMENT_STATUS } from "../constants.js";
import {
    getCheckoutUrl,
    getFailUrl,
    getSuccessUrl,
    getWebhookUrl,
    toMajorAmount,
    toMinorUnits,
} from "../paymentConfig.js";
import {
    createHostedPayment,
    findPaymentByReference,
    parseGatewayError,
} from "../../orders/allpaypayz.service.js";

const SIGNATURE_TOLERANCE_SECONDS = 300;

const mapProviderStatus = (gatewayStatus) => {
    if (gatewayStatus === "succeeded") return PAYMENT_STATUS.SUCCESS;
    if (["failed", "cancelled", "expired"].includes(gatewayStatus)) return PAYMENT_STATUS.FAILED;
    return PAYMENT_STATUS.PENDING;
};

const mapEventType = (eventType) => {
    if (["payment.succeeded", "order.completed"].includes(eventType)) return PAYMENT_STATUS.SUCCESS;
    if (["payment.failed", "payment.cancelled", "order.cancelled", "order.expired"].includes(eventType)) {
        return PAYMENT_STATUS.FAILED;
    }
    return PAYMENT_STATUS.PENDING;
};

const describeFailure = (payment) => {
    const reason = payment?.status_reason || "";
    const text = payment?.status_message || "";
    return [reason, text].filter(Boolean).join(": ");
};

const majorAmount = (amount) => {
    const minor = amount?.amount_minor;
    if (minor === undefined || minor === null || minor === "") return undefined;
    const major = toMajorAmount(minor);
    return Number.isFinite(major) ? major : undefined;
};

const readJsonBody = (req) => {
    if (!Buffer.isBuffer(req.body)) {
        throw new AppError(400, "Invalid body");
    }
    try {
        return JSON.parse(req.body.toString("utf8"));
    } catch {
        throw new AppError(400, "Invalid JSON");
    }
};

const isConfigured = () => Boolean(process.env.ALLPAYPAYZ_API_KEY);

const createSession = async (paymentData) => {
    const urls = {
        success: getSuccessUrl(paymentData.orderId),
        error: getFailUrl(paymentData.orderId),
        back: getCheckoutUrl(paymentData.itemId),
    };

    const webhookUrl = getWebhookUrl(GATEWAYS.ALLPAYPAYZ);
    if (webhookUrl) {
        urls.callback = webhookUrl;
    } else {
        console.warn(`[ALLPAYPAYZ] BACKEND_URL is not a public HTTPS URL. Webhook callback skipped for ${paymentData.orderId}. Status will be verified by polling.`);
    }

    const payload = {
        merchant_reference: paymentData.orderId,
        amount: {
            amount_minor: toMinorUnits(paymentData.amount),
            currency: paymentData.currency || "USD",
        },
        description: `Order: ${paymentData.title || "Service Package"}`.slice(0, 200),
        customer: {
            name: paymentData.customerName || "Customer",
            email: paymentData.customerEmail || "customer@example.com",
        },
        payment_method: process.env.ALLPAYPAYZ_PAYMENT_METHOD || "card-eu",
        urls,
    };

    let gatewayData;
    try {
        const gatewayResponse = await createHostedPayment(payload);
        gatewayData = gatewayResponse?.data;
    } catch (apiError) {
        const parsed = parseGatewayError(apiError);
        console.error(`[ALLPAYPAYZ] createSession failed for ${paymentData.orderId}: ${parsed.status || ""} ${parsed.code || ""} ${parsed.message}`);
        const statusCode = parsed.status >= 400 && parsed.status < 500 ? parsed.status : 502;
        throw new AppError(statusCode, parsed.message);
    }

    if (gatewayData?.redirect_url) {
        return {
            checkoutUrl: gatewayData.redirect_url,
            gatewayPaymentId: gatewayData.id || "",
            raw: gatewayData,
        };
    }

    if (mapProviderStatus(gatewayData?.status) === PAYMENT_STATUS.FAILED) {
        const reason = describeFailure(gatewayData) || gatewayData?.status || "Payment declined";
        console.warn(`[ALLPAYPAYZ] payment ${gatewayData?.id || ""} for ${paymentData.orderId} ended immediately: ${reason}`);
        const error = new AppError(
            402,
            gatewayData.status === "cancelled"
                ? "The payment was cancelled."
                : `The payment was declined${reason ? ` (${reason})` : ""}. Please try another card.`
        );
        error.gatewayPaymentId = gatewayData?.id || "";
        error.failureReason = reason;
        throw error;
    }

    console.error(`[ALLPAYPAYZ] redirect_url missing for ${paymentData.orderId}`);
    throw new AppError(502, "Payment page could not be created. Please try again.");
};

const inquireStatus = async ({ orderId }) => {
    const payment = await findPaymentByReference(orderId);
    if (!payment) {
        return { status: PAYMENT_STATUS.PENDING, proofId: "", failureReason: "", raw: null };
    }

    if (payment.amount?.currency && payment.amount.currency !== "USD") {
        console.warn(`[ALLPAYPAYZ] currency ${payment.amount.currency} for ${orderId} is not USD`);
    }

    return {
        status: mapProviderStatus(payment.status),
        proofId: payment.id || "",
        gatewayPaymentId: payment.id || "",
        failureReason: describeFailure(payment),
        amount: majorAmount(payment.amount),
        raw: payment,
    };
};

const verifyWebhook = (req) => {
    try {
        const secret = process.env.ALLPAYPAYZ_SECRET_KEY;
        if (!secret || !Buffer.isBuffer(req.body)) return false;

        const signature = String(req.headers["callback-signature"] || "").trim();
        const match = signature.match(/^t=(\d+),v1=([0-9a-f]+)$/i);
        if (!match) return false;

        const [, timestamp, provided] = match;
        const expected = crypto
            .createHmac("sha256", secret)
            .update(`${timestamp}.`)
            .update(req.body)
            .digest("hex");

        if (provided.length !== expected.length) return false;
        const valid = crypto.timingSafeEqual(
            Buffer.from(provided.toLowerCase()),
            Buffer.from(expected)
        );
        if (!valid) return false;

        return Math.abs(Date.now() / 1000 - Number(timestamp)) <= SIGNATURE_TOLERANCE_SECONDS;
    } catch {
        return false;
    }
};

const parseWebhook = (req) => {
    const payload = readJsonBody(req);
    const event = payload?.event;
    const resource = event?.resource;
    const status = mapEventType(event?.type);

    if (resource?.amount?.currency && resource.amount.currency !== "USD") {
        console.warn(`[ALLPAYPAYZ] webhook currency ${resource.amount.currency} for ${resource?.merchant_reference || "unknown"} is not USD`);
    }

    return {
        orderId: resource?.merchant_reference || "",
        status,
        proofId: resource?.id || "",
        gatewayPaymentId: resource?.id || "",
        amount: majorAmount(resource?.amount),
        failureReason: describeFailure(resource),
        raw: payload,
    };
};

const webhookAck = () => ({ success: true });

export const allpaypayzGateway = {
    name: GATEWAYS.ALLPAYPAYZ,
    label: "Allpaypayz",
    isConfigured,
    createSession,
    inquireStatus,
    verifyWebhook,
    parseWebhook,
    webhookAck,
};
