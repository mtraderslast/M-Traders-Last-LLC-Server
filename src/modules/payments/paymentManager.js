import crypto from "crypto";
import mongoose from "mongoose";
import Order from "../orders/order.model.js";
import Package from "../services-packages/package.model.js";
import AppError from "../../utils/AppError.js";
import { publish } from "../orders/paymentEvents.js";
import GatewayConfig from "./gatewayConfig.model.js";
import {
    FREE_GATEWAY,
    GATEWAYS,
    PAYMENT_STATUS,
    STORED_PAYMENT_STATUS,
    normalizeGatewayName,
} from "./constants.js";
import {
    MAX_AMOUNT,
    getSuccessUrl,
    toMinorUnits,
} from "./paymentConfig.js";
import {
    describeGateways,
    getGateway,
    registerGateway,
} from "./gatewayRegistry.js";
import { allpaypayzGateway } from "./gateways/allpaypayz.gateway.js";
import { utpiaGateway } from "./gateways/utpia.gateway.js";

const CONFIG_KEY = "default";
const AMOUNT_TOLERANCE = 0.01;

const storedStatus = (status) => {
    if (status === PAYMENT_STATUS.SUCCESS) return STORED_PAYMENT_STATUS.SUCCESS;
    if (status === PAYMENT_STATUS.FAILED) return STORED_PAYMENT_STATUS.FAILED;
    return STORED_PAYMENT_STATUS.PENDING;
};

const amountsMatch = (expected, reported) => {
    const orderAmount = Number(expected);
    const paid = Number(reported);
    if (!Number.isFinite(orderAmount) || !Number.isFinite(paid)) return false;
    if (Math.abs(orderAmount - paid) <= AMOUNT_TOLERANCE) return true;
    return Math.abs(orderAmount - paid / 100) <= AMOUNT_TOLERANCE;
};

export const buildStatusPayload = (order) => ({
    orderId: order.orderId,
    title: order.title,
    price: order.price,
    amount: order.price,
    currency: order.currency || "USD",
    paymentStatus: order.paymentStatus,
    status: order.status,
    paid: order.paymentStatus === STORED_PAYMENT_STATUS.SUCCESS,
    gateway: normalizeGatewayName(order.paymentGateway),
    failureReason: order.paymentFailureReason || "",
});

export const getOrCreateGatewayConfig = async () => {
    const existing = await GatewayConfig.findOne({ key: CONFIG_KEY });
    if (existing) return existing;

    try {
        return await GatewayConfig.create({
            key: CONFIG_KEY,
            activeGateway: GATEWAYS.ALLPAYPAYZ,
        });
    } catch (error) {
        if (error?.code === 11000) {
            return GatewayConfig.findOne({ key: CONFIG_KEY });
        }
        throw error;
    }
};

export const resolveActiveGateway = async () => {
    const config = await getOrCreateGatewayConfig();
    return getGateway(config.activeGateway);
};

export const setActiveGateway = async (name) => {
    const gateway = getGateway(name);
    if (typeof gateway.isConfigured === "function" && !gateway.isConfigured()) {
        throw new AppError(400, `${gateway.label} is not configured. Add its keys before activating it.`);
    }

    const config = await getOrCreateGatewayConfig();
    config.activeGateway = gateway.name;
    await config.save();
    return config;
};

export const createGatewaySession = async (gateway, paymentData) => {
    const session = await gateway.createSession(paymentData);
    return {
        checkoutUrl: session?.checkoutUrl || "",
        gateway: gateway.name,
        gatewayPaymentId: session?.gatewayPaymentId || "",
        raw: session?.raw,
        testMode: Boolean(session?.testMode),
    };
};

