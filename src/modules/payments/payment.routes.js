import express from "express";
import { verifyToken } from "../../middleware/authMiddleware.js";
import protectRoute from "../../middleware/protectRoute.js";
import { ROLES } from "../../utils/roles.js";
import {
    adminListGateways,
    adminSwitchGateway,
    getActiveGateway,
    getPaymentStatus,
    handleWebhook,
    initiatePayment,
} from "./payment.controller.js";

const router = express.Router();

router.post("/webhook/:gateway", express.raw({ type: "*/*" }), handleWebhook);
router.get("/webhook/:gateway", handleWebhook);
router.use(express.json());

router.get("/active-gateway", getActiveGateway);
router.post("/initiate", initiatePayment);
router.get("/status/:orderId", getPaymentStatus);
router.get("/admin/gateways", verifyToken, protectRoute(ROLES.ADMIN), adminListGateways);
router.patch("/admin/switch-gateway", verifyToken, protectRoute(ROLES.ADMIN), adminSwitchGateway);

export default router;
