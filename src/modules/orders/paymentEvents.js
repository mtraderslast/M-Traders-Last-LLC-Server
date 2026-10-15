

const channels = new Map(); // orderId -> Set<res>

export const subscribe = (orderId, res) => {
    if (!channels.has(orderId)) channels.set(orderId, new Set());
    channels.get(orderId).add(res);
};

export const unsubscribe = (orderId, res) => {
    const set = channels.get(orderId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) channels.delete(orderId);
};

export const sendEvent = (res, payload) => {
    res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
};

export const publish = (orderId, payload) => {
    const set = channels.get(orderId);
    if (!set) return;

    const isFinal = payload.paymentStatus !== 'pending';
    for (const res of set) {
        sendEvent(res, payload);
        if (isFinal) res.end();
    }
    if (isFinal) channels.delete(orderId);
};
