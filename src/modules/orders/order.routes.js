import express from "express";
import { verifyToken } from "../../middleware/authMiddleware.js";
import protectRoute from "../../middleware/protectRoute.js";
import { ROLES } from "../../utils/roles.js";
import { cancelOrder, getAllOrders, getMyOrders, getOrderDetails, streamPaymentStatus, updateOrderStatus } from "./order.controller.js";
import { getPaymentStatus, handleWebhook, initiatePayment } from "../payments/payment.controller.js";

const router = express.Router();


router.post("/allpaypayz-webhook", express.raw({ type: "*/*" }), (req, res, next) => {
    req.params.gateway = "allpaypayz";
    return handleWebhook(req, res, next);
});

router.use(express.json());

router.post('/initiate-payment', initiatePayment);
router.get('/payment-status/:orderId', getPaymentStatus);
router.get('/payment-events/:orderId', streamPaymentStatus);

router.get("/my-orders", verifyToken, protectRoute(ROLES.USER), getMyOrders);
router.get("/order-details/:id", verifyToken, getOrderDetails);
router.get("/get-allOrders", verifyToken, protectRoute(ROLES.ADMIN), getAllOrders);
router.patch("/update-order/:id", verifyToken, protectRoute(ROLES.ADMIN), updateOrderStatus);
router.delete("/cancel-order/:id", verifyToken, protectRoute(ROLES.USER), cancelOrder);

export default router;