export const applyPaymentResult = async ({
    orderId,
    status,
    proofId,
    gatewayPaymentId,
    failureReason,
    amount,
    expectedGateway,
}) => {
    if (!orderId) throw new AppError(400, "Order id is required.");

    const order = await Order.findOne({ orderId });
    if (!order) throw new AppError(404, "Order not found.");

    if (order.paymentStatus === STORED_PAYMENT_STATUS.SUCCESS) return order;
    if (status !== PAYMENT_STATUS.SUCCESS && status !== PAYMENT_STATUS.FAILED) return order;

    if (
        expectedGateway &&
        normalizeGatewayName(order.paymentGateway) !== normalizeGatewayName(expectedGateway)
    ) {
        console.warn(`[${normalizeGatewayName(expectedGateway)}] ignored event for ${orderId} because the order was started on ${order.paymentGateway}`);
        return order;
    }

    if (status === PAYMENT_STATUS.SUCCESS && Number.isFinite(Number(amount)) && !amountsMatch(order.price, amount)) {
        console.warn(`[payment] amount mismatch for ${orderId}: expected ${order.price}, received ${amount}. Access was not granted.`);
        return order;
    }

    const patch = { paymentStatus: storedStatus(status) };

    if (status === PAYMENT_STATUS.SUCCESS) {
        patch.paymentFailureReason = "";
        patch.amountMismatch = false;
        if (order.status === "pending" || order.status === "cancelled") patch.status = "processing";
        if (Number.isFinite(Number(amount))) {
            const reported = Number(amount);
            const major = Math.abs(Number(order.price) - reported) <= AMOUNT_TOLERANCE
                ? reported
                : reported / 100;
            patch.paidAmountMinor = toMinorUnits(major);
        }
    } else if (failureReason) {
        patch.status = "cancelled";
        patch.paymentFailureReason = String(failureReason).slice(0, 500);
    } else {
        patch.status = "cancelled";
    }

    if (proofId) {
        patch.proofId = String(proofId);
        patch.paymentEventId = String(proofId);
    }
    if (gatewayPaymentId) patch.gatewayOrderId = String(gatewayPaymentId);

    const updated = await Order.findOneAndUpdate(
        { orderId, paymentStatus: { $ne: STORED_PAYMENT_STATUS.SUCCESS } },
        { $set: patch },
        { returnDocument: "after" }
    );

    if (!updated) {
        const current = await Order.findOne({ orderId });
        if (!current) throw new AppError(404, "Order not found.");
        return current;
    }

    publish(updated.orderId, buildStatusPayload(updated));
    return updated;
};

export const syncPendingPayment = async (order, { silent = false } = {}) => {
    if (!order || order.paymentStatus !== STORED_PAYMENT_STATUS.PENDING) return order;

    const gatewayName = normalizeGatewayName(order.paymentGateway);
    if (!gatewayName || gatewayName === FREE_GATEWAY) return order;

    let gateway;
    try {
        gateway = getGateway(gatewayName);
    } catch (error) {
        if (silent) {
            console.warn(`[payment] cannot sync ${order.orderId}: ${error.message}`);
            return order;
        }
        throw error;
    }

    try {
        const result = await gateway.inquireStatus({
            orderId: order.orderId,
            gatewayPaymentId: order.gatewayOrderId || "",
        });
        return await applyPaymentResult({
            orderId: order.orderId,
            status: result.status,
            proofId: result.proofId,
            gatewayPaymentId: result.gatewayPaymentId,
            failureReason: result.failureReason,
            amount: result.amount,
            expectedGateway: gateway.name,
        });
    } catch (error) {
        if (silent) {
            console.warn(`[${gateway.name}] status inquiry failed for ${order.orderId}: ${error.message}`);
            return order;
        }
        throw error;
    }
};

export const handleGatewayWebhook = async (req) => {
    const gateway = getGateway(req.params?.gateway);
    let valid = false;

    try {
        valid = gateway.verifyWebhook(req) === true;
    } catch (error) {
        console.error(`[${gateway.name}] webhook verification error: ${error.message}`);
        valid = false;
    }

    if (!valid) throw new AppError(401, "Invalid signature");

    let parsed;
    try {
        parsed = gateway.parseWebhook(req);
    } catch (error) {
        if (error.statusCode === 400 || error.statusCode === 404) {
            console.warn(`[${gateway.name}] webhook not applied: ${error.message}`);
            return { ack: gateway.webhookAck(), order: null };
        }
        throw error;
    }

    try {
        const order = await applyPaymentResult({
            orderId: parsed.orderId,
            status: parsed.status,
            proofId: parsed.proofId,
            gatewayPaymentId: parsed.gatewayPaymentId,
            failureReason: parsed.failureReason,
            amount: parsed.amount,
            expectedGateway: gateway.name,
        });
        return { ack: gateway.webhookAck(), order };
    } catch (error) {
        if (error.statusCode === 400 || error.statusCode === 404) {
            console.warn(`[${gateway.name}] webhook ignored for order ${parsed.orderId || "unknown"}: ${error.message}`);
            return { ack: gateway.webhookAck(), order: null };
        }
        throw error;
    }
};

const markSessionFailed = async (order, gateway, error) => {
    const reason = String(error.failureReason || error.message || "Payment session could not be created").slice(0, 300);
    try {
        await applyPaymentResult({
            orderId: order.orderId,
            status: PAYMENT_STATUS.FAILED,
            failureReason: reason,
            gatewayPaymentId: error.gatewayPaymentId,
            expectedGateway: gateway.name,
        });
    } catch (saveError) {
        console.error(`[${gateway.name}] could not mark ${order.orderId} failed: ${saveError.message}`);
    }
    return reason;
};

