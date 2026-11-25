import { fromNodeHeaders } from "better-auth/node";
import catchAsync from "../../utils/catchAsync.js";
import AppError from "../../utils/AppError.js";
import Order from "../orders/order.model.js";
import { getClientIp } from "./paymentConfig.js";
import { describeGateways } from "./gatewayRegistry.js";
import {
    buildStatusPayload,
    getActiveGatewaySummary,
    handleGatewayWebhook,
    initiateCheckout,
    setActiveGateway,
    syncPendingPayment,
} from "./paymentManager.js";

const getOptionalUser = async (req) => {
    try {
        const auth = req.app.get("auth");
        if (!auth) return null;
        const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
        return session?.user || null;
    } catch {
        return null;
    }
};

const sendAck = (res, ack) => {
    if (typeof ack === "string") {
        return res.status(200).type("text/plain").send(ack);
    }
    return res.status(200).json(ack);
};

export const getActiveGateway = catchAsync(async (req, res) => {
    const summary = await getActiveGatewaySummary();
    return res.status(200).json({ success: true, ...summary });
});

export const initiatePayment = catchAsync(async (req, res) => {
    const sessionUser = await getOptionalUser(req);
    const result = await initiateCheckout({
        packageId: req.body?.packageId,
        customerName: req.body?.userName?.trim() || sessionUser?.name || "Customer",
        customerEmail: sessionUser?.email || req.body?.userEmail?.trim() || "",
        phone: req.body?.phone?.trim() || "",
        country: req.body?.country?.trim() || "",
        state: req.body?.state?.trim() || "",
        street: req.body?.street?.trim() || "",
        city: req.body?.city?.trim() || "",
        postCode: req.body?.postCode?.trim() || "",
        dateOfBirth: req.body?.dateOfBirth?.trim() || "",
        userId: sessionUser?.id || null,
        ipAddress: getClientIp(req),
    });

    return res.status(200).json({
        success: true,
        url: result.checkoutUrl,
        checkoutUrl: result.checkoutUrl,
        orderId: result.orderId,
        gateway: result.gateway,
        free: Boolean(result.free),
        testMode: Boolean(result.testMode),
    });
});

export const getPaymentStatus = catchAsync(async (req, res) => {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) throw new AppError(404, "Order not found");

    const fresh = await syncPendingPayment(order, { silent: true });
    return res.status(200).json({
        success: true,
        data: buildStatusPayload(fresh),
    });
});

export const handleWebhook = catchAsync(async (req, res) => {
    const { ack } = await handleGatewayWebhook(req);
    return sendAck(res, ack);
});

export const adminListGateways = catchAsync(async (req, res) => {
    const summary = await getActiveGatewaySummary();
    return res.status(200).json({
        success: true,
        activeGateway: summary.activeGateway,
        gateways: describeGateways(),
    });
});

export const adminSwitchGateway = catchAsync(async (req, res) => {
    const config = await setActiveGateway(req.body?.gateway);
    return res.status(200).json({
        success: true,
        message: "New checkouts will use this gateway. Payments already started stay on their own gateway.",
        activeGateway: config.activeGateway,
    });
});
