export const GATEWAYS = Object.freeze({
    ALLPAYPAYZ: "ALLPAYPAYZ",
    UTPIA: "UTPIA",
});

export const PAYMENT_STATUS = Object.freeze({
    PENDING: "PENDING",
    SUCCESS: "SUCCESS",
    FAILED: "FAILED",
});

// Zero-price orders skip every provider. This code is not registered.
export const FREE_GATEWAY = "FREE";

// Orders already in the database use these words. Gateways never see them.
export const STORED_PAYMENT_STATUS = Object.freeze({
    PENDING: "pending",
    SUCCESS: "paid",
    FAILED: "failed",
});

export const normalizeGatewayName = (name) => String(name || "").trim().toUpperCase();