export const initiateCheckout = async ({
    packageId,
    customerName,
    customerEmail,
    phone,
    country,
    state,
    street,
    city,
    postCode,
    dateOfBirth,
    userId,
    ipAddress,
}) => {
    if (!packageId || !mongoose.Types.ObjectId.isValid(packageId)) {
        throw new AppError(400, "A valid Package ID is required.");
    }

    const targetPackage = await Package.findById(packageId).lean();
    if (!targetPackage) throw new AppError(404, "Package not found.");

    const price = Number(targetPackage.price);
    if (!Number.isFinite(price) || price < 0) {
        throw new AppError(400, "This package has an invalid price.");
    }
    if (price > MAX_AMOUNT) {
        throw new AppError(400, "This package price is above the payment limit.");
    }

    const daysMatch = targetPackage.deliveryTime?.match(/\d+/);
    const deliveryDays = daysMatch ? parseInt(daysMatch[0], 10) : 7;
    const deliveryDate = new Date();
    deliveryDate.setDate(deliveryDate.getDate() + deliveryDays);

    const orderId = `ORD${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
    const snapshot = {
        orderId,
        packageId: targetPackage._id,
        title: targetPackage.title || "Service Package",
        image: targetPackage.image?.[0] || "",
        category: targetPackage.serviceCategory || "General",
        price,
        currency: "USD",
        deliveryTime: targetPackage.deliveryTime || `${deliveryDays} Days`,
        deliveryDate,
        userId: userId || null,
        userName: customerName || "Customer",
        userEmail: customerEmail || "",
    };

    if (price === 0) {
        const freeOrder = await Order.create({
            ...snapshot,
            status: "processing",
            paymentStatus: STORED_PAYMENT_STATUS.SUCCESS,
            paymentGateway: FREE_GATEWAY,
        });
        publish(freeOrder.orderId, buildStatusPayload(freeOrder));
        return {
            checkoutUrl: getSuccessUrl(freeOrder.orderId),
            orderId: freeOrder.orderId,
            gateway: FREE_GATEWAY,
            free: true,
        };
    }

    const gateway = await resolveActiveGateway();
    if (typeof gateway.isConfigured === "function" && !gateway.isConfigured()) {
        throw new AppError(400, `${gateway.label} is not configured.`);
    }

    const order = await Order.create({
        ...snapshot,
        status: "pending",
        paymentStatus: STORED_PAYMENT_STATUS.PENDING,
        paymentGateway: gateway.name,
    });

    const paymentData = {
        orderId: order.orderId,
        amount: price,
        currency: "USD",
        title: order.title,
        itemId: String(targetPackage._id),
        customerEmail: customerEmail || "",
        customerName: customerName || "Customer",
        customer: {
            email: customerEmail || "",
            name: customerName || "Customer",
            phone: phone || "",
            country: country || "",
            state: state || "",
            street: street || "",
            city: city || "",
            postCode: postCode || "",
            dateOfBirth: dateOfBirth || "",
        },
        ipAddress: ipAddress || "",
    };

    let session;
    try {
        session = await createGatewaySession(gateway, paymentData);
    } catch (error) {
        const reason = await markSessionFailed(order, gateway, error);
        if (error.statusCode >= 400 && error.statusCode < 500) throw error;
        throw new AppError(502, reason);
    }

    if (session.gatewayPaymentId) {
        order.gatewayOrderId = session.gatewayPaymentId;
        await order.save();
    }

    if (!session.checkoutUrl && !session.testMode) {
        const error = new AppError(502, "Payment page could not be created. Please try again.");
        await markSessionFailed(order, gateway, error);
        throw error;
    }

    return {
        checkoutUrl: session.checkoutUrl,
        orderId: order.orderId,
        gateway: gateway.name,
        free: false,
        testMode: Boolean(session.testMode),
    };
};

export const getActiveGatewaySummary = async () => {
    const config = await getOrCreateGatewayConfig();
    const gateway = getGateway(config.activeGateway);
    return {
        activeGateway: gateway.name,
        label: gateway.label || gateway.name,
        availableGateways: describeGateways().map(({ name, label }) => ({ name, label })),
    };
};

// Adding a gateway later: create one strategy file, add its code to GATEWAYS, then register it on the next line.
registerGateway(allpaypayzGateway);
registerGateway(utpiaGateway);
